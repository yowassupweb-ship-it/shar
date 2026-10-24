import { useState, useEffect, useRef } from 'react';

interface PreviewData {
  title: string;
  description: string;
  image: string;
  siteName: string;
  url: string;
}

interface LinkPreviewProps {
  url: string;
  isMyMessage?: boolean;
}

// Кэш на модуль: живёт между монтированиями. Запрос в полёте — общий: одна ссылка в ленте и в профиле
// (или в нескольких сообщениях) — один поход сервера на чужой сайт.
const previewCache = new Map<string, PreviewData | false>();
const inflight = new Map<string, Promise<PreviewData | false>>();

function loadPreview(url: string): Promise<PreviewData | false> {
  const cached = previewCache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);
  let job = inflight.get(url);
  if (!job) {
    job = fetch(`/api/preview?url=${encodeURIComponent(url)}`)
      .then((r) => r.json())
      .then((d: PreviewData) => (d?.title ? d : false) as PreviewData | false)
      .catch(() => false as const)
      .then((result) => { previewCache.set(url, result); inflight.delete(url); return result; });
    inflight.set(url, job);
  }
  return job;
}

/** Текст превью из кэша (заголовок, описание, сайт) — для поиска по ссылкам; пусто, пока не загружено. */
export function previewText(url: string): string {
  const d = previewCache.get(url);
  return d ? `${d.title} ${d.description} ${d.siteName}`.toLowerCase() : '';
}

/**
 * Подгрузить превью списка ссылок (по шесть за раз) — для поиска по их тексту во вкладке «Ссылки».
 * onLoaded зовётся после каждой новой; вернуть — отмена.
 */
export function warmPreviews(urls: string[], onLoaded: () => void): () => void {
  let alive = true;
  const queue = [...new Set(urls)].filter((u) => !isOwnLink(u) && !previewCache.has(u));
  const worker = async () => {
    while (alive && queue.length) {
      const d = await loadPreview(queue.shift()!);
      if (alive && d) onLoaded();
    }
  };
  for (let i = 0; i < 6; i += 1) void worker();
  return () => { alive = false; };
}

// Один наблюдатель на всё приложение: превью запрашиваем, когда ссылка подошла к экрану (с запасом),
// а не все сразу — во вкладке «Ссылки» и в длинной ленте их сотни.
const waiting = new Map<Element, () => void>();
let observer: IntersectionObserver | null = null;
function whenNear(el: Element, fn: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') { fn(); return () => {}; }
  observer ??= new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const cb = waiting.get(e.target);
      waiting.delete(e.target);
      observer?.unobserve(e.target);
      cb?.();
    }
  }, { rootMargin: '600px 0px' });
  waiting.set(el, fn);
  observer.observe(el);
  return () => { waiting.delete(el); observer?.unobserve(el); };
}

/** Ссылка на сам Шар: страница — приложение с заголовком «Шар» без описания, карточка ничего не добавляет к тексту. */
function isOwnLink(url: string) {
  try {
    const host = new URL(url).hostname;
    return host === window.location.hostname || host.endsWith('.shar-os.ru');
  } catch {
    return false;
  }
}

export default function LinkPreview({ url, isMyMessage }: LinkPreviewProps) {
  if (isOwnLink(url)) return null;
  return <ExternalPreview url={url} isMyMessage={isMyMessage} />;
}

function ExternalPreview({ url, isMyMessage }: LinkPreviewProps) {
  const [data, setData] = useState<PreviewData | false | undefined>(() => previewCache.get(url));
  const probe = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const known = previewCache.get(url);
    if (known !== undefined) { setData(known); return undefined; }
    let alive = true;
    const el = probe.current;
    const start = () => { void loadPreview(url).then((d) => { if (alive) setData(d); }); };
    const stop = el ? whenNear(el, start) : (start(), () => {});
    return () => { alive = false; stop(); };
  }, [url]);

  // Пока не знаем — пустая метка для наблюдателя (места не занимает).
  if (data === undefined) return <span ref={probe} className="nx-lp-probe" aria-hidden="true" />;
  // Нет данных (у страницы нет Open Graph или не загрузилась) — ничего не показываем.
  if (!data) return null;

  const hostname = (() => {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch { return url; }
  })();

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()}
      style={{
        display: 'block',
        marginTop: 8,
        borderRadius: 12,
        overflow: 'hidden',
        textDecoration: 'none',
        background: isMyMessage ? 'rgba(0,0,0,0.15)' : 'var(--element-bg)',
        border: isMyMessage
          ? '1px solid rgba(255,255,255,0.18)'
          : '1px solid var(--apple-border-color)',
        maxWidth: '100%',
        color: 'inherit',
      }}
    >
      {data.image && (
        <img
          src={data.image}
          alt=""
          style={{ width: '100%', height: 130, objectFit: 'cover', display: 'block' }}
          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
      )}
      <div style={{ padding: '8px 10px' }}>
        <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 2 }}>
          {data.siteName || hostname}
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, lineHeight: '1.3',
          marginBottom: data.description ? 3 : 0,
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          overflow: 'hidden' } as React.CSSProperties}>
          {data.title}
        </div>
        {data.description && (
          <div style={{ fontSize: 12, opacity: 0.65, lineHeight: '1.4',
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
            overflow: 'hidden' } as React.CSSProperties}>
            {data.description}
          </div>
        )}
      </div>
    </a>
  );
}
