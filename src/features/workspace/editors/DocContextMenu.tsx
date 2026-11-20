import type { Editor } from '@tiptap/react';
import {
  Bold, ClipboardPaste, Copy, Italic, Link as LinkIcon, MessageSquarePlus, RemoveFormatting, Scissors, TextSelect, Underline as UnderlineIcon,
} from 'lucide-react';
import { Menu, MenuItem } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const key = (k: string) => (mac ? `⌘${k}` : `Ctrl+${k}`);

/**
 * Контекстное меню документа — то же меню Шара, что везде (shared/ui/overlay), а не меню браузера: вырезать, копировать,
 * вставить, оформление, ссылка, комментарий. Shift+ПКМ по-прежнему открывает системное меню (там подсказки орфографии).
 */
export function DocContextMenu({ editor, at, readOnly, onClose, onAddComment, onLink }: {
  editor: Editor; at: { x: number; y: number }; readOnly: boolean; onClose: () => void; onAddComment?: () => void; onLink: () => void;
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
      {onAddComment && (
        <>
          <div className="nx-menu-sep" />
          <MenuItem icon={<MessageSquarePlus size={16} />} disabled={empty} onSelect={run(onAddComment)}>Комментарий <kbd className="nx-menu-kbd">{mac ? '⌥⌘M' : 'Ctrl+Alt+M'}</kbd></MenuItem>
        </>
      )}
    </Menu>
  );
}
