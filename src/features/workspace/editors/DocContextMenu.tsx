import type { Editor } from '@tiptap/react';
import {
  ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, ArrowUpToLine, Bold, ClipboardPaste, Columns2, Copy, Italic, Link as LinkIcon, MessageSquarePlus,
  PaintBucket, RemoveFormatting, Scissors, Table, TableCellsMerge, TableCellsSplit, TextSelect, Trash2, Underline as UnderlineIcon,
} from 'lucide-react';
import { Menu, MenuItem } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const key = (k: string) => (mac ? `⌘${k}` : `Ctrl+${k}`);

/**
 * Контекстное меню документа — то же меню Шара, что везде (shared/ui/overlay), а не меню браузера: вырезать, копировать,
 * вставить, оформление, ссылка, комментарий. Shift+ПКМ по-прежнему открывает системное меню (там подсказки орфографии).
 */
export function DocContextMenu({ editor, at, readOnly, onClose, onAddComment, onLink, onCellColor }: {
  editor: Editor; at: { x: number; y: number }; readOnly: boolean; onClose: () => void; onAddComment?: () => void; onLink: () => void;
  /** Палитра заливки ячейки таблицы — открывается у места щелчка. */
  onCellColor: () => void;
}) {
  const { empty } = editor.state.selection;
  const run = (fn: () => void) => () => { onClose(); fn(); };
  // Вырезать и копировать — системными командами: в буфер уходит и текст, и оформление (HTML), как при Ctrl+C.
  const clip = (cmd: 'cut' | 'copy') => { editor.commands.focus(); if (!document.execCommand(cmd)) showToast(`Нажмите ${key(cmd === 'cut' ? 'X' : 'C')}`, 'info'); };
  const paste = async () => {
    editor.commands.focus();
    // В приложении execCommand('paste') вставляет как обычный Ctrl+V (с оформлением); в браузере он запрещён — берём текст.
    if (document.execCommand('paste')) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) editor.chain().focus().insertContent(text.replace(/\r\n?/g, '\n').split('\n').map((line) => ({
        type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [],
      }))).run();
    } catch { showToast(`Браузер не дал прочитать буфер — нажмите ${key('V')}`, 'info'); }
  };

  return (
    <Menu anchor={at} label="Действия с текстом" onClose={onClose}>
      {!readOnly && <MenuItem icon={<Scissors size={16} />} disabled={empty} onSelect={run(() => clip('cut'))}>Вырезать <kbd className="nx-menu-kbd">{key('X')}</kbd></MenuItem>}
      <MenuItem icon={<Copy size={16} />} disabled={empty} onSelect={run(() => clip('copy'))}>Копировать <kbd className="nx-menu-kbd">{key('C')}</kbd></MenuItem>
      {!readOnly && <MenuItem icon={<ClipboardPaste size={16} />} onSelect={run(() => void paste())}>Вставить <kbd className="nx-menu-kbd">{key('V')}</kbd></MenuItem>}
      <MenuItem icon={<TextSelect size={16} />} onSelect={run(() => editor.chain().focus().selectAll().run())}>Выделить всё <kbd className="nx-menu-kbd">{key('A')}</kbd></MenuItem>
      {!readOnly && (
        <>
          <div className="nx-menu-sep" />
          <MenuItem icon={<Bold size={16} />} onSelect={run(() => editor.chain().focus().toggleBold().run())}>Жирный <kbd className="nx-menu-kbd">{key('B')}</kbd></MenuItem>
          <MenuItem icon={<Italic size={16} />} onSelect={run(() => editor.chain().focus().toggleItalic().run())}>Курсив <kbd className="nx-menu-kbd">{key('I')}</kbd></MenuItem>
          <MenuItem icon={<UnderlineIcon size={16} />} onSelect={run(() => editor.chain().focus().toggleUnderline().run())}>Подчёркнутый <kbd className="nx-menu-kbd">{key('U')}</kbd></MenuItem>
          <MenuItem icon={<LinkIcon size={16} />} onSelect={run(onLink)}>{editor.isActive('link') ? 'Изменить ссылку…' : 'Ссылка…'}</MenuItem>
          <MenuItem icon={<RemoveFormatting size={16} />} disabled={empty} onSelect={run(() => editor.chain().focus().unsetAllMarks().run())}>Очистить оформление</MenuItem>
        </>
      )}
      {!readOnly && editor.isActive('table') && (
        <>
          <div className="nx-menu-sep" />
          <div className="nx-menu-label">Таблица</div>
          <MenuItem icon={<ArrowUpToLine size={16} />} onSelect={run(() => editor.chain().focus().addRowBefore().run())}>Вставить строку выше</MenuItem>
          <MenuItem icon={<ArrowDownToLine size={16} />} onSelect={run(() => editor.chain().focus().addRowAfter().run())}>Вставить строку ниже</MenuItem>
          <MenuItem icon={<ArrowLeftToLine size={16} />} onSelect={run(() => editor.chain().focus().addColumnBefore().run())}>Вставить столбец слева</MenuItem>
          <MenuItem icon={<ArrowRightToLine size={16} />} onSelect={run(() => editor.chain().focus().addColumnAfter().run())}>Вставить столбец справа</MenuItem>
          {editor.can().mergeCells() && <MenuItem icon={<TableCellsMerge size={16} />} onSelect={run(() => editor.chain().focus().mergeCells().run())}>Объединить ячейки</MenuItem>}
          {editor.can().splitCell() && <MenuItem icon={<TableCellsSplit size={16} />} onSelect={run(() => editor.chain().focus().splitCell().run())}>Разделить ячейку</MenuItem>}
          <MenuItem icon={<PaintBucket size={16} />} onSelect={run(onCellColor)}>Цвет ячейки…</MenuItem>
          <MenuItem icon={<Trash2 size={16} />} onSelect={run(() => editor.chain().focus().deleteRow().run())}>Удалить строку</MenuItem>
          <MenuItem icon={<Columns2 size={16} />} onSelect={run(() => editor.chain().focus().deleteColumn().run())}>Удалить столбец</MenuItem>
          <MenuItem icon={<Table size={16} />} tone="danger" onSelect={run(() => editor.chain().focus().deleteTable().run())}>Удалить таблицу</MenuItem>
        </>
      )}
      {onAddComment && (
        <>
          <div className="nx-menu-sep" />
          <MenuItem icon={<MessageSquarePlus size={16} />} disabled={empty} onSelect={run(onAddComment)}>Комментарий <kbd className="nx-menu-kbd">{mac ? '⌥⌘M' : 'Ctrl+Alt+M'}</kbd></MenuItem>
        </>
      )}
    </Menu>
  );
}
