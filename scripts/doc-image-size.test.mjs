import test from 'node:test';
import assert from 'node:assert/strict';
import { pmToUniver } from '../src/features/workspace/lib/pmToUniver.ts';
import { univerToHtml } from '../src/features/workspace/lib/univerHtml.ts';

const imageDoc = (attrs) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'image', attrs }] }] });
test('resizing an existing picture persists both dimensions and preserves positioning', () => {
  const base = { id: 'test', drawings: { img: { source: 'https://example.com/a.png', transform: { width: 800, height: 400, left: 12 }, docTransform: { size: { width: 800, height: 400 }, angle: 15 }, layoutType: 0 } } };
  const result = pmToUniver(imageDoc({ blockId: 'img', src: base.drawings.img.source, width: 320, height: 160 }), base);
  assert.deepEqual(result.drawings.img.transform, { width: 320, height: 160, left: 12 });
  assert.deepEqual(result.drawings.img.docTransform, { size: { width: 320, height: 160 }, angle: 15 });
  assert.equal(base.drawings.img.transform.width, 800);
  assert.match(univerToHtml(result, { editor: true }), /width="320" height="160" data-block-id="img"/);
});
test('width-only updates preserve original aspect ratio', () => {
  const result = pmToUniver(imageDoc({ blockId: 'img', width: 200 }), { drawings: { img: { transform: { width: 600, height: 900 } } } });
  assert.equal(result.drawings.img.transform.height, 300);
});
test('new pictures retain supplied height instead of using a fixed aspect ratio', () => {
  const result = pmToUniver(imageDoc({ src: 'https://example.com/portrait.png', width: 240, height: 480 }), {});
  const drawing = Object.values(result.drawings)[0];
  assert.deepEqual(drawing.docTransform.size, { width: 240, height: 480 });
});
