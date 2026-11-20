import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

/**
 * Разбивка на листы, как в Google Документах: текст идёт отдельными страницами с промежутком между ними.
 *
 * Как устроено: лист рисуется отдельной подложкой (FastDocEditor), а в тексте там, где кончается место на странице,
 * стоит невидимая распорка (декорация-виджет) высотой «остаток страницы + нижнее поле + промежуток + верхнее поле».
 * Абзац, не влезающий целиком, разрезается по строке: распорка встаёт внутрь абзаца перед первой непоместившейся
 * строкой. Картинка, разрыв и одна строка переносятся целиком. Текст и снимок не меняются — это только вид.
 *
 * Пересчёт — после паузы в наборе: распорки снимаются, раскладка мерится (синхронно, до отрисовки — без мигания)
 * и ставятся заново. Между пересчётами старые распорки едут вместе с текстом (map), страница не прыгает.
 */

export interface PageGeometry { pageHeight: number; marginTop: number; marginBottom: number; gap: number; zoom: number }

interface PagesState { deco: DecorationSet; pages: number }
export const pagesKey = new PluginKey<PagesState>('sharDocPages');

function spacer(height: number, inline: boolean): HTMLElement {
  const el = document.createElement(inline ? 'span' : 'div');
  el.className = 'fdoc-pgap';
  el.style.height = `${height}px`;
  el.setAttribute('contenteditable', 'false');
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/** Блоки, которые раскладываются по одному: верхние узлы, а у списков — их пункты. */
function units(root: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of Array.from(root.children) as HTMLElement[]) {
    if (el.classList.contains('fdoc-pgap')) continue;
    if (el.tagName === 'UL' || el.tagName === 'OL') {
      for (const li of Array.from(el.children) as HTMLElement[]) if (li.tagName === 'LI') out.push(li);
    } else out.push(el);
  }
  return out;
}

/** Начало строки, на которой стоит позиция pos (по экранным координатам). */
function lineStart(view: EditorView, pos: number, min: number): number {
  const top = view.coordsAtPos(pos).top;
  let p = pos;
  for (let i = 0; i < 400 && p - 1 > min; i += 1) {
    const c = view.coordsAtPos(p - 1);
    if (Math.abs(c.top - top) > 2) break;
    p -= 1;
  }
  return p;
}

export function computePages(view: EditorView, g: PageGeometry): PagesState {
  const dom = view.dom as HTMLElement;
  const z = g.zoom || 1;
  const base = dom.getBoundingClientRect();
  const content = g.pageHeight - g.marginTop - g.marginBottom;
  const stride = g.pageHeight + g.gap;
  const decos: Decoration[] = [];
  let add = 0;
  if (content < 40) return { deco: DecorationSet.empty, pages: 1 };
  const list = units(dom);
  for (const el of list) {
    const r = el.getBoundingClientRect();
    let top = (r.top - base.top) / z + add;
    const height = r.height / z;
    let bottom = top + height;
    let page = Math.floor(top / stride);
    // Начало попало в промежуток между листами (после прошлого блока) — на следующий лист.
    if (top - page * stride > content) {
      const push = (page + 1) * stride - top;
      decos.push(Decoration.widget(view.posAtDOM(el, 0) - (el.tagName === 'LI' ? 1 : 1), spacer(push, false), { side: -1, key: `pg${decos.length}-${Math.round(push)}` }));
      add += push; top += push; bottom += push; page += 1;
    }
    let guard = 0;
    while (bottom > page * stride + content && guard < 50) {
      guard += 1;
      const limit = page * stride + content;
      const textual = el.tagName === 'P' || /^H[1-6]$/.test(el.tagName) || (el.tagName === 'LI' && !el.querySelector('img'));
      const lines = textual ? Math.round(height / Math.max(14, parseFloat(getComputedStyle(el).lineHeight) || 18)) : 1;
      if (!textual || lines < 2 || top >= limit - 4) {
        // Целиком на следующий лист (если блок и так начинается с верха листа — оставляем: больше страницы не уместить).
        if (top - page * stride < 2) break;
        const push = (page + 1) * stride - top;
        const at = view.posAtDOM(el, 0) - 1;
        decos.push(Decoration.widget(Math.max(0, at), spacer(push, false), { side: -1, key: `pg${decos.length}-${Math.round(push)}` }));
        add += push; top += push; bottom += push; page += 1;
        continue;
      }
      // Разрезаем абзац: первая строка, которая не влезает, — на следующий лист.
      const yScreen = base.top + (limit - add) * z - 2;
      const hit = view.posAtCoords({ left: r.left + 4, top: yScreen });
      if (!hit) break;
      const start = view.posAtDOM(el, 0);
      let pos = lineStart(view, hit.pos, start);
      // Строка, на которую попали, ещё влезает? Тогда режем со следующей.
      const lineTop = (view.coordsAtPos(pos).top - base.top) / z + add;
      const lineBottom = (view.coordsAtPos(pos).bottom - base.top) / z + add;
      if (lineBottom <= limit + 1) {
        const next = view.posAtCoords({ left: r.left + 4, top: view.coordsAtPos(pos).bottom + 3 });
        if (!next || next.pos <= pos) break;
        pos = lineStart(view, next.pos, start);
      }
      const cutTop = (view.coordsAtPos(pos).top - base.top) / z + add;
      if (pos <= start || cutTop <= top + 1) {
        if (top - page * stride < 2) break;
        const push = (page + 1) * stride - top;
        decos.push(Decoration.widget(Math.max(0, start - 1), spacer(push, false), { side: -1, key: `pg${decos.length}-${Math.round(push)}` }));
        add += push; top += push; bottom += push; page += 1;
        continue;
      }
      const push = (page + 1) * stride - cutTop;
      decos.push(Decoration.widget(pos, spacer(push, true), { side: -1, key: `pgi${decos.length}-${Math.round(push)}` }));
      void lineTop;
      add += push; bottom += push; page += 1;
      top = page * stride;
    }
  }
  const total = (dom.getBoundingClientRect().height / z) + add;
  const pages = Math.max(1, Math.floor(total / stride) + 1);
  return { deco: DecorationSet.create(view.state.doc, decos), pages };
}

/** Плагин: держит распорки и число листов; пересчёт — pagesRelayout(view). */
export function docPagesPlugin(onPages: (pages: number) => void) {
  return new Plugin<PagesState>({
    key: pagesKey,
    state: {
      init: () => ({ deco: DecorationSet.empty, pages: 1 }),
      apply(tr, prev): PagesState {
        const next = tr.getMeta(pagesKey) as PagesState | undefined;
        if (next) return next;
        return tr.docChanged ? { ...prev, deco: prev.deco.map(tr.mapping, tr.doc) } : prev;
      },
    },
    props: { decorations: (state: EditorState) => pagesKey.getState(state)?.deco ?? null },
    view: () => ({
      update: (view, prevState) => {
        const a = pagesKey.getState(view.state);
        const b = pagesKey.getState(prevState);
        if (a && a.pages !== b?.pages) onPages(a.pages);
      },
    }),
  });
}

/** Пересчитать листы сейчас: снять распорки, измерить, поставить новые (всё до отрисовки кадра). */
export function pagesRelayout(view: EditorView, g: PageGeometry) {
  if (view.isDestroyed) return;
  const cur = pagesKey.getState(view.state);
  if (cur && cur.deco !== DecorationSet.empty) view.dispatch(view.state.tr.setMeta(pagesKey, { deco: DecorationSet.empty, pages: cur.pages }).setMeta('addToHistory', false));
  const next = computePages(view, g);
  view.dispatch(view.state.tr.setMeta(pagesKey, next).setMeta('addToHistory', false));
}
