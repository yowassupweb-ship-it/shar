import { Extension, Mark, mergeAttributes, type AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TextStyleKit } from '@tiptap/extension-text-style';
import TextAlign from '@tiptap/extension-text-align';

/**
 * Возможности нового редактора документов (TipTap/ProseMirror) — ровно то, что есть в документах Шара (опрос всех
 * 205 документов, 19.11.2026): абзацы и заголовки, списки и чек-листы, выравнивание, жирный, курсив, подчёркнутый,
 * зачёркнутый, цвет, фон, кегль, гарнитура, индексы, ссылки, картинки, разрыв страницы.
 *
 * Хранение не меняется — снимок Univer: открытие через lib/univerHtml.ts, сохранение через lib/pmToUniver.ts.
 * То, чего редактор не показывает, но что лежит в снимке (межстрочный интервал и отступы абзаца, id картинки),
 * едет в атрибутах узлов и возвращается в снимок как было.
 */

type Pt = { v?: number } | number | null | undefined;
const pt = (value: Pt): number => Number(typeof value === 'object' && value ? value.v : value) || 0;

/** Стиль абзаца Univer → CSS: межстрочный (множитель), отступы до и после (pt), отступ слева и красная строка (pt). */
function paragraphCss(ps: Record<string, unknown>): string {
  const css: string[] = [];
  const line = Number(ps.lineSpacing);
  if (line > 0 && line < 5) css.push(`line-height:${line}`);
  const above = pt(ps.spaceAbove as Pt);
  const below = pt(ps.spaceBelow as Pt);
  if (above) css.push(`margin-top:${above}pt`);
  if (below) css.push(`margin-bottom:${below}pt`);
  const start = pt(ps.indentStart as Pt);
  const first = pt(ps.indentFirstLine as Pt);
  if (start) css.push(`padding-left:${start}pt`);
  if (first) css.push(`text-indent:${first}pt`);
  return css.join(';');
}

/** Стиль абзаца Univer целиком (lineSpacing, spaceAbove, …) — в атрибуте data-ps, чтобы не терять при сохранении. */
const ParagraphStyle = Extension.create({
  name: 'univerParagraphStyle',
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading'],
      attributes: {
        ps: {
          default: null,
          parseHTML: (el) => { try { return JSON.parse(el.getAttribute('data-ps') || 'null'); } catch { return null; } },
          // Сам стиль — в data-ps (вернётся в снимок как был), а видимое — CSS: интервал, отступы до/после, красная строка.
          renderHTML: (attrs) => (attrs.ps ? { 'data-ps': JSON.stringify(attrs.ps), style: paragraphCss(attrs.ps) } : {}),
        },
      },
    }];
  },
});

/** Картинка Univer: id блока и рисунка — чтобы при сохранении вернуть тот же рисунок (размер, обтекание). */
const SharImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      blockId: { default: null, parseHTML: (el) => el.getAttribute('data-block-id'), renderHTML: (a) => (a.blockId ? { 'data-block-id': a.blockId } : {}) },
      width: { default: null, parseHTML: (el) => Number(el.getAttribute('width')) || null, renderHTML: (a) => (a.width ? { width: a.width } : {}) },
    };
  },
  // base64 разрешён ради картинок, уже вшитых в старые документы (такой один); новые загружаются файлом на сервер.
}).configure({ inline: true, allowBase64: true });

const Subscript = Mark.create({
  name: 'subscript',
  excludes: 'superscript',
  parseHTML: () => [{ tag: 'sub' }],
  renderHTML: ({ HTMLAttributes }) => ['sub', mergeAttributes(HTMLAttributes), 0],
});
const Superscript = Mark.create({
  name: 'superscript',
  excludes: 'subscript',
  parseHTML: () => [{ tag: 'sup' }],
  renderHTML: ({ HTMLAttributes }) => ['sup', mergeAttributes(HTMLAttributes), 0],
});

export function docExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5] },
      code: false,
      codeBlock: false,
      blockquote: false,
      // Ссылка открывается по Ctrl+клику (как в Google Docs), обычный клик ставит курсор.
      link: { openOnClick: false, autolink: true, linkOnPaste: true, HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' } },
    }),
    TextStyleKit.configure({ lineHeight: false }),
    TextAlign.configure({ types: ['heading', 'paragraph'], alignments: ['left', 'center', 'right', 'justify'] }),
    TaskList,
    TaskItem.configure({ nested: true }),
    SharImage,
    Subscript,
    Superscript,
    ParagraphStyle,
  ];
}
