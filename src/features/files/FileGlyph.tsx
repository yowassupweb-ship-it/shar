import { FileIcon, defaultStyles, type FileIconProps } from 'react-file-icon';
import type { Kind } from './api';

/**
 * Значок файла — те же, что в прежних «Файлах» (react-file-icon): лист с
 * загнутым углом и цветной плашкой расширения, свой вид для каждого типа.
 */

const FALLBACK: Partial<Record<Kind, string>> = { image: 'jpg', video: 'mp4', audio: 'mp3', pdf: 'pdf', sheet: 'xlsx', slides: 'pptx', doc: 'docx', archive: 'zip' };
const PX = { xs: 16, sm: 26, lg: 44 } as const;

export function FileGlyph({ name, kind, size }: { name: string; kind: Kind; size: 'xs' | 'sm' | 'lg' }) {
  const own = name.includes('.') ? (name.split('.').pop() || '').toLowerCase() : '';
  const ext = own && own.length <= 5 ? own : FALLBACK[kind] || 'file';
  const style = (defaultStyles as Record<string, Partial<FileIconProps>>)[ext] || {};
  return (
    <span className="nf-glyph" data-size={size} style={{ width: PX[size] }} aria-hidden="true">
      <FileIcon extension={ext.toUpperCase()} {...style} />
    </span>
  );
}
