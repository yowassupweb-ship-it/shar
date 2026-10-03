import { Pin, Users } from 'lucide-react';
import { thumbUrl } from '@/shared/ui/media';
import { fileUrl, kindOf, type CloudFolder } from './api';
import { FileGlyph } from './FileGlyph';

/**
 * Папка-плитка, как в прежних «Файлах»: цветной квадрат, внутри — превью
 * содержимого. Есть фото — оно крупно справа, до трёх файлов столбиком слева;
 * только документы — сетка 3×3 значков; пусто — надпись «Пусто».
 */
export function FolderTile({ folder }: { folder: CloudFolder }) {
  const files = (folder.previewFiles || []).filter((p) => p.url);
  const empty = (folder.fileCount ?? files.length) === 0 || !files.length;
  const featured = files.find((p) => kindOf(p.name, p.fileType) === 'image');
  const others = featured ? files.filter((p) => p !== featured).slice(0, 3) : files.slice(0, 9);

  const cell = (p: (typeof files)[number] | undefined, i: number) => (
    <span key={i} className="nft-cell" data-empty={p ? undefined : 'true'}>
      {p && (kindOf(p.name, p.fileType) === 'image'
        ? <img src={thumbUrl(fileUrl(p.url), 48)} alt="" loading="lazy" decoding="async" draggable={false} />
        : <FileGlyph name={p.name} kind={kindOf(p.name, p.fileType)} size="xs" />)}
    </span>
  );

  return (
    <span className="nft" data-colored={folder.color ? 'true' : undefined}>
      {empty ? (
        <span className="nft-empty">Пусто</span>
      ) : featured ? (
        <span className="nft-featured">
          <span className="nft-col">{Array.from({ length: 3 }, (_, i) => cell(others[i], i))}</span>
          <img className="nft-hero" src={thumbUrl(fileUrl(featured.url), 120)} alt="" loading="lazy" decoding="async" draggable={false} />
        </span>
      ) : (
        <span className="nft-grid">{Array.from({ length: 9 }, (_, i) => cell(others[i], i))}</span>
      )}
      {folder.isPinned && <span className="nft-badge" data-pos="pin" aria-label="Закреплена"><Pin size={11} strokeWidth={2.4} /></span>}
      {(folder.sharedWith?.length || 0) > 0 && <span className="nft-badge" data-pos="shared" aria-label="Общая"><Users size={10} /></span>}
    </span>
  );
}
