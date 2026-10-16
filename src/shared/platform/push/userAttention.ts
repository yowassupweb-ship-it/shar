/**
 * «Пользователь действительно смотрит на приложение».
 *
 * `document.visibilityState` отвечает на другой вопрос — «отрисовывается ли
 * страница». Окно, полностью перекрытое браузером поверх, там по-прежнему
 * 'visible'. На этом признаке висели и подавление уведомлений, и отметка о
 * прочтении, поэтому сообщения молча прочитывались и не показывались, пока
 * человек работал в другом приложении.
 *
 * Правильный ответ даёт фокус:
 *  - в Electron — из main-процесса (isVisible && !isMinimized && isFocused),
 *    там же учитывается сворачивание в трей;
 *  - в браузере — visibilityState вместе с document.hasFocus().
 */

type Listener = (attending: boolean) => void;

interface AttentionBridge {
  get(): Promise<{ attending?: boolean }>;
  onChange(callback: (attending: boolean) => void): () => void;
}

function bridge(): AttentionBridge | null {
  if (typeof window === 'undefined') return null;
  const desktop = (window as unknown as { sharDesktop?: { attention?: AttentionBridge } }).sharDesktop;
  return desktop?.attention ?? null;
}

function browserAttending(): boolean {
  if (typeof document === 'undefined') return true;
  if (document.visibilityState !== 'visible') return false;
  // hasFocus() отсутствует в очень старых окружениях — тогда довольствуемся видимостью.
  return typeof document.hasFocus === 'function' ? document.hasFocus() : true;
}

// В Electron состояние приходит из main-процесса асинхронно, поэтому держим
// последнее известное значение: вызывающему нужен синхронный ответ прямо в
// момент обработки сообщения.
let electronAttending: boolean | null = null;
const listeners = new Set<Listener>();
let started = false;

function emit(value: boolean): void {
  for (const listener of listeners) {
    try { listener(value); } catch { /* один плохой подписчик не ломает остальных */ }
  }
}

function start(): void {
  if (started || typeof window === 'undefined') return;
  started = true;

  const desktopBridge = bridge();
  if (desktopBridge) {
    void desktopBridge.get()
      .then((state) => { electronAttending = Boolean(state?.attending); emit(electronAttending); })
      .catch(() => { electronAttending = true; });
    desktopBridge.onChange((attending) => { electronAttending = attending; emit(attending); });
    return;
  }

  const onChange = () => emit(browserAttending());
  document.addEventListener('visibilitychange', onChange);
  window.addEventListener('focus', onChange);
  window.addEventListener('blur', onChange);
}

export function isUserAttending(): boolean {
  start();
  const desktopBridge = bridge();
  if (desktopBridge) {
    // До первого ответа из main-процесса считаем, что человек смотрит: ошибиться
    // в эту сторону значит не показать лишнее уведомление, а в обратную —
    // молча проглотить нужное.
    // Фокус самой страницы — вторая опора: main-процесс изредка считал окно
    // несфокусированным, пока в нём печатали. Перекрытое окно фокуса страницы
    // не имеет, так что фоновое прочтение это не возвращает.
    return (electronAttending ?? true) || browserAttending();
  }
  return browserAttending();
}

/**
 * Можно ли сейчас отмечать сообщения прочитанными.
 *
 * В Electron окклюзия окна отключена (см. main.cjs), поэтому страница
 * перекрытого окна всё равно «visible» — и сообщения прочитывались, пока человек
 * работал в другом приложении. Там читаем только при реальном внимании к окну.
 * В браузере и на телефоне — как раньше, по видимости страницы: у вкладки на
 * втором мониторе фокуса нет, но читают именно её.
 */
export function isReadingNow(): boolean {
  if (typeof document === 'undefined') return false;
  if (bridge()) return isUserAttending();
  return document.visibilityState === 'visible';
}

export function subscribeAttention(listener: Listener): () => void {
  start();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
