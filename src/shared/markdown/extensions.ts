import type { AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Paragraph from '@tiptap/extension-paragraph';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import Image from '@tiptap/extension-image';
import { imageWidth, withImageWidth } from './imageSize';
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

/**
 * Картинка с ручками размера: тянете за правый край или угол — ширина в процентах текста (шаг 5%), пока тянете —
 * подпись с процентом; двойной щелчок по ручке — исходный размер. Ширина живёт меткой «#w=NN» в адресе
 * (imageSize.ts), поэтому markdown остаётся обычным: ![](адрес#w=50).
 */
const ResizableImage = Image.extend({
  // Картинка — свой блок: tiptap-markdown писал её без перевода строки, и следующий абзац прилипал к ней
  // («![](…)Текст после») — после перезагрузки текст оказывался в одной строке с картинкой.
  addStorage() {
    return {
      markdown: {
        serialize(state: MdState & { esc: (s: string) => string }, node: { attrs: { src?: string; alt?: string; title?: string } }) {
          const alt = state.esc(String(node.attrs.alt || ''));
          const title = node.attrs.title ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"` : '';
          state.write(`![${alt}](${String(node.attrs.src || '').replace(/[()]/g, '\\$&')}${title})`);
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = document.createElement('span');
      dom.className = 'nve-img';
      const img = document.createElement('img');
      img.draggable = false;
      const label = document.createElement('span');
      label.className = 'nve-img-size';
      const handles = (['r', 'br'] as const).map((side) => {
        const h = document.createElement('span');
        h.className = 'nve-img-handle';
        h.dataset.side = side;
        h.title = 'Потяните — размер картинки; двойной щелчок — исходный размер';
        return h;
      });
      dom.append(img, ...handles, label);
      const render = () => {
        img.src = String(current.attrs.src || '');
        img.alt = String(current.attrs.alt || '');
        const w = imageWidth(current.attrs.src as string);
        dom.style.width = w ? `${w}%` : '';
        if (w) dom.dataset.sized = ''; else delete dom.dataset.sized;
      };
      render();
      const save = (width: number | null) => {
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (typeof pos !== 'number') return;
        const src = withImageWidth(String(current.attrs.src || ''), width);
        editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, src }));
      };
      for (const h of handles) {
        h.addEventListener('pointerdown', (e) => {
          if (!editor.isEditable || e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          h.setPointerCapture(e.pointerId);
          const parent = dom.parentElement || editor.view.dom;
          const cs = getComputedStyle(parent);
          const total = parent.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
          const start = dom.getBoundingClientRect().width;
          const x0 = e.clientX;
          let pct = 0;
          dom.dataset.resizing = '';
          const move = (ev: PointerEvent) => {
            const px = start + (ev.clientX - x0);
            pct = Math.max(10, Math.min(100, Math.round((px / Math.max(1, total)) * 20) * 5));
            dom.style.width = `${pct}%`;
            label.textContent = `${pct}%`;
          };
          const up = () => {
            h.removeEventListener('pointermove', move);
            h.removeEventListener('pointerup', up);
            h.removeEventListener('pointercancel', up);
            delete dom.dataset.resizing;
            if (pct) save(pct); else render();
          };
          h.addEventListener('pointermove', move);
          h.addEventListener('pointerup', up);
          h.addEventListener('pointercancel', up);
        });
        h.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); if (editor.isEditable) save(null); });
      }
      return {
        dom,
        update: (next) => {
          if (next.type !== current.type) return false;
          current = next;
          render();
          return true;
        },
        selectNode: () => dom.classList.add('is-selected'),
        deselectNode: () => dom.classList.remove('is-selected'),
        stopEvent: (e) => (e.target as HTMLElement | null)?.classList?.contains('nve-img-handle') ?? false,
        ignoreMutation: () => true,
      };
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
    ResizableImage,
    Placeholder.configure({ placeholder }),
    Markdown.configure({ html: false, tightLists: true, bulletListMarker: '-', breaks: true, transformPastedText: true, transformCopiedText: true }),
  ];
}
