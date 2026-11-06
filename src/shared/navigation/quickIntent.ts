import { navigate } from './navigate';

/**
 * «Быстрое действие» из нижней полосы (правый клик по разделу): перейти в раздел и сразу сделать — новая задача, новое
 * событие, новый чат. Раздел может ещё не быть на экране, поэтому просьба ждёт: экран забирает её при открытии
 * (takeIntent) или по событию, если уже открыт. Как requestJump у чатов.
 */
export type Intent = 'new-task' | 'new-event' | 'new-chat' | 'new-group';

let pending: Intent | null = null;

export function requestIntent(intent: Intent, path: string) {
  pending = intent;
  navigate(path);
  // Раздел уже открыт — он слушает событие; открывается заново — заберёт просьбу при монтировании.
  window.dispatchEvent(new CustomEvent('nx:intent', { detail: intent }));
}

/** Забрать отложенную просьбу, если она из списка допустимых для этого экрана (один раз). */
export function takeIntent(allowed: Intent[]): Intent | null {
  if (!pending || !allowed.includes(pending)) return null;
  const got = pending;
  pending = null;
  return got;
}

/** Подписка экрана: забирает просьбу при монтировании и по событию. Возвращает отписку. */
export function listenIntent(allowed: Intent[], run: (intent: Intent) => void): () => void {
  const grab = () => { const got = takeIntent(allowed); if (got) run(got); };
  // Следующий кадр: к монтированию экран уже зарегистрировал свои обработчики.
  const frame = window.requestAnimationFrame(grab);
  window.addEventListener('nx:intent', grab);
  return () => { window.cancelAnimationFrame(frame); window.removeEventListener('nx:intent', grab); };
}
