import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { File as FileIcon, Paperclip, Send, X } from 'lucide-react';
import { showToast } from '@/shared/ui/Toast';
import { EmailHtmlView } from '@/features/mail/html/EmailHtmlView';
import { askConfirm } from '@/shared/ui/overlay';
import { recipients, sendMail, type Addr, type MailFull, type Outgoing } from './api';
import { fileSize, fmtFullDate } from './format';
import { Spinner } from '@/shared/ui/Spinner';

/**
 * Новое письмо, ответ, пересылка. Окно, а не лист: письму нужно место.
 *
 * Файлы загружаются сразу, как только их добавили (кнопкой, перетаскиванием,
 * вставкой) — с полосой прогресса; к моменту «Отправить» они уже на сервере.
 * Пересылка берёт вложения исходного письма из хранилища почты, без повторной
 * загрузки. Ctrl/⌘+Enter — отправить, Esc — закрыть (с вопросом, если есть текст).
 */

export type ComposeMode =
  | { kind: 'new'; to?: string[]; subject?: string; body?: string }
  | { kind: 'reply'; msg: MailFull; all?: boolean }
  | { kind: 'forward'; msg: MailFull };

interface Att { id: string; filename: string; size: number; mimeType?: string; url?: string; progress: number; error?: boolean }

const MAX_TOTAL = 25 * 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const toHtml = (text: string) => esc(text).replace(/\n/g, '<br>');

/** Подпись бывает HTML (таблица с логотипом) или просто текст. */
const isHtml = (s: string) => /<\/?[a-z][\s\S]*>/i.test(s);
function htmlToText(html: string): string {
  if (typeof document === 'undefined') return html.replace(/<[^>]+>/g, ' ');
  const div = document.createElement('div');
  div.innerHTML = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n');
  return (div.textContent || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

function initial(mode: ComposeMode, me: string) {
  // Подпись — не в поле текста (её HTML был бы кашей из тегов), см. ncm-sig.
  const sig = '';
  if (mode.kind === 'new') return { to: mode.to ?? ([] as string[]), cc: [] as string[], subject: mode.subject ?? '', body: mode.body ?? sig, quote: '' };
  const m = mode.msg;
  const header = `${fmtFullDate(m.date)}, ${m.fromName || m.fromAddr} <${m.fromAddr}>`;
  const original = (m.bodyText || '').trim();
  if (mode.kind === 'forward') {
    return {
      to: [], cc: [], subject: /^fwd?:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`, body: sig,
      quote: `---------- Пересланное письмо ----------\nОт: ${m.fromName || ''} <${m.fromAddr}>\nДата: ${fmtFullDate(m.date)}\nТема: ${m.subject}\n\n${original}`,
    };
  }
  const others = (list: Addr[]) => list.map((a) => a.addr).filter((a) => a && a.toLowerCase() !== me.toLowerCase());
  return {
    to: [m.fromAddr],
    cc: mode.all ? [...others(m.toAddrs || []), ...others(m.ccAddrs || [])].filter((a) => a !== m.fromAddr) : [],
    subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
    body: sig,
    quote: `${header} пишет:\n${original.split('\n').map((l) => `> ${l}`).join('\n')}`,
  };
}

function Recipients({ label, value, onChange, autoFocus }: { label: string; value: string[]; onChange: (v: string[]) => void; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const [hints, setHints] = useState<Addr[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const q = text.trim();
    if (!q) return undefined;
    const t = window.setTimeout(() => {
      void recipients(q).then((list) => { setHints(list.filter((a) => !value.includes(a.addr)).slice(0, 6)); setActive(0); });
    }, 150);
    return () => window.clearTimeout(t);
  }, [text, value]);

  const commit = (raw: string) => {
    const parts = raw.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
    if (!parts.length) return;
    onChange([...value, ...parts.filter((p) => !value.includes(p))]);
    setText('');
    setHints([]);
  };

  return (
    <div className="ncm-field" onClick={() => inputRef.current?.focus()}>
      <span className="ncm-label">{label}</span>
      <div className="ncm-chips">
        {value.map((a) => (
          <span key={a} className="ncm-chip" data-invalid={EMAIL_RE.test(a) ? undefined : 'true'} title={EMAIL_RE.test(a) ? a : 'Неверный адрес'}>
            {a}
            <button type="button" aria-label={`Убрать ${a}`} onClick={(e) => { e.stopPropagation(); onChange(value.filter((x) => x !== a)); }}><X size={11} /></button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={text}
          autoFocus={autoFocus}
          aria-label={label}
          onChange={(e) => {
            const v = e.target.value;
            if (/[,;]\s*$/.test(v)) commit(v); else setText(v);
          }}
          onKeyDown={(e) => {
            if (hints.length && text.trim() && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : hints.length - 1)) % hints.length);
            } else if (e.key === 'Enter' || e.key === 'Tab') {
              if (hints[active] && text.trim()) { e.preventDefault(); commit(hints[active].addr); } else if (text.trim()) { e.preventDefault(); commit(text); }
            } else if (e.key === 'Backspace' && !text && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => { if (text.trim()) commit(text); }}
          onPaste={(e) => {
            const t = e.clipboardData.getData('text');
            if (/[,;\s]/.test(t.trim())) { e.preventDefault(); commit(t); }
          }}
        />
      </div>
      {hints.length > 0 && text.trim() && (
        <div className="ncm-hints" role="listbox">
          {hints.map((h, i) => (
            <button key={h.addr} type="button" role="option" aria-selected={i === active} onMouseDown={(e) => { e.preventDefault(); commit(h.addr); }}>
              <b>{h.name || h.addr}</b>{h.name && <span>{h.addr}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Compose({ mode, me, signature, onClose }: { mode: ComposeMode; me: string; signature?: string; onClose: () => void }) {
  const init = useRef(initial(mode, me)).current;
  const sigRaw = (signature || '').replace(/^\s*--\s*\n?/, '').trim();
  const sigHtml = sigRaw ? (isHtml(sigRaw) ? sigRaw : toHtml(sigRaw)) : '';
  const sigText = sigRaw ? (isHtml(sigRaw) ? htmlToText(sigRaw) : sigRaw) : '';
  const [withSig, setWithSig] = useState(Boolean(sigRaw));
  const [to, setTo] = useState(init.to);
  const [cc, setCc] = useState(init.cc);
  const [bcc, setBcc] = useState<string[]>([]);
  const [showCc, setShowCc] = useState(init.cc.length > 0);
  const [subject, setSubject] = useState(init.subject);
  const [body, setBody] = useState(init.body);
  const [atts, setAtts] = useState<Att[]>(() => (mode.kind === 'forward'
    ? (mode.msg.attachments || []).map((a, i) => ({ id: `fwd-${i}`, filename: a.filename, size: a.size, mimeType: a.contentType || a.content_type, url: a.url, progress: 100 }))
    : []));
  const [sending, setSending] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (mode.kind === 'reply') { bodyRef.current?.focus(); bodyRef.current?.setSelectionRange(0, 0); }
  }, [mode.kind]);

  const total = atts.reduce((n, a) => n + a.size, 0);
  const uploading = atts.some((a) => !a.url && !a.error);
  const dirty = Boolean(body.trim() !== init.body.trim() || subject !== init.subject || to.length !== init.to.length || atts.length);

  const addFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    const { uploadFileWithProgress } = await import('@/shared/api/uploadFile');
    for (const f of files) {
      const id = crypto.randomUUID();
      setAtts((cur) => [...cur, { id, filename: f.name, size: f.size, mimeType: f.type || undefined, progress: 0 }]);
      uploadFileWithProgress(f, (p) => setAtts((cur) => cur.map((a) => (a.id === id ? { ...a, progress: p } : a))))
        .then((res) => setAtts((cur) => cur.map((a) => (a.id === id ? { ...a, url: res.url, progress: 100 } : a))))
        .catch(() => setAtts((cur) => cur.map((a) => (a.id === id ? { ...a, error: true } : a))));
    }
  }, []);

  const close = useCallback(async () => {
    if (sending) return;
    if (dirty && !await askConfirm({ title: 'Закрыть письмо?', text: 'Написанное не сохранится.', confirm: 'Закрыть', tone: 'danger' })) return;
    onClose();
  }, [dirty, onClose, sending]);

  const send = async () => {
    if (sending) return;
    const bad = [...to, ...cc, ...bcc].filter((a) => !EMAIL_RE.test(a));
    if (!to.length) { showToast('Укажите, кому письмо.', 'error'); return; }
    if (bad.length) { showToast(`Неверный адрес: ${bad[0]}`, 'error'); return; }
    if (uploading) { showToast('Файлы ещё загружаются — отправлю, как только закончатся.', 'info'); return; }
    if (atts.some((a) => a.error)) { showToast('Один из файлов не загрузился — уберите его или добавьте заново.', 'error'); return; }
    if (total > MAX_TOTAL) { showToast('Файлы больше 25 МБ — почтовые серверы такое не примут.', 'error'); return; }
    const sigPartText = withSig && sigText ? `\n\n--\n${sigText}` : '';
    const sigPartHtml = withSig && sigHtml ? `<br><br><div>--</div>${sigHtml}` : '';
    const text = `${body}${sigPartText}${init.quote ? `\n\n${init.quote}` : ''}`;
    const quoteHtml = init.quote
      ? `<blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex;color:#555">${toHtml(init.quote.replace(/^> ?/gm, ''))}</blockquote>`
      : '';
    const out: Outgoing = {
      to, cc, bcc, subject,
      bodyText: text,
      bodyHtml: `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5">${toHtml(body)}${sigPartHtml}${quoteHtml ? `<br><br>${quoteHtml}` : ''}</div>`,
      replyToMessageId: mode.kind === 'reply' ? mode.msg.messageId : undefined,
      attachments: atts.filter((a) => a.url).map((a) => ({ url: a.url!, filename: a.filename, size: a.size, mimeType: a.mimeType })),
    };
    setSending(true);
    try {
      await sendMail(out);
      showToast('Письмо отправлено', 'success');
      onClose();
    } catch (e) {
      setSending(false);
      showToast(`Не отправилось: ${(e as Error).message || 'нет связи с почтовым сервером'}`, 'error');
    }
  };

  const root = typeof document !== 'undefined' ? document.querySelector<HTMLElement>('.nx') || document.body : null;
  if (!root) return null;
  const title = mode.kind === 'new' ? 'Новое письмо' : mode.kind === 'reply' ? 'Ответ' : 'Пересылка';

  return createPortal(
    <div className="nx-scrim ncm-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) void close(); }}>
      <section
        className="ncm"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-drag={dragOver ? 'true' : undefined}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.stopPropagation(); void close(); }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); }
        }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragOver(true); } }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); void addFiles(Array.from(e.dataTransfer.files)); }}
      >
        <header className="ncm-head">
          <h2>{subject.trim() || title}</h2>
          <button type="button" className="nx-icon-btn" onClick={() => void close()} aria-label="Закрыть"><X size={16} /></button>
        </header>
        <div className="ncm-fields">
          <Recipients label="Кому" value={to} onChange={setTo} autoFocus={mode.kind !== 'reply'} />
          {showCc ? (
            <>
              <Recipients label="Копия" value={cc} onChange={setCc} />
              <Recipients label="Скрытая" value={bcc} onChange={setBcc} />
            </>
          ) : (
            <button type="button" className="ncm-cc-toggle" onClick={() => setShowCc(true)}>Копия, скрытая копия</button>
          )}
          <label className="ncm-field">
            <span className="ncm-label">Тема</span>
            <input className="ncm-subject" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Тема" />
          </label>
        </div>
        <textarea
          ref={bodyRef}
          className="ncm-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files || []);
            if (files.length) { e.preventDefault(); void addFiles(files); }
          }}
          placeholder="Текст письма"
          aria-label="Текст письма"
        />
        {sigHtml && (
          <div className="ncm-sig" data-off={withSig ? undefined : 'true'}>
            <div className="ncm-sig-head">
              <span>Подпись</span>
              <button type="button" onClick={() => setWithSig((v) => !v)}>{withSig ? 'Без подписи' : 'Добавить подпись'}</button>
            </div>
            {withSig && <EmailHtmlView html={sigHtml} cacheKey="compose-signature" bare />}
          </div>
        )}
        {init.quote && <pre className="ncm-quote">{init.quote}</pre>}
        {atts.length > 0 && (
          <div className="ncm-atts">
            {atts.map((a) => (
              <span key={a.id} className="ncm-att" data-error={a.error ? 'true' : undefined} title={a.error ? 'Не загрузился' : a.filename}>
                <FileIcon size={14} aria-hidden="true" />
                <span className="ncm-att-name">{a.filename}</span>
                <span className="ncm-att-size">{a.error ? 'ошибка' : a.url ? fileSize(a.size) : `${a.progress}%`}</span>
                {!a.url && !a.error && <i className="ncm-att-bar" style={{ width: `${a.progress}%` }} />}
                <button type="button" aria-label={`Убрать ${a.filename}`} onClick={() => setAtts((cur) => cur.filter((x) => x.id !== a.id))}><X size={12} /></button>
              </span>
            ))}
            <span className="ncm-total" data-over={total > MAX_TOTAL ? 'true' : undefined}>{fileSize(total)} из 25 МБ</span>
          </div>
        )}
        <footer className="ncm-foot">
          <button type="button" className="nx-ghost" onClick={() => fileRef.current?.click()}><Paperclip size={15} aria-hidden="true" /> Файлы</button>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => { void addFiles(Array.from(e.target.files || [])); e.target.value = ''; }} />
          <span className="ncm-hint">Перетащите файлы в окно · Ctrl+Enter — отправить</span>
          <button type="button" className="nx-primary" onClick={() => void send()} disabled={sending}>
            {sending ? <Spinner size={15} /> : <Send size={15} aria-hidden="true" />}
            {sending ? 'Отправляю…' : uploading ? 'Файлы загружаются…' : 'Отправить'}
          </button>
        </footer>
        {dragOver && <div className="ncm-drop" aria-hidden="true">Отпустите — файлы прикрепятся</div>}
      </section>
    </div>,
    root,
  );
}
