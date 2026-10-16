import { navigate } from '@/shared/navigation/navigate';
import { links } from '@/shared/navigation/routes';
import { showToast } from '@/shared/ui/Toast';
import { workspaceApi } from '../api';
import { importFile } from '../lib/importFile';
import type { FileRef } from './kinds';

/**
 * Вложение чата → новый материал «Офиса» (Word и текст — документ, Excel — таблица) и переход в редактор.
 * Исходный файл остаётся в чате нетронутым: правится копия, которая принадлежит нажавшему.
 */
export async function openInEditor(file: FileRef): Promise<boolean> {
  try {
    const res = await fetch(file.url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`Файл не открылся (${res.status})`);
    const blob = await res.blob();
    const imported = await importFile(new File([blob], file.name, { type: blob.type }));
    const item = await workspaceApi.create({ kind: imported.kind, title: imported.title, content: imported.content });
    showToast('Открыто в редакторе — это копия файла из чата', 'success');
    navigate(links.office(item.kind, item.id));
    return true;
  } catch (cause) {
    showToast(cause instanceof Error ? cause.message : 'Не удалось открыть в редакторе', 'error');
    return false;
  }
}
