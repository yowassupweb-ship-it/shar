import { realtime } from '@/shared/realtime/realtime';

/**
 * Мост «агент Ядра → этот компьютер» в Shar OS (сервер: server/app/modules/computer, исполнитель:
 * desktop/electron/computer.cjs). Пока человек включил управление — раз в 30 с говорим серверу «этот компьютер можно»;
 * команды computer_request для этого устройства выполняем и отвечаем снимком экрана. Выключили (или «Стоп» на
 * плашке, Ctrl+Alt+Q) — сразу снимаем отметку, и агент получает «управление выключено».
 */

const BEAT_MS = 30_000;

type Request = { type: 'computer_request'; id: string; deviceId: string; action: string; args?: Record<string, unknown> };

export function startComputerBridge(): () => void {
  const api = window.sharDesktop?.computer;
  if (!api) return () => undefined;
  let enabled = false;
  let deviceId = '';
  let name = '';
  let size = { width: 0, height: 0 };
  let beat = 0;
  let stopped = false;

  const announce = () => {
    if (!enabled || !deviceId) return;
    void fetch('/api/computer/presence', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, name, width: size.width, height: size.height }),
    }).catch(() => undefined);
  };
  const withdraw = () => {
    if (deviceId) void fetch(`/api/computer/presence/${encodeURIComponent(deviceId)}`, { method: 'DELETE' }).catch(() => undefined);
  };
  const apply = (on: boolean) => {
    enabled = on;
    window.clearInterval(beat);
    if (on) { announce(); beat = window.setInterval(announce, BEAT_MS); } else { withdraw(); }
  };

  void api.get().then((info) => {
    if (stopped) return;
    deviceId = info.deviceId;
    name = info.name;
    size = { width: info.width, height: info.height };
    apply(info.enabled && info.supported);
  }).catch(() => undefined);
  const offChanged = api.onChanged((data) => apply(data.enabled));

  const offEvents = realtime.subscribe((event) => {
    const e = event as unknown as Request;
    if (e.type !== 'computer_request' || !enabled || e.deviceId !== deviceId) return;
    void api.run(e.action, e.args || {})
      .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      .then((res) => fetch(`/api/computer/result/${encodeURIComponent(e.id)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(res),
      }))
      .catch(() => undefined);
  });

  return () => { stopped = true; window.clearInterval(beat); offChanged(); offEvents(); };
}
