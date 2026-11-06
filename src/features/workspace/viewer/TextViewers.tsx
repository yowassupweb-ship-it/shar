import { ScrollTable } from '@/shared/ui/ScrollTable';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import DOMPurify from 'dompurify';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkUnderline from '../lib/remarkUnderline';
import remarkBreaks from 'remark-breaks';
import { decodeText, parseCsv } from '../lib/text';
import { MAX_COLS, MAX_ROWS, readWorkbook, type CssMap, type SheetData } from './sheetStyle';
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

/** Результат асинхронной обработки уже загруженных данных (null — ещё считается или обрабатывать нечего). */
function useDerived<T, R>(input: T | null, make: (value: T) => Promise<R>, onError: R): R | null {
  const [out, setOut] = useState<R | null>(null);
  useEffect(() => {
    if (input === null) return undefined;
    let alive = true;
    make(input).then((v) => { if (alive) setOut(v); }).catch(() => { if (alive) setOut(onError); });
    return () => { alive = false; };
  }, [input]); // eslint-disable-line react-hooks/exhaustive-deps
  return out;
}

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

/** Страница Word глазами автора: docx-preview рисует документ с настоящим оформлением — цвета и размеры шрифтов,
 *  выравнивание, заливки и границы таблиц, колонтитулы, картинки, нумерацию. Рисуем в изолированном shadow DOM:
 *  стили документа не влияют на приложение, а стили приложения — на документ. Не получилось (повреждённый или
 *  нестандартный файл) — запасной путь: mammoth даёт упрощённый вид (текст, заголовки, списки, таблицы). */
const DOCX_CSS = `
  :host { display: block; }
  .docx-wrapper { background: transparent !important; padding: 16px 0 !important; align-items: center; }
  .docx-wrapper > section.docx { background: #fff; color: #000; box-shadow: 0 0 0 1px rgba(0,0,0,.12), 0 2px 10px rgba(0,0,0,.18) !important; margin-bottom: 14px !important; max-width: 100%; box-sizing: border-box; overflow: hidden; }
  .docx-wrapper img { max-width: 100%; height: auto; }
  .docx-wrapper a { color: #0563c1; }
`;

function DocxPages({ buffer, onFail }: { buffer: ArrayBuffer; onFail: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return undefined;
    let alive = true;
    const root = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    root.replaceChildren();
    const style = document.createElement('style');
    style.textContent = DOCX_CSS;
    const styles = document.createElement('div');
    const body = document.createElement('div');
    root.append(style, styles, body);
    import('docx-preview')
      .then(({ renderAsync }) => renderAsync(buffer, body, styles, {
        className: 'docx', inWrapper: true, ignoreWidth: false, ignoreHeight: true, ignoreFonts: false, breakPages: true,
        renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true, useBase64URL: true, experimental: true,
      }))
      .then(() => {
        if (!alive) return;
        // Ссылки документа — только http(s)/mailto, в новой вкладке; скрипты и встроенное содержимое отсекаем.
        body.querySelectorAll('script, iframe, object, embed').forEach((n) => n.remove());
        body.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
          const href = a.getAttribute('href') || '';
          if (/^(https?:|mailto:)/i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; } else if (!href.startsWith('#')) a.removeAttribute('href');
        });
      })
      .catch(() => { if (alive) onFail(); });
    return () => { alive = false; root.replaceChildren(); };
  }, [buffer]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={host} className="npv-docx" />;
}

export function DocxViewer({ url, name }: { url: string; name: string }) {
  const [fallback, setFallback] = useState(false);
  const { data, error } = useFetched(url, (res) => res.arrayBuffer());
  const simple = useDerived<ArrayBuffer, string>(fallback ? data : null, async (buffer) => {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.convertToHtml({ arrayBuffer: buffer });
    return DOMPurify.sanitize(value, { USE_PROFILES: { html: true } });
  }, '<p>Не удалось показать документ. Скачайте его.</p>');
  if (error) return <div className="npv-state" role="alert">{error}</div>;
  if (data === null) return <Loading name={name} />;
  if (fallback) {
    if (simple === null) return <Loading name={name} />;
    return <div className="npv-scroll nx-scroll-y"><article className="npv-prose npv-paper" dangerouslySetInnerHTML={{ __html: simple }} /></div>;
  }
  return <div className="npv-scroll nx-scroll-y npv-docx-scroll"><DocxPages buffer={data} onFail={() => setFallback(true)} /></div>;
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

const colName = (n: number) => { let s = ''; for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

const toStyle = (css?: CssMap): CSSProperties | undefined => {
  if (!css) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(css)) out[key.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase())] = value;
  return out as CSSProperties;
};

/** Таблица как в Excel: лист «бумага» (белый, чёрный текст) — заливки и цвета шрифтов из файла рассчитаны на неё и
 *  в тёмной теме иначе давали бы чёрное на тёмном; буквы столбцов и номера строк — в цветах приложения. */
function SheetTable({ sheet }: { sheet: SheetData }) {
  const total = sheet.widths.reduce((sum, w) => sum + w, 0);
  return (
    <table className="npv-table" style={{ width: total + 44 }}>
      <colgroup>
        <col style={{ width: 44 }} />
        {sheet.widths.map((w, i) => <col key={i} style={{ width: w }} />)}
      </colgroup>
      <thead>
        <tr><th />{sheet.widths.map((w, i) => (w ? <th key={i}>{colName(i + 1)}</th> : null))}</tr>
      </thead>
      <tbody>
        {sheet.rows.map((row, r) => (sheet.heights[r] === 0 ? null : (
          <tr key={r} style={sheet.heights[r] ? { height: sheet.heights[r] } : undefined}>
            <th>{r + 1}</th>
            {row.map((cell, c) => (cell.hidden ? null : (
              <td key={c} colSpan={cell.colSpan} rowSpan={cell.rowSpan} style={toStyle(cell.css)}>
                {cell.runs.map((run, i) => {
                  const body = run.css ? <span key={i} style={toStyle(run.css)}>{run.text}</span> : run.text;
                  return cell.link && i === 0 ? <a key={i} href={cell.link} target="_blank" rel="noopener noreferrer">{body}</a> : body;
                })}
              </td>
            )))}
          </tr>
        )))}
      </tbody>
    </table>
  );
}

const plain = (rows: string[][], name: string, truncated: boolean): SheetData => {
  const cols = rows.reduce((max, row) => Math.max(max, row.length), 0);
  return {
    name, cols, truncated,
    widths: Array.from({ length: cols }, () => 96),
    heights: rows.map(() => undefined),
    rows: rows.map((row) => Array.from({ length: cols }, (_, c) => ({ runs: [{ text: row[c] || '' }] }))),
  };
};

/** CSV — той же таблицей, что Excel: разделитель (; , табуляция) и кодировка определяются сами. */
export function CsvViewer({ url, name }: { url: string; name: string }) {
  const { data, error } = useFetched<SheetData>(url, async (res) => {
    const all = parseCsv(decodeText(await res.arrayBuffer()));
    const rows = all.slice(0, MAX_ROWS).map((row) => row.slice(0, MAX_COLS));
    return plain(rows, name, all.length > MAX_ROWS || all.some((row) => row.length > MAX_COLS));
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

/** Excel: листы — таблицей со вкладками, с оформлением из файла (заливки, шрифты, границы, объединения,
 *  ширины, форматы чисел). Значения — как в ячейках (формулы — их результат). */
export function XlsxViewer({ url, name }: { url: string; name: string }) {
  const [active, setActive] = useState(0);
  const { data, error } = useFetched<SheetData[]>(url, async (res) => readWorkbook(await res.arrayBuffer()));
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
          {data.map((s, i) => (
            <button key={s.name + i} type="button" role="tab" aria-selected={i === active} onClick={() => setActive(i)}
              style={s.tab ? { boxShadow: `inset 0 -3px 0 ${s.tab}` } : undefined}>{s.name}</button>
          ))}
        </div>
      )}
    </div>
  );
}
