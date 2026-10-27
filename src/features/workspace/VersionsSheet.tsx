import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, Clock, RotateCcw, Undo2 } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { askConfirm, Sheet } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { workspaceApi } from './api';
import { parseSnapshot, snapshotToMarkdown } from './lib/docSnapshot';
import { diffCells, diffLines, diffStats, type CellChange, type DiffLine } from './lib/diff';
import type { Kind, VersionRow, VersionsState } from './types';
import { Spinner } from '@/shared/ui/Spinner';

/** Postgres отдаёт «2026-10-16 16:20:25.039012+03»: приводим к виду, который понимает Date (миллисекунды, смещение с минутами). */
const parseWhen = (iso: string) => Date.parse(iso.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1').replace(/([+-]\d{2})$/, '$1:00'));

const when = (iso: string) => {
  const t = parseWhen(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : iso;
};

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  return `${n} ${m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many}`;
};

/** Текст состояния для сравнения: заметка — Markdown (вкладки — заголовками), документ — Markdown, презентация — текст
 *  по слайдам. Таблица сравнивается по ячейкам (cellsOf). */
async function textOf(kind: Kind, content: string): Promise<string> {
  if (kind === 'note') return content.replace(/^<!-- shar-tab: (.*?) -->$/gm, '── Вкладка «$1» ──');
  if (kind === 'document') {
    const snapshot = parseSnapshot(content);
    return snapshot ? snapshotToMarkdown(snapshot) : '';
  }
  if (kind === 'presentation') {
    const { parseDeck, plainText } = await import('./slides/deck');
    return parseDeck(content).slides.map((slide, i) => [
      `── Слайд ${i + 1} ──`,
      ...slide.elements.map((el) => (el.type === 'image' ? '[картинка]' : plainText((el as { html?: string }).html || ''))).filter(Boolean),
      ...(slide.notes ? [`Заметки: ${slide.notes}`] : []),
    ].join('\n')).join('\n');
  }
  return '';
}

async function cellsOf(content: string): Promise<Map<string, string>> {
  const { bookFromBase64, cellText } = await import('./lib/workbook');
  const map = new Map<string, string>();
  if (!content.trim()) return map;
  const book = await bookFromBase64(content);
  book.worksheets.forEach((sheet) => sheet.eachRow((row) => row.eachCell((cell) => {
    const text = cellText(cell);
    if (text !== '') map.set(`${sheet.name}!${cell.address}`, text);
  })));
  return map;
}

type Entry = { id: string; current: boolean; label: string; at: string; who: string; via: string };
type Compared = { lines?: DiffLine[]; cells?: CellChange[]; whole: string; first: boolean };

function Who({ entry }: { entry: Entry }) {
  return (
    <>
      {entry.who || 'Неизвестно'}
      {entry.via && <span className="nws-versions-via" title="Правка сделана агентом по MCP от имени этого человека"><Bot size={12} aria-hidden="true" /> через {entry.via}</span>}
    </>
  );
}

/** Построчная разница с подсветкой слов; длинные неизменные куски свёрнуты (по две строки вокруг правок). */
function DiffView({ lines }: { lines: DiffLine[] }) {
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
    <div className="nws-diff" role="list">
      {shown.map((l, i) => ('gap' in l
        ? <div key={i} className="nws-diff-gap" role="listitem">… {plural(l.gap, 'строка', 'строки', 'строк')} без изменений</div>
        : (
          <div key={i} className="nws-diff-line" data-kind={l.kind} role="listitem">
            <span className="nws-diff-sign" aria-label={l.kind === 'add' ? 'добавлено' : l.kind === 'del' ? 'убрано' : undefined}>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
            <span className="nws-diff-text">{l.parts ? l.parts.map((p, k) => (p.changed ? <mark key={k}>{p.text}</mark> : <span key={k}>{p.text}</span>)) : (l.text || ' ')}</span>
          </div>
        )))}
    </div>
  );
}

/**
 * История версий: каждое состояние материала — кто его сделал (и было ли это через агента), когда и что именно
 * изменил по сравнению с предыдущим: строки и слова в заметках, документах и слайдах, ячейки в таблицах. Любую правку
 * можно откатить (вернуть состояние до неё) или вернуть версию целиком; текущее состояние перед этим само уходит в
 * историю, поэтому откат обратим.
 */
export function VersionsSheet({ itemId, kind, currentContent, onClose, onRestored }: {
  itemId: string;
  kind: Kind;
  /** Содержимое как сейчас в редакторе (в том числе ещё не сохранённое). */
  currentContent: () => string;
  onClose: () => void;
  /** Материал вернули к версии — редактор надо открыть заново. */
  onRestored: () => void;
}) {
  const [state, setState] = useState<VersionsState | null>(null);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<number | null>(null);
  const [compared, setCompared] = useState<Compared | null>(null);
  const [tab, setTab] = useState<'diff' | 'whole'>('diff');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState('');
  const [contents] = useState(() => new Map<string, string>());

  const load = useCallback(() => {
    workspaceApi.versions(itemId).then((next) => { setState(next); setError(''); }).catch((cause) => setError(cause instanceof Error ? cause.message : 'Не удалось загрузить историю'));
  }, [itemId]);
  useEffect(load, [load]);

  const entries = useMemo<Entry[]>(() => (state ? [
    { id: 'current', current: true, label: '', at: state.current.updatedAt, who: state.current.savedByName, via: state.current.savedVia || '' },
    ...state.versions.map((v: VersionRow) => ({ id: v.id, current: false, label: v.label, at: v.createdAt, who: v.savedByName, via: v.savedVia || '' })),
  ] : []), [state]);

  const contentOf = useCallback(async (entry: Entry) => {
    if (entry.current) return currentContent();
    if (!contents.has(entry.id)) contents.set(entry.id, (await workspaceApi.version(itemId, entry.id)).content);
    return contents.get(entry.id)!;
  }, [contents, currentContent, itemId]);

  async function open(index: number) {
    setPicked(index);
    setCompared(null);
    setBusy(`open:${index}`);
    try {
      const entry = entries[index];
      const previous = entries[index + 1];
      const now = await contentOf(entry);
      const before = previous ? await contentOf(previous) : '';
      if (kind === 'table') {
        const [a, b] = await Promise.all([cellsOf(before), cellsOf(now)]);
        setCompared({ cells: diffCells(a, b), whole: [...b.entries()].slice(0, 400).map(([k, v]) => `${k.replace('!', ' · ')}: ${v}`).join('\n'), first: !previous });
      } else {
        const [a, b] = await Promise.all([textOf(kind, before), textOf(kind, now)]);
        setCompared({ lines: diffLines(a, b), whole: b, first: !previous });
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось открыть версию'); } finally { setBusy(''); }
  }

  async function save() {
    setBusy('save');
    try {
      setState(await workspaceApi.saveVersion(itemId, label));
      setLabel('');
      showToast('Версия сохранена', 'success');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось сохранить версию'); } finally { setBusy(''); }
  }

  /** Вернуть версию: саму выбранную или ту, что была до выбранной правки (откат правки). */
  async function restore(target: Entry, text: string) {
    if (!(await askConfirm({ title: 'Вернуть?', text, confirm: 'Вернуть' }))) return;
    setBusy('restore');
    try {
      await workspaceApi.restoreVersion(itemId, target.id);
      showToast('Готово: материал возвращён', 'success');
      onRestored();
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось вернуть'); setBusy(''); }
  }

  const entry = picked !== null ? entries[picked] : null;
  const previous = picked !== null ? entries[picked + 1] : undefined;
  const stats = compared?.lines ? diffStats(compared.lines) : null;
  const nothing = compared && ((compared.lines && !stats?.added && !stats?.removed) || (compared.cells && !compared.cells.length));

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
            {entries.map((e, index) => (
              <li key={e.id} className={e.current ? 'is-current' : undefined} aria-current={picked === index ? 'true' : undefined} data-agent={e.via ? 'true' : undefined}>
                <button type="button" disabled={busy === `open:${index}`} onClick={() => void open(index)}>
                  <span className="nws-versions-dot" aria-hidden="true">{e.current ? <Clock size={13} /> : e.via ? <Bot size={12} /> : null}</span>
                  <span className="nws-versions-text">
                    <b>{e.current ? 'Сейчас' : e.label || when(e.at)}</b>
                    <span><Who entry={e} /> · {when(e.at)}</span>
                  </span>
                </button>
              </li>
            ))}
            {state.versions.length === 0 && <li className="nws-versions-empty">Прошлых версий пока нет: они появляются, когда материал правят.</li>}
          </ul>
        )}
        {entry && (
          <section className="nws-versions-view" aria-label="Что изменилось">
            <header>
              <div className="nws-versions-who">
                <b><Who entry={entry} /></b>
                <span>{entry.current ? 'сейчас, ' : ''}{when(entry.at)}{entry.label ? ` · ${entry.label}` : ''}</span>
                {stats && (stats.added || stats.removed) ? <span className="nws-versions-stats"><i data-kind="add">+{stats.added}</i> <i data-kind="del">−{stats.removed}</i> {plural(stats.added + stats.removed, 'строка', 'строки', 'строк')}</span> : null}
                {compared?.cells && compared.cells.length > 0 && <span className="nws-versions-stats">{plural(compared.cells.length, 'ячейка изменена', 'ячейки изменены', 'ячеек изменено')}</span>}
              </div>
              {state?.canRestore && (
                <div className="nws-versions-actions">
                  {previous && (
                    <button type="button" className="nx-primary" disabled={busy === 'restore'}
                      onClick={() => void restore(previous, entry.current
                        ? 'Материал станет таким, каким был до последней правки. Текущее состояние сохранится в истории.'
                        : 'Материал станет таким, каким был до этой правки; более поздние правки тоже уйдут. Текущее состояние сохранится в истории — вернуться можно.')}>
                      <Undo2 size={14} aria-hidden="true" /> {entry.via ? 'Откатить правку агента' : 'Откатить эту правку'}
                    </button>
                  )}
                  {!entry.current && (
                    <button type="button" className="nx-ghost" disabled={busy === 'restore'}
                      onClick={() => void restore(entry, `Материал станет таким, каким был ${when(entry.at)}. Текущее состояние сохранится в истории.`)}>
                      <RotateCcw size={14} aria-hidden="true" /> Вернуть эту версию
                    </button>
                  )}
                </div>
              )}
            </header>
            <div className="nx-segment" role="group" aria-label="Показать">
              <button type="button" aria-pressed={tab === 'diff'} onClick={() => setTab('diff')}>Что изменилось</button>
              <button type="button" aria-pressed={tab === 'whole'} onClick={() => setTab('whole')}>Целиком</button>
            </div>
            {!compared ? <div className="nx-state"><Spinner size={18} label="Сравниваю" /></div>
              : tab === 'whole' ? (
                compared.whole.trim()
                  ? kind === 'table' || kind === 'presentation'
                    ? <pre className="nws-versions-plain">{compared.whole}</pre>
                    : <article className="nws-versions-prose"><Markdown remarkPlugins={[remarkGfm, remarkBreaks]}>{compared.whole}</Markdown></article>
                  : <p className="nx-hint">В этом состоянии пусто.</p>
              ) : (
                <>
                  {compared.first && <p className="nx-hint">Это самая ранняя сохранённая версия — показано всё её содержимое как добавленное.</p>}
                  {nothing && <p className="nx-hint">Текст не менялся — правка затронула только оформление или название.</p>}
                  {compared.lines && !nothing && <DiffView lines={compared.lines} />}
                  {compared.cells && compared.cells.length > 0 && (
                    <ul className="nws-cells">
                      {compared.cells.slice(0, 500).map((c) => (
                        <li key={`${c.sheet}!${c.ref}`}>
                          <span className="nws-cells-ref">{c.sheet} · {c.ref}</span>
                          {c.before ? <del>{c.before}</del> : <em>пусто</em>}
                          <span aria-hidden="true">→</span>
                          {c.after ? <ins>{c.after}</ins> : <em>пусто</em>}
                        </li>
                      ))}
                      {compared.cells.length > 500 && <li className="nws-cells-more">и ещё {compared.cells.length - 500}</li>}
                    </ul>
                  )}
                </>
              )}
          </section>
        )}
      </div>
    </Sheet>
  );
}
