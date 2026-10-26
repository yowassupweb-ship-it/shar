import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { dayIso, weekdayIndex } from './model';

/**
 * Производственный календарь России (сервер: /api/calendar/workdays, источник — xmlcalendar.ru по
 * постановлениям о переносах, обновляется раз в сутки). Отмечаем нерабочие дни с переносами, а не
 * просто субботу и воскресенье: 9 января, 31 декабря, рабочая суббота перед праздником.
 * Пока год не загружен — обычные выходные.
 */

export interface DayKind {
  /** Нерабочий: выходной или праздник (с учётом переносов). */
  off: boolean;
  /** Сокращённый предпраздничный рабочий день. */
  short: boolean;
  /** Суббота или воскресенье, ставшие рабочими из-за переноса. */
  workWeekend: boolean;
  /** Название праздника или «Перенесённый выходной». */
  name?: string;
}

interface YearData { off: Set<string>; short: Set<string>; workWeekend: Set<string>; names: Record<string, string>; provisional: boolean }

const useYears = create<{ years: Record<number, YearData | 'loading' | 'error'> }>(() => ({ years: {} }));

function load(year: number): void {
  const cur = useYears.getState().years[year];
  if (cur && cur !== 'error') return;
  useYears.setState((s) => ({ years: { ...s.years, [year]: 'loading' } }));
  fetch(`/api/calendar/workdays?year=${year}`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((j: { off: string[]; short: string[]; workWeekend: string[]; names: Record<string, string>; provisional: boolean }) => {
      useYears.setState((s) => ({ years: { ...s.years, [year]: {
        off: new Set(j.off), short: new Set(j.short), workWeekend: new Set(j.workWeekend), names: j.names || {}, provisional: Boolean(j.provisional),
      } } }));
    })
    .catch(() => useYears.setState((s) => ({ years: { ...s.years, [year]: 'error' } })));
}

/** Что за день — для видов календаря. years — какие годы видны (подгружаются сами). */
export function useWorkdays(years: number[]): (d: Date) => DayKind {
  const key = [...new Set(years)].sort().join(',');
  useEffect(() => { for (const y of key.split(',')) if (y) load(Number(y)); }, [key]);
  const data = useYears((s) => s.years);
  return useMemo(() => (d: Date): DayKind => {
    const y = data[d.getFullYear()];
    if (!y || typeof y === 'string') return { off: weekdayIndex(d) >= 5, short: false, workWeekend: false };
    const iso = dayIso(d);
    return { off: y.off.has(iso), short: y.short.has(iso), workWeekend: y.workWeekend.has(iso), name: y.names[iso] };
  }, [data]);
}

/** Подсказка к дню: «Новый год», «Сокращённый день», «Рабочая суббота». */
export function dayTitle(k: DayKind): string | undefined {
  if (k.name) return k.name;
  if (k.short) return 'Сокращённый предпраздничный день';
  if (k.workWeekend) return 'Рабочий день (перенос)';
  return undefined;
}
