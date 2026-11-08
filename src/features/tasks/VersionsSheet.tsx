import { useCallback, useEffect, useMemo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { diffLines, diffStats, type DiffLine } from '@/features/workspace';
import { askConfirm, Sheet } from '@/shared/ui/overlay';
import { Spinner } from '@/shared/ui/Spinner';
import { showToast } from '@/shared/ui/Toast';
import { plural } from '@/shared/ui/format';
import { restoreTaskVersion, saveTaskVersion, taskVersion, taskVersions, type TaskVersion } from './api';

/**
 * История версий задачи — как у документов Офиса: кто и когда сохранил, что изменилось по сравнению с предыдущей
 * версией, «Целиком», вернуть версию. Восстановление сперва кладёт текущее состояние в историю (сервер), поэтому обратимо.
 */

const when = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : iso;
};

/** Название и текст одним куском: изменение заголовка тоже видно в сравнении. */
const full = (title: string, md: string) => `# ${title || 'Без названия'}\n\n${md}`;

function Diff({ lines }: { lines: DiffLine[] }) {
  const shown = useMemo(() => {
    const near = new Set<number>();
    lines.forEach((l, i) => { if (l.kind !== 'same') for (let k = i - 2; k <= i + 2; k += 1) near.add(k); });
    const out: Array<DiffLine | { gap: number }> = [];
    let gap = 0;
    lines.forEach((l, i) => {
      if (l.kind === 'same' && !near.has(i)) { gap += 1; return; }
      if (gap) { out.push({ gap }); gap = 0; }
      out.push(l);
    });
    if (gap) out.push({ gap });
    return out;
  }, [lines]);
  return (
    <div className="ntv-diff" role="list">
      {shown.map((l, i) => ('gap' in l
        ? <div key={i} className="ntv-gap" role="listitem">… {l.gap} {plural(l.gap, ['строка', 'строки', 'строк'])} без изменений</div>
        : (
          <div key={i} className="ntv-line" data-kind={l.kind} role="listitem">
            <span className="ntv-sign" aria-label={l.kind === 'add' ? 'добавлено' : l.kind === 'del' ? 'убрано' : undefined}>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
            <span className="ntv-text">{l.parts ? l.parts.map((p, k) => (p.changed ? <mark key={k}>{p.text}</mark> : <span key={k}>{p.text}</span>)) : (l.text || ' ')}</span>
          </div>
        )))}
    </div>
  );
}

export function TaskVersionsSheet({ taskId, canRestore, onClose, onRestore }: {
  taskId: string;
  canRestore: boolean;
  onClose: () => void;
  /** Применить версию к задаче (обычным сохранением). */
  onRestore: (title: string, md: string) => Promise<void>;
}) {
  const [state, setState] = useState<{ versions: TaskVersion[]; ready: boolean } | null>(null);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<number | null>(null);
  const [shown, setShown] = useState<{ lines: DiffLine[]; whole: string; first: boolean } | null>(null);
  const [tab, setTab] = useState<'diff' | 'whole'>('diff');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState('');
  const [cache] = useState(() => new Map<number, { title: string; md: string }>());

  const load = useCallback(() => {
    taskVersions(taskId).then((d) => { setState(d); setError(''); }).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Не удалось загрузить историю'));
  }, [taskId]);
  useEffect(load, [load]);

  const content = useCallback(async (v: TaskVersion) => {
    if (!cache.has(v.id)) { const r = await taskVersion(taskId, v.id); cache.set(v.id, { title: r.title, md: r.md }); }
    return cache.get(v.id)!;
  }, [cache, taskId]);

  async function open(index: number) {
    if (!state) return;
    setPicked(index);
    setShown(null);
    try {
      const now = await content(state.versions[index]);
      const before = state.versions[index + 1];
      const prev = before ? await content(before) : null;
      setShown({ lines: diffLines(prev ? full(prev.title, prev.md) : '', full(now.title, now.md)), whole: full(now.title, now.md), first: !before });
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось открыть версию'); }
  }

  async function save() {
    setBusy('save');
    try {
      await saveTaskVersion(taskId, label.trim());
      setLabel('');
      load();
      showToast('Версия сохранена', 'success');
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить версию'); } finally { setBusy(''); }
  }

  async function restore(v: TaskVersion) {
    if (!await askConfirm({ title: 'Вернуть эту версию?', text: `Задача станет такой, какой была ${when(v.createdAt)}. Текущее состояние сохранится в истории — вернуться можно.`, confirm: 'Вернуть' })) return;
    setBusy('restore');
    try {
      const r = await restoreTaskVersion(taskId, v.id);
      await onRestore(r.title, r.md);
      showToast('Готово: задача возвращена', 'success');
      onClose();
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось вернуть'); setBusy(''); }
  }

  const version = state && picked !== null ? state.versions[picked] : null;
  const stats = shown ? diffStats(shown.lines) : null;
  return (
    <Sheet title="История версий" onClose={onClose} busy={Boolean(busy)}>
      <div className="ntv">
        {canRestore && state?.ready && (
          <div className="ntv-save">
            <input value={label} maxLength={80} placeholder="Название версии (необязательно)" aria-label="Название версии" onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
            <button type="button" className="nx-ghost" disabled={busy === 'save'} onClick={() => void save()}>Сохранить версию</button>
          </div>
        )}
        {error && <p className="nx-hint" data-tone="danger" role="alert">{error}</p>}
        {!state && !error && <div className="nx-state"><Spinner size={22} label="Загружаю" /></div>}
        {state && !state.ready && <p className="nx-hint">История версий ещё не включена на сервере: нужна схема (выкладка с -Schema).</p>}
        {state?.ready && (
          <ul className="ntv-list">
            {state.versions.map((v, index) => (
              <li key={v.id} aria-current={picked === index ? 'true' : undefined}>
                <button type="button" onClick={() => void open(index)}>
                  <b>{v.label || when(v.createdAt)}</b>
                  <span>{v.savedByName || 'Неизвестно'} · {when(v.createdAt)}</span>
                </button>
              </li>
            ))}
            {state.versions.length === 0 && <li className="ntv-empty">Версий пока нет: они появляются, когда задачу правят.</li>}
          </ul>
        )}
        {version && (
          <section className="ntv-view" aria-label="Что изменилось">
            <header>
              <div>
                <b>{version.label || when(version.createdAt)}</b>
                <span>{version.savedByName || 'Неизвестно'} · {when(version.createdAt)}</span>
                {stats && (stats.added || stats.removed) ? <span className="ntv-stats"><i data-kind="add">+{stats.added}</i> <i data-kind="del">−{stats.removed}</i></span> : null}
              </div>
              {canRestore && (
                <button type="button" className="nx-ghost" disabled={busy === 'restore'} onClick={() => void restore(version)}><RotateCcw size={14} aria-hidden="true" /> Вернуть эту версию</button>
              )}
            </header>
            <div className="nx-segment" role="group" aria-label="Показать">
              <button type="button" aria-pressed={tab === 'diff'} onClick={() => setTab('diff')}>Что изменилось</button>
              <button type="button" aria-pressed={tab === 'whole'} onClick={() => setTab('whole')}>Целиком</button>
            </div>
            {!shown ? <div className="nx-state"><Spinner size={18} label="Сравниваю" /></div>
              : tab === 'whole'
                ? <article className="ntv-prose"><Markdown remarkPlugins={[remarkGfm, remarkBreaks]}>{shown.whole}</Markdown></article>
                : (
                  <>
                    {shown.first && <p className="nx-hint">Это самая ранняя сохранённая версия — показано всё её содержимое как добавленное.</p>}
                    {stats && !stats.added && !stats.removed ? <p className="nx-hint">Текст не менялся.</p> : <Diff lines={shown.lines} />}
                  </>
                )}
          </section>
        )}
      </div>
    </Sheet>
  );
}
