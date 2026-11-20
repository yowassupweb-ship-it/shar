import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useEditorState, type Editor } from '@tiptap/react';
import { redoDepth, undoDepth } from '@tiptap/pm/history';
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, Baseline, Bold, ChevronDown, Highlighter, ImagePlus, IndentDecrease, IndentIncrease, Italic,
  Link as LinkIcon, List, ListChecks, ListOrdered, Minus, Omega, PaintRoller, Plus, Printer, Redo2, RemoveFormatting, Smile,
  Strikethrough, Subscript as SubIcon, Superscript as SupIcon, Underline as UnderlineIcon, Undo2, UnfoldVertical,
} from 'lucide-react';

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
  useEffect(() => {
    const down = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key, true); };
  }, [onClose]);
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - 300));
  return createPortal(
    <div ref={box} className={`fdoc-pop ${className || ''}`} style={{ left, top: anchor.bottom + 6 }} onMouseDown={(e) => { if ((e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault(); }}>
      {children}
    </div>,
    document.body,
  );
}

function Palette({ onPick, onReset, resetLabel }: { onPick: (c: string) => void; onReset: () => void; resetLabel: string }) {
  const sw = (c: string) => <button key={c} type="button" className="fdoc-sw" style={{ background: c }} onClick={() => onPick(c)} aria-label={c} title={c} />;
  return (
    <div className="fdoc-palette">
      <button type="button" className="fdoc-pal-reset" onClick={onReset}>{resetLabel}</button>
      <div className="fdoc-pal-row">{GRAYS.map(sw)}</div>
      <div className="fdoc-pal-row fdoc-pal-gap">{BRIGHT.map(sw)}</div>
      {SHADES.map((row, i) => <div key={i} className="fdoc-pal-row">{row.map(sw)}</div>)}
      <label className="fdoc-pal-custom">Свой цвет <input type="color" onChange={(e) => onPick(e.target.value)} /></label>
    </div>
  );
}

export function FastDocToolbar({ editor, onPicture, onPick, onLink }: {
  editor: Editor;
  onPicture: () => void;
  onPick: (kind: 'emoji' | 'symbol', at: { x: number; y: number }) => void;
  onLink: () => void;
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
  const [painter, setPainter] = useState<null | { marks: ReturnType<Editor['state']['selection']['$from']['marks']>; align: string | null; ps: Ps | null }>(null);
  const [sizeDraft, setSizeDraft] = useState('');
  const run = (fn: (c: Chain) => Chain) => fn(editor.chain().focus()).run();
  const open = (kind: string) => (e: React.MouseEvent<HTMLElement>) => setPop((p) => (p?.kind === kind ? null : { kind, at: e.currentTarget.getBoundingClientRect() }));
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
  const AlignIcon = st.align === 'center' ? AlignCenter : st.align === 'right' ? AlignRight : st.align === 'justify' ? AlignJustify : AlignLeft;

  return (
    <div className="fdoc-bar-wrap">
      <div className="fdoc-bar" role="toolbar" aria-label="Оформление">
        {btn('undo', 'Отменить (Ctrl+Z)', false, <Undo2 size={16} />, () => run((c) => c.undo()), !st.canUndo)}
        {btn('redo', 'Повторить (Ctrl+Y)', false, <Redo2 size={16} />, () => run((c) => c.redo()), !st.canRedo)}
        {btn('print', 'Печать (Ctrl+P)', false, <Printer size={16} />, () => window.dispatchEvent(new Event('nx:print-item')))}
        {btn('paint', painter ? 'Копирование формата: выделите текст (Esc — отмена)' : 'Копировать форматирование', Boolean(painter), <PaintRoller size={16} />, () => {
          if (painter) { setPainter(null); return; }
          const { $from } = editor.state.selection;
          setPainter({ marks: editor.state.storedMarks || $from.marks(), align: ($from.parent.attrs.textAlign as string) || null, ps: ($from.parent.attrs.ps as Ps) || null });
        })}
        <span className="fdoc-sep" />
        <button type="button" className="fdoc-drop fdoc-drop-style" onMouseDown={(e) => e.preventDefault()} onClick={open('style')} aria-haspopup="listbox" title="Стиль абзаца">
          <span>{styleLabel}</span><ChevronDown size={14} aria-hidden="true" />
        </button>
        <span className="fdoc-sep" />
        <button type="button" className="fdoc-drop fdoc-drop-font" onMouseDown={(e) => e.preventDefault()} onClick={open('font')} aria-haspopup="listbox" title="Шрифт">
          <span style={{ fontFamily: st.font }}>{st.font}</span><ChevronDown size={14} aria-hidden="true" />
        </button>
        <span className="fdoc-sep" />
        <span className="fdoc-size" role="group" aria-label="Размер шрифта">
          {btn('sz-', 'Уменьшить размер шрифта', false, <Minus size={14} />, () => stepSize(-1))}
          <input className="fdoc-size-input" value={sizeDraft || String(size)} aria-label="Размер шрифта" inputMode="decimal"
            onFocus={(e) => { setSizeDraft(String(size)); e.currentTarget.select(); }}
            onChange={(e) => setSizeDraft(e.target.value.replace(/[^\d.,]/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); const n = Number(sizeDraft.replace(',', '.')); if (n > 0) setSize(n); setSizeDraft(''); editor.commands.focus(); } if (e.key === 'Escape') { setSizeDraft(''); editor.commands.focus(); } }}
            onBlur={() => setSizeDraft('')}
            onClick={(e) => setPop({ kind: 'size', at: e.currentTarget.getBoundingClientRect() })} />
          {btn('sz+', 'Увеличить размер шрифта', false, <Plus size={14} />, () => stepSize(1))}
        </span>
        <span className="fdoc-sep" />
        {btn('b', 'Полужирный (Ctrl+B)', st.bold, <Bold size={16} />, () => run((c) => c.toggleBold()))}
        {btn('i', 'Курсив (Ctrl+I)', st.italic, <Italic size={16} />, () => run((c) => c.toggleItalic()))}
        {btn('u', 'Подчёркнутый (Ctrl+U)', st.underline, <UnderlineIcon size={16} />, () => run((c) => c.toggleUnderline()))}
        <button type="button" className="fdoc-btn fdoc-color" title="Цвет текста" aria-label="Цвет текста" onMouseDown={(e) => e.preventDefault()} onClick={open('color')}>
          <Baseline size={16} /><span className="fdoc-swatch" style={{ background: st.color || 'var(--page-text, currentColor)' }} aria-hidden="true" />
        </button>
        <button type="button" className="fdoc-btn fdoc-color" title="Цвет выделения" aria-label="Цвет выделения" onMouseDown={(e) => e.preventDefault()} onClick={open('bg')}>
          <Highlighter size={16} /><span className="fdoc-swatch" style={{ background: st.bg || 'transparent' }} aria-hidden="true" />
        </button>
        <span className="fdoc-sep" />
        {btn('link', 'Вставить ссылку (Ctrl+K)', st.link, <LinkIcon size={16} />, onLink)}
        {btn('img', 'Вставить изображение', false, <ImagePlus size={16} />, onPicture)}
        <span className="fdoc-sep" />
        <button type="button" className="fdoc-btn fdoc-btn-drop" title="Выравнивание" aria-label="Выравнивание" onMouseDown={(e) => e.preventDefault()} onClick={open('align')}>
          <AlignIcon size={16} /><ChevronDown size={12} aria-hidden="true" />
        </button>
        <button type="button" className="fdoc-btn fdoc-btn-drop" title="Межстрочный интервал и интервал между абзацами" aria-label="Интервал" onMouseDown={(e) => e.preventDefault()} onClick={open('spacing')}>
          <UnfoldVertical size={16} /><ChevronDown size={12} aria-hidden="true" />
        </button>
        <span className="fdoc-sep" />
        {btn('tl', 'Чек-лист (Ctrl+Shift+9)', st.task, <ListChecks size={16} />, () => run((c) => c.toggleTaskList()))}
        {btn('ul', 'Маркированный список (Ctrl+Shift+8)', st.bullet, <List size={16} />, () => run((c) => c.toggleBulletList()))}
        {btn('ol', 'Нумерованный список (Ctrl+Shift+7)', st.ordered, <ListOrdered size={16} />, () => run((c) => c.toggleOrderedList()))}
        <span className="fdoc-sep" />
        {btn('out', 'Уменьшить отступ (Ctrl+[)', false, <IndentDecrease size={16} />, () => indent(-1))}
        {btn('in', 'Увеличить отступ (Ctrl+])', false, <IndentIncrease size={16} />, () => indent(1))}
        {btn('clear', 'Очистить форматирование (Ctrl+\\)', false, <RemoveFormatting size={16} />, () => run((c) => c.unsetAllMarks()))}
        <span className="fdoc-sep" />
        {btn('s', 'Зачёркнутый (Alt+Shift+5)', st.strike, <Strikethrough size={16} />, () => run((c) => c.toggleStrike()))}
        {btn('sup', 'Надстрочный (Ctrl+.)', st.sup, <SupIcon size={16} />, () => run((c) => c.toggleMark('superscript')))}
        {btn('sub', 'Подстрочный (Ctrl+,)', st.sub, <SubIcon size={16} />, () => run((c) => c.toggleMark('subscript')))}
        {btn('emoji', 'Эмодзи', false, <Smile size={16} />, (e) => { const r = e.currentTarget.getBoundingClientRect(); onPick('emoji', { x: r.left, y: r.bottom + 6 }); })}
        {btn('sym', 'Специальные символы', false, <Omega size={16} />, (e) => { const r = e.currentTarget.getBoundingClientRect(); onPick('symbol', { x: r.left, y: r.bottom + 6 }); })}
      </div>

      {pop?.kind === 'style' && (
        <Pop anchor={pop.at} onClose={close} className="fdoc-pop-list">
          {STYLES.map((s) => (
            <button key={s.id} type="button" className="fdoc-pop-item" data-style={s.id} aria-selected={st.style === s.id} onClick={() => setStyle(s.id)}>{s.label}</button>
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
          <Palette resetLabel="Сбросить цвет" onReset={() => { run((c) => c.unsetColor()); close(); }} onPick={(c) => { run((ch) => ch.setColor(c)); close(); }} />
        </Pop>
      )}
      {pop?.kind === 'bg' && (
        <Pop anchor={pop.at} onClose={close}>
          <Palette resetLabel="Без выделения" onReset={() => { run((c) => c.unsetBackgroundColor()); close(); }} onPick={(c) => { run((ch) => ch.setBackgroundColor(c)); close(); }} />
        </Pop>
      )}
      {pop?.kind === 'align' && (
        <Pop anchor={pop.at} onClose={close} className="fdoc-pop-row">
          {btn('al', 'По левому краю (Ctrl+Shift+L)', st.align === 'left', <AlignLeft size={16} />, () => { run((c) => c.setTextAlign('left')); close(); })}
          {btn('ac', 'По центру (Ctrl+Shift+E)', st.align === 'center', <AlignCenter size={16} />, () => { run((c) => c.setTextAlign('center')); close(); })}
          {btn('ar', 'По правому краю (Ctrl+Shift+R)', st.align === 'right', <AlignRight size={16} />, () => { run((c) => c.setTextAlign('right')); close(); })}
          {btn('aj', 'По ширине (Ctrl+Shift+J)', st.align === 'justify', <AlignJustify size={16} />, () => { run((c) => c.setTextAlign('justify')); close(); })}
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
