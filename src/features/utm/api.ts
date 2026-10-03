/** UTM-генератор: пресеты источников и история сгенерированных ссылок. */

export interface Preset {
  id: string;
  name: string;
  source: string;
  medium: string;
  campaign?: string;
  term?: string;
  content?: string;
  color: string;
  description: string;
}

export interface TrackedLink {
  id: string;
  platform: string;
  postUrl: string;
  title: string;
  utmUrl: string;
  createdAt: string;
  clicks: number;
  views: number;
  conversions: number;
}

export interface UtmParams { source: string; medium: string; campaign: string; term: string; content: string }
export const EMPTY_PARAMS: UtmParams = { source: '', medium: '', campaign: '', term: '', content: '' };

export const DEFAULT_PRESETS: Preset[] = [
  { id: 'yandex', name: 'Яндекс', source: 'yandex', medium: 'cpc', color: '#f59e0b', description: 'Яндекс Директ' },
  { id: 'google', name: 'Google', source: 'google', medium: 'cpc', color: '#3b82f6', description: 'Google Ads' },
  { id: 'vk', name: 'VK', source: 'vk', medium: 'social', color: '#0ea5e9', description: 'ВКонтакте' },
  { id: 'tg', name: 'Telegram', source: 'telegram', medium: 'social', color: '#06b6d4', description: 'Telegram' },
  { id: 'dzen', name: 'Дзен', source: 'dzen', medium: 'social', color: '#f97316', description: 'Дзен' },
  { id: 'email', name: 'Email', source: 'email', medium: 'email', color: '#8b5cf6', description: 'Рассылка' },
  { id: 'qr', name: 'QR', source: 'qr', medium: 'offline', color: '#22c55e', description: 'Офлайн, QR-код' },
];

export const PRESET_COLORS = ['#f59e0b', '#3b82f6', '#0ea5e9', '#06b6d4', '#f97316', '#8b5cf6', '#22c55e', '#ef4444', '#ec4899', '#6366f1'];

export const PLATFORMS: { id: string; name: string }[] = [
  { id: 'vk', name: 'VK' },
  { id: 'telegram', name: 'Telegram' },
  { id: 'yandex', name: 'Яндекс Директ' },
  { id: 'google', name: 'Google' },
  { id: 'email', name: 'Email' },
  { id: 'dzen', name: 'Дзен' },
  { id: 'other', name: 'Другое' },
];

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try { res = await fetch(url, { cache: 'no-store', credentials: 'include', ...init }); }
  catch { throw new Error('Нет связи с сервером'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Ошибка ${res.status}`);
  return data as T;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export async function loadPresets(): Promise<Preset[]> {
  try {
    const p = await call<Preset[]>('/api/utm-presets');
    return Array.isArray(p) && p.length ? p : DEFAULT_PRESETS;
  } catch { return DEFAULT_PRESETS; }
}
export const savePresets = (presets: Preset[]) => call('/api/utm-presets', json('POST', presets));
export async function resetPresets(): Promise<Preset[]> {
  const r = await call<{ presets?: Preset[] }>('/api/utm-presets', { method: 'DELETE' });
  return Array.isArray(r.presets) ? r.presets : DEFAULT_PRESETS;
}

export async function loadHistory(): Promise<TrackedLink[]> {
  const d = await call<TrackedLink[]>('/api/tracked-posts');
  return Array.isArray(d) ? d : [];
}
export const addToHistory = (link: Omit<TrackedLink, 'id' | 'createdAt'>) => call<TrackedLink>('/api/tracked-posts', json('POST', link));
export const removeFromHistory = (id: string) => call(`/api/tracked-posts/${encodeURIComponent(id)}`, { method: 'DELETE' });

// ── Логика генерации ───────────────────────────────────────────────────────

export function withUtm(url: string, p: UtmParams): string {
  const q = new URLSearchParams();
  if (p.source) q.append('utm_source', p.source.trim());
  if (p.medium) q.append('utm_medium', p.medium.trim());
  if (p.campaign) q.append('utm_campaign', p.campaign.trim());
  if (p.term) q.append('utm_term', p.term.trim());
  if (p.content) q.append('utm_content', p.content.trim());
  const qs = q.toString();
  if (!qs) return url;
  const [base, hash] = url.split('#', 2);
  return `${base}${base.includes('?') ? '&' : '?'}${qs}${hash !== undefined ? `#${hash}` : ''}`;
}

export function parseUtm(url: string): UtmParams {
  try {
    const u = new URL(url);
    const g = (k: string) => u.searchParams.get(`utm_${k}`) || '';
    return { source: g('source'), medium: g('medium'), campaign: g('campaign'), term: g('term'), content: g('content') };
  } catch { return EMPTY_PARAMS; }
}

export function detectPlatform(source: string, presetId?: string | null): string {
  const s = `${source} ${presetId || ''}`.toLowerCase();
  if (s.includes('telegram') || /\btg\b/.test(s)) return 'telegram';
  if (s.includes('vk')) return 'vk';
  if (s.includes('dzen')) return 'dzen';
  if (s.includes('yandex')) return 'yandex';
  if (s.includes('google')) return 'google';
  if (s.includes('email') || s.includes('mail')) return 'email';
  return 'other';
}

export function titleFor(url: string, campaign: string, idx: number, total: number): string {
  const n = total > 1 ? ` #${idx + 1}` : '';
  if (campaign.trim()) return `${campaign.trim()}${n}`;
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
  } catch { /* не ссылка — ниже запасное имя */ }
  return `UTM-ссылка${n}`;
}

/** Похоже на адрес? Без схемы тоже принимаем — допишем https://. */
export function normalizeUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  try { const u = new URL(withScheme); return u.hostname.includes('.') ? withScheme : null; } catch { return null; }
}
