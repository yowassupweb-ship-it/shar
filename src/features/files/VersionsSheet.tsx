import { useEffect, useState } from 'react';
import { Download, RotateCcw } from 'lucide-react';
import { Sheet, askConfirm } from '@/shared/ui/overlay';
import { Spinner } from '@/shared/ui/Spinner';
import { showToast } from '@/shared/ui/Toast';
import { downloadFile } from '@/shared/platform/download';
import { fileUrl, fmtBytes, loadFileHistory, restoreFileVersion, type CloudFile, type FileHistory } from './api';

const when = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const stamp = (iso?: string) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? when.format(d) : '—';
};

/**
 * История версий файла: текущая и прежние (после замен из буфера или с диска). Ссылка на файл у всех версий одна —
 * вернуть прежнюю значит поменять местами с текущей, ничего не теряется. Скачать можно любую; вернуть — тем, кто может править.
 */
export function VersionsSheet({ file, onClose, onChanged }: { file: CloudFile; onClose: () => void; onChanged: (f: CloudFile) => void }) {
  const [history, setHistory] = useState<FileHistory | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    loadFileHistory(file.id).then((h) => { if (alive) setHistory(h); }).catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [file.id]);

  const restore = async (versionId: string, at: string) => {
    const ok = await askConfirm({ title: 'Вернуть эту версию?', text: `Версия от ${stamp(at)} станет текущей на той же ссылке. Нынешняя останется в истории.`, confirm: 'Вернуть' });
    if (!ok) return;
    setBusy(versionId);
    try {
      const updated = await restoreFileVersion(file.id, versionId);
      showToast('Версия возвращена', 'success');
      onChanged(updated);
      setHistory(await loadFileHistory(file.id));
    } catch {
      showToast('Не вернул — файл изменили, откройте историю заново.', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet title={`Версии «${file.name}»`} onClose={onClose} footer={<button type="button" className="nx-primary" onClick={onClose}>Готово</button>}>
      {error ? (
        <p className="nx-hint" role="alert">Не удалось загрузить историю.</p>
      ) : !history ? (
        <div className="nx-state" aria-busy="true"><Spinner size={20} /></div>
      ) : (
        <div className="nfs-versions">
          <div className="nfs-version" data-current="true">
            <span className="nfs-version-main"><b>Текущая</b><small>{stamp(history.current.updatedAt)} · {fmtBytes(history.current.size) || '—'}</small></span>
            <button type="button" className="nx-icon-btn" aria-label="Скачать текущую версию" title="Скачать" onClick={() => downloadFile(fileUrl(history.current.url), file.name)}><Download size={16} /></button>
          </div>
          {history.versions.length === 0 && <p className="nx-hint">Прежних версий нет. Они появятся, когда файл заменят: «Заменить из буфера» или «Заменить файлом…» в меню файла.</p>}
          {history.versions.map((v) => (
            <div key={v.id} className="nfs-version">
              <span className="nfs-version-main">
                <b>{stamp(v.at)}</b>
                <small>{fmtBytes(v.size) || '—'} · заменена {stamp(v.replacedAt)}{v.byName ? ` · ${v.byName}` : ''}</small>
              </span>
              <button type="button" className="nx-icon-btn" aria-label="Скачать эту версию" title="Скачать" onClick={() => downloadFile(fileUrl(v.url), file.name)}><Download size={16} /></button>
              {history.canRestore && (
                <button type="button" className="nx-icon-btn" aria-label="Вернуть эту версию" title="Вернуть" disabled={Boolean(busy)} onClick={() => void restore(v.id, v.at)}>
                  {busy === v.id ? <Spinner size={14} /> : <RotateCcw size={16} />}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
}
