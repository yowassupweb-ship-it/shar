import { navigate } from '@/shared/navigation/navigate';
import { links } from '@/shared/navigation/routes';
import { showToast } from '@/shared/ui/Toast';
import { workspaceApi } from '../api';
import { importFile } from '../lib/importFile';
import type { FileRef } from './kinds';

/**
 * «Открыть в Шаре»: файл из чата или «Файлов» → новый материал «Офиса» (Word и текст — документ, Excel и CSV — таблица,
 * PowerPoint и PDF — презентация) и переход в редактор. Исходный файл не трогается: правится копия нажавшего.
 */
export async function openInEditor(file: FileRef): Promise<boolean> {
  try {
    const res = await fetch(file.url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`Файл не открылся (${res.status})`);
    const blob = await res.blob();
    const imported = await importFile(new File([blob], file.name, { type: blob.type }));
    const item = await workspaceApi.create({ kind: imported.kind, title: imported.title, content: imported.content });
    showToast('Открыто в Шаре — это копия, исходный файл не изменится', 'success');
    navigate(links.office(item.kind, item.id));
    return true;
  } catch (cause) {
    showToast(cause instanceof Error ? cause.message : 'Не удалось открыть в Шаре', 'error');
    return false;
  }
}
