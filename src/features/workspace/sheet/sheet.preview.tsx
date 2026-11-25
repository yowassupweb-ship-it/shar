import { createRoot, type Root } from 'react-dom/client';
import FastSheetEditor from '../editors/FastSheetEditor';
import { bookToBase64, newBook } from '../lib/workbook';

/**
 * Проверка своего редактора таблиц на тестовой книге в памяти (вручную в окне с Vite, без сервера):
 * `await (await import('/src/features/workspace/sheet/sheet.preview.tsx')).mount()` — и `unmount()` после.
 */
let root: Root | null = null;
let host: HTMLDivElement | null = null;

export async function mount(): Promise<string> {
  const book = await newBook();
  const ws = book.worksheets[0];
  ws.getCell('A1').value = 'Товар'; ws.getCell('B1').value = 'Цена'; ws.getCell('C1').value = 'Кол-во'; ws.getCell('D1').value = 'Сумма';
  ['A1', 'B1', 'C1', 'D1'].forEach((a) => { ws.getCell(a).font = { bold: true }; ws.getCell(a).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } }; });
  const rows: Array<[string, number, number]> = [['Чай', 120.5, 3], ['Кофе', 350, 2], ['Печенье с очень длинным названием', 89.9, 10]];
  rows.forEach(([name, price, qty], i) => {
    const r = i + 2;
    ws.getCell(`A${r}`).value = name;
    ws.getCell(`B${r}`).value = price; ws.getCell(`B${r}`).numFmt = '#,##0.00 "₽"';
    ws.getCell(`C${r}`).value = qty;
    ws.getCell(`D${r}`).value = { formula: `B${r}*C${r}`, result: 0 } as never;
  });
  ws.getCell('D5').value = { formula: 'СУММ(D2:D4)', result: 0 } as never;
  ws.getCell('A7').value = new Date(Date.UTC(2026, 10, 25));
  ws.mergeCells('A9:C10'); ws.getCell('A9').value = 'Объединено'; ws.getCell('A9').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getColumn(1).width = 18;
  ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 0 }];
  const content = await bookToBase64(book);
  document.querySelectorAll('#fsh-preview').forEach((el) => el.remove());
  host = document.createElement('div');
  host.id = 'fsh-preview';
  host.style.cssText = 'position:fixed;inset:40px 40px 40px 40px;z-index:99999;display:flex;flex-direction:column;border:1px solid #888;';
  host.className = 'nx';
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(<FastSheetEditor content={content} onContent={(next) => { (window as unknown as { __fshSaved?: string }).__fshSaved = next; }} readOnly={false} loadKey={0} />);
  return 'ok';
}

export function unmount(): void {
  root?.unmount();
  document.querySelectorAll('#fsh-preview').forEach((el) => el.remove());
  host?.remove();
  root = null; host = null;
}

/** Два редактора рядом, связанные подставным каналом: правки одного применяются у другого (как по сети). */
export async function mountPair(): Promise<string> {
  const book = await newBook();
  book.worksheets[0].getCell('A1').value = 1;
  book.worksheets[0].getCell('B1').value = { formula: 'A1*10', result: 10 } as never;
  const content = await bookToBase64(book);
  document.querySelectorAll('#fsh-preview').forEach((el) => el.remove());
  host = document.createElement('div');
  host.id = 'fsh-preview';
  host.style.cssText = 'position:fixed;inset:40px;z-index:99999;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;';
  host.className = 'nx';
  document.body.appendChild(host);
  type Ed = { apply: (ops: unknown[]) => void };
  const editors: Ed[] = [];
  const channel = (me: number) => ({
    attach: (ed: Ed) => { editors[me] = ed; return () => undefined; },
    local: (ops: unknown[]) => { window.setTimeout(() => editors[1 - me]?.apply(JSON.parse(JSON.stringify(ops))), 30); },
  });
  root = createRoot(host);
  root.render(
    <>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: 'hidden' }} data-side="a"><FastSheetEditor content={content} onContent={() => undefined} readOnly={false} loadKey={0} live={channel(0) as never} /></div>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: 'hidden' }} data-side="b"><FastSheetEditor content={content} onContent={() => undefined} readOnly={false} loadKey={0} live={channel(1) as never} /></div>
    </>,
  );
  return 'ok';
}

/** Большая таблица для замера прокрутки: rows × cols, текст, числа, формулы, закреплённые строка и столбец. */
export async function mountBig(rows = 3000, cols = 12): Promise<string> {
  const book = await newBook();
  const ws = book.worksheets[0];
  for (let r = 1; r <= rows; r += 1) {
    const row = ws.getRow(r);
    for (let c = 1; c <= cols; c += 1) {
      row.getCell(c).value = c === 1 ? `Строка ${r} https://vokrug-sveta.shar-os.ru/office?id=${r}` : c === cols ? ({ formula: `B${r}*C${r}`, result: 0 } as never) : (r * c) % 997;
    }
  }
  ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 1 }];
  const content = await bookToBase64(book);
  document.querySelectorAll('#fsh-preview').forEach((el) => el.remove());
  host = document.createElement('div');
  host.id = 'fsh-preview';
  host.style.cssText = 'position:fixed;inset:40px;z-index:99999;display:flex;flex-direction:column;border:1px solid #888;';
  host.className = 'nx';
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(<FastSheetEditor content={content} onContent={() => undefined} readOnly={false} loadKey={0} />);
  return 'ok';
}
