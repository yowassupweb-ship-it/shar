# Фирменный экран на время установки обновления.
#
# Установщик NSIS закрывает само приложение, поэтому сплэш Electron умирает
# вместе с ним, а стандартное окно NSIS выглядит чужим. Этот экран живёт в
# отдельном процессе: main.cjs запускает его перед quitAndInstall, установщик
# работает молча, а окно само закрывается, когда стартует новая версия и
# показывает уже собственный сплэш.

param(
  [Parameter(Mandatory = $true)][string]$LogoPath,
  [string]$ReadyPath = '',
  [int]$TimeoutSec = 180,
  [int]$TestSeconds = 0,
  # 'install' — fresh install launched from Shar setup.exe (installer.nsh).
  [ValidateSet('update', 'install')][string]$Mode = 'update',
  # Installer process to watch: if it ends and no new app starts, close.
  [int]$InstallerPid = 0,
  # The app writes this file if the install could not start: close at once.
  [string]$CancelPath = ''
)

$statusText = if ($Mode -eq 'install') { 'Устанавливаю Shar OS…' } else { 'Устанавливаю обновление…' }

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$dark = $false
try {
  $personalize = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name AppsUseLightTheme -ErrorAction Stop
  $dark = $personalize.AppsUseLightTheme -eq 0
} catch {}

# Те же цвета, что в splash.html (светлая и тёмная тема).
if ($dark) {
  $card = '#FA2C2C2E'; $border = '#1CFFFFFF'; $title = '#FFFFFFFF'; $muted = '#9EFFFFFF'; $track = '#21FFFFFF'
} else {
  $card = '#F7FFFFFF'; $border = '#1A0F172A'; $title = '#FF111111'; $muted = '#FF6B7280'; $track = '#29767680'
}

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Shar OS" Width="384" Height="244"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ResizeMode="NoResize" WindowStartupLocation="CenterScreen"
        Topmost="True" ShowInTaskbar="True">
  <Border Margin="12" CornerRadius="24" Background="$card" BorderBrush="$border" BorderThickness="1">
    <Border.Effect>
      <DropShadowEffect BlurRadius="22" ShadowDepth="3" Opacity="0.22" Color="#0F172A"/>
    </Border.Effect>
    <StackPanel VerticalAlignment="Center" HorizontalAlignment="Center">
      <Image x:Name="Logo" Width="66" Height="66" RenderOptions.BitmapScalingMode="HighQuality" RenderTransformOrigin="0.5,0.5">
        <Image.RenderTransform>
          <ScaleTransform x:Name="LogoScale" ScaleX="1" ScaleY="1"/>
        </Image.RenderTransform>
      </Image>
      <TextBlock Text="Shar OS" Margin="0,13,0,0" HorizontalAlignment="Center"
                 FontFamily="Segoe UI Variable Display, Segoe UI" FontSize="19" FontWeight="Bold" Foreground="$title"/>
      <TextBlock x:Name="Status" Text="$statusText" Margin="0,9,0,0" HorizontalAlignment="Center"
                 FontFamily="Segoe UI Variable Text, Segoe UI" FontSize="12" Foreground="$muted"/>
      <Border Width="178" Height="4" Margin="0,14,0,0" CornerRadius="2" Background="$track">
        <Border.OpacityMask>
          <VisualBrush>
            <VisualBrush.Visual>
              <Border Width="178" Height="4" CornerRadius="2" Background="Black"/>
            </VisualBrush.Visual>
          </VisualBrush>
        </Border.OpacityMask>
        <Canvas ClipToBounds="True">
          <Border x:Name="Bar" Width="64" Height="4" CornerRadius="2" Canvas.Left="-64">
            <Border.Background>
              <LinearGradientBrush StartPoint="0,0" EndPoint="1,0">
                <GradientStop Color="#007AFF" Offset="0"/>
                <GradientStop Color="#0A84FF" Offset="1"/>
              </LinearGradientBrush>
            </Border.Background>
          </Border>
        </Canvas>
      </Border>
    </StackPanel>
  </Border>
</Window>
"@

$window = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
$logo = $window.FindName('Logo')
$status = $window.FindName('Status')
$bar = $window.FindName('Bar')
$logoScale = $window.FindName('LogoScale')

try {
  $bitmap = New-Object System.Windows.Media.Imaging.BitmapImage
  $bitmap.BeginInit()
  $bitmap.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
  $bitmap.UriSource = New-Object System.Uri($LogoPath)
  $bitmap.EndInit()
  $logo.Source = $bitmap
  $window.Icon = $bitmap
} catch {}

$window.Add_MouseLeftButtonDown({ try { $window.DragMove() } catch {} })

$window.Add_ContentRendered({
  $slide = New-Object System.Windows.Media.Animation.DoubleAnimation(-64, 178, (New-Object System.Windows.Duration ([TimeSpan]::FromMilliseconds(1300))))
  $slide.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
  $slide.EasingFunction = New-Object System.Windows.Media.Animation.SineEase
  $bar.BeginAnimation([System.Windows.Controls.Canvas]::LeftProperty, $slide)

  $pulse = New-Object System.Windows.Media.Animation.DoubleAnimation(1, 0.92, (New-Object System.Windows.Duration ([TimeSpan]::FromMilliseconds(1300))))
  $pulse.AutoReverse = $true
  $pulse.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
  $pulse.EasingFunction = New-Object System.Windows.Media.Animation.SineEase
  $logoScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, $pulse)
  $logoScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, $pulse)

  # Сигнал main.cjs: окно на экране, можно закрывать приложение.
  if ($ReadyPath) { try { [IO.File]::WriteAllText($ReadyPath, 'ready') } catch {} }
})

$startedAt = Get-Date
# Tick handlers run in a child scope: state they change must be script-scoped,
# or each tick sees a fresh copy and the window never closes.
$script:newVersionSeenAt = $null
$script:installerGoneAt = $null
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(500)
$timer.Add_Tick({
  if ($CancelPath -and (Test-Path -LiteralPath $CancelPath)) { $window.Close(); return }

  $elapsed = ((Get-Date) - $startedAt).TotalSeconds

  if ($TestSeconds -gt 0) {
    if ($elapsed -ge $TestSeconds) { $window.Close() }
    return
  }

  # A fresh install may still be downloading ~200 MB at 20 s — only updates say this.
  if ($Mode -eq 'update' -and $elapsed -ge 20 -and $status.Text -ne 'Почти готово…') { $status.Text = 'Почти готово…' }

  if (-not $script:newVersionSeenAt) {
    # Процесс, запущенный позже этого окна, — уже новая версия.
    $fresh = Get-Process -Name 'Shar OS' -ErrorAction SilentlyContinue | Where-Object {
      try { $_.StartTime -gt $startedAt } catch { $false }
    }
    if ($fresh) {
      $script:newVersionSeenAt = Get-Date
      $status.Text = 'Запускаю новую версию…'
    }
  } elseif (((Get-Date) - $script:newVersionSeenAt).TotalSeconds -ge 2.5) {
    # Пауза, чтобы новая версия успела показать свой сплэш: без неё на
    # рабочем столе мелькает пустота между двумя экранами.
    $window.Close()
  }

  # A failed or cancelled install never starts the app; don't wait out the timeout.
  if ($InstallerPid -gt 0 -and -not $script:newVersionSeenAt) {
    if (-not (Get-Process -Id $InstallerPid -ErrorAction SilentlyContinue)) {
      if (-not $script:installerGoneAt) { $script:installerGoneAt = Get-Date }
      elseif (((Get-Date) - $script:installerGoneAt).TotalSeconds -ge 8) { $window.Close() }
    }
  }

  if ($elapsed -ge $TimeoutSec) { $window.Close() }
})
$timer.Start()

[void]$window.ShowDialog()
