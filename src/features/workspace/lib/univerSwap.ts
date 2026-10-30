import { LifecycleStages } from '@univerjs/core';

/**
 * Подмена экземпляра Univer без пустого листа. Редактор пересоздаётся, когда материал записали мимо совместной
 * правки (агент «Ядра», версия из истории) или сменилась тема. Новый экземпляр рисуется не сразу — в dev-сборке
 * дольше секунды, — и на его месте мелькал пустой лист. Старый остаётся поверх, без ввода, и уходит, когда новый
 * отрисовался: LifeCycleChanged → Rendered и ещё TAKEOVER_DELAY_MS — на самом Rendered лист ещё пустой, текст ложится
 * через 150–200 мс (Steady наступает только через ~3 с — слишком поздно). Не дождались — уходит сам через RETIRE_MAX_MS.
 */

const RETIRE_MAX_MS = 5000;
const TAKEOVER_DELAY_MS = 400;
const retired = new WeakMap<HTMLElement, () => void>();

/** Старый экземпляр: остаётся поверх нового до его первой отрисовки. */
export function retireMount(mount: HTMLElement, dispose: () => void): void {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    window.clearTimeout(timer);
    retired.delete(mount);
    dispose();
    mount.remove();
  };
  const timer = window.setTimeout(finish, RETIRE_MAX_MS);
  mount.classList.add('nws-univer-leaving');
  retired.set(mount, finish);
}

/** Новый экземпляр отрисовался — убрать старые в этом же контейнере. */
function takeOver(host: HTMLElement, mount: HTMLElement): void {
  host.querySelectorAll<HTMLElement>('.nws-univer-leaving').forEach((old) => {
    if (old !== mount) retired.get(old)?.();
  });
}

type LifecycleApi = {
  Event: { LifeCycleChanged: string };
  addEvent: (event: string, cb: (params: { stage: LifecycleStages }) => void) => { dispose: () => void };
};

/** Следить за первой отрисовкой нового экземпляра. Возвращает отписку. */
export function takeOverWhenRendered(univerAPI: unknown, host: HTMLElement, mount: HTMLElement): () => void {
  const api = univerAPI as LifecycleApi;
  let timer = 0;
  const sub = api.addEvent(api.Event.LifeCycleChanged, ({ stage }) => {
    if (stage < LifecycleStages.Rendered || timer) return;
    timer = window.setTimeout(() => requestAnimationFrame(() => takeOver(host, mount)), TAKEOVER_DELAY_MS);
  });
  return () => { window.clearTimeout(timer); sub.dispose(); };
}
