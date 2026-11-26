import { Extension, Mark, mergeAttributes, type AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TextStyleKit } from '@tiptap/extension-text-style';
import TextAlign from '@tiptap/extension-text-align';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { docImageView } from './docImageView';

/**
 * Возможности нового редактора документов (TipTap/ProseMirror) — ровно то, что есть в документах Шара (опрос всех
 * 205 документов, 19.11.2026): абзацы и заголовки, списки и чек-листы, выравнивание, жирный, курсив, подчёркнутый,
 * зачёркнутый, цвет, фон, кегль, гарнитура, индексы, ссылки, картинки, таблицы (объединение ячеек, ширина столбцов, заливка), разрыв страницы.
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
  const end = pt(ps.indentEnd as Pt);
  if (end) css.push(`padding-right:${end}pt`);
  // Горизонтальная линия Univer — пустой абзац с нижней границей (doc.command.horizontal-line).
  const bb = ps.borderBottom as { padding?: number; width?: number; color?: { rgb?: string } } | undefined;
  if (bb) css.push(`border-bottom:${Math.max(1, Number(bb.width) || 1)}px solid ${bb.color?.rgb || '#CDD0D8'};padding-bottom:${Number(bb.padding) || 5}pt;margin-bottom:${Number(bb.padding) || 5}pt`);
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

/** Цвет → [r, g, b] 0…255 (#rgb, #rrggbb, rgb()); неизвестный — null. */
function rgbOf(color: string): [number, number, number] | null {
  const c = color.trim().toLowerCase();
  const hex = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  const rgb = c.match(/^rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((x) => x + x).join('') : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
  }
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}
/** Тот же оттенок с другой светлотой (HSL), насыщенность можно приглушить. */
function withLightness([r, g, b]: [number, number, number], light: number, satK = 1): string {
  const R = r / 255; const G = g / 255; const B = b / 255;
  const max = Math.max(R, G, B); const min = Math.min(R, G, B); const l = (max + min) / 2; const d = max - min;
  let h = 0; let s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d) h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h = (h * 60 + 360) % 360; s = Math.min(1, s * satK);
  const C = (1 - Math.abs(2 * light - 1)) * s; const X = C * (1 - Math.abs(((h / 60) % 2) - 1)); const m = light - C / 2;
  const [r1, g1, b1] = h < 60 ? [C, X, 0] : h < 120 ? [X, C, 0] : h < 180 ? [0, C, X] : h < 240 ? [0, X, C] : h < 300 ? [X, 0, C] : [C, 0, X];
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r1)}${to(g1)}${to(b1)}`;
}
const hslLight = ([r, g, b]: [number, number, number]) => (Math.max(r, g, b) + Math.min(r, g, b)) / 510;
/**
 * Цвет текста для тёмного листа: тёмный — светлым того же оттенка (тёмно-синий → светло-голубой), светлый — как
 * есть. null — менять не нужно.
 */
function darkInk(color: string): string | null {
  const rgb = rgbOf(color); if (!rgb) return null;
  // Решаем по воспринимаемой яркости (синий #0000ff по HSL «средний», а на тёмном листе его не видно).
  const lum = lightness(color) ?? hslLight(rgb);
  if (lum >= 0.55) return null;
  return withLightness(rgb, Math.min(0.9, Math.max(0.68, 1 - lum)));
}
/**
 * Заливка (выделение текста, ячейка таблицы) для тёмного листа: светлая — тёмной того же оттенка (жёлтое выделение →
 * тёмно-жёлтое, светло-зелёная ячейка → тёмно-зелёная), белая — прозрачной, тёмная и насыщенная средняя — как есть.
 */
function darkFill(color: string): string | null {
  const rgb = rgbOf(color); if (!rgb) return null;
  // По воспринимаемой яркости: ярко-жёлтое выделение (#ffff00) светлое, хоть по HSL и «среднее».
  const lum = lightness(color) ?? hslLight(rgb);
  if (lum >= 0.97) return 'transparent';
  if (lum < 0.5) return null;
  return withLightness(rgb, Math.min(0.32, Math.max(0.16, 1 - lum)), 0.75);
}
/** Заливка тёмная (на ней светлый текст в светлой теме не надо приглушать) или светлая. */
const fillTone = (color: string) => { const l = lightness(color); return l === null ? null : l < 0.6 ? 'dark' : 'light'; };

/** Яркость цвета 0…1 (#rgb, #rrggbb, rgb()). Неизвестный — null. */
function lightness(color: string): number | null {
  const c = color.trim().toLowerCase();
  let r: number; let g: number; let b: number;
  const hex = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  const rgb = c.match(/^rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((x) => x + x).join('') : hex[1];
    [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  } else if (rgb) [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(Number);
  else return null;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Тёмный текст на тёмном листе: Univer в тёмной теме сам осветлял цвета холста, а здесь цвет пишется как есть —
 * чёрное оставалось на графитовом. Помечаем цвет яркостью (data-ink), а тема (fastDoc.css) подменяет тёмные
 * цвета цветом текста листа. Сам цвет в документе не меняется.
 */
const InkMark = Extension.create({
  name: 'sharInk',
  addGlobalAttributes() {
    return [{
      types: ['textStyle'],
      attributes: {
        ink: {
          default: null,
          parseHTML: () => null,
          renderHTML: (attrs) => {
            const out: Record<string, string> = {};
            const l = attrs.color ? lightness(String(attrs.color)) : null;
            if (l !== null) out['data-ink'] = l < 0.35 ? 'dark' : l > 0.85 ? 'light' : 'mid';
            // Тёмная тема: свой вариант цвета (оттенок тот же, яркость перевёрнута) — в переменной, тема его подставляет.
            const styles: string[] = [];
            const dc = attrs.color ? darkInk(String(attrs.color)) : null;
            if (dc) { out['data-ink-c'] = ''; styles.push(`--ink-dark:${dc}`); }
            const db = attrs.backgroundColor ? darkFill(String(attrs.backgroundColor)) : null;
            if (db) { out['data-ink-b'] = ''; styles.push(`--fill-dark:${db}`); }
            const tone = attrs.backgroundColor ? fillTone(String(attrs.backgroundColor)) : null;
            if (tone) out['data-fill'] = tone;
            if (styles.length) out.style = styles.join(';');
            return out;
          },
        },
      },
    }];
  },
});

/** Картинка Univer: id блока и рисунка — чтобы при сохранении вернуть тот же рисунок (размер, обтекание). */
const SharImage = Image.extend({
  addNodeView() { return docImageView; },
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


/** Свойства Univer у таблицы, строки и ячейки (границы, поля, высота, заливка…) — едут в атрибуте src и возвращаются в снимок. */
const srcAttr = (data: string) => ({
  src: {
    default: null,
    parseHTML: (el: HTMLElement) => { try { return JSON.parse(el.getAttribute(`data-${data}`) || 'null'); } catch { return null; } },
    renderHTML: (a: Record<string, unknown>) => (a.src ? { [`data-${data}`]: JSON.stringify(a.src) } : {}),
  },
});
const SharTable = Table.extend({ addAttributes() { return { ...this.parent?.(), ...srcAttr('table') }; } })
  .configure({ resizable: true, cellMinWidth: 40, lastColumnResizable: false });
const SharTableRow = TableRow.extend({ addAttributes() { return { ...this.parent?.(), ...srcAttr('row') }; } });
/** Ячейка: заливка — видимым фоном (как в Univer), остальные свойства — в src. */
const SharTableCell = TableCell.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      ...srcAttr('cell'),
      // Ширина столбцов (px листа) — из data-colwidth, который пишет lib/univerHtml.ts; ручка у границы меняет её.
      colwidth: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const raw = el.getAttribute('data-colwidth') || el.getAttribute('colwidth');
          const list = raw ? raw.split(',').map((x) => Number(x)) : [];
          return list.length && list.every((x) => x > 0) ? list : null;
        },
        renderHTML: (a: Record<string, unknown>) => (Array.isArray(a.colwidth) ? { 'data-colwidth': a.colwidth.join(',') } : {}),
      },
      background: {
        default: null,
        parseHTML: (el: HTMLElement) => el.style.backgroundColor || null,
        renderHTML: (a: Record<string, unknown>) => {
          if (!a.background) return {};
          const dark = darkFill(String(a.background));
          const tone = fillTone(String(a.background));
          return {
            style: `background-color:${String(a.background)}${dark ? `;--fill-dark:${dark}` : ''}`,
            ...(dark ? { 'data-ink-b': '' } : {}),
            ...(tone ? { 'data-fill': tone } : {}),
          };
        },
      },
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
    SharTable,
    SharTableRow,
    SharTableCell,
    // У Univer нет ячеек-заголовков; узел нужен схеме таблицы (вставленная из HTML <th> станет обычной ячейкой при сохранении).
    TableHeader,
    Subscript,
    Superscript,
    ParagraphStyle,
    GoogleKeys,
    InkMark,
  ];
}
