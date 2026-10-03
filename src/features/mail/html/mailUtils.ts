import { useEffect, useState } from 'react';
import type { EmailMessage, ParsedEmail, Thread } from './mailTypes';

// ── Plain-text ⇄ HTML helpers — used to combine a plain-text compose body
// with a rich-text (HTML) signature into a single outgoing message. ────────

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function plainTextToHtml(text: string): string {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

// Contenteditable wraps even plain unformatted typing in <div>/<br> tags —
// that's not "rich" content, just how the browser represents line breaks.
// Only treat a message as genuinely rich (and therefore send it as bodyHtml,
// rendered on the safe white email canvas) if it has real formatting —
// otherwise send it as plain bodyText so it renders through the normal
// theme-aware bubble text instead of an unnecessary white card.
export function isRichHtml(html: string): boolean {
  return /<(b|strong|i|em|u|a|img|ul|ol|li|blockquote|h[1-6])\b|style\s*=/i.test(html);
}

// Wraps the account signature when it's appended to an outgoing message, so
// the reading pane can find and hide it by default (with a "Показать
// подпись" toggle) instead of showing your full signature on every sent
// message in a dialog.
export const SIG_MARK_OPEN = '<div data-shar-sig="1">';

export function wrapSignatureForSend(sigHtml: string): string {
  return sigHtml ? `${SIG_MARK_OPEN}${sigHtml}</div>` : '';
}

// Splits a sent message's bodyHtml into { main, signature } if it was sent
// with the wrapSignatureForSend() marker. The marker div is always the last
// top-level element appended, so its own closing tag is the string's final
// "</div>" (its content's tags are already balanced internally).
export function splitSignatureHtml(html: string): { main: string; signature: string | null } {
  const idx = html.indexOf(SIG_MARK_OPEN);
  if (idx === -1) return { main: html, signature: null };
  const main = html.slice(0, idx);
  const rest = html.slice(idx + SIG_MARK_OPEN.length).replace(/<\/div>\s*$/, '');
  return { main, signature: rest };
}

export function htmlToPlainText(html: string): string {
  if (!html) return '';
  if (typeof document === 'undefined') return html.replace(/<[^>]+>/g, '');
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || '').trim();
}

export function useChatSettings() {
  const [cs, setCs] = useState<any>({});
  useEffect(() => {
    const read = () => {
      try { setCs(JSON.parse(localStorage.getItem('chatSettings') || '{}')); } catch {}
    };
    read();
    const h = (e: Event) => setCs((e as CustomEvent).detail ?? {});
    window.addEventListener('chatSettingsChanged', h);
    return () => window.removeEventListener('chatSettingsChanged', h);
  }, []);
  return cs;
}

// ── Provider presets ───────────────────────────────────────────────────────

export const PROVIDER_PRESETS: Record<string, { imapHost: string; imapPort: number; smtpHost: string; smtpPort: number }> = {
  'gmail.com':     { imapHost: 'imap.gmail.com',         imapPort: 993, smtpHost: 'smtp.gmail.com',         smtpPort: 587 },
  'yandex.ru':     { imapHost: 'imap.yandex.ru',          imapPort: 993, smtpHost: 'smtp.yandex.ru',          smtpPort: 587 },
  'mail.ru':       { imapHost: 'imap.mail.ru',            imapPort: 993, smtpHost: 'smtp.mail.ru',            smtpPort: 587 },
  'outlook.com':   { imapHost: 'imap-mail.outlook.com',   imapPort: 993, smtpHost: 'smtp-mail.outlook.com',   smtpPort: 587 },
  'hotmail.com':   { imapHost: 'imap-mail.outlook.com',   imapPort: 993, smtpHost: 'smtp-mail.outlook.com',   smtpPort: 587 },
  'yahoo.com':     { imapHost: 'imap.mail.yahoo.com',     imapPort: 993, smtpHost: 'smtp.mail.yahoo.com',     smtpPort: 587 },
  'icloud.com':    { imapHost: 'imap.mail.me.com',        imapPort: 993, smtpHost: 'smtp.mail.me.com',        smtpPort: 587 },
  'vs-travel.ru':  { imapHost: 'mail.vs-travel.ru',       imapPort: 993, smtpHost: 'mail.vs-travel.ru',       smtpPort: 465 },
};

export function applyPreset(email: string) {
  const domain = email.split('@')[1]?.toLowerCase();
  return domain ? PROVIDER_PRESETS[domain] ?? null : null;
}

// ── Formatting helpers ───────────────────────────────────────────────────────

export function fmtDate(iso: string) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 86400000 && d.getDate() === now.getDate()) {
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
  if (diff < 7 * 86400000) {
    return d.toLocaleDateString('ru-RU', { weekday: 'short' });
  }
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

export function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export function initials(name: string) {
  return name.split(/[\s._\-+]+/).slice(0, 2).map(w => w[0]).filter(Boolean).join('').toUpperCase() || '?';
}

// Strip angle-bracket email and surrounding quotes from RFC-2822 display name.
// "Иван Иванов <ivan@mail.ru>" → "Иван Иванов"
// '"Support" <help@co.com>'   → "Support"
// "john@example.com"          → "john@example.com" (full email, like Outlook)
export function cleanSenderName(name: string, email: string): string {
  if (!name) return email;
  // Strip "Name <email>" format → "Name"
  const angleMatch = name.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
  const cleaned = (angleMatch ? angleMatch[1] : name).replace(/^["'\s]+|["'\s]+$/g, '').trim();
  // If "name" is just the email address (no real display name) → show full email like Outlook
  if (!cleaned || cleaned.includes('@')) return email;
  return cleaned;
}

const AVATAR_COLORS = ['#3b82f6','#8b5cf6','#ec4899','#f59e0b','#10b981','#ef4444','#06b6d4'];
export function avatarColor(str: string) {
  const n = str.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return AVATAR_COLORS[n % AVATAR_COLORS.length];
}

// Compact MD5 (RFC 1321) — needed for Gravatar URLs
export function md5(input: string): string {
  const T = Array.from({ length: 64 }, (_, i) => (Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);
  const S = [
    7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
    5, 9,14,20, 5, 9,14,20, 5, 9,14,20, 5, 9,14,20,
    4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
    6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21,
  ];
  const rotl = (v: number, n: number) => (v << n) | (v >>> (32 - n));
  const bytes = Array.from(new TextEncoder().encode(input));
  const len = bytes.length;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 0; i < 8; i++) bytes.push(Math.floor((len * 8) / 2 ** (8 * i)) & 0xff);
  let a0 = 0x67452301, b0 = 0xEFCDAB89, c0 = 0x98BADCFE, d0 = 0x10325476;
  for (let bi = 0; bi < bytes.length; bi += 64) {
    const M = Array.from({ length: 16 }, (_, j) =>
      bytes[bi+j*4] | (bytes[bi+j*4+1] << 8) | (bytes[bi+j*4+2] << 16) | (bytes[bi+j*4+3] << 24));
    let a = a0, b = b0, c = c0, d = d0;
    for (let j = 0; j < 64; j++) {
      let f: number, g: number;
      if (j < 16)      { f = (b & c) | (~b & d); g = j; }
      else if (j < 32) { f = (d & b) | (~d & c); g = (5*j+1) % 16; }
      else if (j < 48) { f = b ^ c ^ d;           g = (3*j+5) % 16; }
      else              { f = c ^ (b | ~d);        g = (7*j) % 16; }
      f = (f + a + T[j] + M[g]) | 0;
      a = d; d = c; c = b; b = (b + rotl(f, S[j])) | 0;
    }
    a0=(a0+a)|0; b0=(b0+b)|0; c0=(c0+c)|0; d0=(d0+d)|0;
  }
  return [a0,b0,c0,d0]
    .flatMap(n => [n&0xff,(n>>8)&0xff,(n>>16)&0xff,(n>>24)&0xff])
    .map(b => b.toString(16).padStart(2,'0')).join('');
}

const _gravatarCache = new Map<string, string>();
export function gravatarUrl(email: string): string {
  const key = email.trim().toLowerCase();
  if (!_gravatarCache.has(key)) _gravatarCache.set(key, `https://www.gravatar.com/avatar/${md5(key)}?d=404&s=80`);
  return _gravatarCache.get(key)!;
}
export function faviconUrl(email: string): string {
  const domain = email.split('@')[1] || '';
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

// Signature line patterns (Russian + English)
const SIG_START = /^(С уважением|Best regards|Regards|Sincerely|Thanks|Спасибо|--\s*$)/i;

// Quote / separator patterns
const QUOTE_SEP = /^(-{3,}|_{3,}|={3,}|\*{3,})/;
const QUOTE_HDR = /^(From|Sent|To|Cc|Subject|Date|От|Кому|Тема|Дата|Reply-To):\s/i;
// Visual separator lines to strip from body (lines made only of dashes, underscores, etc.)
const SEP_LINE  = /^[-_=*]{3,}\s*$/;

// Email HTML is authored as a layout, not ordinary application content. Keep the
// sender's tables, widths, typography and conditional markup intact; the iframe
// sandbox provides the execution boundary. This pass only removes markup that can
// navigate, submit, execute or load an unsafe URL.
export function preprocessHtml(html: string): string {
  return html
    .replace(/<\s*(script|iframe|object|embed|form)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|iframe|object|embed|form|base)\b[^>]*\/?>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(?:href|src|action)\s*=\s*(?:"\s*(?:javascript|vbscript):[^"]*"|'\s*(?:javascript|vbscript):[^']*'|(?:javascript|vbscript):[^\s>]+)/gi, '');
}

export function parseEmailParts(text: string): ParsedEmail {
  if (!text) return { body: '', signature: '', quote: null };

  // Normalise line endings and non-breaking spaces before anything else
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/ /g, ' ');

  const lines = text.split('\n');
  let bodyLines: string[] = [];
  let sigLines: string[] = [];
  const quoteLines: string[] = [];
  const quoteHdr: Record<string, string> = {};

  let phase: 'body' | 'sig' | 'quote_hdr' | 'quote_body' = 'body';

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();

    // Separator → start of quoted block
    if (phase === 'body' && QUOTE_SEP.test(t)) { phase = 'quote_hdr'; continue; }
    // Inline quote header without separator (Outlook mobile style)
    if (phase === 'body' && QUOTE_HDR.test(t) && i > 2) { phase = 'quote_hdr'; }

    if (phase === 'quote_hdr') {
      if (QUOTE_HDR.test(t)) {
        const colon = t.indexOf(':');
        const k = t.slice(0, colon).trim().toLowerCase();
        quoteHdr[k] = t.slice(colon + 1).trim();
        continue;
      }
      if (t === '') continue;
      phase = 'quote_body';
    }

    if (phase === 'quote_body') { quoteLines.push(raw); continue; }

    if (phase === 'body') {
      // Strip pure visual separator lines from body text
      if (SEP_LINE.test(t)) continue;
      if (SIG_START.test(t) || t === '--') { phase = 'sig'; sigLines.push(raw); continue; }
      bodyLines.push(raw);
    } else if (phase === 'sig') {
      sigLines.push(raw);
    }
  }

  // If "signature" is suspiciously long and there's no quote, treat as body
  if (sigLines.length > 8 && !quoteLines.length) {
    bodyLines = [...bodyLines, ...sigLines];
    sigLines = [];
  }

  // Normalize and collapse: CRLF → LF, whitespace-only lines → empty, max 1 blank line
  const clean = (ls: string[]) =>
    ls
      .map(l => l.replace(/\r/g, '').replace(/^[\t  ]+$/, ''))  // CRLF + blank/nbsp-only lines → empty
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')   // max 1 blank line (= 2 newlines)
      .trim();

  const quoteBody = clean(quoteLines);
  const quote = (quoteBody || quoteHdr['from'] || quoteHdr['subject'])
    ? {
        from: quoteHdr['from'] || quoteHdr['от'] || '',
        subject: quoteHdr['subject'] || quoteHdr['тема'] || '',
        date: quoteHdr['sent'] || quoteHdr['date'] || quoteHdr['дата'] || '',
        body: quoteBody,
      }
    : null;

  return { body: clean(bodyLines), signature: clean(sigLines), quote };
}

// Keep for thread-list preview use
export function cleanBodyText(text: string): string {
  const body = parseEmailParts(text).body;
  if (body) return body;
  return text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().split('\n').slice(0, 3).join(' ').replace(/\s+/g, ' ').trim();
}

export function groupIntoThreads(messages: EmailMessage[]): Thread[] {
  const map = new Map<string, EmailMessage[]>();
  for (const m of messages) {
    const key = m.threadId || m.id;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(m);
  }
  const threads: Thread[] = [];
  for (const [tid, msgs] of map.entries()) {
    msgs.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const last = msgs[msgs.length - 1];
    const fromNames = [...new Set(msgs.map(m => cleanSenderName(m.fromName, m.fromAddr)))].slice(0, 3);
    threads.push({
      threadId: tid,
      subject: msgs[0].subject || '(без темы)',
      messages: msgs,
      lastDate: last.date,
      unread: msgs.some(m => !m.isRead),
      fromNames,
    });
  }
  threads.sort((a, b) => new Date(b.lastDate).getTime() - new Date(a.lastDate).getTime());
  return threads;
}

// "Диалоги" mode — merge every subject/thread with the same correspondent
// into one messenger-style conversation, like a chat, instead of splitting
// by subject line the way classic email inboxes do.
export function groupIntoDialogs(messages: EmailMessage[], accountEmail: string): Thread[] {
  const myEmail = accountEmail.toLowerCase();
  const map = new Map<string, EmailMessage[]>();
  for (const m of messages) {
    const fromIsMe = m.fromAddr?.toLowerCase() === myEmail;
    const counterpart = fromIsMe ? (m.toAddrs[0]?.addr || m.fromAddr) : m.fromAddr;
    const key = (counterpart || m.fromAddr || 'unknown').toLowerCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(m);
  }
  const dialogs: Thread[] = [];
  for (const [addr, msgs] of map.entries()) {
    msgs.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const last = msgs[msgs.length - 1];
    const counterpartMsg = [...msgs].reverse().find(m => m.fromAddr?.toLowerCase() !== myEmail) || last;
    const displayName = cleanSenderName(counterpartMsg.fromName, addr);
    dialogs.push({
      threadId: `dialog:${addr}`,
      subject: displayName,
      messages: msgs,
      lastDate: last.date,
      unread: msgs.some(m => !m.isRead),
      fromNames: [displayName],
    });
  }
  dialogs.sort((a, b) => new Date(b.lastDate).getTime() - new Date(a.lastDate).getTime());
  return dialogs;
}

export function getFileExt(filename: string, contentType: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext) return ext;
  if (contentType.includes('pdf')) return 'pdf';
  if (contentType.includes('word')) return 'docx';
  if (contentType.includes('excel') || contentType.includes('spreadsheet')) return 'xlsx';
  if (contentType.includes('powerpoint') || contentType.includes('presentation')) return 'pptx';
  if (contentType.startsWith('image/')) return 'jpg';
  if (contentType.startsWith('video/')) return 'mp4';
  if (contentType.includes('zip') || contentType.includes('archive')) return 'zip';
  return 'file';
}

// Module-level scroll cache — survives component re-mounts and thread switches.
// Anchor-based (which message is at the top + how many px into it), not a raw
// scrollTop number — a raw number drifts as content above it (iframes, lazy
// images) keeps resizing after mount, since it changes the total document
// height without changing which message the user was actually looking at.
export interface ScrollAnchor { msgId: string; offset: number }
export const _threadScrollCache = new Map<string, ScrollAnchor>();

// Measured iframe height per message id — survives thread switches so a
// re-opened email doesn't flash/reflow while its HTML re-measures.
export const _htmlHeightCache = new Map<string, number>();

export const FOLDER_KEYS = ['INBOX', 'SENT', 'DRAFTS', 'SPAM', 'TRASH', 'STARRED'];
