/** Форматирование для почты: даты в списке и в письме, размеры файлов. */

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const pad = (n: number) => String(n).padStart(2, '0');

/** Время из базы без зоны — московское: так его хранит база (сессия в
 *  Europe/Moscow переводит дату письма в своё время). */
export function parseMailDate(value?: string): Date {
  if (!value) return new Date(NaN);
  const s = String(value);
  return new Date(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(' ', 'T')}+03:00`);
}

// Строка списка перерисовывается часто, а дата у письма не меняется — помним готовую подпись
// (сбрасываем со сменой дня: «сегодня» становится «вчера»).
const listDates = new Map<string, string>();
let listDay = '';

/** В списке: сегодня — время, в этом году — «12 сент», раньше — дата. */
export function fmtListDate(value?: string): string {
  const today = new Date().toDateString();
  if (today !== listDay) { listDay = today; listDates.clear(); }
  const key = value || '';
  let out = listDates.get(key);
  if (out === undefined) {
    out = listDate(value);
    if (listDates.size > 5000) listDates.clear();
    listDates.set(key, out);
  }
  return out;
}

function listDate(value?: string): string {
  const d = parseMailDate(value);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Вчера';
  if (d.getFullYear() === now.getFullYear()) return `${d.getDate()} ${MONTHS_GEN[d.getMonth()].slice(0, 3)}`;
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
}

/** В письме: «30 сентября 2026, 13:05». */
export function fmtFullDate(value?: string): string {
  const d = parseMailDate(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fileSize(bytes: number): string {
  if (!bytes) return '0 Б';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0).replace('.', ',')} МБ`;
}
