import { Fragment } from 'react';

// Адрес с http(s):// или www.; знаки в конце предложения («…сайт.», «(см. ссылку)») к ссылке не относим.
const URL_RE = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;
const TRAILING = /[.,;:!?)\]}»"']+$/;

/** Текст с кликабельными ссылками: открываются в новой вкладке, без передачи окна и источника. */
export function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) return <Fragment key={i}>{part}</Fragment>;
        const tail = part.match(TRAILING)?.[0] ?? '';
        const url = tail ? part.slice(0, -tail.length) : part;
        return (
          <Fragment key={i}>
            <a href={/^www\./i.test(url) ? `https://${url}` : url} target="_blank" rel="noopener noreferrer">{url}</a>
            {tail}
          </Fragment>
        );
      })}
    </>
  );
}
