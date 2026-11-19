import {
  ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, ArrowUpToLine, ClipboardPaste, ClipboardType, Columns2, Copy, Eraser, FileText, Link2,
  MessageSquarePlus, Pilcrow, Scissors, Smile, Table, Trash2,
} from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { Menu, MenuItem } from '@/shared/ui/overlay';
import { SharEmojiPicker } from '@/shared/emoji/SharEmojiPicker';

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const keyHint = (k: string) => (mac ? `⌘${k}` : `Ctrl+${k}`);

export interface DocMenuContext {
  x: number;
  y: number;
  /** Что-то выделено (не просто курсор). */
  selected: boolean;
  /** Курсор в таблице: показываем строки и столбцы. */
  inTable: boolean;
}

/**
 * Меню правого клика документа — как у Google Документов: длинный список с иконками слева и сочетаниями справа,
 * группы через разделитель. Вместо встроенного меню Univer (с рядом мелких кнопок наверху); команды — те же, Univer.
 * Shift+ПКМ — системное меню.
 */
export function UniverDocMenu({ ctx, readOnly, has, exec, onClose, onComment, onPick }: {
  ctx: DocMenuContext;
  readOnly: boolean;
  has: (id: string) => boolean;
  exec: (id: string, params?: object) => void;
  onClose: () => void;
  onComment?: () => void;
  onPick: (kind: 'emoji' | 'symbol') => void;
}) {
  const item = (label: string, icon: ReactNode, run: () => void, opts: { hint?: string; disabled?: boolean; id?: string } = {}) => {
    if (opts.id && !has(opts.id)) return null;
    return (
      <MenuItem key={label} icon={icon} disabled={opts.disabled} onSelect={() => { onClose(); run(); }}>
        <span className="nws-bar-item">{label}{opts.hint && <kbd className="nws-bar-hint">{opts.hint}</kbd>}</span>
      </MenuItem>
    );
  };
  const cmd = (label: string, icon: ReactNode, id: string, opts: { hint?: string; disabled?: boolean; params?: object } = {}) =>
    item(label, icon, () => exec(id, opts.params), { ...opts, id });
  const sep = (key: string) => <div key={key} className="nx-menu-sep" />;
  const { selected, inTable } = ctx;

  return (
    <Menu anchor={{ x: ctx.x, y: ctx.y }} label="Действия с текстом" onClose={onClose} minWidth={372}>
      {!readOnly && cmd('Вырезать', <Scissors size={16} />, 'univer.command.cut', { hint: keyHint('X'), disabled: !selected })}
      {cmd('Скопировать', <Copy size={16} />, 'univer.command.copy', { hint: keyHint('C'), disabled: !selected })}
      {!readOnly && cmd('Вставить', <ClipboardPaste size={16} />, 'univer.command.paste', { hint: keyHint('V') })}
      {!readOnly && cmd('Вставить без форматирования', <ClipboardType size={16} />, 'doc.command.paste-special', { hint: mac ? '⇧⌘V' : 'Ctrl+Shift+V', params: { value: 'text' } })}
      {!readOnly && cmd('Удалить', <Trash2 size={16} />, 'doc.command.delete-left', { disabled: !selected })}
      {onComment && sep('s1')}
      {onComment && item('Комментарий', <MessageSquarePlus size={16} />, onComment, { hint: mac ? '⌥⌘M' : 'Ctrl+Alt+M' })}
      {!readOnly && sep('s2')}
      {!readOnly && item('Вставить эмодзи', <Smile size={16} />, () => onPick('emoji'))}
      {!readOnly && cmd('Вставить ссылку', <Link2 size={16} />, 'doc.operation.show-hyper-link-edit-popup', { hint: keyHint('K') })}
      {!readOnly && inTable && [
        sep('t0'),
        cmd('Вставить строку выше', <ArrowUpToLine size={16} />, 'doc.command.table-insert-row-above'),
        cmd('Вставить строку ниже', <ArrowDownToLine size={16} />, 'doc.command.table-insert-row-bellow'),
        cmd('Вставить столбец слева', <ArrowLeftToLine size={16} />, 'doc.command.table-insert-column-left'),
        cmd('Вставить столбец справа', <ArrowRightToLine size={16} />, 'doc.command.table-insert-column-right'),
        cmd('Удалить строку', <Trash2 size={16} />, 'doc.table.delete-rows'),
        cmd('Удалить столбец', <Columns2 size={16} />, 'doc.table.delete-columns'),
        cmd('Удалить таблицу', <Table size={16} />, 'doc.table.delete-table'),
      ]}
      {!readOnly && sep('s3')}
      {!readOnly && cmd('Настройка абзаца', <Pilcrow size={16} />, 'sidebar.operation.doc-paragraph-setting-panel')}
      {!readOnly && cmd('Параметры страницы', <FileText size={16} />, 'docs.operation.open-page-setting')}
      {!readOnly && cmd('Очистить форматирование', <Eraser size={16} />, 'ui.command.clear-formatting', { hint: keyHint('\\') })}
    </Menu>
  );
}

/** Частые знаки, которых нет на клавиатуре: тире, кавычки-ёлочки, №, градус, валюты, стрелки. */
export const SYMBOLS = [
  '—', '–', '«', '»', '„', '“', '№', '§', '°', '±', '×', '÷', '≈', '≠', '≤', '≥', '∞', '½', '¼', '¾',
  '₽', '€', '$', '£', '¥', '©', '®', '™', '•', '·', '…', '†', '→', '←', '↑', '↓', '↔', '⇒', '✓', '✗',
  '★', '☆', '♥', '☎', '✉', '✂', '¹', '²', '³', 'α', 'β', 'γ', 'Δ', 'π', 'Σ', 'Ω', 'µ', '‰', '√', '∑',
];

/** Всплывающий выбор эмодзи или символа у курсора мыши (или под пунктом меню). Выбранное вставляется в позицию курсора. */
export function DocInsertPicker({ kind, at, onPick, onClose }: { kind: 'emoji' | 'symbol'; at: { x: number; y: number }; onPick: (value: string) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key, true); };
  }, [onClose]);
  const w = kind === 'emoji' ? 352 : 336;
  const h = kind === 'emoji' ? 420 : 236;
  const left = Math.max(8, Math.min(at.x, window.innerWidth - w - 8));
  const top = Math.max(8, Math.min(at.y, window.innerHeight - h - 8));
  return (
    <div ref={box} className="nws-insert-picker" style={{ left, top, width: w }} role="dialog" aria-label={kind === 'emoji' ? 'Эмодзи' : 'Специальные символы'}>
      {kind === 'emoji' ? (
        <div className="nem-host"><SharEmojiPicker onPick={(e) => { onPick(e); onClose(); }} /></div>
      ) : (
        <>
          <div className="nws-insert-picker-title">Специальные символы</div>
          <div className="nws-symbols">
            {SYMBOLS.map((s) => <button key={s} type="button" onClick={() => { onPick(s); onClose(); }} aria-label={`Вставить «${s}»`}>{s}</button>)}
          </div>
        </>
      )}
    </div>
  );
}
