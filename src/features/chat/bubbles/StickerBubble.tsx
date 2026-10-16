import { useState, useEffect, useRef } from 'react';
import { X, Plus } from 'lucide-react';
import AnimatedSticker from './AnimatedSticker';
import { Spinner } from '@/shared/ui/Spinner';

interface StickerMeta { url: string; emoji: string; setName: string }

interface Props {
  sticker: StickerMeta;
  size?: number;
  hasReactions?: boolean;
  isMobileView?: boolean;
  timestamp?: string;
}

export default function StickerBubble({ sticker, size = 132, hasReactions, isMobileView, timestamp }: Props) {
  const [showPopup, setShowPopup] = useState(false);
  const [setInfo, setSetInfo] = useState<{ title: string; thumbUrl: string | null; count: number } | null>(null);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState(false);
  const [alreadyHave, setAlreadyHave] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);

  const containerSize = isMobileView ? size + 20 : size;

  const handleClick = async () => {
    if (!sticker.setName || sticker.setName === '') return;
    setShowPopup(true);

    if (!setInfo) {
      try {
        // Check if already installed
        const idx = await fetch('/api/stickers/sets').then(r => r.json()).catch(() => []);
        const installed = Array.isArray(idx) && idx.some((s: any) => s.setName === sticker.setName);
        if (installed) { setAlreadyHave(true); }

        // Get set info
        const r = await fetch(`/api/stickers/sets/${sticker.setName}`);
        if (r.ok) {
          const d = await r.json();
          setSetInfo({ title: d.title || sticker.setName, thumbUrl: d.thumbUrl, count: (d.stickers || []).length });
        } else {
          setSetInfo({ title: sticker.setName, thumbUrl: null, count: 0 });
        }
      } catch {
        setSetInfo({ title: sticker.setName, thumbUrl: null, count: 0 });
      }
    }
  };

  const handleImport = async () => {
    if (alreadyHave || importing || imported) return;
    setImporting(true);
    try {
      const r = await fetch('/api/stickers/sets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setName: sticker.setName }),
      });
      if (r.ok) { setImported(true); setAlreadyHave(true); }
    } catch {}
    finally { setImporting(false); }
  };

  // Close on outside click
  useEffect(() => {
    if (!showPopup) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) setShowPopup(false);
    };
    setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPopup]);

  const isAnimated = sticker.url.endsWith('.tgs');
  const marginClass = hasReactions ? (isMobileView ? 'mb-[29px]' : 'mb-[26px]') : '';

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      {/* Sticker image */}
      <div
        onClick={handleClick}
        className={marginClass}
        style={{ width: containerSize, height: containerSize, padding: 4, cursor: 'pointer', position: 'relative' }}
        title="Нажмите чтобы добавить набор"
      >
        {isAnimated
          ? <AnimatedSticker url={sticker.url} size={containerSize - 8} loop autoplay />
          : <img src={sticker.url} alt={sticker.emoji || '🎭'} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        }
        {/* Timestamp overlay */}
        {timestamp && (
          <div className="absolute bottom-1 right-1 flex items-center px-1.5 py-0.5 rounded-full"
            style={{ backgroundColor: 'rgba(0,0,0,0.55)' }}>
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.9)', lineHeight: 1 }}>{timestamp}</span>
          </div>
        )}
      </div>

      {/* Add-set popup */}
      {showPopup && (
        <div
          ref={popupRef}
          style={{
            position: 'absolute', bottom: 'calc(100% + 8px)', left: '50%', transform: 'translateX(-50%)',
            zIndex: 200, minWidth: 220,
            backgroundColor: 'var(--element-bg)',
            border: '1px solid var(--apple-border-color)',
            borderRadius: 16, padding: 14,
            boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
          }}
          onClick={e => e.stopPropagation()}
        >
          <button onClick={() => setShowPopup(false)}
            style={{ position: 'absolute', top: 8, right: 8, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2 }}>
            <X style={{ width: 14, height: 14 }} />
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            {/* Thumb */}
            <div style={{ width: 44, height: 44, flexShrink: 0, borderRadius: 10, overflow: 'hidden',
              backgroundColor: 'var(--container-bg)', border: '1px solid var(--apple-border-color)',
              display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {setInfo?.thumbUrl
                ? setInfo.thumbUrl.endsWith('.tgs')
                  ? <AnimatedSticker url={setInfo.thumbUrl} size={40} loop playOnHover />
                  : <img src={setInfo.thumbUrl} alt="" style={{ width: 40, height: 40, objectFit: 'contain' }} />
                : <span style={{ fontSize: 26 }}>🎭</span>}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {setInfo ? setInfo.title : sticker.setName}
              </div>
              {setInfo?.count ? (
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{setInfo.count} стикеров</div>
              ) : null}
            </div>
          </div>

          <button
            onClick={handleImport}
            disabled={alreadyHave || importing || imported}
            style={{
              width: '100%', height: 34, borderRadius: 10, border: 'none', cursor: alreadyHave ? 'default' : 'pointer',
              fontSize: 13, fontWeight: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              backgroundColor: alreadyHave ? 'var(--container-bg)' : 'var(--accent-primary)',
              color: alreadyHave ? 'var(--text-muted)' : '#fff',
              opacity: importing ? 0.7 : 1,
            }}
          >
            {importing && <Spinner size={13} />}
            {alreadyHave ? '✓ Уже добавлен' : imported ? '✓ Добавлен!' : <><Plus style={{ width: 13, height: 13 }} /> Добавить набор</>}
          </button>
        </div>
      )}
    </div>
  );
}
