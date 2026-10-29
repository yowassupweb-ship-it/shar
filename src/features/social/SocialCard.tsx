import { useState } from 'react';
import { ArrowUpRight, MessagesSquare, Send } from 'lucide-react';
import { useNavigate } from 'react-router';
import { paths } from '@/shared/navigation/routes';
import { Sheet } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { replyToClient, type SocialCardData } from './api';
import { Linkified } from './Linkified';
import { SocialAvatar } from './SocialAvatar';
import './social.css';

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/**
 * Сообщение или комментарий из ВКонтакте/MAX в чате. Клиенту уходит только то, что написано в окне
 * «Ответить клиенту», — обычные сообщения в чате под карточкой остаются внутренним обсуждением.
 * Новое состояние (ответили) приходит всем участникам событием card_updated.
 */
export function SocialCard({ card, time, createdAt }: { card: SocialCardData; time: string; createdAt: string }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const who = card.authorUsername ? `${card.authorName} · @${card.authorUsername}` : card.authorName;
  return (
    <article className="cxm-notice cxs-social" data-platform={card.platform} data-status={card.status} onClick={(e) => e.stopPropagation()}>
      <SocialAvatar platform={card.platform} name={card.authorName} seed={`${card.platform}:${card.authorUsername || card.authorName}`} src={card.authorAvatar} size={40} />
      <div className="cxm-notice-main">
        <div className="cxm-notice-top">
          <span className="cxm-notice-type">{card.platformLabel} · {card.sourceLabel}{card.sourceTitle && card.sourceType !== 'private' && card.sourceType !== 'business' ? ` · ${card.sourceTitle}` : ''}</span>
          <time dateTime={createdAt}>{time}</time>
        </div>
        <div className="cxm-notice-title">{who}</div>
        {card.context && <div className="cxs-social-context">↳ {card.context}</div>}
        {card.text && <div className="cxs-social-text" data-deleted={card.deleted ? 'true' : undefined}><Linkified text={card.text} /></div>}
        {(card.deleted || card.edited) && <div className="cxs-social-flag">{card.deleted ? 'Сообщение удалено' : 'Сообщение изменено'}</div>}
        {card.media.length > 0 && <div className="cxs-social-media">{card.media.join(' · ')}{card.link ? ' — открыть в мессенджере' : ''}</div>}
        {card.answers.length > 0 && (
          <ul className="cxs-social-answers">
            {card.answers.map((a, i) => (
              <li key={i}><b>{a.byName}</b> <time dateTime={a.at}>{fmtTime(a.at)}</time><span>{a.text}</span></li>
            ))}
          </ul>
        )}
        <div className="cxs-social-foot">
          <span className="cxs-social-links">
            {card.dialogId && (
              <button type="button" className="cxs-social-open cxs-social-linkbtn"
                onClick={() => navigate(`${paths.social}?${card.sourceType === 'comments' ? 'tab=comments&' : ''}dialog=${encodeURIComponent(card.dialogId!)}`)}>
                <MessagesSquare size={13} aria-hidden="true" /> Открыть диалог
              </button>
            )}
            {card.link && <a className="cxs-social-open" href={card.link} target="_blank" rel="noopener noreferrer">Открыть в {card.platformLabel}<ArrowUpRight size={13} aria-hidden="true" /></a>}
          </span>
          {card.itemId && card.canReply !== false && (
            <button type="button" className={card.status === 'new' ? 'nx-primary cxs-social-act' : 'nx-ghost cxs-social-act'} onClick={() => setOpen(true)}>
              <Send size={14} aria-hidden="true" /> {card.status === 'new' ? 'Ответить клиенту' : 'Ответить ещё'}
            </button>
          )}
        </div>
      </div>
      {open && card.itemId && <ReplySheet card={card} itemId={card.itemId} onClose={() => setOpen(false)} />}
    </article>
  );
}

export function ReplySheet({ card, itemId, onClose, onSent }: { card: SocialCardData; itemId: string; onClose: () => void; onSent?: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = () => {
    if (!text.trim()) return;
    setBusy(true);
    replyToClient(itemId, text.trim())
      .then(() => { showToast(`Ответ ушёл в ${card.platformLabel}`, 'success'); onSent?.(); onClose(); })
      .catch((e: Error) => { showToast(e.message, 'error'); setBusy(false); });
  };
  const where = card.sourceType === 'comments' ? 'ответом на комментарий' : card.sourceType === 'group' ? 'ответом в беседе' : 'в личные сообщения';
  return (
    <Sheet
      title={`Ответ: ${card.authorName}`}
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button type="button" className="nx-ghost" onClick={onClose}>Отмена</button>
          <button type="button" className="nx-primary" disabled={busy || !text.trim()} onClick={send}>{busy ? 'Отправляю…' : 'Отправить клиенту'}</button>
        </>
      )}
    >
      <div className="cxs-social-reply">
        {card.text && <blockquote>{card.text}</blockquote>}
        <textarea
          className="nx-field"
          rows={5}
          maxLength={4000}
          value={text}
          autoFocus
          placeholder="Текст ответа"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); }}
        />
        <p className="cxs-social-hint">Уйдёт в {card.platformLabel} {where} от имени {card.account || 'компании'}. Ctrl+Enter — отправить.</p>
      </div>
    </Sheet>
  );
}
