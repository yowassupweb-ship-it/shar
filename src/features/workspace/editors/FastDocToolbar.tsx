import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useEditorState, type Editor } from '@tiptap/react';
import { redoDepth, undoDepth } from '@tiptap/pm/history';
import {
  OAlignCenter, OAlignJustify, OAlignLeft, OAlignRight, OBold, OBulletedList, OChecklist, OChevronDown, OClearFormat, ODecreaseIndent, OEmoji,
  OFontSizeMinus, OFontSizePlus, OHighlightColor, OIncreaseIndent, OInsertImage, OInsertLink, OItalic, OLineSpacing, ONumberedList, OPaintFormat, OPrint,
  ORedo, OSpecialCharacter, OStrikethrough, OSubscript, OSuperscript, OTextColor, OUnderline, OUndo,
} from '@/shared/ui/OfficeIcons';

/**
 * Панель оформления своего редактора — в порядке и с набором Google Документов (и прежнего Univer):
 * ↶ ↷ печать, копировать формат | стиль | шрифт | − размер + | Ж К Ч, цвет текста, цвет фона | ссылка, картинка |
 * выравнивание | интервал | чек-лист, маркеры, нумерация | отступ − + | очистить формат | ⋮ (зачёркнутый, индексы,
 * эмодзи, символы).
 *
 * Межстрочный интервал, интервалы до/после и отступы пишутся в стиль абзаца Univer (атрибут ps) — снимок сохраняет их
 * как было (lib/pmToUniver.ts). «Название» и «Подзаголовок» — именованные стили Univer (namedStyleType 2 и 3).
 */

type Chain = ReturnType<Editor['chain']>;
type Ps = Record<string, unknown> & { lineSpacing?: number; spaceAbove?: { v: number }; spaceBelow?: { v: number }; indentStart?: { v: number }; namedStyleType?: number };

export const FONTS = ['Arial', 'Inter', 'Roboto', 'Times New Roman', 'Georgia', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Courier New', 'Calibri', 'Cambria', 'Comic Sans MS'];
const SIZES = [6, 7, 8, 9, 10, 10.5, 11, 12, 14, 15, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 48, 56, 64, 72, 96];
const STYLES: Array<{ id: string; label: string; level?: 1 | 2 | 3 | 4 | 5; named?: number }> = [
  { id: 'p', label: 'Обычный текст' },
  { id: 'title', label: 'Название', level: 1, named: 2 },
  { id: 'subtitle', label: 'Подзаголовок', level: 2, named: 3 },
  { id: 'h1', label: 'Заголовок 1', level: 1, named: 4 },
  { id: 'h2', label: 'Заголовок 2', level: 2, named: 5 },
  { id: 'h3', label: 'Заголовок 3', level: 3, named: 6 },
  { id: 'h4', label: 'Заголовок 4', level: 4, named: 7 },
  { id: 'h5', label: 'Заголовок 5', level: 5, named: 8 },
];
const SPACINGS = [{ v: 1, label: 'Одинарный' }, { v: 1.15, label: '1,15' }, { v: 1.5, label: '1,5' }, { v: 2, label: 'Двойной' }];
/** Шаг отступа — 1,27 см (36 pt), как в Google Документах. */
const INDENT_PT = 36;

// Палитра Google Документов: серые, яркие и шесть строк оттенков.
const GRAYS = ['#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff'];
const BRIGHT = ['#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff'];
const SHADES = [
  ['#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc'],
  ['#dd7e6b', '#ea9999', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#a4c2f4', '#9fc5e8', '#b4a7d6', '#d5a6bd'],
  ['#cc4125', '#e06666', '#f6b26b', '#ffd966', '#93c47d', '#76a5af', '#6d9eeb', '#6fa8dc', '#8e7cc3', '#c27ba0'],
  ['#a61c00', '#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3c78d8', '#3d85c6', '#674ea7', '#a64d79'],
  ['#85200c', '#990000', '#b45f06', '#bf9000', '#38761d', '#134f5c', '#1155cc', '#0b5394', '#351c75', '#741b47'],
  ['#5b0f00', '#660000', '#783f04', '#7f6000', '#274e13', '#0c343d', '#1c4587', '#073763', '#20124d', '#4c1130'],
];

const ptOf = (v: unknown): number => Number(typeof v === 'object' && v ? (v as { v?: number }).v : v) || 0;

/** Поменять стиль абзаца Univer (ps) у всех абзацев выделения. */
function patchPs(editor: Editor, patch: (ps: Ps) => Ps) {
  const { state } = editor;
  const tr = state.tr;
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
    if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return true;
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, ps: patch({ ...((node.attrs.ps as Ps) || {}) }) });
    return false;
  });
  if (tr.docChanged) editor.view.dispatch(tr);
  editor.commands.focus();
}

/** Всплывающая панель у кнопки (палитра, списки выбора). Закрывается кликом мимо и Esc. */
function Pop({ anchor, onClose, children, className }: { anchor: DOMRect; onClose: () => void; children: ReactNode; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const place = () => {
      const { width, height } = el.getBoundingClientRect();
      el.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))}px`;
      el.style.top = `${Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - height - 8))}px`;
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor]);
  useEffect(() => {
    const down = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
      if (!['ArrowDown', 'ArrowUp'].includes(e.key) || (e.target as HTMLElement).tagName === 'INPUT') return;
      if (!box.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest('.fdoc-bar')) return;
      const buttons = Array.from(box.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      if (!buttons.length) return;
      e.preventDefault(); e.stopPropagation();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = index < 0 ? (e.key === 'ArrowDown' ? 0 : buttons.length - 1) : (index + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
      buttons[next].focus();
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key, true); };
  }, [onClose]);
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - 300));
  return createPortal(
    <div ref={box} role="dialog" aria-label="Настройки оформления" className={`fdoc-pop ${className || ''}`} style={{ left, top: anchor.bottom + 6 }} onMouseDown={(e) => { if ((e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault(); }}>
      {children}
    </div>,
    // В корень Шара (.nx), а не в body: там заданы цвета темы — иначе фон окна был прозрачным.
    document.querySelector('.nx') || document.body,
  );
}

function Palette({ current, onPick, onReset, resetLabel, ResetIcon }: { current: string; onPick: (c: string) => void; onReset: () => void; resetLabel: string; ResetIcon: typeof OClearFormat }) {
  const cur = current.toLowerCase();
  const sw = (c: string) => (
    <button key={c} type="button" className="fdoc-sw" style={{ background: c }} data-light={GRAYS.indexOf(c) >= 6 || undefined}
      aria-pressed={cur === c} onClick={() => onPick(c)} aria-label={c} title={c} />
  );
  return (
    <div className="fdoc-palette">
      <button type="button" className="fdoc-pal-reset" onClick={onReset}><ResetIcon size={15} aria-hidden="true" />{resetLabel}</button>
      <div className="fdoc-pal-grid">{GRAYS.map(sw)}</div>
      <div className="fdoc-pal-grid fdoc-pal-bright">{BRIGHT.map(sw)}</div>
      <div className="fdoc-pal-grid">{SHADES.flat().map(sw)}</div>
      <div className="fdoc-pal-foot">
        <span>Свой</span>
        <label className="fdoc-sw fdoc-sw-custom" title="Выбрать свой цвет" aria-label="Выбрать свой цвет">
          <OFontSizePlus size={12} aria-hidden="true" />
          <input type="color" defaultValue={/^#[0-9a-f]{6}$/i.test(cur) ? cur : '#1a73e8'} onChange={(e) => onPick(e.target.value)} />
        </label>
      </div>
    </div>
  );
}

export function FastDocToolbar({ editor, onPicture, onPick, onLink, zoom }: {
  editor: Editor;
  onPicture: () => void;
  onPick: (kind: 'emoji' | 'symbol', at: { x: number; y: number }) => void;
  onLink: () => void;
  /** Масштаб листа — выпадающим списком в панели, как «100%» у Google. */
  zoom: { value: number; fit: boolean; pick: (z: number | 'fit') => void; options: number[] };
}) {
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const ts = e.getAttributes('textStyle');
      const block = e.state.selection.$from.parent;
      const ps = (block.attrs.ps as Ps) || {};
      const named = Number(ps.namedStyleType) || 0;
      const level = block.type.name === 'heading' ? Number(block.attrs.level) : 0;
      const style = !level ? 'p' : named === 2 ? 'title' : named === 3 ? 'subtitle' : `h${level}`;
      return {
        bold: e.isActive('bold'), italic: e.isActive('italic'), underline: e.isActive('underline'), strike: e.isActive('strike'),
        sub: e.isActive('subscript'), sup: e.isActive('superscript'),
        bullet: e.isActive('bulletList'), ordered: e.isActive('orderedList'), task: e.isActive('taskList'), link: e.isActive('link'),
        align: (['center', 'right', 'justify'] as const).find((a) => e.isActive({ textAlign: a })) ?? 'left',
        style,
        font: String(ts.fontFamily || '').replace(/^["']|["']$/g, '') || 'Arial',
        size: Number(String(ts.fontSize || '').replace(/pt$/, '')) || 0,
        color: String(ts.color || ''), bg: String(ts.backgroundColor || ''),
        spacing: Number(ps.lineSpacing) || 1.15,
        canUndo: undoDepth(e.state) > 0, canRedo: redoDepth(e.state) > 0,
      };
    },
  });
  const [pop, setPop] = useState<{ kind: string; at: DOMRect } | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || el.scrollWidth <= el.clientWidth + 1) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? el.clientWidth : 1;
      el.scrollLeft += delta * unit;
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  const [painter, setPainter] = useState<null | { marks: ReturnType<Editor['state']['selection']['$from']['marks']>; align: string | null; ps: Ps | null }>(null);
  const [sizeDraft, setSizeDraft] = useState<string | null>(null);
  const skipSizeBlur = useRef(false);
  const run = (fn: (c: Chain) => Chain) => fn(editor.chain().focus()).run();
  const open = (kind: string) => (e: React.MouseEvent<HTMLElement>) => { const at = e.currentTarget.getBoundingClientRect(); setPop((p) => (p?.kind === kind ? null : { kind, at })); };
  const close = () => setPop(null);

  // Копировать формат: запомнили оформление у курсора, следующее выделение получает его (Esc — отмена).
  useEffect(() => {
    if (!painter) return undefined;
    const apply = () => {
      if (editor.state.selection.empty) return;
      const { from, to } = editor.state.selection;
      const tr = editor.state.tr;
      tr.removeMark(from, to);
      for (const m of painter.marks) tr.addMark(from, to, m);
      editor.view.dispatch(tr);
      if (painter.align || painter.ps) {
        editor.chain().setTextAlign((painter.align as 'left') || 'left').run();
        if (painter.ps) patchPs(editor, (ps) => ({ ...ps, lineSpacing: painter.ps!.lineSpacing, spaceAbove: painter.ps!.spaceAbove, spaceBelow: painter.ps!.spaceBelow }));
      }
      setPainter(null);
    };
    const dom = editor.view.dom;
    const up = () => window.setTimeout(apply, 0);
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setPainter(null); };
    dom.addEventListener('mouseup', up);
    document.addEventListener('keydown', esc);
    dom.classList.add('fdoc-painting');
    return () => { dom.removeEventListener('mouseup', up); document.removeEventListener('keydown', esc); dom.classList.remove('fdoc-painting'); };
  }, [painter, editor]);

  const size = st.size || 11;
  const setSize = (n: number) => { const v = Math.max(1, Math.min(400, Math.round(n * 2) / 2)); run((c) => c.setFontSize(`${v}pt`)); };
  const stepSize = (d: 1 | -1) => {
    const next = d > 0 ? SIZES.find((x) => x > size) ?? size + 1 : [...SIZES].reverse().find((x) => x < size) ?? Math.max(1, size - 1);
    setSize(next);
  };
  const setStyle = (id: string) => {
    const s = STYLES.find((x) => x.id === id)!;
    if (!s.level) run((c) => c.setParagraph());
    else run((c) => c.setHeading({ level: s.level! }));
    patchPs(editor, (ps) => { const next = { ...ps }; if (s.named) next.namedStyleType = s.named; else delete next.namedStyleType; return next; });
    close();
  };
  const indent = (d: 1 | -1) => {
    if (editor.isActive('listItem') || editor.isActive('taskItem')) {
      const item = editor.isActive('taskItem') ? 'taskItem' : 'listItem';
      run((c) => (d > 0 ? c.sinkListItem(item) : c.liftListItem(item)));
      return;
    }
    patchPs(editor, (ps) => ({ ...ps, indentStart: { v: Math.max(0, ptOf(ps.indentStart) + d * INDENT_PT) } }));
  };
  const btn = (key: string, title: string, active: boolean, icon: ReactNode, action: (e: React.MouseEvent<HTMLButtonElement>) => void, disabled = false) => (
    <button key={key} type="button" className="fdoc-btn" title={title} aria-label={title} aria-pressed={active} disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} onClick={action}>{icon}</button>
  );
  const styleLabel = STYLES.find((s) => s.id === st.style)?.label ?? 'Обычный текст';
  const AlignIcon = st.align === 'center' ? OAlignCenter : st.align === 'right' ? OAlignRight : st.align === 'justify' ? OAlignJustify : OAlignLeft;

  return (
    <div className="fdoc-bar-wrap">
      <div ref={bar} className="fdoc-bar" role="toolbar" aria-label="Оформление" onScroll={() => setPop(null)}>
        {btn('undo', 'Отменить (Ctrl+Z)', false, <OUndo size={18} />, () => run((c) => c.undo()), !st.canUndo)}
        {btn('redo', 'Повторить (Ctrl+Y)', false, <ORedo size={18} />, () => run((c) => c.redo()), !st.canRedo)}
        {btn('print', 'Печать (Ctrl+P)', false, <OPrint size={18} />, () => window.dispatchEvent(new Event('nx:print-item')))}
        {btn('paint', painter ? 'Копирование формата: выделите текст (Esc — отмена)' : 'Копировать форматирование', Boolean(painter), <OPaintFormat size={18} />, () => {
          if (painter) { setPainter(null); return; }
          const { $from } = editor.state.selection;
          setPainter({ marks: editor.state.storedMarks || $from.marks(), align: ($from.parent.attrs.textAlign as string) || null, ps: ($from.parent.attrs.ps as Ps) || null });
        })}
        <button type="button" className="fdoc-drop fdoc-drop-zoom" onMouseDown={(e) => e.preventDefault()} onClick={open('zoom')} aria-expanded={pop?.kind === 'zoom'} aria-haspopup="dialog" title="Масштаб (Ctrl+колесо)">
          <span>{Math.round(zoom.value * 100)}%</span><OChevronDown size={14} aria-hidden="true" />
        </button>
        <span className="fdoc-sep" />
        <button type="button" className="fdoc-drop fdoc-drop-style" onMouseDown={(e) => e.preventDefault()} onClick={open('style')} aria-expanded={pop?.kind === 'style'} aria-haspopup="dialog" title="Стиль абзаца">
          <span>{styleLabel}</span><OChevronDown size={14} aria-hidden="true" />
        </button>
        <span className="fdoc-sep" />
        <button type="button" className="fdoc-drop fdoc-drop-font" onMouseDown={(e) => e.preventDefault()} onClick={open('font')} aria-expanded={pop?.kind === 'font'} aria-haspopup="dialog" title="Шрифт">
          <span style={{ fontFamily: st.font }}>{st.font}</span><OChevronDown size={14} aria-hidden="true" />
        </button>
        <span className="fdoc-sep" />
        <span className="fdoc-size" role="group" aria-label="Размер шрифта">
          {btn('sz-', 'Уменьшить размер шрифта', false, <OFontSizeMinus size={14} />, () => stepSize(-1))}
          <input className="fdoc-size-input" value={sizeDraft ?? String(size)} aria-label="Размер шрифта" inputMode="decimal"
            onFocus={(e) => { skipSizeBlur.current = false; setSizeDraft(String(size)); e.currentTarget.select(); }}
            onChange={(e) => setSizeDraft(e.target.value.replace(/[^\d.,]/g, ''))}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== 'Escape') return;
              e.preventDefault(); e.stopPropagation(); skipSizeBlur.current = true;
              const n = Number((sizeDraft ?? '').replace(',', '.'));
              if (e.key === 'Enter' && Number.isFinite(n) && n > 0) setSize(n);
              setSizeDraft(null); close(); editor.commands.focus();
            }}
            onBlur={(e) => {
              const n = Number(e.currentTarget.value.replace(',', '.'));
              if (!skipSizeBlur.current && Number.isFinite(n) && n > 0 && n !== size) setSize(n);
              setSizeDraft(null);
            }}
            onClick={(e) => setPop({ kind: 'size', at: e.currentTarget.getBoundingClientRect() })} />
          {btn('sz+', 'Увеличить размер шрифта', false, <OFontSizePlus size={14} />, () => stepSize(1))}
        </span>
        <span className="fdoc-sep" />
        {btn('b', 'Полужирный (Ctrl+B)', st.bold, <OBold size={18} />, () => run((c) => c.toggleBold()))}
        {btn('i', 'Курсив (Ctrl+I)', st.italic, <OItalic size={18} />, () => run((c) => c.toggleItalic()))}
        {btn('u', 'Подчёркнутый (Ctrl+U)', st.underline, <OUnderline size={18} />, () => run((c) => c.toggleUnderline()))}
        <button type="button" className="fdoc-btn fdoc-color" title="Цвет текста" aria-label="Цвет текста" onMouseDown={(e) => e.preventDefault()} onClick={open('color')} aria-expanded={pop?.kind === 'color'}>
          <OTextColor size={18} style={{ '--swatch': st.color || 'currentColor' } as React.CSSProperties} />
        </button>
        <button type="button" className="fdoc-btn fdoc-color" title="Цвет выделения" aria-label="Цвет выделения" onMouseDown={(e) => e.preventDefault()} onClick={open('bg')} aria-expanded={pop?.kind === 'bg'}>
          <OHighlightColor size={18} style={{ '--swatch': st.bg || 'transparent' } as React.CSSProperties} />
        </button>
        <span className="fdoc-sep" />
        {btn('link', 'Вставить ссылку (Ctrl+K)', st.link, <OInsertLink size={18} />, onLink)}
        {btn('img', 'Вставить изображение', false, <OInsertImage size={18} />, onPicture)}
        <span className="fdoc-sep" />
        <button type="button" className="fdoc-btn fdoc-btn-drop" title="Выравнивание" aria-label="Выравнивание" onMouseDown={(e) => e.preventDefault()} onClick={open('align')} aria-expanded={pop?.kind === 'align'}>
          <AlignIcon size={16} /><OChevronDown size={12} aria-hidden="true" />
        </button>
        <button type="button" className="fdoc-btn fdoc-btn-drop" title="Межстрочный интервал и интервал между абзацами" aria-label="Интервал" onMouseDown={(e) => e.preventDefault()} onClick={open('spacing')} aria-expanded={pop?.kind === 'spacing'}>
          <OLineSpacing size={18} /><OChevronDown size={12} aria-hidden="true" />
        </button>
        <span className="fdoc-sep" />
        {btn('tl', 'Чек-лист (Ctrl+Shift+9)', st.task, <OChecklist size={18} />, () => run((c) => c.toggleTaskList()))}
        {btn('ul', 'Маркированный список (Ctrl+Shift+8)', st.bullet, <OBulletedList size={18} />, () => run((c) => c.toggleBulletList()))}
        {btn('ol', 'Нумерованный список (Ctrl+Shift+7)', st.ordered, <ONumberedList size={18} />, () => run((c) => c.toggleOrderedList()))}
        <span className="fdoc-sep" />
        {btn('out', 'Уменьшить отступ (Ctrl+[)', false, <ODecreaseIndent size={18} />, () => indent(-1))}
        {btn('in', 'Увеличить отступ (Ctrl+])', false, <OIncreaseIndent size={18} />, () => indent(1))}
        {btn('clear', 'Очистить форматирование (Ctrl+\\)', false, <OClearFormat size={18} />, () => run((c) => c.unsetAllMarks()))}
        <span className="fdoc-sep" />
        {btn('s', 'Зачёркнутый (Alt+Shift+5)', st.strike, <OStrikethrough size={18} />, () => run((c) => c.toggleStrike()))}
        {btn('sup', 'Надстрочный (Ctrl+.)', st.sup, <OSuperscript size={18} />, () => run((c) => c.toggleMark('superscript')))}
        {btn('sub', 'Подстрочный (Ctrl+,)', st.sub, <OSubscript size={18} />, () => run((c) => c.toggleMark('subscript')))}
        {btn('emoji', 'Эмодзи', false, <OEmoji size={18} />, (e) => { const r = e.currentTarget.getBoundingClientRect(); onPick('emoji', { x: r.left, y: r.bottom + 6 }); })}
        {btn('sym', 'Специальные символы', false, <OSpecialCharacter size={18} />, (e) => { const r = e.currentTarget.getBoundingClientRect(); onPick('symbol', { x: r.left, y: r.bottom + 6 }); })}
      </div>

      {pop?.kind === 'style' && (
        <Pop anchor={pop.at} onClose={close} className="fdoc-pop-list">
          {STYLES.map((s) => (
            <button key={s.id} type="button" className="fdoc-pop-item" data-style={s.id} aria-selected={st.style === s.id} onClick={() => setStyle(s.id)}>{s.label}</button>
          ))}
        </Pop>
      )}
      {pop?.kind === 'zoom' && (
        <Pop anchor={pop.at} onClose={close} className="fdoc-pop-list fdoc-pop-sizes">
          <button type="button" className="fdoc-pop-item" aria-selected={zoom.fit} onClick={() => { zoom.pick('fit'); close(); }}>По ширине</button>
          <div className="fdoc-pop-sep" />
          {zoom.options.map((z) => (
            <button key={z} type="button" className="fdoc-pop-item" aria-selected={!zoom.fit && Math.abs(zoom.value - z) < 0.005} onClick={() => { zoom.pick(z); close(); }}>{Math.round(z * 100)}%</button>
          ))}
        </Pop>
      )}
      {pop?.kind === 'font' && (
        <Pop anchor={pop.at} onClose={close} className="fdoc-pop-list">
          {FONTS.map((f) => (
            <button key={f} type="button" className="fdoc-pop-item" aria-selected={st.font === f} style={{ fontFamily: f }} onClick={() => { run((c) => c.setFontFamily(f)); close(); }}>{f}</button>
          ))}
        </Pop>
      )}
      {pop?.kind === 'size' && (
        <Pop anchor={pop.at} onClose={close} className="fdoc-pop-list fdoc-pop-sizes">
          {SIZES.map((n) => <button key={n} type="button" className="fdoc-pop-item" aria-selected={size === n} onClick={() => { setSize(n); close(); }}>{String(n).replace('.', ',')}</button>)}
        </Pop>
      )}
      {pop?.kind === 'color' && (
        <Pop anchor={pop.at} onClose={close}>
          <Palette current={st.color} resetLabel="Цвет по умолчанию" ResetIcon={OTextColor} onReset={() => { run((c) => c.unsetColor()); close(); }} onPick={(c) => { run((ch) => ch.setColor(c)); close(); }} />
        </Pop>
      )}
      {pop?.kind === 'bg' && (
        <Pop anchor={pop.at} onClose={close}>
          <Palette current={st.bg} resetLabel="Без выделения" ResetIcon={OClearFormat} onReset={() => { run((c) => c.unsetBackgroundColor()); close(); }} onPick={(c) => { run((ch) => ch.setBackgroundColor(c)); close(); }} />
        </Pop>
      )}
      {pop?.kind === 'align' && (
        <Pop anchor={pop.at} onClose={close} className="fdoc-pop-row">
          {btn('al', 'По левому краю (Ctrl+Shift+L)', st.align === 'left', <OAlignLeft size={18} />, () => { run((c) => c.setTextAlign('left')); close(); })}
          {btn('ac', 'По центру (Ctrl+Shift+E)', st.align === 'center', <OAlignCenter size={18} />, () => { run((c) => c.setTextAlign('center')); close(); })}
          {btn('ar', 'По правому краю (Ctrl+Shift+R)', st.align === 'right', <OAlignRight size={18} />, () => { run((c) => c.setTextAlign('right')); close(); })}
          {btn('aj', 'По ширине (Ctrl+Shift+J)', st.align === 'justify', <OAlignJustify size={18} />, () => { run((c) => c.setTextAlign('justify')); close(); })}
        </Pop>
      )}
      {pop?.kind === 'spacing' && (
        <Pop anchor={pop.at} onClose={close} className="fdoc-pop-list">
          {SPACINGS.map((s) => (
            <button key={s.v} type="button" className="fdoc-pop-item" aria-selected={Math.abs(st.spacing - s.v) < 0.01}
              onClick={() => { patchPs(editor, (ps) => ({ ...ps, lineSpacing: s.v })); close(); }}>{s.label}</button>
          ))}
          <div className="fdoc-pop-sep" />
          <button type="button" className="fdoc-pop-item" onClick={() => { patchPs(editor, (ps) => ({ ...ps, spaceAbove: { v: ptOf(ps.spaceAbove) ? 0 : 10 } })); close(); }}>Интервал перед абзацем — добавить/убрать</button>
          <button type="button" className="fdoc-pop-item" onClick={() => { patchPs(editor, (ps) => ({ ...ps, spaceBelow: { v: ptOf(ps.spaceBelow) ? 0 : 10 } })); close(); }}>Интервал после абзаца — добавить/убрать</button>
        </Pop>
      )}
    </div>
  );
}
