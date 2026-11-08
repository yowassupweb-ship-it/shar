/** Срок задачи: «YYYY-MM-DD» или «YYYY-MM-DDTHH:MM:SS» (полночь = без времени). Время локальное, без зоны. */
export function parseDue(iso?: string | null): { day: Date; time: string } | null {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return null;
  const hh = Number(m[4] || 0);
  const mm = Number(m[5] || 0);
  return { day: new Date(+m[1], +m[2] - 1, +m[3], hh, mm), time: hh || mm ? `${m[4]}:${m[5]}` : '' };
}

