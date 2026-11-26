import { createRoot, type Root } from 'react-dom/client';
import FastDocEditor from './FastDocEditor';

/**
 * Проверка своего редактора документов вне приложения (в окне с Vite, без сервера): открыть содержимое документа —
 * `await (await import('/src/features/workspace/editors/doc.preview.tsx')).mountDoc(content)`, убрать — `unmountDoc()`.
 * Сохранения — в window.__fdocSaved.
 */
let root: Root | null = null;
let host: HTMLDivElement | null = null;

export function unmountDoc(): void {
  root?.unmount(); root = null;
  host?.remove(); host = null;
}

export function mountDoc(content: string): string {
  unmountDoc();
  host = document.createElement('div');
  host.id = 'fdoc-preview';
  host.className = 'nx';
  host.style.cssText = 'position:fixed;inset:0;z-index:900;display:flex;flex-direction:column;background:var(--bg-color,#fff)';
  // Первым в body: меню и всплывающие окна встают в первый .nx на странице (overlay.tsx) — пусть это будет превью.
  document.body.prepend(host);
  root = createRoot(host);
  root.render(<FastDocEditor content={content} onContent={(next) => { (window as unknown as { __fdocSaved?: string }).__fdocSaved = next; }} readOnly={false} loadKey={0} />);
  return 'ok';
}
