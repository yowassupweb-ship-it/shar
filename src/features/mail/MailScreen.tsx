import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import {
  AlertCircle, Archive, ArrowLeft, Download, File as FileIcon, FileEdit, Folder, Forward, Inbox, Mail, MailOpen, Paperclip,
  PenSquare, Reply, ReplyAll, RotateCw, Send, ShieldAlert, Star, Trash2, Settings2,
} from 'lucide-react';
import { EmailHtmlView } from '@/features/mail/html/EmailHtmlView';
import { showToast } from '@/shared/ui/Toast';
import { useTheme } from '@/shared/theme/ThemeContext';
import { useChatStore } from '@/features/chat';
import { useShellOptions } from '@/shared/shell/ShellContext';
import { Avatar } from '@/shared/ui/Avatar';
import { Menu, MenuItem, type MenuAnchor } from '@/shared/ui/overlay';
import { SearchField } from '@/shared/ui/SearchField';
import {
  loadAccounts, loadBoxes, moveMessage, onNewMail, openFolder, openMessage, searchMail, selectAccount, setFlags, syncFolder,
  useMail, type Box, type MailFull, type MailRow,
} from './api';
import AccountSheet from './AccountSheet';
import Compose, { type ComposeMode } from './Compose';
import { fileSize, fmtFullDate, fmtListDate } from './format';
import { Spinner } from '@/shared/ui/Spinner';
import { downloadOnClick } from '@/shared/platform/download';

/**
 * Раздел «Почта» нового Шара — как Mail.app: слева ящики, в середине список,
 * справа письмо. На телефоне — одна панель за раз.
 *
 * Клавиши: ↑/↓ — по списку, Delete — в корзину, R — ответить, F — переслать,
 * N — новое письмо, U — прочитано/непрочитано.
 */

const NARROW = '(max-width: 760px)';
const subscribeMedia = (cb: () => void) => {
  const mq = window.matchMedia(NARROW);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
};
const subscribeNoop = () => () => {};

const BOX_ICON: Record<Box['role'], typeof Inbox> = {
  inbox: Inbox, drafts: FileEdit, sent: Send, junk: ShieldAlert, trash: Trash2, archive: Archive, folder: Folder,
};

type Face = { seed: string; src?: string; name?: string };

/** Лицо по адресу: сотрудник Шара выглядит как в чатах — его фото или тот же
 *  рисованный аватар (сид — id сотрудника), остальные — рисованный по адресу. */
function useFaceByEmail(): (email?: string, fallbackName?: string) => Face {
  const users = useChatStore((s) => s.users);
  const byEmail = useMemo(() => {
    const map = new Map<string, Face>();
    for (const u of Object.values(users)) {
      if (u.email) map.set(u.email.toLowerCase(), { seed: String(u.id), src: u.avatar || undefined, name: u.name || undefined });
    }
    return map;
  }, [users]);
  return useCallback((email?: string, fallbackName?: string) => (
    (email && byEmail.get(email.toLowerCase())) || { seed: email || fallbackName || '?', name: fallbackName }
  ), [byEmail]);
}

const Row = memo(function Row({ m, active, sentView, faceOf, onOpen, onMenu }: {
  m: MailRow; active: boolean; sentView: boolean; faceOf: (email?: string, name?: string) => Face;
  onOpen: (id: string) => void; onMenu: (m: MailRow, at: MenuAnchor) => void;
}) {
  const who = sentView
    ? (m.toAddrs || []).map((a) => a.name || a.addr).join(', ') || 'Без получателя'
    : m.fromName || m.fromAddr || 'Без отправителя';
  const addr = sentView ? m.toAddrs?.[0] : { addr: m.fromAddr, name: m.fromName };
  const face = faceOf(addr?.addr, addr?.name);
  return (
    <button
      type="button"
      className="nml-row"
      data-mail-id={m.id}
      aria-current={active ? 'true' : undefined}
      data-unread={!m.isRead ? 'true' : undefined}
      onClick={() => onOpen(m.id)}
      onContextMenu={(e) => { e.preventDefault(); onMenu(m, { x: e.clientX, y: e.clientY }); }}
    >
      <span className="nml-face">
        <Avatar name={face.name || addr?.name || addr?.addr || '?'} seed={face.seed} src={face.src} person size={40} />
        {!m.isRead && <span className="nml-dot" aria-label="Не прочитано" />}
      </span>
      <span className="nml-text">
        <span className="nml-top">
          <span className="nml-who">{sentView && <span className="nml-to">Кому: </span>}{who}</span>
          <span className="nml-date">{fmtListDate(m.date)}</span>
        </span>
        <span className="nml-subject">
          {m.isStarred && <Star size={11} className="nml-star" aria-label="Со звездой" />}
          {m.attachments?.length > 0 && <Paperclip size={11} className="nml-clip" aria-label="Есть вложения" />}
          {m.subject || 'Без темы'}
        </span>
        {m.snippet && <span className="nml-snippet">{m.snippet}</span>}
      </span>
    </button>
  );
});

function Reader({ msg, onCompose, onBack, dark, face }: {
  msg: MailFull; onCompose: (m: ComposeMode) => void; onBack?: () => void; dark: boolean; face: Face;
}) {
  const images = (msg.attachments || []).filter((a) => /^image\//.test(a.contentType || a.content_type || ''));
  const files = (msg.attachments || []).filter((a) => !/^image\//.test(a.contentType || a.content_type || ''));
  const act = (p: Promise<unknown>) => p.catch(() => showToast('Не получилось — нет связи с почтовым сервером.', 'error'));
  return (
    <article className="nmr-doc" aria-label={msg.subject || 'Письмо'}>
      <div className="nmr-bar" role="toolbar" aria-label="Действия с письмом">
        {onBack && <button type="button" className="nx-icon-btn" onClick={onBack} aria-label="Назад к списку"><ArrowLeft size={17} /></button>}
        <button type="button" className="nx-icon-btn" title="Ответить (R)" aria-label="Ответить" onClick={() => onCompose({ kind: 'reply', msg })}><Reply size={17} /></button>
        <button type="button" className="nx-icon-btn" title="Ответить всем" aria-label="Ответить всем" onClick={() => onCompose({ kind: 'reply', msg, all: true })}><ReplyAll size={17} /></button>
        <button type="button" className="nx-icon-btn" title="Переслать (F)" aria-label="Переслать" onClick={() => onCompose({ kind: 'forward', msg })}><Forward size={17} /></button>
        <span className="nmr-bar-gap" />
        <button type="button" className="nx-icon-btn" title="Со звездой" aria-label="Со звездой" aria-pressed={msg.isStarred}
          onClick={() => act(setFlags(msg.id, { isStarred: !msg.isStarred }))}><Star size={17} fill={msg.isStarred ? 'currentColor' : 'none'} /></button>
        <button type="button" className="nx-icon-btn" title="Отметить непрочитанным (U)" aria-label="Непрочитанное"
          onClick={() => act(setFlags(msg.id, { isRead: false }))}><Mail size={17} /></button>
        <button type="button" className="nx-icon-btn" title="В архив" aria-label="В архив" onClick={() => act(moveMessage(msg.id, 'archive'))}><Archive size={17} /></button>
        <button type="button" className="nx-icon-btn" title="В корзину (Delete)" aria-label="В корзину" onClick={() => act(moveMessage(msg.id, 'trash'))}><Trash2 size={17} /></button>
      </div>
      <div className="nmr-scroll nx-scroll-y">
        <h1 className="nmr-subject">{msg.subject || 'Без темы'}</h1>
        <header className="nmr-head">
          <Avatar name={face.name || msg.fromName || msg.fromAddr || '?'} seed={face.seed} src={face.src} size={40} person />
          <div className="nmr-who">
            <span className="nmr-from"><b>{msg.fromName || msg.fromAddr}</b>{msg.fromName && <span>{msg.fromAddr}</span>}</span>
            <span className="nmr-to">Кому: {(msg.toAddrs || []).map((a) => a.name || a.addr).join(', ') || '—'}</span>
            {(msg.ccAddrs || []).length > 0 && <span className="nmr-to">Копия: {msg.ccAddrs.map((a) => a.name || a.addr).join(', ')}</span>}
          </div>
          <time className="nmr-date">{fmtFullDate(msg.date)}</time>
        </header>

        {(images.length > 0 || files.length > 0) && (
          <section className="nmr-atts" aria-label="Вложения">
            {images.map((a) => (
              <a key={a.url} className="nmr-att-img" href={a.url} download={a.filename} onClick={downloadOnClick(a.url || '', a.filename)} title={`${a.filename} · ${fileSize(a.size)}`}>
                <img src={a.url} alt={a.filename} loading="lazy" />
              </a>
            ))}
            {files.map((a) => (
              <a key={a.url} className="nmr-att" href={a.url} download={a.filename} onClick={downloadOnClick(a.url || '', a.filename)} title="Скачать">
                <span className="nmr-att-ico"><FileIcon size={18} aria-hidden="true" /></span>
                <span className="nmr-att-text"><b>{a.filename}</b><span>{fileSize(a.size)}</span></span>
                <Download size={15} aria-hidden="true" />
              </a>
            ))}
          </section>
        )}

        <div className="nmr-body">
          {msg.bodyHtml ? <EmailHtmlView html={msg.bodyHtml} isDark={dark} cacheKey={msg.id} /> : <pre className="nmr-text">{msg.bodyText}</pre>}
        </div>
      </div>
    </article>
  );
}

function readMailLink(): { id: string; account: string | null; folder: string | null } | null {
  if (typeof window === 'undefined') return null;
  const p = new URLSearchParams(window.location.search);
  const id = p.get('message');
  return id ? { id, account: p.get('account'), folder: p.get('folder') } : null;
}

export default function MailScreen() {
  const mounted = useSyncExternalStore(subscribeNoop, () => true, () => false);
  const narrow = useSyncExternalStore(subscribeMedia, () => window.matchMedia(NARROW).matches, () => false);
  const { theme } = useTheme();
  const accounts = useMail((s) => s.accounts);
  const accountsPhase = useMail((s) => s.accountsPhase);
  const accountId = useMail((s) => s.accountId);
  const boxes = useMail((s) => s.boxes);
  const boxesError = useMail((s) => s.boxesError);
  const folder = useMail((s) => s.folder);
  const list = useMail((s) => s.lists[s.folder]);
  const phase = useMail((s) => s.listPhase[s.folder]);
  const syncing = useMail((s) => Boolean(s.syncing[s.folder]));
  const found = useMail((s) => s.found);
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  /** Письмо из ссылки (поиск): его может не быть в загруженной части папки, и это не «письмо ушло». */
  const [linkedId, setLinkedId] = useState<string | null>(null);
  const mailLink = useRef(readMailLink());
  const [msg, setMsg] = useState<MailFull | null>(null);
  const [msgPhase, setMsgPhase] = useState<'idle' | 'loading' | 'error'>('idle');
  const [compose, setCompose] = useState<ComposeMode | null>(null);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [menu, setMenu] = useState<{ m: MailRow; anchor: MenuAnchor } | null>(null);
  const [pane, setPane] = useState<'boxes' | 'list' | 'reader'>('list');
  const listRef = useRef<HTMLDivElement>(null);
  const faceOf = useFaceByEmail();
  const account = accounts.find((a) => String(a.id) === accountId) || null;

  useEffect(() => { void loadAccounts(); }, []);
  useEffect(() => {
    if (!accountId) return;
    void loadBoxes();
    openFolder('INBOX');
  }, [accountId]);

  // Новое письмо — строка появляется сама; здесь только тихое уведомление,
  // если человек смотрит не во «Входящие».
  useEffect(() => onNewMail((e) => {
    const first = (e.messages as { fromName?: string; subject?: string }[] | undefined)?.[0];
    if (useMail.getState().folder !== 'INBOX' && first) showToast(`Новое письмо: ${first.fromName || ''} — ${first.subject || 'без темы'}`, 'info');
  }), []);

  useEffect(() => { const t = window.setTimeout(() => void searchMail(query), 250); return () => window.clearTimeout(t); }, [query]);

  const rows = useMemo(() => found ?? list ?? [], [found, list]);
  const box = boxes.find((b) => b.folder === folder);
  const sentView = box?.role === 'sent' || box?.role === 'drafts';

  const open = useCallback(async (id: string) => {
    setOpenId(id);
    setPane('reader');
    const cached = useMail.getState().full[id];
    if (cached) { setMsg(cached); setMsgPhase('idle'); void openMessage(id); return; }
    setMsg(null);
    setMsgPhase('loading');
    const full = await openMessage(id);
    if (full) { setMsg(full); setMsgPhase('idle'); } else setMsgPhase('error');
  }, []);

  // Письмо из ссылки: переключаем ящик и папку, потом открываем само письмо — один раз.
  useEffect(() => {
    const link = mailLink.current;
    if (!link || !accountId) return;
    if (link.account && link.account !== accountId && accounts.some((a) => String(a.id) === link.account)) { selectAccount(link.account); return; }
    mailLink.current = null;
    setLinkedId(link.id);
    if (link.folder && link.folder !== 'INBOX') openFolder(link.folder);
    void open(link.id);
  }, [accountId, accounts, open]);

  // Письмо обновилось в сторе (звезда, прочтение) — показываем свежее.
  const fullFromStore = useMail((s) => (openId ? s.full[openId] : undefined));
  // Письмо ушло из папки (перенесли, удалили) — больше его не показываем.
  const gone = Boolean(openId && openId !== linkedId && list && !found && phase === 'ready' && !list.some((r) => r.id === openId));
  const shown = gone ? null : fullFromStore || msg;

  const pickFolder = (f: string) => {
    openFolder(f);
    setQuery('');
    setOpenId(null);
    setMsg(null);
    setPane('list');
  };

  useShellOptions({ navHidden: narrow && pane === 'reader', onReselect: () => pickFolder('INBOX') });

  // ── Клавиши ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (compose || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector('.nx-scrim, .nx-menu')) return;
      const idx = rows.findIndex((r) => r.id === openId);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = rows[Math.max(0, Math.min(rows.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (next) { void open(next.id); listRef.current?.querySelector<HTMLElement>(`[data-mail-id="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: 'nearest' }); }
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && openId) {
        e.preventDefault();
        const next = rows[idx + 1] || rows[idx - 1];
        moveMessage(openId, 'trash').catch(() => showToast('Не удалилось — нет связи с почтовым сервером.', 'error'));
        if (next) void open(next.id);
      } else if (e.code === 'KeyR' && shown) setCompose({ kind: 'reply', msg: shown });
      else if (e.code === 'KeyF' && shown) setCompose({ kind: 'forward', msg: shown });
      else if (e.code === 'KeyN') { e.preventDefault(); setCompose({ kind: 'new' }); }
      else if (e.code === 'KeyU' && shown) void setFlags(shown.id, { isRead: !shown.isRead }).catch(() => {});
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [compose, rows, openId, shown, open]);

  const totalUnread = useMemo(() => boxes.find((b) => b.role === 'inbox')?.unread || 0, [boxes]);

  if (!mounted) return null;

  // ── Нет ящика ───────────────────────────────────────────────────────────
  if (accountsPhase === 'ready' && !accounts.length) {
    return (
      <div className="nx-state nml-empty-state">
        <Mail size={32} aria-hidden="true" />
        <h2>Почтовый ящик не подключён</h2>
        <p>Подключите рабочую почту — письма появятся здесь, а новые приходят сразу.</p>
        <button type="button" className="nx-primary" onClick={() => setAccountsOpen(true)}>Подключить ящик</button>
        {accountsOpen && <AccountSheet onClose={() => setAccountsOpen(false)} startAdding />}
      </div>
    );
  }

  const sidebar = (
    <aside className="nmb" aria-label="Ящики">
      <div className="nmb-head">
        <h1>Почта</h1>
        <button type="button" className="nx-primary nmb-compose" onClick={() => setCompose({ kind: 'new' })} title="Новое письмо (N)">
          <PenSquare size={15} aria-hidden="true" /> Написать
        </button>
      </div>
      {accounts.length > 1 ? (
        <div className="nx-segment nmb-accounts" role="group" aria-label="Ящик">
          {accounts.map((a) => (
            <button key={a.id} type="button" aria-pressed={String(a.id) === accountId} onClick={() => selectAccount(String(a.id))} title={a.email}>{a.email.split('@')[0]}</button>
          ))}
        </div>
      ) : account && <p className="nmb-account" title={account.email}>{account.email}</p>}
      <button type="button" className="nx-ghost nmb-manage" onClick={() => setAccountsOpen(true)}><Settings2 size={14} aria-hidden="true" /> Ящики</button>
      <nav className="nmb-list">
        {(boxes.length ? boxes : [{ role: 'inbox', folder: 'INBOX', title: 'Входящие', unread: 0 } as Box]).map((b) => {
          const Icon = BOX_ICON[b.role] || Inbox;
          return (
            <button key={b.folder} type="button" className="nmb-item" data-custom={b.role === 'folder' ? 'true' : undefined}
              style={b.depth ? { '--depth': b.depth } as CSSProperties : undefined}
              aria-current={b.folder === folder ? 'true' : undefined} onClick={() => pickFolder(b.folder)} title={b.folder}>
              <Icon size={16} aria-hidden="true" />
              <span>{b.title}</span>
              {b.unread > 0 && b.role !== 'sent' && b.role !== 'trash' && <span className="nmb-count">{b.unread}</span>}
            </button>
          );
        })}
      </nav>
      {boxesError && (
        <div className="nmb-error" role="alert">
          <AlertCircle size={14} aria-hidden="true" />
          {boxesError === 'password' ? (
            <>
              <span>Шар не может войти в ящик: пароль нужно ввести заново.</span>
              <button type="button" className="nx-ghost" onClick={() => setAccountsOpen(true)}>Ввести пароль</button>
            </>
          ) : (
            <>
              <span>Не получил список папок с почтового сервера.</span>
              <button type="button" className="nx-ghost" onClick={() => void loadBoxes(true)}>Повторить</button>
            </>
          )}
        </div>
      )}
    </aside>
  );

  const listPane = (
    <section className="nml" aria-label={box?.title || 'Письма'}>
      <div className="nml-head">
        <div className="nml-title">
          {narrow && <button type="button" className="nx-icon-btn" onClick={() => setPane('boxes')} aria-label="Ящики"><Inbox size={17} /></button>}
          <h2>{box?.title || 'Входящие'}</h2>
          {box?.role === 'inbox' && totalUnread > 0 && <span className="nml-unread">{totalUnread} непрочитанных</span>}
          <button type="button" className="nx-icon-btn nml-refresh" onClick={() => void syncFolder(folder)} aria-label="Проверить почту" title="Проверить почту" data-busy={syncing ? 'true' : undefined}>
            <RotateCw size={15} />
          </button>
          {narrow && <button type="button" className="nx-primary-round" onClick={() => setCompose({ kind: 'new' })} aria-label="Новое письмо"><PenSquare size={16} /></button>}
        </div>
        <SearchField value={query} onChange={setQuery} placeholder="Поиск по письмам" label="Поиск по письмам" />
      </div>
      <div ref={listRef} className="nml-list nx-scroll-y">
        {phase === 'loading' && !rows.length ? (
          Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="nx-skel-row nml-skel"><span className="nx-skel-lines">
              <span className="nx-skel nx-skel-line" style={{ '--w': `${40 + ((i * 17) % 40)}%` } as CSSProperties} />
              <span className="nx-skel nx-skel-line" style={{ '--w': `${60 + ((i * 11) % 30)}%` } as CSSProperties} />
            </span></div>
          ))
        ) : phase === 'error' && !rows.length ? (
          <div className="nx-state" data-tone="danger" role="alert">
            <AlertCircle size={24} aria-hidden="true" />
            <p>Не загрузил письма.</p>
            <button type="button" className="nx-ghost" onClick={() => void syncFolder(folder)}><RotateCw size={14} aria-hidden="true" /> Повторить</button>
          </div>
        ) : !rows.length ? (
          <div className="nx-state"><MailOpen size={26} aria-hidden="true" /><p>{query ? 'Ничего не нашлось.' : 'Писем нет.'}</p></div>
        ) : (
          rows.map((m) => <Row key={m.id} m={m} active={m.id === openId} sentView={sentView} faceOf={faceOf} onOpen={(id) => void open(id)} onMenu={(r, anchor) => setMenu({ m: r, anchor })} />)
        )}
      </div>
    </section>
  );

  const readerPane = (
    <section className="nmr" aria-label="Письмо">
      {shown ? (
        <Reader msg={shown} dark={theme === 'dark'} face={faceOf(shown.fromAddr, shown.fromName)} onCompose={setCompose} onBack={narrow ? () => setPane('list') : undefined} />
      ) : msgPhase === 'loading' ? (
        <div className="nx-state"><Spinner size={22} label="Открываю письмо" /></div>
      ) : msgPhase === 'error' ? (
        <div className="nx-state" data-tone="danger"><AlertCircle size={24} aria-hidden="true" /><p>Письмо не открылось.</p></div>
      ) : (
        <div className="nx-state">
          <Mail size={40} aria-hidden="true" />
          <h2>Выберите письмо</h2>
          <p>↑/↓ — по списку, R — ответить, N — новое письмо.</p>
          {narrow && <button type="button" className="nx-ghost" onClick={() => setPane('list')}><ArrowLeft size={14} aria-hidden="true" /> К списку</button>}
        </div>
      )}
    </section>
  );

  return (
    <div className="nmail" data-narrow={narrow ? 'true' : undefined} data-pane={pane}>
      {(!narrow || pane === 'boxes') && sidebar}
      {(!narrow || pane === 'list') && listPane}
      {(!narrow || pane === 'reader') && readerPane}

      {menu && (() => {
        const m = menu.m;
        const close = () => setMenu(null);
        const act = (p: Promise<unknown>) => p.catch(() => showToast('Не получилось — нет связи с почтовым сервером.', 'error'));
        const withFull = async (fn: (f: MailFull) => void) => { const f = await openMessage(m.id); if (f) fn(f); };
        return (
          <Menu anchor={menu.anchor} label={m.subject || 'Письмо'} onClose={close}>
            <MenuItem icon={<Reply size={16} />} onSelect={() => { close(); void withFull((f) => setCompose({ kind: 'reply', msg: f })); }}>Ответить</MenuItem>
            <MenuItem icon={<Forward size={16} />} onSelect={() => { close(); void withFull((f) => setCompose({ kind: 'forward', msg: f })); }}>Переслать</MenuItem>
            <div className="nx-menu-sep" />
            <MenuItem icon={m.isRead ? <Mail size={16} /> : <MailOpen size={16} />} onSelect={() => { close(); act(setFlags(m.id, { isRead: !m.isRead })); }}>
              {m.isRead ? 'Непрочитанное' : 'Прочитанное'}
            </MenuItem>
            <MenuItem icon={<Star size={16} />} onSelect={() => { close(); act(setFlags(m.id, { isStarred: !m.isStarred })); }}>{m.isStarred ? 'Убрать звезду' : 'Со звездой'}</MenuItem>
            <div className="nx-menu-sep" />
            {box?.role !== 'archive' && <MenuItem icon={<Archive size={16} />} onSelect={() => { close(); act(moveMessage(m.id, 'archive')); }}>В архив</MenuItem>}
            {box?.role !== 'junk' && box?.role !== 'sent' && <MenuItem icon={<ShieldAlert size={16} />} onSelect={() => { close(); act(moveMessage(m.id, 'junk')); }}>Это спам</MenuItem>}
            {box?.role === 'junk' && <MenuItem icon={<Inbox size={16} />} onSelect={() => { close(); act(moveMessage(m.id, 'inbox')); }}>Не спам</MenuItem>}
            <MenuItem icon={<Trash2 size={16} />} tone="danger" onSelect={() => { close(); act(moveMessage(m.id, 'trash')); }}>
              {box?.role === 'trash' ? 'Удалить навсегда' : 'В корзину'}
            </MenuItem>
          </Menu>
        );
      })()}

      {accountsOpen && <AccountSheet onClose={() => setAccountsOpen(false)} />}
      {compose && account && (
        <Compose key={JSON.stringify(compose.kind) + (compose.kind !== 'new' ? compose.msg.id : '')} mode={compose} me={account.email} signature={account.signature} onClose={() => setCompose(null)} />
      )}
    </div>
  );
}
