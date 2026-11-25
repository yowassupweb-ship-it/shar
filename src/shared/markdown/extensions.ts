import type { AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Paragraph from '@tiptap/extension-paragraph';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import Image from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from 'tiptap-markdown';
import { EMPTY_LINE_MARK } from './paragraphs';

type MdState = { write: (s: string) => void; renderInline: (n: unknown) => void; closeBlock: (n: unknown) => void };

/**
 * Абзац для markdown Шара: пустой абзац (Enter на пустой строке) tiptap-markdown не пишет вовсе — пустые строки
 * пропадали после сохранения. Пишем его меткой, а fromEditorMarkdown превращает её в пустую строку.
 */
const SharParagraph = Paragraph.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: MdState, node: { childCount: number }) {
          if (node.childCount === 0) state.write(EMPTY_LINE_MARK);
          else state.renderInline(node);
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

/** Набор визуального редактора markdown (задачи): тот же и в проверке visual.check.ts. */
export function markdownExtensions(placeholder = ''): AnyExtension[] {
  return [
    StarterKit.configure({ underline: false, paragraph: false, link: { openOnClick: false, autolink: true } }),
    SharParagraph,
    TaskList,
    TaskItem.configure({ nested: true }),
    Image,
    Placeholder.configure({ placeholder }),
    Markdown.configure({ html: false, tightLists: true, bulletListMarker: '-', breaks: true, transformPastedText: true, transformCopiedText: true }),
  ];
}
