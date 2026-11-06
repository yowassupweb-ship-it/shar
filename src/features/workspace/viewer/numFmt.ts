/**
 * Числовые форматы Excel для просмотра: «0,00 ₽», «0%», «# ##0», «дд.мм.гггг», «чч:мм».
 * Покрыто то, что встречается в обычных таблицах; сложное (дроби, условия) показывается как «Общий».
 * Разделители — русские (запятая, неразрывный пробел): так видят таблицу владельцы.
 */

const NBSP = ' ';
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** «Общий» формат: до 10 значащих цифр, запятая вместо точки. */
export function formatGeneral(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const text = Math.abs(n) >= 1e11 || (n !== 0 && Math.abs(n) < 1e-9) ? n.toExponential(5).replace(/\.?0+e/, 'e') : String(Number(n.toPrecision(10)));
  return text.replace('.', ',');
}

/** Разбить формат на секции «положительные;отрицательные;нули;текст», не трогая «;» внутри кавычек. */
function sections(fmt: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < fmt.length; i += 1) {
    const ch = fmt[i];
    if (ch === '"') quoted = !quoted;
    if (ch === ';' && !quoted) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Литералы и служебные скобки формата → (текст, остаток без литералов с заменой на маркер). */
interface Piece { lit?: string; raw?: string }

function pieces(section: string): Piece[] {
  const out: Piece[] = [];
  let raw = '';
  const flush = () => { if (raw) { out.push({ raw }); raw = ''; } };
  for (let i = 0; i < section.length; i += 1) {
    const ch = section[i];
    if (ch === '"') {
      const end = section.indexOf('"', i + 1);
      flush();
      out.push({ lit: section.slice(i + 1, end < 0 ? undefined : end) });
      i = end < 0 ? section.length : end;
    } else if (ch === '\\') {
      flush();
      out.push({ lit: section[i + 1] || '' });
      i += 1;
    } else if (ch === '[') {
      const end = section.indexOf(']', i);
      const inner = section.slice(i + 1, end < 0 ? undefined : end);
      flush();
      const cur = inner.match(/^\$([^-\]]*)/); // [$₽-419] → «₽»
      if (cur) out.push({ lit: cur[1] });
      else if (/^[hms]+$/i.test(inner)) out.push({ raw: inner[0] + inner[0] }); // [h] — часы без сброса
      i = end < 0 ? section.length : end;
    } else if (ch === '_' || ch === '*') {
      flush();
      if (ch === '_') out.push({ lit: ' ' });
      i += 1;
    } else raw += ch;
  }
  flush();
  return out;
}

const isDateSection = (section: string) =>
  pieces(section).some((p) => p.raw !== undefined && /[ymdhs]/i.test(p.raw.replace(/e[+-]/gi, '').replace(/general/gi, '')) && !/^[#0?.,%\s]*$/.test(p.raw));

function serialToDate(n: number): Date {
  return new Date(Math.round((n - 25569) * 86400000));
}

function formatDate(date: Date, section: string): string {
  const parts = pieces(section);
  const raw = parts.map((p) => p.raw ?? '\u0001').join('');
  const hasDay = /d/i.test(raw);
  const twelve = /AM\/PM|A\/P/i.test(raw);
  const hours = date.getUTCHours();
  const tokenRe = /yyyy|yy|mmmmm|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|AM\/PM|A\/P|\.0+/gi;
  // «m» после часов или перед секундами — минуты, иначе месяц.
  const kinds: string[] = [];
  let lastWasHour = false;
  const flat: Array<{ text: string; tok: boolean }> = [];
  for (const p of parts) {
    if (p.lit !== undefined) { flat.push({ text: p.lit, tok: false }); continue; }
    let last = 0;
    const src = p.raw || '';
    for (const m of src.matchAll(tokenRe)) {
      if (m.index! > last) flat.push({ text: src.slice(last, m.index), tok: false });
      flat.push({ text: m[0], tok: true });
      last = m.index! + m[0].length;
    }
    if (last < src.length) flat.push({ text: src.slice(last), tok: false });
  }
  flat.forEach((t, i) => {
    if (!t.tok) { kinds[i] = ''; return; }
    const low = t.text.toLowerCase();
    if (low[0] === 'h') { lastWasHour = true; kinds[i] = 'h'; return; }
    if (low[0] === 'm' && low.length >= 3) { lastWasHour = false; kinds[i] = 'mon'; return; }
    if (low[0] === 'm') {
      const next = flat.slice(i + 1).find((x) => x.tok);
      kinds[i] = lastWasHour || (next && next.text.toLowerCase()[0] === 's') ? 'min' : 'mon';
      lastWasHour = false;
      return;
    }
    if (low[0] !== 'm') lastWasHour = low[0] === 's' ? false : lastWasHour;
    kinds[i] = low[0];
  });
  return flat.map((t, i) => {
    if (!t.tok) return t.text;
    const low = t.text.toLowerCase();
    const kind = kinds[i];
    switch (kind) {
      case 'y': return low.length >= 4 ? String(date.getUTCFullYear()) : pad(date.getUTCFullYear() % 100);
      case 'mon':
        if (low.length === 1) return String(date.getUTCMonth() + 1);
        if (low.length === 2) return pad(date.getUTCMonth() + 1);
        if (low.length === 3) return MONTHS[date.getUTCMonth()].slice(0, 3);
        if (low.length === 5) return MONTHS[date.getUTCMonth()][0].toUpperCase();
        return (hasDay ? MONTHS_GEN : MONTHS)[date.getUTCMonth()];
      case 'd':
        if (low.length === 1) return String(date.getUTCDate());
        if (low.length === 2) return pad(date.getUTCDate());
        return low.length === 3 ? WEEKDAYS[date.getUTCDay()].slice(0, 2) : WEEKDAYS[date.getUTCDay()];
      case 'h': { const h = twelve ? (hours % 12 || 12) : hours; return low.length === 2 ? pad(h) : String(h); }
      case 'min': return low.length === 2 ? pad(date.getUTCMinutes()) : String(date.getUTCMinutes());
      case 's': return low.length === 2 ? pad(date.getUTCSeconds()) : String(date.getUTCSeconds());
      case 'a': return hours < 12 ? (low.length > 3 ? 'AM' : 'A') : (low.length > 3 ? 'PM' : 'P');
      default: return t.text;
    }
  }).join('');
}

function groupThousands(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

function formatNumberSection(value: number, section: string, signed: boolean): string {
  const parts = pieces(section);
  const rawAll = parts.map((p) => p.raw ?? '').join('');
  if (/general/i.test(rawAll)) {
    const text = formatGeneral(Math.abs(value));
    return (signed && value < 0 ? '-' : '') + parts.map((p) => (p.lit !== undefined ? p.lit : p.raw!.replace(/general/gi, text))).join('');
  }
  if (/[#0?]\s*\/\s*[#0?]/.test(rawAll) || /e[+-]/i.test(rawAll)) {
    return (signed && value < 0 ? '-' : '') + formatGeneral(Math.abs(value)); // дроби и научный вид — без точного повтора
  }
  // Сколько «%» и хвостовых запятых (деление на тысячу) в числовой части.
  const percents = (rawAll.match(/%/g) || []).length;
  const core = rawAll.replace(/[^#0?.,]/g, '');
  const trailingCommas = (core.match(/,+$/) || [''])[0].length;
  const body = trailingCommas ? core.slice(0, -trailingCommas) : core;
  const thousands = body.includes(',');
  const [intPattern, fracPattern = ''] = body.replace(/,/g, '').split('.');
  const minInt = (intPattern.match(/0/g) || []).length;
  const maxFrac = fracPattern.length;
  const minFrac = (fracPattern.match(/0/g) || []).length;
  let n = Math.abs(value) * 100 ** percents / 1000 ** trailingCommas;
  const text = n.toFixed(Math.min(maxFrac, 20));
  let [intPart, fracPart = ''] = text.split('.');
  while (fracPart.length > minFrac && fracPart.endsWith('0')) fracPart = fracPart.slice(0, -1);
  intPart = intPart.padStart(minInt, '0');
  if (intPart === '0' && minInt === 0 && fracPart) intPart = '';
  if (thousands) intPart = groupThousands(intPart);
  n = Number(text);
  const number = intPart + (fracPart ? `,${fracPart}` : '');
  // Подставляем число на место первого плейсхолдера, остальные «сырые» куски числа выкидываем.
  let placed = false;
  const out = parts.map((p) => {
    if (p.lit !== undefined) return p.lit;
    const raw = p.raw!;
    if (!/[#0?]/.test(raw) && !placed) return raw.replace(/[^%\s-]/g, '');
    // Сначала метка на месте плейсхолдера и вычистка остального, потом число: иначе вычистка съедала нули и запятые самого числа.
    if (!placed) { placed = true; return raw.replace(/[#0?.,]+/, ' ').replace(/[#0?.,]+/g, '').replace(' ', () => number); }
    return raw.replace(/[#0?.,]/g, '');
  }).join('');
  return (signed && value < 0 && n !== 0 ? '-' : '') + out;
}

/** Значение ячейки по числовому формату Excel; для «Общий» и неизвестного — как в Excel по умолчанию. */
export function formatCell(value: number | Date, fmt?: string): string {
  const numeric = value instanceof Date ? (value.getTime() / 86400000) + 25569 : value;
  if (!fmt || /^general$/i.test(fmt) || fmt === '@') return value instanceof Date ? formatDate(value, 'dd.mm.yyyy' + (value.getUTCHours() || value.getUTCMinutes() ? ' hh:mm' : '')) : formatGeneral(value);
  const list = sections(fmt);
  let index = 0;
  if (numeric < 0 && list.length > 1) index = 1;
  else if (numeric === 0 && list.length > 2) index = 2;
  const section = list[index] ?? list[0];
  if (isDateSection(section)) return formatDate(value instanceof Date ? value : serialToDate(numeric), section);
  return formatNumberSection(numeric, section, index === 0);
}
