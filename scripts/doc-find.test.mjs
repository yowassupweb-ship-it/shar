import test from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { docFindPlugin, findKey, findState } from '../src/features/workspace/editors/docFind.ts';

const schema = new Schema({ nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*', group: 'block' }, text: { group: 'inline' } } });
function setup(text) {
  const plugin = docFindPlugin();
  const doc = schema.node('doc', null, [schema.node('paragraph', null, schema.text(text))]);
  return { plugin, state: EditorState.create({ doc, plugins: [plugin] }) };
}
test('search reuses highlight decorations when moving the caret through 5000 matches', () => {
  let { state, plugin } = setup('word '.repeat(6000));
  state = state.apply(state.tr.setMeta(findKey, { query: 'word' }));
  assert.equal(findState(state).matches.length, 5000);
  const decorations = plugin.props.decorations(state);
  for (let pos = 1; pos < 100; pos++) {
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
    assert.strictEqual(plugin.props.decorations(state), decorations);
  }
});
test('editing and switching the current match refresh highlights; clearing search removes them', () => {
  let { state, plugin } = setup('word word');
  state = state.apply(state.tr.setMeta(findKey, { query: 'word' }));
  const initial = plugin.props.decorations(state);
  state = state.apply(state.tr.setMeta(findKey, { index: 1 }));
  const next = plugin.props.decorations(state);
  assert.notStrictEqual(next, initial);
  assert.equal(next.find()[1].type.attrs.class, 'fdoc-find fdoc-find-now');
  state = state.apply(state.tr.insertText('x', 2));
  assert.equal(findState(state).matches.length, 1);
  assert.notStrictEqual(plugin.props.decorations(state), next);
  state = state.apply(state.tr.setMeta(findKey, { query: '' }));
  assert.equal(plugin.props.decorations(state), null);
});

test('editing one paragraph reuses the other 999 and shifts their match positions', () => {
  const plugin = docFindPlugin();
  const paragraphs = Array.from({ length: 1000 }, () => schema.node('paragraph', null, schema.text('word text')));
  const doc = schema.node('doc', null, paragraphs);
  let state = EditorState.create({ doc, plugins: [plugin] });
  state = state.apply(state.tr.setMeta(findKey, { query: 'word' }));
  const before = findState(state).matches;
  let visits = 0;
  for (const paragraph of paragraphs.slice(1)) {
    const original = paragraph.forEach;
    paragraph.forEach = function (...args) { visits++; return original.apply(this, args); };
  }
  state = state.apply(state.tr.insertText('prefix ', 1));
  assert.equal(visits, 0, 'unchanged paragraphs must not be parsed again');
  assert.deepEqual(findState(state).matches, before.map(({ from, to }) => ({ from: from + 7, to: to + 7 })));
  state = state.apply(state.tr.setMeta(findKey, { query: 'text' }));
  assert.equal(findState(state).matches.length, 1000);
  assert.equal(visits, 999, 'changing the query invalidates the block cache');
  assert.equal(findState(state).matches[0].from, 13);
});

test('cached results beyond the global limit become visible after earlier matches are removed', () => {
  const plugin = docFindPlugin();
  const first = schema.node('paragraph', null, schema.text('word '.repeat(4999)));
  const second = schema.node('paragraph', null, schema.text('word '.repeat(10)));
  let state = EditorState.create({ doc: schema.node('doc', null, [first, second]), plugins: [plugin] });
  state = state.apply(state.tr.setMeta(findKey, { query: 'word' }));
  assert.equal(findState(state).matches.length, 5000);
  state = state.apply(state.tr.delete(0, first.nodeSize));
  assert.equal(findState(state).matches.length, 10);
  assert.deepEqual(findState(state).matches[0], { from: 1, to: 5 });
});
