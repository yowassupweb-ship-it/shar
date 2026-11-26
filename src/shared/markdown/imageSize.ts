/**
 * Размер картинки в тексте задачи хранится в самой ссылке — меткой «#w=NN» в конце адреса (NN — проценты ширины
 * текста, 10…100): `![фото](https://…/a.jpg#w=50)`. Так markdown остаётся обычным (метку понимают просмотр,
 * визуальный редактор и HTML; другие программы её просто не заметят), а запрос картинки от неё не меняется.
 * Нет метки — картинка в своём размере, но не шире текста.
 */
export const IMAGE_MIN_WIDTH = 10;
const MARK = /#w=(\d{1,3})$/;

export function imageWidth(src: string | null | undefined): number | null {
  const m = MARK.exec(String(src || ''));
  if (!m) return null;
  const n = Number(m[1]);
  return n >= IMAGE_MIN_WIDTH && n <= 100 ? n : null;
}

/** Адрес с новой шириной (null — убрать метку, исходный размер). */
export function withImageWidth(src: string, width: number | null): string {
  const base = String(src || '').replace(MARK, '');
  if (width === null) return base;
  const w = Math.max(IMAGE_MIN_WIDTH, Math.min(100, Math.round(width)));
  return `${base}#w=${w}`;
}
