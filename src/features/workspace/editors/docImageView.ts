import type { NodeViewRendererProps } from '@tiptap/core';

/** Inline-картинка: размер меняется одной правкой, координаты учитывают масштаб листа. */
export function docImageView({ node: initial, editor, getPos }: NodeViewRendererProps) {
  let node = initial;
  const dom = document.createElement('span');
  dom.className = 'fdoc-image';
  dom.contentEditable = 'false';
  const img = document.createElement('img');
  img.draggable = true;
  dom.append(img);
  let drag: { x: number; width: number; ratio: number; scale: number; direction: number; next: number } | null = null;
  const draw = () => {
    img.src = String(node.attrs.src || '');
    img.alt = String(node.attrs.alt || '');
    img.title = String(node.attrs.title || '');
    img.style.width = node.attrs.width ? `${node.attrs.width}px` : '';
    img.style.height = 'auto';
  };
  const dimensions = () => {
    const width = img.offsetWidth || Number(node.attrs.width) || img.naturalWidth || 100;
    const height = img.offsetHeight || img.naturalHeight || 100;
    return { width, ratio: width / height, scale: img.getBoundingClientRect().width / width || 1 };
  };
  const limit = (width: number) => Math.round(Math.max(24, Math.min(width, editor.view.dom.clientWidth || 1600)));
  const commit = (width: number, ratio: number) => {
    const pos = getPos();
    if (typeof pos !== 'number' || editor.isDestroyed || !editor.isEditable) return;
    const current = editor.state.doc.nodeAt(pos);
    if (current?.type !== node.type) return;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, width, height: Math.max(1, Math.round(width / ratio)) }));
  };
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'fdoc-image-handle';
    handle.dataset.corner = corner;
    handle.setAttribute('aria-label', 'Размер изображения: перетащите или используйте стрелки');
    handle.title = 'Потяните за угол. Стрелки — изменить ширину, Shift — шаг 10 px';
    handle.addEventListener('pointerdown', (event) => {
      if (!editor.isEditable || event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      const d = dimensions();
      drag = { x: event.clientX, ...d, direction: corner.endsWith('w') ? -1 : 1, next: d.width };
      handle.setPointerCapture(event.pointerId);
      dom.classList.add('is-resizing');
    });
    handle.addEventListener('pointermove', (event) => {
      if (!drag) return;
      drag.next = limit(drag.width + (event.clientX - drag.x) / drag.scale * drag.direction);
      img.style.width = `${drag.next}px`;
      dom.dataset.size = `${drag.next} × ${Math.round(drag.next / drag.ratio)}`;
    });
    const finish = (event: PointerEvent, cancelled = false) => {
      if (!drag) return;
      const last = drag;
      drag = null;
      dom.classList.remove('is-resizing');
      delete dom.dataset.size;
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      if (cancelled) draw(); else commit(last.next, last.ratio);
    };
    handle.addEventListener('pointerup', (e) => finish(e));
    handle.addEventListener('pointercancel', (e) => finish(e, true));
    handle.addEventListener('lostpointercapture', (e) => finish(e, true));
    handle.addEventListener('keydown', (event) => {
      if (!editor.isEditable || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const d = dimensions();
      const direction = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 1;
      commit(limit(d.width + direction * (event.shiftKey ? 10 : 1)), d.ratio);
    });
    dom.append(handle);
  }
  draw();
  return {
    dom,
    update(next: typeof node) { if (next.type !== node.type) return false; node = next; if (!drag) draw(); return true; },
    selectNode() { dom.classList.add('is-selected'); },
    deselectNode() { dom.classList.remove('is-selected'); },
    stopEvent(event: Event) { return event.target instanceof Element && Boolean(event.target.closest('.fdoc-image-handle')); },
    ignoreMutation() { return true; },
    destroy() { drag = null; },
  };
}
