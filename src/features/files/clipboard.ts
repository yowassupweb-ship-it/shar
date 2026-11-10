import { fileUrl, type CloudFile } from './api';

/**
 * Буфер обмена раздела «Файлы».
 *
 * «Копировать» кладёт файл в системный буфер как файл (в приложении Windows — через главный процесс), так что его можно
 * вставить в Проводник, в поле чата, в письмо. Параллельно раздел помнит скопированное у себя: в браузере файл в
 * системный буфер не положить, а вставка внутри раздела («Вставить» в папке) нужна и там.
 */

let held: CloudFile[] = [];

/** Что скопировано в этом разделе и ещё не забыто. */
export const heldFiles = () => held;
export const forgetHeld = () => { held = []; };

export type CopyHow = 'system' | 'image' | 'app';

/** PNG из любой картинки: в системный буфер браузер принимает только его. */
async function toPng(blob: Blob): Promise<Blob | null> {
  if (blob.type === 'image/png') return blob;
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  } catch { return null; }
}

/** Скопировать файлы: как файлы (приложение) → как картинку (браузер) → только внутри раздела. */
export async function copyFiles(files: CloudFile[]): Promise<CopyHow> {
  held = files.slice();
  const desktop = window.sharDesktop?.copyFilesToClipboard;
  if (desktop) {
    try {
      const n = await desktop(files.map((f) => ({ url: new URL(fileUrl(f.url), window.location.href).href, name: f.name })));
      if (n > 0) return 'system';
    } catch { /* ниже — запасной путь */ }
  }
  const only = files.length === 1 ? files[0] : null;
  if (only && /^image\//i.test(only.mimeType || '') && typeof ClipboardItem !== 'undefined') {
    try {
      const png = await toPng(await (await fetch(fileUrl(only.url))).blob());
      if (png) { await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]); return 'image'; }
    } catch { /* без картинки в системном буфере раздел всё равно помнит файл */ }
  }
  return 'app';
}

/** Имя, которого ещё нет среди `taken`: «отчёт.pdf» → «отчёт (копия).pdf» → «отчёт (копия 2).pdf». */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; ; n += 1) {
    const next = `${base} (копия${n > 1 ? ` ${n}` : ''})${ext}`;
    if (!used.has(next)) return next;
  }
}

/** Настоящая копия файла: качаем и загружаем заново, чтобы удаление одного не ломало другой. */
export async function duplicateAsFile(f: CloudFile, name: string): Promise<File> {
  const res = await fetch(fileUrl(f.url));
  if (!res.ok) throw new Error(String(res.status));
  const blob = await res.blob();
  return new File([blob], name, { type: f.mimeType || blob.type });
}
