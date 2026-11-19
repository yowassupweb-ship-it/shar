import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

/**
 * Слой поверх текста быстрого редактора документов (ProseMirror): то, чего нет в самом документе, но что человек должен
 * видеть на месте.
 *   • цитаты открытых комментариев — подсветка, курсор в ней открывает ветку;
 *   • курсоры и выделения коллег (позиции ProseMirror: документ у всех один, шаги идут общим порядком);
 *   • зоны агентов: агент «занял» кусок текста и правит его — зона подсвечена с подписью, правки людей внутри неё не
 *     проходят (filterTransaction), снаружи — как обычно. Так человек и агент работают в одном документе без конфликтов.
 *
 * Данные приходят метой транзакции (setOverlay), позиции курсоров и зон сдвигаются вместе с правками.
 */

export interface OverlayCursor { userId: string; name: string; color: string; from: number; to: number; movedAt: number }
/** Зона агента: найдена по цитате (quote) или задана позициями. */
export interface OverlayZone { id: string; label: string; color?: string; quote?: string; from?: number; to?: number }
export interface OverlayInput { quotes: string[]; cursors: OverlayCursor[]; zones: OverlayZone[] }

interface Ranges { zones: Array<{ id: string; label: string; from: number; to: number }>; quotes: Array<{ quote: string; from: number; to: number }> }
interface OverlayState { input: OverlayInput; ranges: Ranges; deco: DecorationSet }

export const overlayKey = new PluginKey<OverlayState>('fdocOverlay');
const EMPTY: OverlayInput = { quotes: [], cursors: [], zones: [] };
/** Метка своих правок, которые зону не проверяют: загрузка новой версии и чужие шаги (live/pmOps.ts). */
const PASS_METAS = ['sharRemote', 'preventUpdate', 'fdocSystem'];

/** Текст документа без лишних пробелов и откуда в документе взялся каждый его символ (для поиска цитат). */
function textIndex(doc: PMNode): { text: string; at: number[] } {
  let text = '';
  const at: number[] = [];
  let space = true;
  const push = (ch: string, pos: number) => {
    const ws = /\s/.test(ch);
    if (ws && space) return;
    text += ws ? ' ' : ch;
    at.push(pos);
    space = ws;
  };
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      for (let i = 0; i < node.text.length; i += 1) push(node.text[i], pos + i);
    } else if (node.isBlock && node.isTextblock && text) {
      push(' ', pos);
    }
    return true;
  });
  return { text, at };
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

function findQuote(index: { text: string; at: number[] }, quote: string): { from: number; to: number } | null {
  const q = norm(quote);
  if (!q) return null;
  const i = index.text.indexOf(q);
  if (i < 0) return null;
  return { from: index.at[i], to: index.at[i + q.length - 1] + 1 };
}

function compute(doc: PMNode, input: OverlayInput): { ranges: Ranges; deco: DecorationSet } {
  const size = doc.content.size;
  const clamp = (n: number) => Math.max(0, Math.min(size, n));
  const needIndex = input.quotes.length > 0 || input.zones.some((z) => z.quote);
  const index = needIndex ? textIndex(doc) : null;
  const ranges: Ranges = { zones: [], quotes: [] };
  const decos: Decoration[] = [];

  for (const quote of new Set(input.quotes)) {
    const r = index ? findQuote(index, quote) : null;
    if (!r) continue;
    ranges.quotes.push({ quote, ...r });
    decos.push(Decoration.inline(r.from, r.to, { class: 'fdoc-cq' }));
  }

  for (const z of input.zones) {
    const r = z.quote && index ? findQuote(index, z.quote) : (typeof z.from === 'number' && typeof z.to === 'number' ? { from: clamp(z.from), to: clamp(z.to) } : null);
    if (!r || r.to <= r.from) continue;
    ranges.zones.push({ id: z.id, label: z.label, ...r });
    const style = `--c:${z.color || 'var(--accent-fill)'}`;
    decos.push(Decoration.inline(r.from, r.to, { class: 'fdoc-zone', style }));
    decos.push(Decoration.widget(r.from, () => {
      const flag = document.createElement('span');
      flag.className = 'fdoc-zone-flag';
      flag.setAttribute('style', style);
      flag.contentEditable = 'false';
      flag.textContent = z.label;
      return flag;
    }, { side: -1, key: `zone-${z.id}-${z.label}` }));
  }

  for (const c of input.cursors) {
    const from = clamp(Math.min(c.from, c.to));
    const to = clamp(Math.max(c.from, c.to));
    const style = `--c:${c.color}`;
    if (to > from) decos.push(Decoration.inline(from, to, { class: 'fdoc-rsel', style }));
    decos.push(Decoration.widget(clamp(c.to), () => {
      const caret = document.createElement('span');
      caret.className = 'fdoc-rcaret';
      caret.setAttribute('style', style);
      const flag = document.createElement('span');
      flag.className = 'fdoc-rflag';
      flag.textContent = c.name;
      caret.appendChild(flag);
      return caret;
    }, { side: 1, key: `cur-${c.userId}-${c.movedAt}` }));
  }

  return { ranges, deco: DecorationSet.create(doc, decos) };
}

/** Позиции курсоров и зон — вслед за правкой документа. */
function mapInput(input: OverlayInput, tr: Transaction): OverlayInput {
  if (!tr.docChanged) return input;
  const map = (n: number, assoc: number) => tr.mapping.map(n, assoc);
  return {
    quotes: input.quotes,
    cursors: input.cursors.map((c) => ({ ...c, from: map(c.from, -1), to: map(c.to, 1) })),
    zones: input.zones.map((z) => (typeof z.from === 'number' && typeof z.to === 'number' && !z.quote ? { ...z, from: map(z.from, 1), to: map(z.to, -1) } : z)),
  };
}

/** Задать то, что рисуется поверх текста (без изменения документа). */
export function setOverlay(state: EditorState, patch: Partial<OverlayInput>): Transaction {
  return state.tr.setMeta(overlayKey, patch).setMeta('addToHistory', false);
}

export function overlayRanges(state: EditorState): Ranges | null {
  return overlayKey.getState(state)?.ranges ?? null;
}

/** Плагин слоя. onBlocked — человек попробовал править в зоне агента (подсказать, почему не печатается). */
export function docOverlayPlugin(onBlocked: (zone: { label: string }) => void): Plugin<OverlayState> {
  return new Plugin<OverlayState>({
    key: overlayKey,
    state: {
      init: (_config, state) => ({ input: EMPTY, ...compute(state.doc, EMPTY) }),
      apply: (tr, prev, _old, next) => {
        const patch = tr.getMeta(overlayKey) as Partial<OverlayInput> | undefined;
        if (!patch && !tr.docChanged) return prev;
        const input = { ...mapInput(prev.input, tr), ...(patch || {}) };
        if (!input.quotes.length && !input.cursors.length && !input.zones.length) return { input, ranges: { zones: [], quotes: [] }, deco: DecorationSet.empty };
        return { input, ...compute(next.doc, input) };
      },
    },
    props: {
      decorations: (state) => overlayKey.getState(state)?.deco ?? null,
    },
    filterTransaction: (tr, state) => {
      if (!tr.docChanged || PASS_METAS.some((m) => tr.getMeta(m))) return true;
      const zones = overlayKey.getState(state)?.ranges.zones ?? [];
      if (!zones.length) return true;
      for (const step of tr.steps) {
        let hit: { label: string } | null = null;
        step.getMap().forEach((oldStart, oldEnd) => {
          if (hit) return;
          const z = zones.find((zone) => (oldEnd > zone.from && oldStart < zone.to) || (oldStart === oldEnd && oldStart > zone.from && oldStart < zone.to));
          if (z) hit = z;
        });
        if (hit) {
          onBlocked(hit);
          return false;
        }
      }
      return true;
    },
  });
}
