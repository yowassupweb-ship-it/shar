import { useEffect, useState } from 'react';
import { Folder, Link2 } from 'lucide-react';
import { showToast } from '@/shared/ui/Toast';
import { displayName, useChatStore } from '@/features/chat';
import { Sheet } from '@/shared/ui/overlay';
import { absolute, links } from '@/shared/navigation/routes';
import { fetchImageDims, fileUrl, fmtBytes, folderChain, kindOf, myId, type CloudFile, type CloudFolder, type Kind } from './api';
import { FileGlyph } from './FileGlyph';
import { useInheritedAccess } from './inherited';

const KIND_LABEL: Record<Kind, string> = {
  image: 'Изображение', video: 'Видео', audio: 'Аудио', doc: 'Документ', sheet: 'Таблица', slides: 'Презентация', pdf: 'PDF-документ',
  archive: 'Архив', code: 'Код и данные', file: 'Файл',
};

const exactDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const when = (iso?: string | null) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? exactDate.format(d) : '—';
};

/** «5,2 МБ (5 452 118 Б)»: точное число нужно, когда сравнивают файлы или проверяют лимиты почты. */
const sizeLine = (bytes?: number | null) => (bytes ? `${fmtBytes(bytes)} (${new Intl.NumberFormat('ru-RU').format(bytes)} Б)` : '—');

const ACCESS_LABEL = { view: 'Просмотр', edit: 'Редактирование' } as const;

const plural = (n: number) => (n === 1 ? 'элемент' : n > 1 && n < 5 ? 'элемента' : 'элементов');

/**
 * «Свойства» файла или папки: что это, где лежит, сколько весит, кто владелец, когда создан и менялся, кому открыт.
 * Всё берётся из того, что раздел уже знает; путь и разрешение картинки догружаются.
 */
export function PropertiesSheet({ item, kind, onClose }: { item: CloudFile | CloudFolder; kind: 'file' | 'folder'; onClose: () => void }) {
  const users = useChatStore((s) => s.users);
  const [path, setPath] = useState<string | null>(null);
  const [dims, setDims] = useState<[number, number] | null>(null);
  const file = kind === 'file' ? (item as CloudFile) : null;
  const folder = kind === 'folder' ? (item as CloudFolder) : null;
  const parent = file ? file.folderId : folder!.parentId;
  const k: Kind = file ? kindOf(file.name, file.fileType, file.mimeType) : 'file';

  useEffect(() => {
    let alive = true;
    if (!parent) { setPath('Мои файлы'); return undefined; }
    void folderChain(parent).then((chain) => { if (alive) setPath(['Мои файлы', ...chain.map((f) => f.name)].join(' / ')); });
    return () => { alive = false; };
  }, [parent]);

  useEffect(() => {
    if (!file || k !== 'image') return undefined;
    let alive = true;
    void fetchImageDims([file.id]).then((got) => { if (alive && got[file.id]?.[0]) setDims(got[file.id]); });
    return () => { alive = false; };
  }, [file, k]);

  const inherited = useInheritedAccess(parent);
  const owner = users[String(item.ownerId)];
  const ownerName = String(item.ownerId) === myId() ? 'Вы' : owner ? displayName(owner) : '—';
  // Свой доступ и доступ от папок выше: открытая папка открывает и всё внутри, поэтому он тут тоже виден.
  const own = new Set((item.editAccess || []).map(String));
  const people = [...new Set([...(item.sharedWith || []).map(String), ...own, ...Object.keys(inherited.view)])].filter((id) => id !== String(item.ownerId));
  const levelOf = (id: string) => (own.has(id) || id in inherited.edit ? 'edit' : 'view');
  const viaOf = (id: string) => (!(item.sharedWith || []).map(String).includes(id) && !own.has(id) ? inherited.view[id] : undefined);
  const ext = file && file.name.includes('.') ? (file.name.split('.').pop() || '').toUpperCase() : '';

  const rows: Array<[string, string]> = [];
  if (file) {
    rows.push(['Тип', ext ? `${KIND_LABEL[k]} · ${ext}` : KIND_LABEL[k]]);
    rows.push(['Размер', sizeLine(file.size)]);
    if (dims) rows.push(['Разрешение', `${dims[0]} × ${dims[1]} пикс.`]);
    if (file.mimeType) rows.push(['MIME-тип', file.mimeType]);
  } else {
    rows.push(['Тип', 'Папка']);
    if (typeof folder!.fileCount === 'number') rows.push(['Содержимое', `${folder!.fileCount} ${plural(folder!.fileCount)}`]);
  }
  rows.push(['Расположение', path ?? '…']);
  rows.push(['Владелец', ownerName]);
  rows.push(['Создан', when(item.createdAt)]);
  rows.push(['Изменён', when(item.updatedAt)]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(absolute(file ? links.file(item.id) : links.folder(item.id)));
      showToast('Ссылка скопирована', 'success');
    } catch { showToast('Не удалось скопировать ссылку', 'error'); }
  };

  return (
    <Sheet
      title="Свойства"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="nx-ghost" onClick={() => void copyLink()}><Link2 size={14} aria-hidden="true" /> Копировать ссылку</button>
          <button type="button" className="nx-primary" onClick={onClose}>Готово</button>
        </>
      )}
    >
      <div className="nfs-props">
        <div className="nfs-props-head">
          <span className="nfs-props-icon">
            {file
              ? (k === 'image' ? <img src={fileUrl(file.url)} alt="" decoding="async" draggable={false} /> : <FileGlyph name={file.name} kind={k} size="lg" />)
              : <Folder size={40} aria-hidden="true" style={folder!.color ? { color: folder!.color } : undefined} />}
          </span>
          <span className="nfs-props-name">{item.name}</span>
        </div>
        <dl className="nfs-props-list">
          {rows.map(([label, value]) => (<div key={label}><dt>{label}</dt><dd>{value}</dd></div>))}
          <div>
            <dt>Доступ</dt>
            <dd>
              {people.length === 0 ? 'Только владелец' : people.map((id) => {
                const u = users[id];
                return <span key={id} className="nfs-props-person">{u ? displayName(u) : 'Сотрудник'} <small>{ACCESS_LABEL[levelOf(id)]}{viaOf(id) ? ` · от папки «${viaOf(id)}»` : ''}</small></span>;
              })}
            </dd>
          </div>
        </dl>
      </div>
    </Sheet>
  );
}
