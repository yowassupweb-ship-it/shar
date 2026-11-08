import { useEffect, useRef, type ReactNode } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import Image from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from 'tiptap-markdown';
import {
  Bold, Code, Heading1, Heading2, Heading3, ImagePlus, Italic, Link as LinkIcon, List, ListChecks, ListOrdered, Pilcrow, Quote, Redo2, Strikethrough, Undo2,
} from 'lucide-react';
import { tightenLists, unescapeBreaks } from './paragraphs';
import './visual.css';

/**
 * Визуальный редактор markdown: текст правится «как в обычном редакторе» — жирное, списки, заголовки видны сразу, без
 * разметки. Хранится по-прежнему markdown: значение приходит и уходит строкой, так что режимы «Правка» и «Код»
 * (исходный markdown) показывают одно и то же. Список по выделению нескольких строк делает пунктами все строки.
 *
 * Внешнее изменение значения (правка коллеги, возврат версии) подхватывается, пока человек не печатает.
 */

const getMarkdown = (editor: Editor): string => tightenLists(unescapeBreaks((editor.storage as unknown as { markdown: { getMarkdown: () => string } }).markdown.getMarkdown()));

export function VisualEditor({ value, onChange, placeholder, onBlur, uploadImage, extraTools, autoFocus }: {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  onBlur?: () => void;
  /** Загрузить картинку и вернуть её адрес; без этого вставка картинок из буфера отключена. */
  uploadImage?: (file: File) => Promise<string>;
  /** Дополнительные кнопки панели (прикрепить файл и т. п.). */
  extraTools?: { key: string; title: string; icon: ReactNode; onClick: () => void }[];
  autoFocus?: boolean;
}) {
  const emitted = useRef(value);
  const upload = useRef(uploadImage);
  upload.current = uploadImage;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ underline: false, link: { openOnClick: false, autolink: true } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Image,
      Placeholder.configure({ placeholder: placeholder || '' }),
      Markdown.configure({ html: false, tightLists: true, bulletListMarker: '-', breaks: true, transformPastedText: true, transformCopiedText: true }),
    ],
    content: value,
    autofocus: autoFocus ? 'end' : false,
    editorProps: {
      attributes: { class: 'nve-content', 'aria-label': 'Текст', role: 'textbox', 'aria-multiline': 'true' },
      handlePaste: (view, event) => {
        const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
        if (!files.length || !upload.current) return false;
        event.preventDefault();
        void insertImages(files);
        return true;
      },
      handleDrop: (view, event) => {
        const files = [...(event.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
        if (!files.length || !upload.current) return false;
        event.preventDefault();
        void insertImages(files);
        return true;
      },
    },
    onUpdate: ({ editor: ed }) => {
      const md = getMarkdown(ed);
      emitted.current = md;
      onChange(md);
    },
    onBlur: () => onBlur?.(),
  });

  async function insertImages(files: File[]) {
    if (!editor || !upload.current) return;
    for (const file of files) {
      try {
        const src = await upload.current(file);
        editor.chain().focus().setImage({ src, alt: file.name.replace(/\.[^.]+$/, '') }).run();
      } catch { /* ошибку загрузки показывает вызывающий */ }
    }
  }

  // Значение изменили снаружи (не мы): подставляем, сохраняя положение курсора, пока человек не печатает.
  useEffect(() => {
    if (!editor || value === emitted.current) return;
    if (editor.isFocused && getMarkdown(editor) !== value && document.activeElement?.closest('.nve')) {
      // Печатает прямо сейчас — внешнюю правку применяем, но курсор не теряем.
      const { from, to } = editor.state.selection;
      editor.commands.setContent(value, { emitUpdate: false });
      const max = editor.state.doc.content.size;
      editor.commands.setTextSelection({ from: Math.min(from, max), to: Math.min(to, max) });
    } else {
      editor.commands.setContent(value, { emitUpdate: false });
    }
    emitted.current = value;
  }, [value, editor]);

  const pickImage = () => {
    if (!uploadImage) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = () => { void insertImages([...(input.files ?? [])]); };
    input.click();
  };

  if (!editor) return null;
  const btn = (title: string, icon: ReactNode, run: () => void, active?: boolean, disabled?: boolean) => (
    <button key={title} type="button" className="nx-icon-btn" title={title} aria-label={title} aria-pressed={active} disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} onClick={run}>{icon}</button>
  );
  const chain = () => editor.chain().focus();
  /** Выделили несколько строк одного абзаца (перенос строки) и жмём «Список»/«Цитата»: каждая строка — отдельный пункт. */
  const blockChain = () => editor.chain().focus().command(({ state, tr }) => {
    const { from, to, empty, $from, $to } = state.selection;
    if (empty) return true;
    const breaks: number[] = [];
    state.doc.nodesBetween($from.start(), $to.end(), (node, pos) => { if (node.type.name === 'hardBreak' && pos >= from - 1 && pos <= to) breaks.push(pos); });
    for (const pos of breaks.reverse()) { tr.delete(pos, pos + 1); tr.split(pos); }
    return true;
  });
  const setLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Адрес ссылки', prev || 'https://');
    if (url === null) return;
    if (url.trim() === '') chain().extendMarkRange('link').unsetLink().run();
    else chain().extendMarkRange('link').setLink({ href: url.trim() }).run();
  };

  return (
    <div className="nve">
      <div className="nve-bar" role="toolbar" aria-label="Форматирование">
        {btn('Заголовок 1', <Heading1 size={16} />, () => chain().toggleHeading({ level: 1 }).run(), editor.isActive('heading', { level: 1 }))}
        {btn('Заголовок 2', <Heading2 size={16} />, () => chain().toggleHeading({ level: 2 }).run(), editor.isActive('heading', { level: 2 }))}
        {btn('Заголовок 3', <Heading3 size={16} />, () => chain().toggleHeading({ level: 3 }).run(), editor.isActive('heading', { level: 3 }))}
        {btn('Обычный текст', <Pilcrow size={16} />, () => chain().setParagraph().run(), editor.isActive('paragraph'))}
        <span className="nve-sep" aria-hidden="true" />
        {btn('Жирный (Ctrl+B)', <Bold size={16} />, () => chain().toggleBold().run(), editor.isActive('bold'))}
        {btn('Курсив (Ctrl+I)', <Italic size={16} />, () => chain().toggleItalic().run(), editor.isActive('italic'))}
        {btn('Зачёркнутый', <Strikethrough size={16} />, () => chain().toggleStrike().run(), editor.isActive('strike'))}
        {btn('Код', <Code size={16} />, () => chain().toggleCode().run(), editor.isActive('code'))}
        <span className="nve-sep" aria-hidden="true" />
        {btn('Чек-лист', <ListChecks size={16} />, () => blockChain().toggleTaskList().run(), editor.isActive('taskList'))}
        {btn('Список', <List size={16} />, () => blockChain().toggleBulletList().run(), editor.isActive('bulletList'))}
        {btn('Нумерованный список', <ListOrdered size={16} />, () => blockChain().toggleOrderedList().run(), editor.isActive('orderedList'))}
        {btn('Цитата', <Quote size={16} />, () => blockChain().toggleBlockquote().run(), editor.isActive('blockquote'))}
        {btn('Ссылка', <LinkIcon size={16} />, setLink, editor.isActive('link'))}
        {uploadImage && btn('Картинка', <ImagePlus size={16} />, pickImage)}
        <span className="nve-sep" aria-hidden="true" />
        {btn('Отменить (Ctrl+Z)', <Undo2 size={16} />, () => chain().undo().run(), false, !editor.can().undo())}
        {btn('Повторить (Ctrl+Shift+Z)', <Redo2 size={16} />, () => chain().redo().run(), false, !editor.can().redo())}
        {extraTools && extraTools.length > 0 && <span className="nve-sep" aria-hidden="true" />}
        {extraTools?.map((t) => btn(t.title, t.icon, t.onClick))}
      </div>
      <EditorContent editor={editor} className="nve-page" />
    </div>
  );
}
