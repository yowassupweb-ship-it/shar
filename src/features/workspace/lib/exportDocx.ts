import type { Content, PhrasingContent, Root, TableCell } from 'mdast';

/**
 * Markdown → настоящий файл Word (.docx). Документы и заметки хранятся как Markdown-подобный текст, поэтому
 * разбираем его remark'ом и собираем документ библиотекой docx: заголовки, списки (в том числе вложенные и
 * задачи), цитаты, код, таблицы, ссылки, жирный/курсив/зачёркнутый. Картинки заменяются ссылкой на них:
 * вложения Шара лежат за входом, и Word всё равно не смог бы их скачать.
 * Тяжёлое — грузится только по нажатию «Скачать .docx».
 */

type Docx = typeof import('docx');
type Inline = { bold?: boolean; italics?: boolean; strike?: boolean; underline?: boolean; code?: boolean };

const HEADINGS = ['HEADING_1', 'HEADING_2', 'HEADING_3', 'HEADING_4', 'HEADING_5', 'HEADING_6'] as const;

export async function markdownToDocx(title: string, markdown: string): Promise<Blob> {
  const [docx, { unified }, { default: remarkParse }, { default: remarkGfm }] = await Promise.all([
    import('docx'), import('unified'), import('remark-parse'), import('remark-gfm'),
  ]);
  // Подчёркнутое (<u>, __, ++) — отдельным узлом, как в просмотре заметки.
  const { default: remarkUnderline } = await import('./remarkUnderline');
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkUnderline as unknown as () => (tree: Root) => void);
  const tree = processor.runSync(processor.parse(markdown), markdown) as Root;
  const { Document, Packer, Paragraph, TextRun, ExternalHyperlink, HeadingLevel, Table, TableRow, TableCell: Cell, WidthType, BorderStyle, LevelFormat, AlignmentType } = docx;

  const runs = (nodes: PhrasingContent[], style: Inline = {}): Array<InstanceType<Docx['TextRun']> | InstanceType<Docx['ExternalHyperlink']>> => {
    const out: Array<InstanceType<Docx['TextRun']> | InstanceType<Docx['ExternalHyperlink']>> = [];
    for (const node of nodes) {
      switch (node.type) {
        case 'text': out.push(new TextRun({ text: node.value, bold: style.bold, italics: style.italics, strike: style.strike, underline: style.underline ? {} : undefined, font: style.code ? 'Consolas' : undefined })); break;
        case 'strong': out.push(...runs(node.children, { ...style, bold: true })); break;
        case 'emphasis': out.push(...runs(node.children, { ...style, italics: true })); break;
        case 'delete': out.push(...runs(node.children, { ...style, strike: true })); break;
        // Узел подчёркивания добавляет remarkUnderline — в типах mdast его нет.
        case 'underline' as PhrasingContent['type']: out.push(...runs((node as unknown as { children: PhrasingContent[] }).children, { ...style, underline: true })); break;
        case 'inlineCode': out.push(new TextRun({ text: node.value, font: 'Consolas', bold: style.bold, italics: style.italics })); break;
        case 'break': out.push(new TextRun({ break: 1 })); break;
        case 'link': out.push(new ExternalHyperlink({ link: node.url, children: runs(node.children, style).filter((r): r is InstanceType<Docx['TextRun']> => r instanceof TextRun).map((r) => r) })); break;
        case 'image': out.push(new TextRun({ text: node.alt ? `[${node.alt}] ${node.url}` : node.url, italics: true })); break;
        default: if ('children' in node) out.push(...runs((node as { children: PhrasingContent[] }).children, style)); else if ('value' in node) out.push(new TextRun({ text: String((node as { value: unknown }).value) }));
      }
    }
    return out;
  };

  type Block = InstanceType<Docx['Paragraph']> | InstanceType<Docx['Table']>;
  const blocks = (nodes: Content[], level = 0, quote = false): Block[] => {
    const out: Block[] = [];
    const indent = quote ? { left: 480 } : undefined;
    for (const node of nodes) {
      switch (node.type) {
        case 'heading': out.push(new Paragraph({ heading: HeadingLevel[HEADINGS[Math.min(node.depth, 6) - 1]], children: runs(node.children), spacing: { before: 240, after: 80 } })); break;
        case 'paragraph': out.push(new Paragraph({ children: runs(node.children), spacing: { after: 120 }, indent })); break;
        case 'blockquote': out.push(...blocks(node.children, level, true)); break;
        case 'code': out.push(...node.value.split('\n').map((line) => new Paragraph({ children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 20 })], shading: { fill: 'F3F4F6' }, indent }))); break;
        case 'thematicBreak': out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'BBBBBB', space: 1 } }, spacing: { after: 120 } })); break;
        case 'list': {
          for (const item of node.children) {
            const [first, ...rest] = item.children;
            const prefix = typeof item.checked === 'boolean' ? [new TextRun({ text: item.checked ? '☑ ' : '☐ ' })] : [];
            const lead = first?.type === 'paragraph' ? runs(first.children) : [];
            out.push(new Paragraph({ children: [...prefix, ...lead], numbering: { reference: node.ordered ? 'shar-numbers' : 'shar-bullets', level: Math.min(level, 5) }, spacing: { after: 60 } }));
            const tail = first && first.type !== 'paragraph' ? [first, ...rest] : rest;
            out.push(...blocks(tail as Content[], level + 1, quote));
          }
          break;
        }
        case 'table': {
          const columns = Math.max(1, ...node.children.map((row) => row.children.length));
          const cell = (c: TableCell | undefined, header: boolean) => new Cell({
            children: [new Paragraph({ children: c ? runs(c.children, header ? { bold: true } : {}) : [] })],
            shading: header ? { fill: 'EEF1F5' } : undefined,
            width: { size: Math.floor(100 / columns), type: WidthType.PERCENTAGE },
          });
          out.push(new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: node.children.map((row, index) => new TableRow({ tableHeader: index === 0, children: Array.from({ length: columns }, (_, i) => cell(row.children[i], index === 0)) })),
          }));
          out.push(new Paragraph({ spacing: { after: 120 } }));
          break;
        }
        case 'html': out.push(new Paragraph({ children: [new TextRun({ text: node.value.replace(/<[^>]+>/g, '') })] })); break;
        default: break;
      }
    }
    return out;
  };

  const levels = (format: (typeof LevelFormat)[keyof typeof LevelFormat], text: (level: number) => string) =>
    Array.from({ length: 6 }, (_, level) => ({ level, format, text: text(level), alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540 + level * 360, hanging: 270 } } } }));

  const heading = title.trim();
  const doc = new Document({
    creator: 'Шар',
    title: heading,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: {
      config: [
        { reference: 'shar-bullets', levels: levels(LevelFormat.BULLET, () => '•') },
        { reference: 'shar-numbers', levels: levels(LevelFormat.DECIMAL, (level) => `%${level + 1}.`) },
      ],
    },
    sections: [{
      children: [
        ...(heading ? [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: heading })], spacing: { after: 200 } })] : []),
        ...blocks(tree.children as Content[]),
      ],
    }],
  });
  return Packer.toBlob(doc);
}

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
