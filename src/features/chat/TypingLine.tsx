import { useEffect, useState } from 'react';
import { useChatStore, type TypingKind } from './store';

/**
 * «Инесса печатает…» — строка прямо над полем ввода: имя словами и три
 * прыгающие точки. Стоит абсолютно над композером, поэтому не меняет его
 * высоту и не сдвигает ленту. Исчезает плавно, а не в тот же кадр.
 */

const VERB: Record<TypingKind, [string, string]> = {
  text: ['печатает', 'печатают'],
  file: ['отправляет файл', 'отправляют файлы'],
  voice: ['записывает голосовое', 'записывают голосовые'],
};

function phrase(names: string[], kind: TypingKind): string {
  const first = names.map((n) => n.split(' ')[0]);
  if (first.length === 1) return `${first[0]} ${VERB[kind][0]}`;
  if (first.length === 2) return `${first[0]} и ${first[1]} ${VERB[kind][1]}`;
  return `${first[0]}, ${first[1]} и ещё ${first.length - 2} ${VERB[kind][1]}`;
}

export default function TypingLine({ chatId }: { chatId: string }) {
  const names = useChatStore((s) => s.typing[chatId]);
  const kinds = useChatStore((s) => s.typingKind[chatId]);
  const entries = names ? Object.entries(names) : [];
  const live = entries.length ? phrase(entries.map(([, n]) => n), kinds?.[entries[0][0]] || 'text') : '';
  const [text, setText] = useState('');

  // Держим последний текст на время исчезновения.
  useEffect(() => {
    if (live) { setText(live); return undefined; }
    const t = window.setTimeout(() => setText(''), 200);
    return () => window.clearTimeout(t);
  }, [live]);

  if (!text) return null;
  return (
    <div className="cxc-typing" data-leaving={live ? undefined : 'true'} role="status" aria-live="polite">
      <span>{text}</span>
      <span className="cxc-typing-dots" aria-hidden="true"><i /><i /><i /></span>
    </div>
  );
}
