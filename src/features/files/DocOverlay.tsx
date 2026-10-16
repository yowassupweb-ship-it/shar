import { Suspense } from 'react';
import { DocPanel, type FileRef } from '@/features/workspace';
import { Spinner } from '@/shared/ui/Spinner';

/**
 * Просмотр документа в «Файлах» — та же панель, что в чате (PDF, Word, Excel, CSV, текст, HTML), поверх раздела
 * справа. Раньше файл открывался window.open: в приложении — во внешнем браузере с адресом 127.0.0.1.
 * Закрыть: Esc, крестик или клик мимо панели.
 */
export function DocOverlay({ file, onClose }: { file: FileRef; onClose: () => void }) {
  return (
    <div className="nf-doc" role="dialog" aria-modal="true" aria-label={`Просмотр: ${file.name}`} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <Suspense fallback={<div className="nf-doc-loading"><Spinner size={24} label="Открываю" /></div>}>
        <DocPanel file={file} onClose={onClose} />
      </Suspense>
    </div>
  );
}
