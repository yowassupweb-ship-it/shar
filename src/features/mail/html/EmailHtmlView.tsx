import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { preprocessHtml, _htmlHeightCache } from './mailUtils';

// Renders an email's own HTML in its own colors/fonts. The reading surface is
// always a plain white "paper", regardless of the app's light/dark theme —
// same as Gmail/Outlook. Trying to auto-invert the canvas to follow the app
// theme was repeatedly breaking real emails (dark-on-dark, white-on-white)
// because there's no reliable way to know what background an email assumed
// without one; a fixed white canvas is what virtually all HTML email is
// actually authored against, so it's the only choice that's never wrong.
// `cacheKey` (the message id) lets a re-opened email reuse its last measured
// height instead of starting at a stub and reflowing/flashing on every open.

// Базовые стили идут в <head> ДО письма: его собственные стили (в т.ч. <style> внутри тела) позже и
// важнее. Здесь только то, что браузер иначе делает плохо: Times New Roman у писем без своего шрифта,
// текст вплотную к краю листа, цитаты без отбивки. Высоту картинок не трогаем через !important —
// она бывает задана в самом письме, и `height: auto !important` растягивала распорки и логотипы.
const BASE_CSS = `
  html, body { margin: 0; padding: 0; overflow: hidden; background: #ffffff; }
  #shar-mail {
    box-sizing: border-box; padding: 20px 24px; transform-origin: 0 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 14px; line-height: 1.5; color: #1f2328;
    overflow-wrap: break-word; -webkit-text-size-adjust: 100%;
  }
  img { max-width: 100%; height: auto; }
  img[width="1"], img[height="1"] { max-width: none; }
  pre { white-space: pre-wrap; }
  p.MsoNormal, li.MsoNormal, div.MsoNormal { margin: 0; } /* так их рисует сам Outlook */
  blockquote[type="cite"], .gmail_quote > blockquote { margin: 8px 0 8px 4px; padding-left: 12px; border-left: 3px solid #d0d7de; color: #57606a; }
  a { overflow-wrap: anywhere; }
  @media (max-width: 480px) { #shar-mail { padding: 14px; } }
  #shar-mail.bare { padding: 0; }
`;

/** `bare` — без полей листа (подпись в окне письма). */
export function EmailHtmlView({ html, cacheKey, bare }: {
  html: string; isDark?: boolean; cacheKey?: string; bare?: boolean;
}) {
  const cached = cacheKey ? _htmlHeightCache.get(cacheKey) : undefined;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(cached ?? 80);
  const roRef = useRef<ResizeObserver | null>(null);

  const measure = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    const box = doc?.getElementById('shar-mail');
    if (!doc || !box) return;
    // Рассылка шире панели (таблица на 600–700px с фиксированными ячейками) — уменьшаем её целиком,
    // как Gmail, а не обрезаем справа: раньше край письма просто пропадал. Меряем без масштаба
    // (transform не меняет раскладку), поэтому повторный замер не накапливает уменьшение.
    const avail = doc.documentElement.clientWidth;
    box.style.width = '';
    box.style.transform = '';
    const wide = box.scrollWidth;
    let scale = 1;
    if (avail > 0 && wide > avail + 2) {
      scale = Math.max(0.45, avail / wide);
      box.style.width = `${wide}px`;
      box.style.transform = `scale(${scale})`;
    }
    const h = Math.ceil(box.offsetHeight * scale);
    if (h > 0) {
      setHeight(h);
      if (cacheKey) _htmlHeightCache.set(cacheKey, h);
    }
  }, [cacheKey]);

  const handleLoad = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc?.body) return;
    // Ссылки — в новой вкладке (переход внутри песочницы всё равно запрещён).
    doc.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    });
    doc.querySelectorAll('img').forEach((img) => {
      if (!img.complete) img.addEventListener('load', measure, { once: true });
    });
    roRef.current?.disconnect();
    roRef.current = new ResizeObserver(() => measure());
    roRef.current.observe(doc.getElementById('shar-mail') || doc.body);
    roRef.current.observe(doc.documentElement); // ширина панели изменилась — пересчитать масштаб
    measure();
  }, [measure]);

  useEffect(() => () => { roRef.current?.disconnect(); }, []);

  const srcDoc = useMemo(() =>
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"/><base target="_blank"><style>${BASE_CSS}</style></head><body><div id="shar-mail"${bare ? ' class="bare"' : ''}>${preprocessHtml(html)}</div></body></html>`,
  [html, bare]);

  return (
    <iframe
      ref={iframeRef}
      className="nx-mail-paper"
      title="Текст письма"
      srcDoc={srcDoc}
      sandbox="allow-same-origin allow-popups"
      referrerPolicy="no-referrer"
      scrolling="no"
      style={{ width: '100%', height, minHeight: 40, border: 'none', display: 'block', background: '#ffffff', overflow: 'hidden' }}
      onLoad={handleLoad}
    />
  );
}
