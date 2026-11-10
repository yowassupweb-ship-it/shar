import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Folder } from 'lucide-react';
import { Sheet } from '@/shared/ui/overlay';
import { Spinner } from '@/shared/ui/Spinner';
import { showToast } from '@/shared/ui/Toast';
import { loadFolder, patchFolderCache, registerUpload, type CloudFolder } from './api';

/** Что сохраняем: адрес файла (вложение письма или чата), имя и, если известно, тип. */
export interface SaveSource { url: string; name: string; mimeType?: string }

/**
 * «Сохранить в Файлы»: выбираем папку облака (с заходом во вложенные) и кладём туда копию вложения — скачиваем его и
 * загружаем заново, так что у файла в «Файлах» своя жизнь: письмо или чат можно удалить, файл останется.
 */
export function SaveToFilesSheet({ source, onClose }: { source: SaveSource; onClose: () => void }) {
  const [trail, setTrail] = useState<CloudFolder[]>([]);
  const [loaded, setLoaded] = useState<{ at: string | null; folders: CloudFolder[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const here = trail[trail.length - 1]?.id ?? null;

  useEffect(() => {
    let alive = true;
    loadFolder(here)
      .then((d) => { if (alive) setLoaded({ at: here, folders: d.folders }); })
      .catch(() => { if (alive) setLoaded({ at: here, folders: [] }); });
    return () => { alive = false; };
  }, [here]);

  const folders = loaded && loaded.at === here ? loaded.folders : null;
  const place = trail[trail.length - 1]?.name || 'Мои файлы';

  const save = async () => {
    setBusy(true);
    try {
      const res = await fetch(new URL(source.url, window.location.href).href, { credentials: 'include' });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const file = new File([blob], source.name, { type: source.mimeType || blob.type });
      const { uploadFileWithProgress } = await import('@/shared/api/uploadFile');
      const uploaded = await uploadFileWithProgress(file, () => {});
      const saved = await registerUpload(file, uploaded, here);
      patchFolderCache(here, (d) => ({ ...d, files: [saved, ...d.files] }));
      showToast(`Сохранено в «${place}»`, 'success');
      onClose();
    } catch {
      showToast('Не сохранил — не удалось получить файл или нет связи с сервером.', 'error');
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={`Сохранить «${source.name}»`}
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button type="button" className="nx-ghost" onClick={onClose}>Отмена</button>
          <button type="button" className="nx-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Сохраняю' : `Сохранить в «${place}»`}</button>
        </>
      )}
    >
      <div className="nfs-trail">
        <button type="button" className="nx-icon-btn" disabled={!trail.length || busy} onClick={() => setTrail((t) => t.slice(0, -1))} aria-label="Назад">
          <ChevronLeft size={16} />
        </button>
        <span>{['Мои файлы', ...trail.map((f) => f.name)].join(' / ')}</span>
      </div>
      {folders === null ? (
        <div className="nx-state" aria-busy="true"><Spinner size={20} /></div>
      ) : !folders.length ? (
        <p className="nx-hint">Здесь нет вложенных папок — файл ляжет сюда.</p>
      ) : folders.map((f) => (
        <button key={f.id} type="button" className="nx-pick" disabled={busy} onClick={() => setTrail((t) => [...t, f])}>
          <Folder size={18} aria-hidden="true" style={f.color ? { color: f.color } : undefined} />
          <span className="nx-pick-text"><span>{f.name}</span></span>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      ))}
    </Sheet>
  );
}
