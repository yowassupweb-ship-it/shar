!define MUI_WELCOMEPAGE_TITLE "Установка Shar OS"
!define MUI_WELCOMEPAGE_TEXT "Balanced Deep стиль загрузки и фирменная тема Shar OS."
!define MUI_FINISHPAGE_TITLE "Shar OS установлен"
!define MUI_FINISHPAGE_TEXT "Установка завершена. Можно запускать Shar OS."
!define MUI_UNWELCOMEPAGE_TITLE "Удаление Shar OS"
!define MUI_UNFINISHPAGE_TITLE "Shar OS удален"


; --- Branded install ---------------------------------------------------------
; The stock one-click progress window (grey, "Установка, пожалуйста, подождите")
; looked foreign.  A non-silent run (fresh install from Shar setup.exe, or an
; update launched by an older app) switches NSIS to silent and shows the same
; branded window the app uses for its own updates (update-splash.ps1).  Silent
; runs are left alone: the app already shows that window before starting them.
!macro customInit
  Var /GLOBAL sharBrandedInstall
  StrCpy $sharBrandedInstall "0"
  ${IfNot} ${Silent}
    StrCpy $sharBrandedInstall "1"
    CreateDirectory "$TEMP\shar-install-splash"
    SetOutPath "$TEMP\shar-install-splash"
    File /oname=update-splash.ps1 "${PROJECT_DIR}\electron\update-splash.ps1"
    File /oname=logo.png "${PROJECT_DIR}\electron\icon.png"
    ; The splash watches this process so a failed or cancelled install closes it.
    System::Call "kernel32::GetCurrentProcessId() i .r0"
    ExecShell "open" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "$TEMP\shar-install-splash\update-splash.ps1" -LogoPath "$TEMP\shar-install-splash\logo.png" -Mode install -InstallerPid $0' SW_HIDE
    SetSilent silent
  ${EndIf}
!macroend

; Silent one-click installs start the app only with --force-run, which a manual
; install never has.  Start it here instead; runs from old apps pass --force-run
; and are started by electron-builder itself.
!macro customInstall
  ${If} $sharBrandedInstall == "1"
  ${AndIfNot} ${isForceRun}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
  ${EndIf}
!macroend
