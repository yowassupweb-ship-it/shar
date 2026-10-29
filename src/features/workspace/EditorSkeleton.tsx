import type { Kind } from './types';

/**
 * Скелетон открывающегося материала — вместо спиннеров «Открываю» и «Загружаю редактор». Повторяет то, что
 * следом рисует сам Univer (лента и лист), поэтому при подмене меняется только содержимое, без прыжка.
 * withHeader — когда материал ещё не пришёл и шапки (название, меню) тоже нет.
 */
export function EditorSkeleton({ kind, withHeader = false }: { kind?: Kind; withHeader?: boolean }) {
  return (
    <div className="nws-skel" data-kind={kind || 'document'} role="status" aria-busy="true" aria-label="Открываю">
      {withHeader && (
        <div className="nws-skel-head">
          <i className="nws-skel-icon" />
          <span className="nws-skel-titles"><i style={{ width: 200 }} /><i style={{ width: 300 }} /></span>
        </div>
      )}
      {(kind === 'document' || kind === 'table' || !kind) && (
        <div className="nws-skel-bar"><i style={{ width: 96 }} /><i className="nws-skel-sq" /><i className="nws-skel-sq" /><i style={{ width: 140 }} /></div>
      )}
      {kind === 'table' && <div className="nws-skel-grid" />}
      {kind === 'note' && (
        <div className="nws-skel-lines">{[62, 90, 84, 70, 88, 40].map((w, i) => <i key={i} style={{ width: `${w}%` }} />)}</div>
      )}
      {kind === 'presentation' && <div className="nws-skel-slide" />}
      {(kind === 'document' || !kind) && <><div className="nws-skel-strip" /><div className="nws-skel-page" /></>}
    </div>
  );
}
