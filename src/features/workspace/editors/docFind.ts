import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PmNode } from '@tiptap/pm/model';

/**
 * Поиск в документе (Ctrl+F) для своего редактора: совпадения подсвечиваются декорациями, текущее — ярче;
 * без учёта регистра. Замена — обычной транзакцией (её видят коллеги и история Ctrl+Z).
 */

export interface FindState { query: string; matches: Array<{ from: number; to: number }>; index: number }
export const findKey = new PluginKey<FindState>('sharDocFind');

function search(doc: PmNode, query: string): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  const q = query.toLocaleLowerCase('ru');
  if (!q) return out;
  // Текст блока целиком (с позициями каждого символа): слово, разрезанное оформлением, всё равно находится.
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = '';
    const at: number[] = [];
    node.forEach((child, offset) => {
      if (child.isText && child.text) {
        for (let i = 0; i < child.text.length; i++) at.push(pos + 1 + offset + i);
        text += child.text;
      } else {
        at.push(pos + 1 + offset);
        text += '￼';
      }
    });
    const low = text.toLocaleLowerCase('ru');
    let i = low.indexOf(q);
    while (i >= 0 && out.length < 5000) {
      out.push({ from: at[i], to: at[i + q.length - 1] + 1 });
      i = low.indexOf(q, i + q.length);
    }
    return false;
  });
  return out;
}

export function docFindPlugin() {
  return new Plugin<FindState>({
    key: findKey,
    state: {
      init: () => ({ query: '', matches: [], index: 0 }),
      apply(tr: Transaction, prev: FindState): FindState {
        const meta = tr.getMeta(findKey) as Partial<FindState> | undefined;
        if (meta) {
          const query = meta.query ?? prev.query;
          const matches = meta.query !== undefined || tr.docChanged ? search(tr.doc, query) : prev.matches;
          const index = Math.max(0, Math.min(meta.index ?? (meta.query !== undefined ? 0 : prev.index), matches.length - 1));
          return { query, matches, index };
        }
        if (tr.docChanged && prev.query) {
          const matches = search(tr.doc, prev.query);
          return { ...prev, matches, index: Math.min(prev.index, Math.max(0, matches.length - 1)) };
        }
        return prev;
      },
    },
    props: {
      decorations(state: EditorState) {
        const st = findKey.getState(state);
        if (!st || !st.query || !st.matches.length) return null;
        return DecorationSet.create(state.doc, st.matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === st.index ? 'fdoc-find fdoc-find-now' : 'fdoc-find' })));
      },
    },
  });
}

export const findState = (state: EditorState): FindState => findKey.getState(state) ?? { query: '', matches: [], index: 0 };
