/**
 * «Где я был в Офисе»: вид, открытый материал, поиск и прокрутка списка. Раздел размонтируется, когда уходишь
 * в другой (чаты, почта), — без этой памяти возвращение начиналось бы со списка «Все». Живёт в sessionStorage
 * (перезагрузка окна возвращает на то же место), а не в localStorage: новый запуск начинается с чистого списка.
 */

export interface OfficePlace {
  /** Адресная строка раздела: ?kind=&id= */
  search: string;
  query: string;
  listScroll: number;
}

const KEY = 'nws:place';

export function readPlace(): OfficePlace | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    const value = raw ? (JSON.parse(raw) as Partial<OfficePlace>) : null;
    if (!value || typeof value.search !== 'string') return null;
    return { search: value.search, query: typeof value.query === 'string' ? value.query : '', listScroll: Number(value.listScroll) || 0 };
  } catch {
    return null;
  }
}

export function writePlace(patch: Partial<OfficePlace>) {
  try {
    const next = { search: '', query: '', listScroll: 0, ...readPlace(), ...patch };
    sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch { /* приватный режим — живём без памяти */ }
}
