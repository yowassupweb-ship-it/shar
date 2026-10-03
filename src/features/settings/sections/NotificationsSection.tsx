import { useEffect, useState } from 'react';
import { notificationState, requestNotifications, type NotificationState } from '@/shared/platform/notifications';
import { myId } from '@/shared/session/session';
import { showToast } from '@/shared/ui/Toast';
import { loadReactionPush, saveReactionPush, sendTestPush } from '../api';
import { Group, Row, Switch } from '@/shared/ui/controls';

const STATE_TEXT: Record<NotificationState, string> = {
  granted: 'Разрешены',
  denied: 'Запрещены в браузере',
  default: 'Ещё не разрешены',
  unsupported: 'Браузер не поддерживает',
};

type Line = { tone: 'ok' | 'warn' | 'bad' | 'info'; text: string };

export default function NotificationsSection() {
  const [perm, setPerm] = useState<NotificationState>(notificationState);
  const [reactions, setReactions] = useState(true);
  const [startup, setStartup] = useState<{ supported: boolean; on: boolean }>({ supported: false, on: false });
  const [log, setLog] = useState<Line[]>([]);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    void loadReactionPush().then((v) => { if (v !== null) setReactions(v); });
    window.sharDesktop?.startup?.get?.()
      .then((s) => { if (s?.supported) setStartup({ supported: true, on: Boolean(s.openAtLogin) }); })
      .catch(() => {});
    // Разрешение меняют и в настройках браузера — сверяемся, когда окно снова в фокусе.
    const sync = () => setPerm(notificationState());
    window.addEventListener('focus', sync);
    return () => window.removeEventListener('focus', sync);
  }, []);

  const toggleReactions = async (on: boolean) => {
    setReactions(on);
    try { await saveReactionPush(on); } catch { setReactions(!on); showToast('Не сохранилось — нет связи с сервером', 'error'); }
  };

  const toggleStartup = (on: boolean) => {
    setStartup((s) => ({ ...s, on }));
    window.sharDesktop?.startup?.set?.(on)
      .then((s) => { if (s?.supported) setStartup({ supported: true, on: Boolean(s.openAtLogin) }); })
      .catch(() => setStartup((s) => ({ ...s, on: !on })));
  };

  const allow = async () => setPerm(await requestNotifications(myId()));

  const diagnose = async () => {
    const lines: Line[] = [];
    const add = (tone: Line['tone'], text: string) => { lines.push({ tone, text }); setLog([...lines]); };
    setTesting(true);
    try {
      if (!('serviceWorker' in navigator)) { add('bad', 'Service worker не поддерживается'); return; }
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) add('warn', 'Service worker не зарегистрирован (в режиме разработки это нормально)');
      else {
        add('ok', `Service worker: ${reg.active?.state || 'неактивен'}`);
        const sub = 'PushManager' in window ? await reg.pushManager.getSubscription() : null;
        add(sub ? 'ok' : 'warn', sub ? 'Подписка на пуши есть' : 'Подписки на пуши нет');
        try {
          await reg.showNotification('Проверка Шара', { body: 'Локальные уведомления работают', icon: '/favicon.png', tag: 'shar-test' });
          add('ok', 'Локальное уведомление показано');
        } catch (e) { add('bad', `Локальное уведомление: ${e instanceof Error ? e.message : e}`); }
      }
      try {
        await sendTestPush();
        add('ok', 'Сервер отправил пуш');
      } catch (e) { add('bad', `Сервер: ${e instanceof Error ? e.message : e}`); }
    } finally { setTesting(false); }
  };

  return (
    <>
      <Group title="На этом устройстве">
        <Row label="Уведомления" hint={STATE_TEXT[perm]}>
          {perm === 'granted'
            ? <button type="button" className="nx-ghost" disabled={testing} onClick={() => void diagnose()}>{testing ? 'Проверяем…' : 'Проверить'}</button>
            : perm !== 'unsupported' && <button type="button" className="nx-primary" onClick={() => void allow()}>{perm === 'denied' ? 'Запросить снова' : 'Разрешить'}</button>}
        </Row>
        {startup.supported && (
          <Row label="Запускать вместе с Windows" hint="Шар откроется сам после включения компьютера">
            <Switch checked={startup.on} onChange={toggleStartup} label="Запускать вместе с Windows" />
          </Row>
        )}
      </Group>
      {perm === 'denied' && (
        <p className="nx-note">Браузер запретил уведомления для этого сайта. Разрешите их в настройках сайта (значок замка в адресной строке) и вернитесь сюда.</p>
      )}

      <Group title="О чём сообщать">
        <Row label="Реакции на мои сообщения" hint="Пуш, когда кто-то ставит реакцию">
          <Switch checked={reactions} onChange={(v) => void toggleReactions(v)} label="Реакции на мои сообщения" />
        </Row>
      </Group>

      {log.length > 0 && (
        <ul className="nst-log" aria-live="polite">
          {log.map((l, i) => <li key={i} data-tone={l.tone}>{l.text}</li>)}
        </ul>
      )}
    </>
  );
}
