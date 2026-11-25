import { Editor } from '@tiptap/core';
import { markdownExtensions } from './extensions';
import { fromEditorMarkdown, toEditorMarkdown } from './paragraphs';

/** Проверка круга markdown → визуальный редактор → markdown (вручную в окне с Vite): пустые строки не должны теряться. */
export function run(): Array<{ src: string; out: string; ok: boolean }> {
  const cases = ['a\nb', 'a\n\nb', 'a\n\n\nb', 'a\n\n\n\nb', '- [ ] x\n- [x] y\n\n\nтекст', '# Заг\n\n\nтекст\nстрока', 'a\n\n\n- x\n- y\n\n\n\nb'];
  return cases.map((src) => {
    const ed = new Editor({ element: document.createElement('div'), extensions: markdownExtensions(), content: toEditorMarkdown(src) });
    const out = fromEditorMarkdown((ed.storage as unknown as { markdown: { getMarkdown: () => string } }).markdown.getMarkdown());
    ed.destroy();
    return { src, out, ok: out === src };
  });
}

/** Пустые абзацы, набранные в самом редакторе (Enter на пустой строке): каждый — одна пустая строка. */
export function typed(): Array<{ html: string; out: string }> {
  const p = (t?: string) => ({ type: 'paragraph', content: t ? [{ type: 'text', text: t }] : [] });
  const ul = { type: 'bulletList', content: [{ type: 'listItem', content: [p('x')] }] };
  return [[p('a'), p(), p('b')], [p('a'), p(), p(), p('b')], [p('a'), ul, p(), p('b')]].map((blocks) => {
    const html = JSON.stringify(blocks.map((b) => b.type));
    const ed = new Editor({ element: document.createElement('div'), extensions: markdownExtensions(), content: { type: 'doc', content: blocks } });
    const out = fromEditorMarkdown((ed.storage as unknown as { markdown: { getMarkdown: () => string } }).markdown.getMarkdown());
    ed.destroy();
    return { html, out };
  });
}
