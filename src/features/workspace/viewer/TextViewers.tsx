import { ScrollTable } from '@/shared/ui/ScrollTable';
import { useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkUnderline from '../lib/remarkUnderline';
import remarkBreaks from 'remark-breaks';
import { decodeText, parseCsv } from '../lib/text';
import { cellText } from '../lib/workbook';
import { Spinner } from '@/shared/ui/Spinner';

/** Загрузка файла как текста/байт для просмотрщиков; ошибка — с понятным сообщением. */
function useFetched<T>(url: string, read: (res: Response) => Promise<T>): { data: T | null; error: string } {
  const [state, setState] = useState<{ data: T | null; error: string }>({ data: null, error: '' });
  useEffect(() => {
    let alive = true;
    setState({ data: null, error: '' });
    fetch(url, { credentials: 'same-origin' })
      .then((res) => { if (!res.ok) throw new Error(`Файл не открылся (${res.status})`); return read(res); })
      .then((data) => { if (alive) setState({ data, error: '' }); })
      .catch((cause) => { if (alive) setState({ data: null, error: cause instanceof Error ? cause.message : 'Не удалось открыть файл' }); });
    return () => { alive = false; };
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

/** Текст: кодировку определяем сами (UTF-8 или Windows-1251), а не верим серверу. */
const readText = async (res: Response) => decodeText(await res.arrayBuffer());

const Loading = ({ name }: { name: string }) => <div className="npv-state"><Spinner size={24} label={`Открываю «${name}»`} /></div>;

/** HTML — только просмотр: страница в изолированной «песочнице» без скриптов, форм и внешних запросов. */
export function HtmlViewer({ url, name }: { url: string; name: string }) {
  const { data, error } = useFetched(url, readText);
  if (error) return <div className="npv-state" role="alert">{error}</div>;
  if (data === null) return <Loading name={name} />;
  // CSP внутри документа запрещает загрузку чего-либо внешнего, кроме встроенных картинок и стилей.
  const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; style-src \'unsafe-inline\'; font-src data:">';
  const doc = /<head[^>]*>/i.test(data) ? data.replace(/<head[^>]*>/i, (m) => `${m}${csp}`) : `${csp}${data}`;
  return <iframe className="npv-frame" title={name} sandbox="" srcDoc={doc} />;
}

/** Word: страница разбирается mammoth в HTML и очищается от всего, кроме оформления текста. */
export function DocxViewer({ url, name }: { url: string; name: string }) {
  const { data, error } = useFetched(url, async (res) => {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.convertToHtml({ arrayBuffer: await res.arrayBuffer() });
    return DOMPurify.sanitize(value, { USE_PROFILES: { html: true } });
  });
  if (error) return <div className="npv-state" role="alert">{error}</div>;
  if (data === null) return <Loading name={name} />;
  return <div className="npv-scroll nx-scroll-y"><article className="npv-prose npv-paper" dangerouslySetInnerHTML={{ __html: data }} /></div>;
}

export function MarkdownViewer({ url, name }: { url: string; name: string }) {
  const { data, error } = useFetched(url, readText);
  if (error) return <div className="npv-state" role="alert">{error}</div>;
  if (data === null) return <Loading name={name} />;
  return (
    <div className="npv-scroll nx-scroll-y">
      <article className="npv-prose npv-paper">
        <Markdown remarkPlugins={[remarkGfm, remarkBreaks, remarkUnderline]} components={{
          a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
          table: ({ children }) => <ScrollTable className="npv-md-table"><table>{children}</table></ScrollTable>,
        }}>{data}</Markdown>
      </article>
    </div>
  );
}

export function PlainTextViewer({ url, name }: { url: string; name: string }) {
  const { data, error } = useFetched(url, readText);
  if (error) return <div className="npv-state" role="alert">{error}</div>;
  if (data === null) return <Loading name={name} />;
  return <div className="npv-scroll nx-scroll-y"><pre className="npv-plain">{data}</pre></div>;
}

const MAX_ROWS = 1000;
const MAX_COLS = 60;
const colName = (n: number) => { let s = ''; for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

interface SheetData { name: string; rows: string[][]; cols: number; truncated: boolean }

function SheetTable({ sheet }: { sheet: SheetData }) {
  return (
    <table className="npv-table">
      <thead>
        <tr><th />{Array.from({ length: sheet.cols }, (_, i) => <th key={i}>{colName(i + 1)}</th>)}</tr>
      </thead>
      <tbody>
        {sheet.rows.map((row, r) => (
          <tr key={r}>
            <th>{r + 1}</th>
            {Array.from({ length: sheet.cols }, (_, c) => <td key={c}>{row[c] || ''}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** CSV — той же таблицей, что Excel: разделитель (; , табуляция) и кодировка определяются сами. */
export function CsvViewer({ url, name }: { url: string; name: string }) {
  const { data, error } = useFetched<SheetData>(url, async (res) => {
    const all = parseCsv(decodeText(await res.arrayBuffer()));
    const rows = all.slice(0, MAX_ROWS).map((row) => row.slice(0, MAX_COLS));
    return { name, rows, cols: rows.reduce((max, row) => Math.max(max, row.length), 0), truncated: all.length > MAX_ROWS || all.some((row) => row.length > MAX_COLS) };
  });
  if (error) return <div className="npv-state" role="alert">{error}</div>;
  if (data === null) return <Loading name={name} />;
  return (
    <div className="npv-sheet">
      <div className="npv-scroll nx-scroll-y">
        <SheetTable sheet={data} />
        {data.truncated && <p className="npv-note">Показаны первые {MAX_ROWS} строк и {MAX_COLS} столбцов. Остальное — в редакторе.</p>}
      </div>
    </div>
  );
}

/** Excel: листы показываются таблицей со вкладками; значения — как в ячейках (формулы — их результат). */
export function XlsxViewer({ url, name }: { url: string; name: string }) {
  const [active, setActive] = useState(0);
  const { data, error } = useFetched<SheetData[]>(url, async (res) => {
    const { Workbook } = await import('exceljs');
    const book = new Workbook();
    await book.xlsx.load(await res.arrayBuffer());
    return book.worksheets.map((sheet) => {
      const rows: string[][] = [];
      let cols = 0;
      sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
        if (rowNumber > MAX_ROWS) return;
        const cells: string[] = [];
        for (let c = 1; c <= Math.min(MAX_COLS, row.cellCount); c += 1) cells.push(cellText(row.getCell(c)));
        cols = Math.max(cols, cells.length);
        rows[rowNumber - 1] = cells;
      });
      return { name: sheet.name, rows: Array.from(rows, (r) => r || []), cols, truncated: sheet.rowCount > MAX_ROWS || sheet.columnCount > MAX_COLS };
    });
  });
  if (error) return <div className="npv-state" role="alert">{error}</div>;
  if (data === null) return <Loading name={name} />;
  const sheet = data[Math.min(active, data.length - 1)];
  if (!sheet) return <div className="npv-state">В книге нет листов.</div>;
  return (
    <div className="npv-sheet">
      <div className="npv-scroll nx-scroll-y">
        <SheetTable sheet={sheet} />
        {sheet.truncated && <p className="npv-note">Показаны первые {MAX_ROWS} строк и {MAX_COLS} столбцов. Остальное — в редакторе.</p>}
      </div>
      {data.length > 1 && (
        <div className="npv-tabs" role="tablist" aria-label="Листы">
          {data.map((s, i) => <button key={s.name + i} type="button" role="tab" aria-selected={i === active} onClick={() => setActive(i)}>{s.name}</button>)}
        </div>
      )}
    </div>
  );
}
