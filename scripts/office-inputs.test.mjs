import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSheetRange, normalizeDocumentLink } from '../src/features/workspace/editors/officeInput.ts';

test('range navigation supports absolute, lowercase and reversed ranges', () => {
  assert.deepEqual(parseSheetRange(' $d$20:b2 '), { row: 1, col: 1, rows: 19, cols: 3 });
  assert.deepEqual(parseSheetRange('AA10'), { row: 9, col: 26, rows: 1, cols: 1 });
});
test('invalid ranges do not silently navigate to another cell', () => {
  for (const range of ['A0', 'A1:', ':A1', 'A1:B2:C3', 'Sheet1!A1', 'A1 B2', 'A-1', 'A01', '']) assert.equal(parseSheetRange(range), null, range);
});
test('links accept web, internal hosts, mail and telephone addresses', () => {
  for (const value of ['https://example.ru/path?q=1', 'http://localhost:3005', 'mailto:hello@example.ru', 'tel:+79991234567']) assert.equal(normalizeDocumentLink(value), value);
  assert.equal(normalizeDocumentLink(' example.ru '), 'https://example.ru');
});
test('links reject unsafe schemes and incomplete input', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,test', 'file:///tmp/test', 'https://', 'mailto:', 'tel:', 'hello world', '', 'https://user:password@example.ru']) assert.equal(normalizeDocumentLink(value), null, value);
});
