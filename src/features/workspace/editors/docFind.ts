import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PmNode } from '@tiptap/pm/model';

/**
 * Поиск в документе (Ctrl+F) для своего редактора: совпадения подсвечиваются декорациями, текущее — ярче;
 * без учёта регистра. Замена — обычной транзакцией (её видят коллеги и история Ctrl+Z).
 */

export interface FindState { query: string; matches: Array<{ from: number; to: number }>; index: number }
export const findKey = new PluginKey<FindState>('sharDocFind');

type Matches = FindState['matches'];

function search(doc: PmNode, query: string, blocks: WeakMap<PmNode, Matches>): Matches {
  const out: Array<{ from: number; to: number }> = [];
  const q = query.toLocaleLowerCase('ru');
  if (!q) return out;
  // Текст блока целиком (с позициями каждого символа): слово, разрезанное оформлением, всё равно находится.
  doc.descendants((node, pos) => {
    if (out.length >= 5000) return false;
    if (!node.isTextblock) return true;
    const cached = blocks.get(node);
    if (cached) {
      for (const match of cached) {
        if (out.length >= 5000) break;
        out.push({ from: pos + match.from, to: pos + match.to });
      }
      return false;
    }
    let text = '';
    const at: number[] = [];
    node.forEach((child, offset) => {
      if (child.isText && child.text) {
        for (let i = 0; i < child.text.length; i++) at.push(1 + offset + i);
        text += child.text;
      } else {
        at.push(1 + offset);
        text += '￼';
      }
    });
    const low = text.toLocaleLowerCase('ru');
    const matches: Matches = [];
    let i = low.indexOf(q);
    while (i >= 0 && matches.length < 5000) {
      matches.push({ from: at[i], to: at[i + q.length - 1] + 1 });
      i = low.indexOf(q, i + q.length);
    }
    blocks.set(node, matches);
    for (const match of matches) {
      if (out.length >= 5000) break;
      out.push({ from: pos + match.from, to: pos + match.to });
    }
    return false;
  });
  return out;
}

export function docFindPlugin() {
  // ProseMirror keeps unchanged nodes by identity. Store relative positions so
  // edits before a cached paragraph do not invalidate its matches.
  let queryCache = '';
  let blocks = new WeakMap<PmNode, Matches>();
  const searchDocument = (doc: PmNode, query: string) => {
    if (query !== queryCache) { queryCache = query; blocks = new WeakMap(); }
    return search(doc, query, blocks);
  };
  let cachedState: FindState | undefined;
  let cachedDoc: PmNode | undefined;
  let cachedDecorations: DecorationSet | null = null;
  return new Plugin<FindState>({
    key: findKey,
    state: {
      init: () => ({ query: '', matches: [], index: 0 }),
      apply(tr: Transaction, prev: FindState): FindState {
        const meta = tr.getMeta(findKey) as Partial<FindState> | undefined;
        if (meta) {
          const query = meta.query ?? prev.query;
          const matches = query !== prev.query || tr.docChanged ? searchDocument(tr.doc, query) : prev.matches;
          const index = Math.max(0, Math.min(meta.index ?? (meta.query !== undefined ? 0 : prev.index), matches.length - 1));
          return { query, matches, index };
        }
        if (tr.docChanged && prev.query) {
          const matches = searchDocument(tr.doc, prev.query);
          return { ...prev, matches, index: Math.min(prev.index, Math.max(0, matches.length - 1)) };
        }
        return prev;
      },
    },
    props: {
      decorations(state: EditorState) {
        const st = findKey.getState(state);
        if (!st || !st.query || !st.matches.length) return null;
        if (st !== cachedState || state.doc !== cachedDoc) {
          cachedState = st;
          cachedDoc = state.doc;
          cachedDecorations = DecorationSet.create(state.doc, st.matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === st.index ? 'fdoc-find fdoc-find-now' : 'fdoc-find' })));
        }
        return cachedDecorations;
      },
    },
  });
}

export const findState = (state: EditorState): FindState => findKey.getState(state) ?? { query: '', matches: [], index: 0 };
