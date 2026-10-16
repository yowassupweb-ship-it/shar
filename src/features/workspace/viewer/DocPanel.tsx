import { lazy, Suspense, useEffect, useState } from 'react';
import { Download, PenLine, X } from 'lucide-react';
import { canOpenInEditor, KIND_LABEL, viewKindOf, type FileRef } from './kinds';
import { CsvViewer, DocxViewer, HtmlViewer, MarkdownViewer, PlainTextViewer, XlsxViewer } from './TextViewers';
import { openInEditor } from './openInEditor';
import { Spinner } from '@/shared/ui/Spinner';
import './viewer.css';
import { downloadOnClick } from '@/shared/platform/download';

// pdf.js тяжёлый — грузится только когда открыли PDF.
const PdfViewer = lazy(() => import('./PdfViewer'));

function fmtSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1).replace('.', ',')} КБ`;
  return `${(bytes / 1048576).toFixed(1).replace('.', ',')} МБ`;
}

/**
 * Просмотр вложения в боковой панели чата — на месте профиля и эмодзи. Ширину панели тянет граница слева
 * (Splitter в Conversation), запоминается отдельно от других панелей. «Открыть в редакторе» — у Word, Excel, CSV,
 * Markdown и текста; PDF, HTML и журналы — только просмотр.
 */
export default function DocPanel({ file, onClose }: { file: FileRef; onClose: () => void }) {
  const kind = viewKindOf(file.name);
  const [opening, setOpening] = useState(false);
  const editable = canOpenInEditor(file.name);

  // Esc закрывает просмотр (в полях ввода — например в поиске по PDF — Esc остаётся за полем).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const edit = async () => {
    setOpening(true);
    const ok = await openInEditor(file);
    if (!ok) setOpening(false);
  };

  let body;
  if (kind === 'pdf') body = <Suspense fallback={<div className="npv-state"><Spinner size={24} label="Загружаю просмотрщик" /></div>}><PdfViewer key={file.url} url={file.url} name={file.name} /></Suspense>;
  else if (kind === 'html') body = <HtmlViewer key={file.url} url={file.url} name={file.name} />;
  else if (kind === 'docx') body = <DocxViewer key={file.url} url={file.url} name={file.name} />;
  else if (kind === 'xlsx') body = <XlsxViewer key={file.url} url={file.url} name={file.name} />;
  else if (kind === 'csv') body = <CsvViewer key={file.url} url={file.url} name={file.name} />;
  else if (kind === 'markdown') body = <MarkdownViewer key={file.url} url={file.url} name={file.name} />;
  else if (kind === 'text') body = <PlainTextViewer key={file.url} url={file.url} name={file.name} />;
  else body = <div className="npv-state">Этот тип файла нельзя посмотреть здесь. Скачайте его.</div>;

  return (
    <aside className="cxp npv-panel" aria-label={`Просмотр: ${file.name}`}>
      <header className="cxp-head npv-head">
        <div className="npv-title">
          <b title={file.name}>{file.name}</b>
          <span>{[kind ? KIND_LABEL[kind] : '', fmtSize(file.size)].filter(Boolean).join(' · ')}</span>
        </div>
        <a className="nx-icon-btn" href={file.url} download={file.name} target="_blank" rel="noopener noreferrer" onClick={downloadOnClick(file.url, file.name)} aria-label="Скачать" title="Скачать"><Download size={16} /></a>
        <button type="button" className="nx-icon-btn" onClick={onClose} aria-label="Закрыть просмотр" title="Закрыть (Esc)"><X size={16} /></button>
      </header>
      {editable && (
        <div className="npv-actions">
          <button type="button" className="nx-primary" disabled={opening} onClick={() => void edit()}>
            {opening ? <Spinner size={14} /> : <PenLine size={14} aria-hidden="true" />} Открыть в редакторе
          </button>
          <span>Откроется копия — исходный файл в чате не изменится.</span>
        </div>
      )}
      <div className="cxp-body npv-body">{body}</div>
    </aside>
  );
}
