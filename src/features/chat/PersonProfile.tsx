import { useState, type CSSProperties } from 'react';
import { ArrowLeft, AtSign, Clock, Mail, Phone, Send, X } from 'lucide-react';
import type { User } from '@/shared/types/chat';
import { showToast } from '@/shared/ui/Toast';
import { getDepartmentColor, getDepartmentName } from '@/shared/lib/departmentColors';
import { Avatar } from '@/shared/ui/Avatar';
import { lastSeenText } from '@/shared/ui/format';
import { SectionIcon } from '@/shared/ui/SectionIcon';
import { createChat } from './actions';
import { displayName, openChat, setPanel, useChatStore } from './store';
import { Spinner } from '@/shared/ui/Spinner';
import { MailLink } from '@/features/mail';

/**
 * Профиль человека внутри боковой панели — открывается нажатием на его
 * аватар в ленте или на строку в «Участниках» группы. «Назад» возвращает к
 * профилю чата, из которого пришли.
 */

type Person = User & {
  position?: string; phone?: string; department?: string; telegramUsername?: string; workSchedule?: string;
};

export default function PersonProfile({ userId, onBack }: { userId: string; onBack: () => void }) {
  const u = useChatStore((s) => s.users[userId]) as Person | undefined;
  const me = useChatStore((s) => s.me);
  const [busy, setBusy] = useState(false);
  const name = displayName(u) || 'Сотрудник';
  const mine = String(me?.id ?? '') === userId;
  const deptColor = u?.department ? getDepartmentColor(u.department) : undefined;

  const write = async () => {
    setBusy(true);
    const id = mine ? `favorites_${userId}` : await createChat([userId]);
    setBusy(false);
    if (!id) { showToast('Чат не открылся — нет связи с сервером. Попробуйте ещё раз.', 'error'); return; }
    const url = new URL(window.location.href);
    url.searchParams.set('chat', id);
    window.history.replaceState({ ...window.history.state, nxChat: id, nxPanel: undefined }, '', url);
    setPanel(null);
    openChat(id);
  };

  return (
    <aside className="cxp" aria-label={`Профиль: ${name}`}>
      <header className="cxp-head">
        <button type="button" className="nx-icon-btn" onClick={onBack} aria-label="Назад к профилю чата"><ArrowLeft size={18} /></button>
        <h2>Профиль</h2>
        <button type="button" className="nx-icon-btn" onClick={() => setPanel(null)} aria-label="Закрыть панель"><X size={16} /></button>
      </header>
      <div className="cxp-body nx-scroll-y cxf">
        <div className="cxf-photo">
          <span className="cxf-photo-frame">
            {/* Тот же Avatar, что в шапке и списке — одинаковая картинка везде. */}
            <span className="cxf-photo-btn cxf-photo-static">
              <Avatar name={name} seed={userId} src={u?.avatar} person size={128} />
            </span>
          </span>
        </div>

        <div className="cxf-hero">
          <h3>{name}</h3>
          <p data-live={u?.isOnline ? 'true' : undefined}>{lastSeenText(u?.lastSeen, u?.isOnline) || 'Не в сети'}</p>
          {u?.position && <p>{u.position}</p>}
          {u?.department && deptColor && (
            <span className="cxf-dept" style={{ '--dept': deptColor } as CSSProperties}><i />{getDepartmentName(u.department)}</span>
          )}
        </div>

        <div className="cxf-actions">
          <button type="button" className="cxf-action" onClick={() => void write()} disabled={busy} aria-busy={busy || undefined}>
            <span className="cxf-action-icon">{busy ? <Spinner size={18} /> : <SectionIcon name="chats" size={22} />}</span>
            <span>{mine ? 'Избранное' : 'Написать'}</span>
          </button>
          {u?.phone && (
            <a className="cxf-action" href={`tel:${u.phone.replace(/[^\d+]/g, '')}`}>
              <span className="cxf-action-icon"><Phone size={18} /></span><span>Позвонить</span>
            </a>
          )}
        </div>

        {u && (u.email || u.phone || u.telegramUsername || u.workSchedule || u.username) && (
          <dl className="cxf-info">
            {u.email && (<><dt><Mail size={12} aria-hidden="true" /> Почта</dt><dd><MailLink email={u.email} /></dd></>)}
            {u.phone && (<><dt><Phone size={12} aria-hidden="true" /> Телефон</dt><dd><a href={`tel:${u.phone.replace(/[^\d+]/g, '')}`}>{u.phone}</a></dd></>)}
            {u.telegramUsername && (
              <><dt><Send size={12} aria-hidden="true" /> Telegram</dt>
                <dd><a href={`https://t.me/${u.telegramUsername.replace(/^@/, '')}`} target="_blank" rel="noopener noreferrer">@{u.telegramUsername.replace(/^@/, '')}</a></dd></>
            )}
            {u.workSchedule && (<><dt><Clock size={12} aria-hidden="true" /> График</dt><dd>{u.workSchedule}</dd></>)}
            {u.username && (<><dt><AtSign size={12} aria-hidden="true" /> Логин</dt><dd>{u.username}</dd></>)}
          </dl>
        )}
      </div>
    </aside>
  );
}
