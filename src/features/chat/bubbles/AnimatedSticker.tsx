import { useEffect, useRef, useState } from 'react';

interface Props {
  url: string;
  size?: number;
  autoplay?: boolean;
  loop?: boolean;
  playOnHover?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

// Module-level cache: url → Lottie JSON data
const _jsonCache = new Map<string, object>();
// Pre-fetch queue: urls being downloaded right now
const _inFlight = new Set<string>();

export function preloadStickerUrl(url: string): void {
  if (_jsonCache.has(url) || _inFlight.has(url)) return;
  _inFlight.add(url);
  fetchAndCache(url).finally(() => _inFlight.delete(url));
}

async function fetchAndCache(url: string): Promise<object | null> {
  if (_jsonCache.has(url)) return _jsonCache.get(url)!;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let json: string;
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const { decompressSync } = await import('fflate');
      json = new TextDecoder().decode(decompressSync(bytes));
    } else {
      json = new TextDecoder().decode(bytes);
    }
    const data = JSON.parse(json);
    _jsonCache.set(url, data);
    return data;
  } catch { return null; }
}

export default function AnimatedSticker({ url, size = 96, autoplay = true, loop = true, playOnHover = false, className, style }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<any>(null);
  const isVisibleRef = useRef(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    const mount = async () => {
      try {
        const animData = await fetchAndCache(url);
        if (!animData || cancelled || !containerRef.current) return;

        const lottie = (await import('lottie-web')).default;
        if (animRef.current) { animRef.current.destroy(); animRef.current = null; }

        const shouldPlay = playOnHover ? false : (autoplay && isVisibleRef.current);
        animRef.current = lottie.loadAnimation({
          container: containerRef.current,
          renderer: 'svg',
          loop,
          autoplay: shouldPlay,
          animationData: animData,
        });

        if (playOnHover) {
          animRef.current.goToAndStop(0, true);
        }
      } catch {
        if (!cancelled) setError(true);
      }
    };

    void mount();
    return () => {
      cancelled = true;
      if (animRef.current) { animRef.current.destroy(); animRef.current = null; }
    };
  }, [url, autoplay, loop, playOnHover]);

  // Pause when out of viewport, resume when back in view
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        isVisibleRef.current = entry.isIntersecting;
        if (!animRef.current || playOnHover) return;
        if (entry.isIntersecting) {
          if (autoplay) animRef.current.play();
        } else {
          animRef.current.pause();
        }
      },
      { threshold: 0 }
    );
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [autoplay, playOnHover]);

  const handleMouseEnter = () => {
    if (playOnHover && animRef.current) animRef.current.play();
  };
  const handleMouseLeave = () => {
    if (playOnHover && animRef.current) {
      animRef.current.stop();
      animRef.current.goToAndStop(0, true);
    }
  };

  if (error) {
    return <div style={{ width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.4 }}>🎭</div>;
  }

  return (
    <div
      ref={containerRef}
      className={className}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{ width: size, height: size, flexShrink: 0, ...style }}
    />
  );
}
