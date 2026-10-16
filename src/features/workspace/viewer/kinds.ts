/** Что умеет просмотр вложения и во что файл превращается в редакторе. */
export type ViewKind = 'pdf' | 'html' | 'docx' | 'xlsx' | 'csv' | 'markdown' | 'text';

export interface FileRef {
  url: string;
  name: string;
  size?: number;
}

const BY_EXT: Record<string, ViewKind> = {
  pdf: 'pdf',
  html: 'html', htm: 'html',
  docx: 'docx',
  xlsx: 'xlsx', xlsm: 'xlsx',
  md: 'markdown', markdown: 'markdown',
  csv: 'csv',
  txt: 'text', log: 'text',
};

export function viewKindOf(name: string): ViewKind | null {
  const ext = name.toLowerCase().match(/\.([a-z0-9]{1,8})(?:[?#].*)?$/)?.[1];
  return (ext && BY_EXT[ext]) || null;
}

/** «Открыть в редакторе» есть у Word, Excel и CSV (станут таблицей), Markdown и обычного текста; PDF, HTML и журналы — только просмотр. */
export const canOpenInEditor = (name: string): boolean => /\.(docx|xlsx|xlsm|csv|md|markdown|txt)(?:[?#].*)?$/i.test(name);

export const KIND_LABEL: Record<ViewKind, string> = {
  pdf: 'PDF', html: 'HTML', docx: 'Word', xlsx: 'Excel', csv: 'CSV', markdown: 'Markdown', text: 'Текст',
};
