import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownAZ, ArrowUpZA, Search } from 'lucide-react';
import { columnValues, readFilters, type FilterColumn } from '../sheet/filter';
import { colName, type Book, type Sheet } from '../sheet/model';

/**
 * Меню фильтра столбца (стрелка в заголовке), как в Google Таблицах: сортировка, поиск по значениям, галочки видимых
 * значений и «(Пустые)». «Применить» — условие столбца (filters), все отмечены — условие снимается.
 */
export function FilterMenu({ col, x, y, book, sheet, onClose, onApply, onSort }: {
  col: number; x: number; y: number; book: Book; sheet: Sheet;
  onClose: () => void; onApply: (col: number, criteria: FilterColumn | null) => void; onSort: (desc: boolean, col: number) => void;
}) {
  const filter = readFilters(book)[sheet.id];
  const { values, blank } = useMemo(() => (filter ? columnValues(book, sheet, filter, col) : { values: [], blank: false }), [book, sheet, filter, col]);
  const current = filter?.filterColumns?.find((c) => c.colId === col)?.filters;
  const [checked, setChecked] = useState<Set<string>>(() => new Set(current ? current.filters || [] : values));
  const [withBlank, setWithBlank] = useState(current ? Boolean(current.blank) : true);
  const [query, setQuery] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const shown = values.filter((v) => !query || v.toLowerCase().includes(query.toLowerCase()));

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(x - 20, window.innerWidth - r.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;
  }, [x, y]);
  useEffect(() => {
    const down = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key, true); };
  }, [onClose]);

  const toggle = (v: string) => setChecked((cur) => { const next = new Set(cur); if (next.has(v)) next.delete(v); else next.add(v); return next; });
  const apply = () => {
    const all = values.every((v) => checked.has(v)) && (withBlank || !blank);
    onApply(col, all ? null : { colId: col, filters: { ...(withBlank ? { blank: true as const } : {}), filters: values.filter((v) => checked.has(v)) } });
    onClose();
  };

  return createPortal(
    <div ref={box} className="fsh-fmenu" role="dialog" aria-label={`Фильтр столбца ${colName(col)}`}>
      <button type="button" className="fsh-fmenu-item" onClick={() => { onSort(false, col); onClose(); }}><ArrowDownAZ size={15} /> Сортировать А → Я</button>
      <button type="button" className="fsh-fmenu-item" onClick={() => { onSort(true, col); onClose(); }}><ArrowUpZA size={15} /> Сортировать Я → А</button>
      <div className="fsh-fmenu-sep" />
      <div className="fsh-fmenu-head">
        <button type="button" className="fsh-fmenu-link" onClick={() => { setChecked(new Set(values)); setWithBlank(true); }}>Выбрать все</button>
        <button type="button" className="fsh-fmenu-link" onClick={() => { setChecked(new Set()); setWithBlank(false); }}>Очистить</button>
      </div>
      <label className="fsh-fmenu-search">
        <Search size={14} aria-hidden="true" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти значение" autoFocus />
      </label>
      <div className="fsh-fmenu-list">
        {blank && !query && (
          <label className="fsh-fmenu-check"><input type="checkbox" checked={withBlank} onChange={() => setWithBlank(!withBlank)} /> <i>(Пустые)</i></label>
        )}
        {shown.slice(0, 500).map((v) => (
          <label key={v} className="fsh-fmenu-check"><input type="checkbox" checked={checked.has(v)} onChange={() => toggle(v)} /> <span>{v}</span></label>
        ))}
        {!shown.length && <p className="fsh-fmenu-empty">Ничего не найдено</p>}
      </div>
      <div className="fsh-fmenu-foot">
        <button type="button" className="nx-ghost" onClick={onClose}>Отмена</button>
        <button type="button" className="nx-primary" onClick={apply}>Применить</button>
      </div>
    </div>,
    document.querySelector('.nx') || document.body,
  );
}
