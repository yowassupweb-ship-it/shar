import { useState } from 'react';
import { ArrowUpRight, Check, Globe, Hand, Mail, Phone, RotateCcw } from 'lucide-react';
import { showToast } from '@/shared/ui/Toast';
import { changeLead, STATUS_LABEL, type LeadCardData, type LeadStatus } from './api';
import './leads.css';
import { MailLink } from '@/features/mail';

/**
 * Заявка с сайта в чате. Вид — как у карточек уведомлений (значок вида, тип и время, заголовок), плюс
 * то, что нужно менеджеру сразу: телефон и почта нажатием, поля формы, ссылки на тур и страницу, кто
 * взял заявку. Действие одно — по состоянию: «Беру», «Готово», «Вернуть». Новое состояние приходит
 * всем участникам событием card_updated, здесь — только ожидание ответа.
 */
export function LeadCard({ card, time, createdAt }: { card: LeadCardData; time: string; createdAt: string }) {
  const [busy, setBusy] = useState(false);
  const act = (change: { take?: boolean; status?: LeadStatus }) => {
    setBusy(true);
    changeLead(card.leadId, change)
      .catch((e: Error) => showToast(e.message || 'Не получилось изменить заявку', 'error'))
      .finally(() => setBusy(false));
  };
  const tel = card.phone ? `tel:${card.phone.replace(/[^\d+]/g, '')}` : '';
  return (
    <article className="cxm-notice cxl-lead" data-kind="lead" data-status={card.status} onClick={(e) => e.stopPropagation()}>
      <span className="cxm-notice-icon" aria-hidden="true"><Globe size={18} /></span>
      <div className="cxm-notice-main">
        <div className="cxm-notice-top">
          <span className="cxm-notice-type">{card.type} · {card.site}</span>
          <time dateTime={createdAt}>{time}</time>
        </div>
        <div className="cxm-notice-title">{card.title}</div>
        {(card.phone || card.email) && (
          <div className="cxl-lead-contacts">
            {card.phone && <a href={tel}><Phone size={13} aria-hidden="true" />{card.phone}</a>}
            {card.email && <MailLink email={card.email}><Mail size={13} aria-hidden="true" />{card.email}</MailLink>}
          </div>
        )}
        {card.rows.length > 0 && (
          <dl className="cxl-lead-rows">
            {card.rows.map(([k, v]) => (
              <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
            ))}
          </dl>
        )}
        {card.links.length > 0 && (
          <div className="cxl-lead-links">
            {card.links.map((l) => (
              <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer">{l.label}<ArrowUpRight size={13} aria-hidden="true" /></a>
            ))}
          </div>
        )}
        <div className="cxl-lead-foot">
          <span className="cxl-lead-status" data-status={card.status}>
            {STATUS_LABEL[card.status]}{card.assigneeName && card.status !== 'new' ? ` · ${card.assigneeName}` : ''}
          </span>
          {card.status === 'new' && (
            <button type="button" className="nx-primary cxl-lead-act" disabled={busy} onClick={() => act({ take: true })}><Hand size={14} aria-hidden="true" /> Беру</button>
          )}
          {card.status === 'work' && (
            <button type="button" className="nx-ghost cxl-lead-act" disabled={busy} onClick={() => act({ status: 'done' })}><Check size={14} aria-hidden="true" /> Готово</button>
          )}
          {card.status === 'done' && (
            <button type="button" className="nx-ghost cxl-lead-act" disabled={busy} onClick={() => act({ status: 'work' })}><RotateCcw size={14} aria-hidden="true" /> Вернуть</button>
          )}
        </div>
      </div>
    </article>
  );
}
