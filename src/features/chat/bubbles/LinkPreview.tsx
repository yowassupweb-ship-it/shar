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

// Module-level cache: persists across component mounts
const previewCache = new Map<string, PreviewData | false>();

export default function LinkPreview({ url, isMyMessage }: LinkPreviewProps) {
  const [data, setData] = useState<PreviewData | false | undefined>(() =>
    previewCache.has(url) ? previewCache.get(url) : undefined
  );
  const fetching = useRef(false);

  useEffect(() => {
    if (previewCache.has(url)) {
      setData(previewCache.get(url));
      return;
    }
    if (fetching.current) return;
    fetching.current = true;
    const ctrl = new AbortController();
    fetch(`/api/preview?url=${encodeURIComponent(url)}`, { signal: ctrl.signal })
      .then(r => r.json())
      .then((d: PreviewData) => {
        const result = d?.title ? d : false;
        previewCache.set(url, result);
        setData(result);
      })
      .catch(() => {
        previewCache.set(url, false);
        setData(false);
      });
    return () => ctrl.abort();
  }, [url]);

  // Show nothing while loading or when fetch failed / no OG data
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
