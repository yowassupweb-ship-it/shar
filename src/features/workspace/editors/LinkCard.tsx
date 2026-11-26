import { useEffect, useState, type CSSProperties, type Ref } from 'react';
import { Copy, Globe, Link2Off, Pencil } from 'lucide-react';
import { openHere, openInNewWindow, sharTarget } from '../../../shared/navigation/internalLinks';
import { loadPreview, type PreviewData } from '../../chat/bubbles/LinkPreview';
import './linkCard.css';

/**
 * Карточка ссылки под ячейкой таблицы или ссылкой в документе — как в Google: превью страницы (заголовок, описание,
 * картинка; источник и кэш — те же, что у превью в чате), адрес (щелчок открывает), копировать, изменить, убрать.
 * Ссылка на материал Шара — «Открыть» (здесь, вместо текущего) и «В новом окне», как раньше.
 * Где стоять — решает редактор (cardRef/style); цвета — из переменных --sh-* редактора (linkCard.css).
 */
export function LinkCard({ url, cardRef, style, readOnly, onEdit, onUnlink }: {
  url: string; cardRef?: Ref<HTMLDivElement>; style?: CSSProperties; readOnly?: boolean; onEdit?: () => void; onUnlink?: () => void;
}) {
  const inner = sharTarget(url);
  const [preview, setPreview] = useState<{ url: string; data: PreviewData | false } | null>(null);
  useEffect(() => {
    if (inner) return undefined;
    let alive = true;
    // Небольшая задержка — не ходить за превью, пока стрелками пробегают по ссылкам.
    const timer = window.setTimeout(() => { void loadPreview(url).then((data) => { if (alive) setPreview({ url, data }); }); }, 250);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [url, inner]);
  const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  const data = preview?.url === url ? preview.data : null;
  return (
    <div ref={cardRef} className="fsh-linkcard" style={style} onMouseDown={(e) => e.preventDefault()}>
      {!inner && data && (
        <a className="fsh-linkcard-prev" href={url} target="_blank" rel="noopener noreferrer">
          {data.image && <img src={data.image} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
          <span className="fsh-linkcard-prev-text">
            <b>{data.title}</b>
            {data.description && <span>{data.description}</span>}
            <small>{data.siteName || host}</small>
          </span>
        </a>
      )}
      <div className="fsh-linkcard-row">
        <Globe size={18} strokeWidth={1.75} className="fsh-linkcard-globe" />
        <a href={url} target="_blank" rel="noopener noreferrer" title={url} className="fsh-linkcard-url">{url}</a>
        {inner ? (
          <>
            <button type="button" className="nx-ghost fsh-linkcard-act" onClick={() => openHere(inner)}>Открыть</button>
            <button type="button" className="nx-ghost fsh-linkcard-act" onClick={() => { void openInNewWindow(inner); }}>В новом окне</button>
          </>
        ) : (
          <>
            <button type="button" className="nx-icon-btn" title="Копировать ссылку" aria-label="Копировать ссылку" onClick={() => { void navigator.clipboard?.writeText(url).catch(() => undefined); }}><Copy size={17} strokeWidth={1.75} /></button>
            {!readOnly && onEdit && <button type="button" className="nx-icon-btn" title="Изменить ссылку" aria-label="Изменить ссылку" onClick={onEdit}><Pencil size={17} strokeWidth={1.75} /></button>}
            {!readOnly && onUnlink && <button type="button" className="nx-icon-btn" title="Удалить ссылку" aria-label="Удалить ссылку" onClick={onUnlink}><Link2Off size={17} strokeWidth={1.75} /></button>}
          </>
        )}
      </div>
    </div>
  );
}
