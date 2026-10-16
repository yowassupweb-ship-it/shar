import { FilePenLine, Presentation, StickyNote, Table2, type LucideIcon } from 'lucide-react';
import { PUBLIC_ORIGIN, links } from '@/shared/navigation/routes';
import type { Kind } from './types';

/** Всё, чем виды материалов отличаются снаружи: названия, значок, адрес раздела и ссылки по токену. */
export interface KindInfo {
  kind: Kind;
  /** «Заметки» — заголовок раздела. */
  plural: string;
  /** Короткая подпись для переключателя видов. */
  short: string;
  /** «заметку» — в оборотах вроде «Ссылка на заметку». */
  accusative: string;
  newLabel: string;
  untitled: string;
  empty: string;
  icon: LucideIcon;
  /** Цвета плашки в «Ещё». */
  tint: [string, string];
  /** Адрес раздела «Офис» на этом виде. */
  href: string;
  /** Первая буква адреса публичной ссылки: /n/…, /d/…, /t/…, /p/…. */
  linkPrefix: string;
}

export const KINDS: Record<Kind, KindInfo> = {
  note: {
    kind: 'note', plural: 'Заметки', short: 'Заметки', accusative: 'заметку', newLabel: 'Новая заметка', untitled: 'Без заголовка',
    empty: 'Заметок пока нет.', icon: StickyNote, tint: ['#fde047', '#f59e0b'], href: links.office('note'), linkPrefix: 'n',
  },
  document: {
    kind: 'document', plural: 'Документы', short: 'Доки', accusative: 'документ', newLabel: 'Новый документ', untitled: 'Новый документ',
    empty: 'Документов пока нет.', icon: FilePenLine, tint: ['#60a5fa', '#2563eb'], href: links.office('document'), linkPrefix: 'd',
  },
  table: {
    kind: 'table', plural: 'Таблицы', short: 'Таблицы', accusative: 'таблицу', newLabel: 'Новая таблица', untitled: 'Новая таблица',
    empty: 'Таблиц пока нет.', icon: Table2, tint: ['#4ade80', '#16a34a'], href: links.office('table'), linkPrefix: 't',
  },
  presentation: {
    kind: 'presentation', plural: 'Презентации', short: 'Слайды', accusative: 'презентацию', newLabel: 'Новая презентация', untitled: 'Новая презентация',
    empty: 'Презентаций пока нет.', icon: Presentation, tint: ['#fb923c', '#dc2626'], href: links.office('presentation'), linkPrefix: 'p',
  },
};

export const KIND_LIST: KindInfo[] = [KINDS.note, KINDS.document, KINDS.table, KINDS.presentation];

export const kindByPrefix = (prefix: string): Kind | null => KIND_LIST.find((k) => k.linkPrefix === prefix)?.kind ?? null;

/** Публичный адрес ссылки: в приложении для компьютера интерфейс живёт на 127.0.0.1, поэтому там — боевой адрес. */
export function sharedUrl(kind: Kind, token: string): string {
  const origin = window.sharDesktop ? PUBLIC_ORIGIN : window.location.origin;
  return `${origin}/${KINDS[kind].linkPrefix}/${token}`;
}
