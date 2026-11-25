import { recalc, shiftFormula } from './formulas';
import { displayText, parseInput, Styles, type Book, type Sheet } from './model';
import { applyOp, inverseOf, OP } from './ops';
import { shiftRefs } from './refs';

/**
 * Проверка модели своего редактора таблиц (вручную в окне с Vite:
 * `await (await import('/src/features/workspace/sheet/sheet.check.ts')).run()`).
 */
export function run(): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const expect = (what: string, got: unknown, want: unknown) => { if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${what}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`); };
  const sheet: Sheet = { id: 'a', name: 'Лист1', rowCount: 100, columnCount: 26, cellData: {
    0: { 0: { v: 2 }, 1: { v: 3 }, 2: { f: '=A1*B1' } },
    1: { 0: { v: 10 }, 2: { f: '=СУММ(A1:A2)+C1' } },
    2: { 0: { f: '=A3' } },
  } };
  const book = { id: 'b', sheetOrder: ['a'], sheets: { a: sheet }, styles: {} } as unknown as Book;
  const styles = new Styles(book);
  recalc(book);
  expect('A1*B1', sheet.cellData[0][2].v, 6);
  expect('СУММ+C1', sheet.cellData[1][2].v, 18);
  expect('круговая ссылка', sheet.cellData[2][0].v, '#REF!');

  // Правка значения → пересчёт; отмена возвращает как было.
  const op = { id: OP.VALUES, params: { subUnitId: 'a', cellValue: { 0: { 0: { v: 5, t: 2 } } } } };
  const undo = inverseOf(book, op);
  applyOp(book, styles, op);
  recalc(book);
  expect('после правки', sheet.cellData[1][2].v, 30);
  undo.forEach((u) => applyOp(book, styles, u));
  recalc(book);
  expect('после отмены', sheet.cellData[0][0].v, 2);

  // Стиль в правке — объектом, в книге — id.
  applyOp(book, styles, { id: OP.VALUES, params: { subUnitId: 'a', cellValue: { 5: { 5: { v: 'x', s: { bl: 1 } } } } } });
  const sid = sheet.cellData[5][5].s as string;
  expect('стиль по id', book.styles?.[sid], { bl: 1 });

  // Вставка строки сдвигает данные и объединения; отмена — обратно.
  sheet.mergeData = [{ startRow: 3, endRow: 4, startColumn: 0, endColumn: 1 }];
  const ins = { id: OP.INSERT_ROW, params: { subUnitId: 'a', range: { startRow: 1, endRow: 1, startColumn: 0, endColumn: 25 } } };
  const insUndo = inverseOf(book, ins);
  applyOp(book, styles, ins);
  expect('сдвиг строки', sheet.cellData[2]?.[0]?.v, 10);
  expect('сдвиг объединения', sheet.mergeData, [{ startRow: 4, endRow: 5, startColumn: 0, endColumn: 1 }]);
  insUndo.forEach((u) => applyOp(book, styles, u));
  expect('отмена вставки', sheet.cellData[1]?.[0]?.v, 10);

  // Удаление строки и возврат содержимого.
  const rm = { id: OP.REMOVE_ROWS, params: { subUnitId: 'a', range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 25 } } };
  const rmUndo = inverseOf(book, rm);
  applyOp(book, styles, rm);
  expect('после удаления', sheet.cellData[0]?.[0]?.v, 10);
  rmUndo.forEach((u) => applyOp(book, styles, u));
  expect('отмена удаления', sheet.cellData[0]?.[0]?.v, 2);

  expect('ввод числа', parseInput('1 234,5'), { v: 1234.5, t: 2 });
  expect('ввод процента', parseInput('15%').v, 0.15);
  expect('ввод даты', parseInput('25.11.2026').pattern, 'dd.mm.yyyy');
  expect('показ даты', displayText({ v: parseInput('25.11.2026').v as number }, { n: { pattern: 'dd.mm.yyyy' } }), '25.11.2026');
  expect('показ денег', displayText({ v: 1234.5 }, { n: { pattern: '#,##0.00' } }), '1 234,50');
  expect('сдвиг формулы', shiftFormula('=A1+$B$2+C$3', 1, 1), '=B2+$B$2+D$3');
  expect('ссылки: вставка строки', shiftRefs('=A1*10+SUM(A1:A5)+LOG10(B9)', 'Л', 'Л', true, 0, 1), '=A2*10+SUM(A2:A6)+LOG10(B10)');
  expect('ссылки: удаление строк', shiftRefs('=SUM(A1:A5)+B3', 'Л', 'Л', true, 1, -2), '=SUM(A1:A3)+#REF!');
  expect('ссылки: другой лист', shiftRefs("=A1+'Лист 2'!B2+\"A1\"", 'Л', 'Лист 2', false, 0, 1), "=A1+'Лист 2'!C2+\"A1\"");
  return { ok: problems.length === 0, problems };
}
