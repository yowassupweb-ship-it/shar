import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { preprocessHtml, _htmlHeightCache } from './mailUtils';

// Renders an email's own HTML in its own colors/fonts. The reading surface is
// always a plain white "paper", regardless of the app's light/dark theme —
// same as Gmail/Outlook. Trying to auto-invert the canvas to follow the app
// theme was repeatedly breaking real emails (dark-on-dark, white-on-white)
// because there's no reliable way to know what background an email assumed
// without one; a fixed white canvas is what virtually all HTML email is
// actually authored against, so it's the only choice that's never wrong.
// Only genuine readability CSS (fonts/line-height/table responsiveness/
// Outlook-artifact hiding) is injected — the email's own colors are untouched.
// `cacheKey` (the message id) lets a re-opened email reuse its last measured
// height instead of starting at a stub and reflowing/flashing on every open.
export function EmailHtmlView({ html, cacheKey }: {
  html: string; isDark?: boolean; cacheKey?: string;
}) {
  const cached = cacheKey ? _htmlHeightCache.get(cacheKey) : undefined;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(cached ?? 80);
  const roRef = useRef<ResizeObserver | null>(null);
  const loadedRef = useRef(false);
  const naturalHeightRef = useRef(cached ?? 0);

  const measure = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc?.body) return;
    const h = doc.body.scrollHeight || doc.documentElement.scrollHeight;
    if (h > 0) {
      naturalHeightRef.current = h;
      setHeight(h + 2);
      if (cacheKey) _htmlHeightCache.set(cacheKey, h + 2);
    }
  }, [cacheKey]);

  const applyBaseStyles = useCallback((doc: Document) => {
    doc.querySelectorAll('style[data-mail-inject]').forEach(s => s.remove());
    const style = doc.createElement('style');
    style.setAttribute('data-mail-inject', '1');
    style.textContent = `
      html, body { margin: 0; padding: 0; max-width: 100%; overflow-x: hidden; }
      body {
        word-wrap: break-word; overflow-wrap: break-word;
      }
      img { max-width: 100% !important; height: auto !important; }
      table { max-width: 100% !important; }
      a { overflow-wrap: anywhere; }
    `;
    doc.head.appendChild(style);

    // Ensure all links open in a new tab (sandbox doesn't allow same-page navigation anyway)
    if (!doc.querySelector('base')) {
      const base = doc.createElement('base');
      base.target = '_blank';
      doc.head.insertBefore(base, doc.head.firstChild);
    }
    doc.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(a => {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    });
  }, []);

  const handleLoad = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc?.body) return;
    loadedRef.current = true;

    applyBaseStyles(doc);

    // Images: re-measure when loaded
    doc.querySelectorAll('img').forEach(img => {
      if (!img.complete) img.addEventListener('load', () => setTimeout(measure, 50), { once: true });
    });

    // ResizeObserver for live height tracking
    if (roRef.current) roRef.current.disconnect();
    roRef.current = new ResizeObserver(() => measure());
    roRef.current.observe(doc.body);

    measure();
    setTimeout(measure, 100);
    setTimeout(measure, 500);
  }, [applyBaseStyles, measure]);

  // Cleanup ResizeObserver on unmount
  useEffect(() => () => { roRef.current?.disconnect(); }, []);

  const srcDoc = useMemo(() =>
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body>${preprocessHtml(html)}</body></html>`,
  [html]);

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      sandbox="allow-same-origin allow-popups"
      referrerPolicy="no-referrer"
      scrolling="no"
      style={{
        width: '100%', height, minHeight: 40,
        border: 'none', display: 'block', background: '#ffffff',
        overflow: 'hidden',
      }}
      onLoad={handleLoad}
    />
  );
}
