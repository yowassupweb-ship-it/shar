import { parseA1, type Range } from './model';
import { RU_FUNCTIONS } from './formulas';

/**
 * Правка формулы как в Google Таблицах: каждая ссылка в формуле своим цветом (тем же — рамка на листе и текст в поле
 * правки) и выпадающая подсказка функций по первым буквам.
 */

/** Цвета ссылок по порядку (как у Google Таблиц). */
export const REF_COLORS = ['#4285f4', '#ea4335', '#fbbc04', '#34a853', '#ff6d01', '#46bdc6', '#ab47bc', '#7baaf7'];

export interface RefSpan { start: number; end: number; text: string; range: Range | null; color: string; sheet: string | null }

const REF = /("(?:[^"]|"")*")|((?:'(?:[^']|'')+'|[A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё.]*)!)?(?<![\w.$])(\$?[A-Z]{1,3}\$?\d{1,7})(?::(\$?[A-Z]{1,3}\$?\d{1,7}))?(?![\w(!])/gi;

/** Ссылки в тексте формулы с цветами: одинаковые ссылки — одного цвета. */
export function formulaRefs(text: string): RefSpan[] {
  if (!text.startsWith('=')) return [];
  const out: RefSpan[] = [];
  const colorOf = new Map<string, string>();
  for (const m of text.matchAll(REF)) {
    if (m[1]) continue;
    const prefix = m[2] ? m[2].slice(0, -1).replace(/^'(.*)'$/, '$1').replace(/''/g, "'") : null;
    const a = parseA1(m[3]);
    const b = m[4] ? parseA1(m[4]) : a;
    const range = a && b ? { startRow: Math.min(a.row, b.row), endRow: Math.max(a.row, b.row), startColumn: Math.min(a.col, b.col), endColumn: Math.max(a.col, b.col) } : null;
    const key = `${prefix ?? ''}!${m[3]}:${m[4] ?? ''}`.toUpperCase().replace(/\$/g, '');
    let color = colorOf.get(key);
    if (!color) { color = REF_COLORS[colorOf.size % REF_COLORS.length]; colorOf.set(key, color); }
    out.push({ start: m.index!, end: m.index! + m[0].length, text: m[0], range, color, sheet: prefix });
  }
  return out;
}

/** Ссылка, вставленная щелчком, заменяется следующим щелчком, пока курсор стоит сразу за ней (как в Google). */
export function refEndingAt(text: string, caret: number): RefSpan | null {
  return formulaRefs(text).find((r) => r.end === caret) ?? null;
}

/** Можно ли сейчас вставить ссылку щелчком: формула, курсор после оператора, скобки, запятой/точки с запятой или «=». */
export function canInsertRef(text: string, caret: number): boolean {
  if (!text.startsWith('=')) return false;
  if (refEndingAt(text, caret)) return true;
  const before = text.slice(0, caret).trimEnd();
  return /[=+\-*/^&(,;:<>]$/.test(before);
}

// ── Подсказка функций ─────────────────────────────────────────────────────────────────────────────────────────

/** Описания самых нужных функций (остальные показываются только именем). */
const ABOUT: Record<string, string> = {
  SUM: 'Сумма значений', AVERAGE: 'Среднее значение', COUNT: 'Количество чисел', COUNTA: 'Количество непустых', MIN: 'Наименьшее', MAX: 'Наибольшее',
  IF: 'Значение по условию', IFERROR: 'Значение при ошибке', SUMIF: 'Сумма по условию', COUNTIF: 'Количество по условию', AVERAGEIF: 'Среднее по условию',
  VLOOKUP: 'Поиск по первому столбцу', HLOOKUP: 'Поиск по первой строке', INDEX: 'Значение по номеру строки и столбца', ROUND: 'Округление',
  ROUNDUP: 'Округление вверх', ROUNDDOWN: 'Округление вниз', TODAY: 'Сегодняшняя дата', NOW: 'Текущие дата и время', CONCATENATE: 'Склеить текст',
  LEFT: 'Символы слева', RIGHT: 'Символы справа', MID: 'Символы из середины', LEN: 'Длина текста', TRIM: 'Убрать лишние пробелы', UPPER: 'В верхний регистр',
  LOWER: 'В нижний регистр', TEXT: 'Число как текст по формату', DATE: 'Дата из года, месяца, дня', YEAR: 'Год даты', MONTH: 'Месяц даты', DAY: 'День даты',
  AND: 'Все условия истинны', OR: 'Хотя бы одно условие истинно', NOT: 'Отрицание', ABS: 'Модуль числа', MOD: 'Остаток от деления', POWER: 'Степень',
  SQRT: 'Квадратный корень', PRODUCT: 'Произведение', SUMPRODUCT: 'Сумма произведений', INT: 'Целая часть', DAYS: 'Дней между датами',
};
const SIGNATURE: Record<string, string> = {
  SUM: 'СУММ(значение1; [значение2; …])', AVERAGE: 'СРЗНАЧ(значение1; [значение2; …])', IF: 'ЕСЛИ(условие; если_истина; [если_ложь])',
  VLOOKUP: 'ВПР(искомое; диапазон; номер_столбца; [интервальный_просмотр])', SUMIF: 'СУММЕСЛИ(диапазон; условие; [диапазон_суммирования])',
  COUNTIF: 'СЧЁТЕСЛИ(диапазон; условие)', ROUND: 'ОКРУГЛ(число; число_разрядов)', IFERROR: 'ЕСЛИОШИБКА(значение; значение_при_ошибке)',
  INDEX: 'ИНДЕКС(диапазон; номер_строки; [номер_столбца])', TEXT: 'ТЕКСТ(число; формат)', DATE: 'ДАТА(год; месяц; день)',
  CONCATENATE: 'СЦЕПИТЬ(текст1; [текст2; …])', LEFT: 'ЛЕВСИМВ(текст; [число_знаков])', MID: 'ПСТР(текст; начало; число_знаков)',
};
const EN_TO_RU = Object.fromEntries(Object.entries(RU_FUNCTIONS).map(([ru, en]) => [en, ru]));

let catalog: Array<{ name: string; en: string; about: string }> | null = null;
function functionCatalog(all: string[]): Array<{ name: string; en: string; about: string }> {
  if (catalog) return catalog;
  const out: Array<{ name: string; en: string; about: string }> = [];
  for (const [ru, en] of Object.entries(RU_FUNCTIONS)) out.push({ name: ru, en, about: ABOUT[en] || '' });
  for (const en of all) out.push({ name: en, en, about: ABOUT[en] || '' });
  catalog = out;
  return out;
}

/** Слово (имя функции), которое человек сейчас набирает перед курсором, и его начало. */
export function typingName(text: string, caret: number): { word: string; start: number } | null {
  if (!text.startsWith('=')) return null;
  const before = text.slice(0, caret);
  const inString = (before.match(/"/g) || []).length % 2 === 1;
  if (inString) return null;
  const m = /([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё.\d]*)$/.exec(before);
  if (!m) return null;
  const start = caret - m[1].length;
  const prev = before.slice(0, start).trimEnd();
  if (!/[=+\-*/^&(,;:<> ]$/.test(prev) && prev !== '=') return null;
  if (/^[A-Z]{1,3}\d+$/i.test(m[1])) return null; // это ссылка вида A1, не функция
  return { word: m[1], start };
}

export function suggestFunctions(word: string, all: string[], limit = 8): Array<{ name: string; about: string; signature: string }> {
  const w = word.toUpperCase();
  const seen = new Set<string>();
  const out: Array<{ name: string; about: string; signature: string }> = [];
  const list = functionCatalog(all);
  // Сначала — совпадение с начала (русские имена раньше английских), затем — по вхождению.
  for (const pass of [0, 1]) {
    for (const f of list) {
      if (out.length >= limit) break;
      const hitIt = pass === 0 ? f.name.startsWith(w) : !f.name.startsWith(w) && f.name.includes(w);
      if (!hitIt || seen.has(f.name)) continue;
      seen.add(f.name);
      out.push({ name: f.name, about: f.about, signature: SIGNATURE[f.en] ? (f.name === f.en ? SIGNATURE[f.en].replace(/^[^(]+/, f.en).replace(/; /g, ', ') : SIGNATURE[f.en]) : `${f.name}(…)` });
    }
  }
  return out;
}

/** Функция, внутри скобок которой стоит курсор, — для подсказки с аргументами. */
export function enclosingFunction(text: string, caret: number): string | null {
  let depth = 0;
  const before = text.slice(0, caret);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const ch = before[i];
    if (ch === ')') depth += 1;
    else if (ch === '(') {
      if (depth === 0) {
        const m = /([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё.\d]*)$/.exec(before.slice(0, i));
        return m ? m[1].toUpperCase() : null;
      }
      depth -= 1;
    }
  }
  return null;
}

export function signatureOf(name: string): string | null {
  const en = RU_FUNCTIONS[name] || name;
  const sig = SIGNATURE[en];
  if (!sig) return null;
  return RU_FUNCTIONS[name] ? sig : sig.replace(/^[^(]+/, en).replace(/; /g, ', ');
}
export { EN_TO_RU };
