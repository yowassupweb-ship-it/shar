import { useMemo, useRef } from 'react';
import { useEditorState, type Editor } from '@tiptap/react';
import { ListTree, Search } from 'lucide-react';

/** Навигация читает модель, поэтому видит и заголовки за пределами экрана. */
export function DocNavigation({ editor, pages, onFind }: { editor: Editor; pages: number; onFind: () => void }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const doc = useEditorState({ editor, selector: ({ editor: e }) => e.state.doc });
  const info = useMemo(() => {
    const headings: Array<{ pos: number; level: number; text: string }> = [];
    doc.descendants((node, pos) => {
      if (node.type.name === 'heading' && node.textContent.trim()) headings.push({ pos, level: Number(node.attrs.level) || 1, text: node.textContent });
    });
    const text = doc.textBetween(0, doc.content.size, ' ');
    return { headings, words: text.trim().match(/\S+/gu)?.length ?? 0, characters: text.length };
  }, [doc]);
  return (
    <div className="fdoc-navigation">
      <details ref={menu} className="fdoc-outline" onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (menu.current) menu.current.open = false; menu.current?.querySelector('summary')?.focus(); }
      }} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false; }}>
        <summary><ListTree size={15} aria-hidden="true" />Структура</summary>
        <nav className="fdoc-outline-list" aria-label="Заголовки документа">
          <strong>Структура документа</strong>
          {info.headings.length ? info.headings.map((h) => (
            <button key={h.pos} type="button" style={{ paddingInlineStart: `calc(var(--space-3) + ${(h.level - 1) * 12}px)` }} onClick={() => {
              editor.chain().focus().setTextSelection(h.pos + 1).scrollIntoView().run();
              if (menu.current) menu.current.open = false;
            }}>{h.text}</button>
          )) : <p>Примените стиль заголовка к разделам — здесь появятся быстрые переходы.</p>}
        </nav>
      </details>
      <span>Страниц: {pages.toLocaleString('ru-RU')}</span>
      <span title={`Знаков с пробелами: ${info.characters.toLocaleString('ru-RU')}`}>Слов: {info.words.toLocaleString('ru-RU')}</span>
      <button type="button" className="fdoc-find-trigger" onClick={onFind} title="Найти в документе (Ctrl+F)"><Search size={15} aria-hidden="true" /><span>Найти</span></button>
    </div>
  );
}
