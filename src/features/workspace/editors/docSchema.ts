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
          // data-named — именованный стиль Univer («Название» 2, «Подзаголовок» 3): по нему CSS рисует их иначе, чем заголовки.
          renderHTML: (attrs) => (attrs.ps ? {
            'data-ps': JSON.stringify(attrs.ps), style: paragraphCss(attrs.ps),
            ...(attrs.ps.namedStyleType ? { 'data-named': String(attrs.ps.namedStyleType) } : {}),
          } : {}),
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

/** Сочетания клавиш Google Документов, которых нет в TipTap по умолчанию. */
const GoogleKeys = Extension.create({
  name: 'sharGoogleKeys',
  addKeyboardShortcuts() {
    const indent = (d: 1 | -1) => () => {
      const ed = this.editor;
      if (ed.isActive('listItem')) return d > 0 ? ed.commands.sinkListItem('listItem') : ed.commands.liftListItem('listItem');
      if (ed.isActive('taskItem')) return d > 0 ? ed.commands.sinkListItem('taskItem') : ed.commands.liftListItem('taskItem');
      const { state } = ed;
      const tr = state.tr;
      state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
        if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return true;
        const ps = { ...((node.attrs.ps as Record<string, unknown>) || {}) };
        ps.indentStart = { v: Math.max(0, pt(ps.indentStart as Pt) + d * 36) };
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, ps });
        return false;
      });
      if (tr.docChanged) ed.view.dispatch(tr);
      return true;
    };
    return {
      'Mod-.': () => this.editor.commands.toggleMark('superscript'),
      'Mod-,': () => this.editor.commands.toggleMark('subscript'),
      'Mod-\\': () => this.editor.commands.unsetAllMarks(),
      'Alt-Shift-5': () => this.editor.commands.toggleStrike(),
      'Mod-]': indent(1),
      'Mod-[': indent(-1),
    };
  },
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
    GoogleKeys,
  ];
}
