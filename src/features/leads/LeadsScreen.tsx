import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { AlertCircle, ArrowUpRight, Check, ChevronLeft, Hand, Inbox, Mail, MessageSquare, Phone, RotateCcw, Settings2 } from 'lucide-react';
import { chatTitle, isGroupChat, useChatStore } from '@/features/chat';
import { links, paths } from '@/shared/navigation/routes';
import { realtime } from '@/shared/realtime/realtime';
import { Sheet } from '@/shared/ui/overlay';
import { SearchField } from '@/shared/ui/SearchField';
import { Spinner } from '@/shared/ui/Spinner';
import { showToast } from '@/shared/ui/Toast';
import {
  changeLead, listLeads, loadLeadSettings, saveLeadSettings, SITE_URLS, STATUS_LABEL,
  type Lead, type LeadSettings, type LeadStatus,
} from './api';
import './leads.css';

const FILTERS: { id: LeadStatus | ''; label: string }[] = [
  { id: 'new', label: 'Новые' }, { id: 'work', label: 'В работе' }, { id: 'done', label: 'Закрытые' }, { id: '', label: 'Все' },
];

const FIELD_LABEL: [keyof Lead['fields'], string][] = [
  ['where', 'Куда'], ['date', 'Желаемая дата'], ['count', 'Размер группы'], ['question', 'Вопрос'], ['contact', 'Как связаться'],
  ['organization', 'Организация'], ['tour', 'Тур (из отзыва)'], ['text', 'Отзыв'], ['comment', 'Комментарий'],
];

const fmt = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Приложение «Заявки»: все заявки с corp и school, фильтр по статусу, поиск, «Беру»/«Готово».
 *  Админ здесь же выбирает, в какой чат уходит карточка заявки каждого сайта. */
export default function LeadsScreen() {
  const navigate = useNavigate();
  const me = useChatStore((s) => s.me);
  const admin = me?.role === 'admin';
  const [status, setStatus] = useState<LeadStatus | ''>('new');
  const [q, setQ] = useState('');
  const [data, setData] = useState<{ leads: Lead[]; counts: Record<LeadStatus, number> } | null>(null);
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    listLeads({ status, q })
      .then((d) => { setData(d); setError(''); })
      .catch((e: Error) => setError(e.message));
  }, [status, q]);

  useEffect(() => { const t = window.setTimeout(load, q ? 250 : 0); return () => window.clearTimeout(t); }, [load, q]);
  // Новая заявка или чужое «Беру» — карточка в чате обновилась; список подтягиваем тем же событием.
  useEffect(() => realtime.subscribe((event) => {
    const e = event as { type?: string; message?: { metadata?: { card?: { kind?: string } } }; card?: { kind?: string } };
    if ((e.type === 'new_message' && e.message?.metadata?.card?.kind === 'lead') || (e.type === 'card_updated' && e.card?.kind === 'lead')) load();
  }), [load]);

  const act = (lead: Lead, change: { take?: boolean; status?: LeadStatus }) => {
    setBusyId(lead.id);
    changeLead(lead.id, change)
      .then(() => load())
      .catch((e: Error) => showToast(e.message, 'error'))
      .finally(() => setBusyId(null));
  };

  return (
    <div className="nx-page nx-scroll-y">
      <div className="nx-page-inner" data-wide="">
        <header className="nx-page-head">
          <button type="button" className="nx-icon-btn nx-page-back" aria-label="Назад в «Ещё»" onClick={() => navigate(paths.more)}>
            <ChevronLeft size={20} />
          </button>
          <h1>Заявки</h1>
          {admin && (
            <button type="button" className="nx-ghost nx-page-tools" onClick={() => setSettingsOpen(true)}>
              <Settings2 size={14} aria-hidden="true" /> Куда приходят
            </button>
          )}
        </header>

        <div className="nld-bar">
          <nav className="nx-segment" aria-label="Статус">
            {FILTERS.map((f) => (
              <button key={f.id || 'all'} type="button" aria-pressed={status === f.id} onClick={() => setStatus(f.id)}>
                {f.label}{f.id && data ? <span className="nld-count">{data.counts[f.id]}</span> : null}
              </button>
            ))}
          </nav>
          <SearchField value={q} onChange={setQ} placeholder="Имя, телефон, тур" label="Поиск по заявкам" />
        </div>

        {error ? (
          <div className="nx-state" data-tone="danger" role="alert"><AlertCircle size={24} aria-hidden="true" /><p>{error}</p></div>
        ) : !data ? (
          <div className="nx-state"><Spinner size={22} label="Загружаю заявки" /></div>
        ) : !data.leads.length ? (
          <div className="nx-state"><Inbox size={26} aria-hidden="true" /><p>{q ? 'Ничего не нашлось.' : status === 'new' ? 'Новых заявок нет.' : 'Заявок нет.'}</p></div>
        ) : (
          <div className="nld-list">
            {data.leads.map((l) => {
              const who = l.fields.name || l.fields.contact || l.fields.phone || l.kindLabel;
              const tel = l.fields.phone ? `tel:${l.fields.phone.replace(/[^\d+]/g, '')}` : '';
              return (
                <article key={l.id} className="nld-item" data-status={l.status}>
                  <div className="nld-head">
                    <b>{who}</b>
                    <span className="nld-meta">{l.kindLabel} · {l.siteLabel}</span>
                  </div>
                  <div className="nld-side">
                    <time dateTime={l.createdAt}>{fmt(l.createdAt)}</time>
                    <span className="cxl-lead-status" data-status={l.status}>{STATUS_LABEL[l.status]}{l.assigneeName && l.status !== 'new' ? ` · ${l.assigneeName}` : ''}</span>
                  </div>
                  <div className="nld-body">
                    {(l.fields.phone || l.fields.email) && (
                      <div className="cxl-lead-contacts">
                        {l.fields.phone && <a href={tel}><Phone size={13} aria-hidden="true" />{l.fields.phone}</a>}
                        {l.fields.email && <a href={`mailto:${l.fields.email}`}><Mail size={13} aria-hidden="true" />{l.fields.email}</a>}
                      </div>
                    )}
                    <dl className="cxl-lead-rows">
                      {FIELD_LABEL.filter(([k]) => l.fields[k]).map(([k, label]) => <div key={k}><dt>{label}</dt><dd>{l.fields[k]}</dd></div>)}
                      {l.tours && <div><dt>Туры из избранного</dt><dd>{l.tours}</dd></div>}
                    </dl>
                    <div className="cxl-lead-links">
                      {l.tour && <a href={`${SITE_URLS[l.site]}/tour/${l.tour.id}`} target="_blank" rel="noopener noreferrer">{l.tour.title} (№ {l.tour.id})<ArrowUpRight size={13} aria-hidden="true" /></a>}
                      {l.page?.startsWith('/') && <a href={SITE_URLS[l.site] + l.page} target="_blank" rel="noopener noreferrer">{l.pageName || 'Страница заявки'}<ArrowUpRight size={13} aria-hidden="true" /></a>}
                    </div>
                    <div className="cxl-lead-foot">
                      {l.chatId && l.messageId ? (
                        <button type="button" className="nld-chatlink" onClick={() => navigate(links.chat(l.chatId!))}><MessageSquare size={13} aria-hidden="true" /> Обсуждение в чате</button>
                      ) : <span />}
                      {l.status === 'new' && <button type="button" className="nx-primary cxl-lead-act" disabled={busyId === l.id} onClick={() => act(l, { take: true })}><Hand size={14} aria-hidden="true" /> Беру</button>}
                      {l.status === 'work' && <button type="button" className="nx-ghost cxl-lead-act" disabled={busyId === l.id} onClick={() => act(l, { status: 'done' })}><Check size={14} aria-hidden="true" /> Готово</button>}
                      {l.status === 'done' && <button type="button" className="nx-ghost cxl-lead-act" disabled={busyId === l.id} onClick={() => act(l, { status: 'work' })}><RotateCcw size={14} aria-hidden="true" /> Вернуть</button>}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
      {settingsOpen && <RoutesSheet onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

/** Куда приходят заявки: чат для каждого сайта (только админ). */
function RoutesSheet({ onClose }: { onClose: () => void }) {
  const chats = useChatStore((s) => s.chats);
  const users = useChatStore((s) => s.users);
  const me = useChatStore((s) => s.me);
  const [settings, setSettings] = useState<LeadSettings | null>(null);
  const [routes, setRoutes] = useState<LeadSettings['routes']>({ corp: null, school: null });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadLeadSettings().then((s) => { setSettings(s); setRoutes(s.routes); }).catch((e: Error) => showToast(e.message, 'error'));
  }, []);

  const options = useMemo(() => Object.values(chats)
    .filter((c) => isGroupChat(c))
    .map((c) => ({ id: String(c.id), title: chatTitle(c, me, users) }))
    .sort((a, b) => a.title.localeCompare(b.title, 'ru')), [chats, me, users]);

  const save = () => {
    setBusy(true);
    saveLeadSettings(routes)
      .then(() => { showToast('Сохранено', 'success'); onClose(); })
      .catch((e: Error) => { showToast(e.message, 'error'); setBusy(false); });
  };

  return (
    <Sheet
      title="Куда приходят заявки"
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button type="button" className="nx-ghost" onClick={onClose}>Отмена</button>
          <button type="button" className="nx-primary" disabled={busy || !settings} onClick={save}>{busy ? 'Сохраняю…' : 'Сохранить'}</button>
        </>
      )}
    >
      {!settings ? <Spinner size={20} label="Загружаю" /> : (
        <div className="nld-settings">
          {(Object.keys(settings.sites) as (keyof LeadSettings['routes'])[]).map((site) => {
            const current = routes[site];
            const missing = current && !options.some((o) => o.id === current);
            return (
              <label key={site} className="nx-label">
                {settings.sites[site]}
                <select className="nx-field" value={current || ''} onChange={(e) => setRoutes((r) => ({ ...r, [site]: e.target.value || null }))}>
                  <option value="">Не отправлять в чат</option>
                  {missing && <option value={current!}>{settings.chats[site]?.title || 'Чат, в котором вас нет'}</option>}
                  {options.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
                </select>
              </label>
            );
          })}
          <p className="nld-hint">Карточка заявки появится в выбранном групповом чате, взять её в работу может любой его участник. Письмо менеджерам сайт по-прежнему отправляет.</p>
        </div>
      )}
    </Sheet>
  );
}
