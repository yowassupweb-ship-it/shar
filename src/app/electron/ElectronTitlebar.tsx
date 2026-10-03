import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { BellRing, Copy, Download, Minus, MoreVertical, PhoneCall, RefreshCw, RotateCw, Square, X } from 'lucide-react';
import { isNotifications, useChatStore } from '@/features/chat';
import { links } from '@/shared/navigation/routes';
import './electron.css';

/**
 * Шапка окна для компьютера (Electron): окно без системной рамки, поэтому
 * перетаскивание, свернуть / развернуть / закрыть и масштаб — здесь.
 * Слева — знак и состояние связи, по центру — звонок или счётчик уведомлений,
 * справа — обновление, меню и кнопки окна. В браузере не рисуется.
 */

export const TITLEBAR_HEIGHT = 30;
const clampZoom = (n: number) => Math.max(50, Math.min(300, Math.round(n)));

interface CallIsland { state: string | null; callerName?: string }

const CONNECTION_LABEL: Record<string, string> = { connecting: 'Подключаюсь…', closed: 'Нет связи — переподключаюсь' };

export default function ElectronTitlebar() {
  const desk = typeof window !== 'undefined' ? window.sharDesktop : undefined;
  const navigate = useNavigate();
  const status = useChatStore((s) => s.status);
  const notifications = useChatStore((s) => Object.values(s.chats).find((c) => isNotifications(c)));
  const unread = Number(notifications?.unreadCount || 0);

  const [maximized, setMaximized] = useState(false);
  const [menu, setMenu] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [call, setCall] = useState<CallIsland | null>(null);
  const [update, setUpdate] = useState<{ state: 'downloading' | 'downloaded'; version?: string; percent?: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Высота шапки — переменной: корень .nx и шторки встают под неё.
  useEffect(() => {
    if (!desk) return undefined;
    const root = document.documentElement;
    root.style.setProperty('--electron-titlebar-height', `${TITLEBAR_HEIGHT}px`);
    root.style.setProperty('--shar-electron-header-h', `${TITLEBAR_HEIGHT}px`);
    return () => { root.style.removeProperty('--electron-titlebar-height'); root.style.removeProperty('--shar-electron-header-h'); };
  }, [desk]);

  useEffect(() => {
    if (!desk) return undefined;
    void desk.windowControls.isMaximized().then((v) => setMaximized(Boolean(v))).catch(() => undefined);
    const offs = [
      desk.windowControls.onMaximizedChanged((v) => setMaximized(Boolean(v))),
      desk.call?.onIslandUpdate?.((d) => setCall(d && d.state ? d : null)),
      desk.updater?.onStatus((d) => setUpdate(d)),
    ];
    return () => offs.forEach((off) => { if (typeof off === 'function') off(); });
  }, [desk]);

  useEffect(() => {
    if (!menu) return undefined;
    void Promise.resolve(desk?.windowControls.getZoom()).then((z) => { if (typeof z === 'number') setZoom(clampZoom(z)); }).catch(() => undefined);
    const outside = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [menu, desk]);

  const applyZoom = useCallback(async (next: number) => {
    const value = clampZoom(next);
    setZoom(value);
    try { const applied = await desk?.windowControls.setZoom(value); if (typeof applied === 'number') setZoom(clampZoom(applied)); } catch { /* масштаб не применился */ }
  }, [desk]);

  if (!desk) return null;

  const connection = CONNECTION_LABEL[status];

  return (
    <header id="shar-titlebar" className="electron-header-pill ntb">
      <div className="ntb-brand" role="status" aria-live="polite">
        <img className="ntb-logo" data-spin={connection ? 'true' : undefined} src="/logo-shar-120.png" alt="" width={22} height={22} />
        <span className="ntb-name">ШАР</span>
        {connection && <span className="ntb-conn" data-state={status}>{connection}</span>}
      </div>

      {call ? (
        <div className="ntb-island ntb-call" role="group" aria-label="Звонок">
          <button type="button" className="ntb-call-main" title="Вернуться к звонку" onClick={() => desk.call?.islandAction('restore')}>
            <PhoneCall size={13} aria-hidden="true" />
            <span>{call.callerName || (call.state === 'ringing-in' ? 'Входящий звонок' : 'Звонок')}</span>
          </button>
          {call.state === 'ringing-in' && (
            <button type="button" className="ntb-round" data-tone="ok" title="Ответить" aria-label="Ответить" onClick={() => desk.call?.islandAction('answer')}><PhoneCall size={12} /></button>
          )}
          <button type="button" className="ntb-round" data-tone="danger" title={call.state === 'ringing-in' ? 'Отклонить' : 'Завершить'} aria-label="Завершить" onClick={() => desk.call?.islandAction('hangup')}><X size={12} /></button>
        </div>
      ) : unread > 0 && notifications ? (
        <button type="button" className="ntb-island ntb-notify" title="Уведомления" onClick={() => navigate(links.chat(String(notifications.id)))}>
          <BellRing size={12} aria-hidden="true" /> Уведомления <b>{unread > 99 ? '99+' : unread}</b>
        </button>
      ) : null}

      <div className="ntb-right">
        {update && (
          <button type="button" className="ntb-update" data-state={update.state} disabled={update.state === 'downloading'}
            title={update.state === 'downloaded' ? 'Установить обновление и перезапустить' : `Загрузка обновления ${update.percent ?? 0}%`}
            onClick={() => { if (update.state === 'downloaded') void desk.updater?.install(); }}>
            {update.state === 'downloaded' ? <><RefreshCw size={11} aria-hidden="true" /> Обновить{update.version ? ` v${update.version}` : ''}</> : <><Download size={11} aria-hidden="true" /> {update.percent ?? 0}%</>}
          </button>
        )}

        <div className="ntb-menu-wrap" ref={menuRef}>
          <button type="button" className="ntb-btn" aria-label="Меню" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}><MoreVertical size={14} /></button>
          {menu && (
            <div className="ntb-menu" role="menu">
              <div className="ntb-zoom" role="group" aria-label="Масштаб">
                <button type="button" title="Меньше" onClick={() => void applyZoom(zoom - 5)}>−</button>
                <button type="button" title="Сбросить масштаб" onClick={() => void applyZoom(100)}>{zoom}%</button>
                <button type="button" title="Больше" onClick={() => void applyZoom(zoom + 5)}>+</button>
              </div>
              <button type="button" role="menuitem" className="ntb-item" onClick={() => { setMenu(false); void desk.windowControls.reload(); }}><RotateCw size={14} aria-hidden="true" /> Обновить страницу</button>
            </div>
          )}
        </div>

        <div className="ntb-controls">
          <button type="button" className="ntb-btn" title="Свернуть" aria-label="Свернуть" onClick={() => void desk.windowControls.minimize()}><Minus size={14} /></button>
          <button type="button" className="ntb-btn" title={maximized ? 'Восстановить' : 'Развернуть'} aria-label={maximized ? 'Восстановить' : 'Развернуть'}
            onClick={() => void desk.windowControls.toggleMaximize().then((v) => setMaximized(Boolean(v)))}>
            {maximized ? <Copy size={12} /> : <Square size={12} />}
          </button>
          <button type="button" className="ntb-btn" data-close="true" title="Закрыть" aria-label="Закрыть" onClick={() => void desk.windowControls.close()}><X size={14} /></button>
        </div>
      </div>
    </header>
  );
}
