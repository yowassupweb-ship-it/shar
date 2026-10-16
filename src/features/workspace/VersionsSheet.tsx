import { useCallback, useEffect, useState } from 'react';
import { Clock, RotateCcw } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { askConfirm, Sheet } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { workspaceApi } from './api';
import { parseSnapshot, snapshotToMarkdown } from './lib/docSnapshot';
import type { Kind, VersionRow, VersionsState } from './types';
import { Spinner } from '@/shared/ui/Spinner';

/** Postgres отдаёт «2026-10-16 16:20:25.039012+03»: приводим к виду, который понимает Date (миллисекунды, смещение с минутами). */
const parseWhen = (iso: string) => Date.parse(iso.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1').replace(/([+-]\d{2})$/, '$1:00'));

const when = (iso: string) => {
  const t = parseWhen(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : iso;
};

const size = (bytes: number) => (bytes < 1024 ? `${bytes} Б` : bytes < 1048576 ? `${Math.round(bytes / 1024)} КБ` : `${(bytes / 1048576).toFixed(1)} МБ`);

/** Текст версии для просмотра: у заметки это сам Markdown, у документа — его текст; таблицу и презентацию не рисуем. */
function previewOf(kind: Kind, content: string): string | null {
  if (kind === 'note') return content;
  if (kind === 'document') {
    const snapshot = parseSnapshot(content);
    return snapshot ? snapshotToMarkdown(snapshot) : '';
  }
  return null;
}

/**
 * История версий, как в Google Docs и MBOX: список состояний материала с именем того, кто его правил, и временем.
 * Версию можно посмотреть, а владельцу и редакторам — восстановить (перед восстановлением текущее состояние
 * само попадает в историю, поэтому откат обратим) или сохранить текущее состояние как именованную версию.
 */
export function VersionsSheet({ itemId, kind, onClose, onRestored }: {
  itemId: string;
  kind: Kind;
  onClose: () => void;
  /** Материал вернули к версии — редактор надо открыть заново. */
  onRestored: () => void;
}) {
  const [state, setState] = useState<VersionsState | null>(null);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<(VersionRow & { content: string }) | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    workspaceApi.versions(itemId).then((next) => { setState(next); setError(''); }).catch((cause) => setError(cause instanceof Error ? cause.message : 'Не удалось загрузить историю'));
  }, [itemId]);
  useEffect(load, [load]);

  async function open(version: VersionRow) {
    setBusy(`open:${version.id}`);
    try { setPicked(await workspaceApi.version(itemId, version.id)); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось открыть версию'); } finally { setBusy(''); }
  }

  async function save() {
    setBusy('save');
    try {
      setState(await workspaceApi.saveVersion(itemId, label));
      setLabel('');
      showToast('Версия сохранена', 'success');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось сохранить версию'); } finally { setBusy(''); }
  }

  async function restore(version: VersionRow) {
    const ok = await askConfirm({
      title: 'Вернуть эту версию?',
      text: `Материал станет таким, каким он был ${when(version.createdAt)}. Текущее состояние сохранится в истории — вернуться обратно можно.`,
      confirm: 'Вернуть',
    });
    if (!ok) return;
    setBusy('restore');
    try {
      await workspaceApi.restoreVersion(itemId, version.id);
      showToast('Версия восстановлена', 'success');
      onRestored();
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось восстановить'); setBusy(''); }
  }

  const text = picked ? previewOf(kind, picked.content) : null;

  return (
    <Sheet title="История версий" onClose={onClose} busy={Boolean(busy)}>
      <div className="nws-versions">
        {state?.canRestore && (
          <div className="nws-versions-save">
            <input value={label} maxLength={80} placeholder="Название версии (необязательно)" aria-label="Название версии" onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
            <button type="button" className="nx-ghost" disabled={busy === 'save'} onClick={() => void save()}>Сохранить версию</button>
          </div>
        )}
        {error && <p className="nx-hint nws-error" role="alert">{error}</p>}
        {!state && !error && <div className="nx-state"><Spinner size={22} label="Загружаю" /></div>}
        {state && (
          <ul className="nws-versions-list">
            <li className="is-current">
              <span className="nws-versions-dot" aria-hidden="true"><Clock size={13} /></span>
              <span className="nws-versions-text">
                <b>Текущая версия</b>
                <span>{[state.current.savedByName, when(state.current.updatedAt)].filter(Boolean).join(' · ')}</span>
              </span>
            </li>
            {state.versions.length === 0 && <li className="nws-versions-empty">Прошлых версий пока нет: они появляются, когда материал правят.</li>}
            {state.versions.map((version) => (
              <li key={version.id} aria-current={picked?.id === version.id ? 'true' : undefined}>
                <button type="button" disabled={busy === `open:${version.id}`} onClick={() => void open(version)}>
                  <span className="nws-versions-dot" aria-hidden="true" />
                  <span className="nws-versions-text">
                    <b>{version.label || when(version.createdAt)}</b>
                    <span>{[version.label ? when(version.createdAt) : '', version.savedByName ? `правил(а) ${version.savedByName}` : '', size(version.size)].filter(Boolean).join(' · ')}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {picked && (
          <section className="nws-versions-view" aria-label="Содержимое версии">
            <header>
              <b>{picked.label || when(picked.createdAt)}</b>
              {state?.canRestore && (
                <button type="button" className="nx-primary" disabled={busy === 'restore'} onClick={() => void restore(picked)}>
                  <RotateCcw size={14} aria-hidden="true" /> Вернуть эту версию
                </button>
              )}
            </header>
            {text === null
              ? <p className="nx-hint">Для этого вида предпросмотр недоступен — версию можно только вернуть.</p>
              : text.trim()
                ? <article className="nws-versions-prose"><Markdown remarkPlugins={[remarkGfm, remarkBreaks]}>{text}</Markdown></article>
                : <p className="nx-hint">В этой версии пусто.</p>}
          </section>
        )}
      </div>
    </Sheet>
  );
}
