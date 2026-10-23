/**
 * Вкладки заметки (как у листов таблицы, перенесено из MBOX). Заметка в Шаре — одна строка Markdown: по ней ищут,
 * из неё делают фрагмент в списке, её сливают при совместной правке и хранят в истории. Поэтому вкладки живут в
 * той же строке: каждая следующая начинается служебной строкой `<!-- shar-tab: Название -->` (комментарий HTML
 * в просмотре Markdown не виден). Заметка без вкладок — обычный текст, как раньше.
 */

export interface NoteTab { title: string; content: string }

export const FIRST_TAB = 'Основная';
const MARK = /^<!-- shar-tab: (.*?) -->$/;
const SPLIT = /\n<!-- shar-tab: (.*?) -->\n/;

/** Название без того, что сломало бы служебную строку. */
export const cleanTabTitle = (title: string) => title.replace(/-->|[\r\n]/g, ' ').trim().slice(0, 80) || 'Вкладка';

export function parseTabs(text: string): NoteTab[] {
  let rest = text;
  let first = FIRST_TAB;
  const lead = /^<!-- shar-tab: (.*?) -->\n?/.exec(rest);
  if (lead) { first = lead[1]; rest = rest.slice(lead[0].length); }
  const parts = rest.split(SPLIT);
  const tabs: NoteTab[] = [{ title: first, content: parts[0] }];
  for (let i = 1; i < parts.length; i += 2) tabs.push({ title: parts[i], content: parts[i + 1] ?? '' });
  return tabs;
}

export function serializeTabs(tabs: NoteTab[]): string {
  return tabs.map((t, i) => {
    if (i === 0) return t.title === FIRST_TAB ? t.content : `<!-- shar-tab: ${cleanTabTitle(t.title)} -->\n${t.content}`;
    return `\n<!-- shar-tab: ${cleanTabTitle(t.title)} -->\n${t.content}`;
  }).join('');
}

/** Для печати и экспорта: вкладки становятся разделами с заголовком. */
export function tabsAsSections(text: string): string {
  const tabs = parseTabs(text);
  if (tabs.length === 1) return tabs[0].content;
  return tabs.map((t) => `## ${t.title}\n\n${t.content.trim()}`).join('\n\n');
}

export const isTabMark = (line: string) => MARK.test(line);
