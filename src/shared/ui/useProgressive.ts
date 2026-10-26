import { useEffect, useState } from 'react';

/**
 * Длинный список — частями: сначала первые `step` элементов, следующие — когда метка в конце списка подошла
 * к экрану (с запасом). Вкладки профиля чата (медиа, файлы, ссылки, участники) в большом чате — сотни
 * элементов: раньше они монтировались, раскладывались и грузили миниатюры разом при каждом открытии вкладки.
 * Смена `resetKey` (другая вкладка, поиск) возвращает к первой части. Метка — callback-ref: у другой вкладки
 * своя метка, и наблюдатель переходит на неё.
 */
export function useProgressive(total: number, resetKey: unknown, step = 60) {
  const [count, setCount] = useState(step);
  const [mark, sentinel] = useState<HTMLDivElement | null>(null);
  useEffect(() => { setCount(step); }, [resetKey, step]);
  const more = count < total;
  useEffect(() => {
    if (!mark || !more) return undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setCount((c) => c + step);
    }, { rootMargin: '800px 0px' });
    io.observe(mark);
    return () => io.disconnect();
  }, [mark, more, step, count]);
  return { count: Math.min(count, total), sentinel, more };
}
