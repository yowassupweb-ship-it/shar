import type { ReactNode } from 'react';

/**
 * Подсветка Markdown в поле правки заметки. Рисуется в слое под прозрачным текстом поля, поэтому меняет только
 * цвет: жирный или курсив изменили бы ширину букв, и каретка разошлась бы с текстом. Служебные знаки (#, **, [ ], ( ))
 * приглушены, содержимое — своим цветом; вложенное (жирное внутри ссылки и т. п.) раскрашивается тоже.
 */

const INLINE = new RegExp([
  '(`+)([^`\\n]+?)\\1',                                   // 1-2   `код`
  '(!?\\[)([^\\]\\n]*)(\\]\\()([^)\\s]*)(\\))',            // 3-7   [текст](адрес), ![картинка](адрес)
  '(\\*\\*|__)(?=\\S)([^\\n]+?)(?<=\\S)\\8',               // 8-9   **жирный**
  '(~~)(?=\\S)([^\\n]+?)(?<=\\S)\\10',                     // 10-11 ~~зачёркнутый~~
  '(?<![\\w*])([*_])(?=[^\\s*_])([^*_\\n]+?)(?<=\\S)\\12(?![\\w*])', // 12-13 *курсив*
  '(https?:\\/\\/[^\\s)<>]+)',                             // 14    голый адрес
].join('|'), 'g');

const mark = (text: string, key: string) => <span key={key} className="nmd-mark">{text}</span>;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0;
    if (i > at) out.push(text.slice(at, i));
    const k = `${key}.${n++}`;
    if (m[1]) out.push(<span key={k} className="nmd-code">{mark(m[1], 'a')}{m[2]}{mark(m[1], 'b')}</span>);
    else if (m[3]) {
      out.push(
        <span key={k} className={m[3] === '![' ? 'nmd-image' : 'nmd-link'}>
          {mark(m[3], 'a')}<span className="nmd-link-text">{inline(m[4], `${k}t`)}</span>{mark(m[5], 'b')}
          <span className="nmd-link-url">{m[6]}</span>{mark(m[7], 'c')}
        </span>,
      );
    } else if (m[8]) out.push(<span key={k} className="nmd-strong">{mark(m[8], 'a')}{inline(m[9], `${k}s`)}{mark(m[8], 'b')}</span>);
    else if (m[10]) out.push(<span key={k} className="nmd-strike">{mark(m[10], 'a')}{inline(m[11], `${k}s`)}{mark(m[10], 'b')}</span>);
    else if (m[12]) out.push(<span key={k} className="nmd-em">{mark(m[12], 'a')}{inline(m[13], `${k}s`)}{mark(m[12], 'b')}</span>);
    else if (m[14]) out.push(<span key={k} className="nmd-link-url">{m[14]}</span>);
    at = i + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function line(text: string, key: string, fenced: boolean): ReactNode {
  if (fenced || /^\s*```/.test(text)) return <span key={key} className="nmd-code">{text}</span>;
  let m = /^(#{1,6})(\s+)(.*)$/.exec(text);
  if (m) return <span key={key} className="nmd-h">{mark(m[1], 'a')}{m[2]}{inline(m[3], key)}</span>;
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(text)) return <span key={key} className="nmd-mark">{text}</span>;
  m = /^(\s*>+\s?)(.*)$/.exec(text);
  if (m) return <span key={key} className="nmd-quote">{mark(m[1], 'a')}{inline(m[2], key)}</span>;
  m = /^(\s*(?:[-*+]|\d+[.)])\s+)(\[[ xX]\]\s+)?(.*)$/.exec(text);
  if (m) {
    return (
      <span key={key}>
        <span className="nmd-list">{m[1]}</span>
        {m[2] && <span className={/x/i.test(m[2]) ? 'nmd-task-done' : 'nmd-task'}>{m[2]}</span>}
        {inline(m[3], key)}
      </span>
    );
  }
  if (/^\s*\|.*\|\s*$/.test(text)) {
    // Строка таблицы: черты и строка-разделитель приглушены, ячейки — как обычный текст.
    if (/^[\s|:-]+$/.test(text)) return <span key={key} className="nmd-mark">{text}</span>;
    return <span key={key}>{text.split(/(\|)/).map((part, i) => (part === '|' ? mark(part, `p${i}`) : inline(part, `${key}c${i}`)))}</span>;
  }
  return <span key={key}>{inline(text, key)}</span>;
}

export function highlightMarkdown(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let fenced = false;
  text.split('\n').forEach((raw, i) => {
    const fence = /^\s*```/.test(raw);
    out.push(line(raw, `l${i}`, fenced || fence));
    if (fence) fenced = !fenced;
    out.push('\n');
  });
  out.pop();
  return out;
}
