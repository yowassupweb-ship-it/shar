import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Cloud, ExternalLink, FileSpreadsheet, FileText, Link2, NotebookPen, Paperclip, Presentation, Search, X } from 'lucide-react';
import { internalPath, links } from '@/shared/navigation/routes';
import { Sheet } from '@/shared/ui/overlay';
import { Spinner } from '@/shared/ui/Spinner';

/**
 * Вложения задачи: материалы «Офиса», файлы из «Файлов», файлы с компьютера и ссылки. Хранятся в metadata.attachments —
 * задача остаётся тем же объектом /api/todos, старый экран вложения просто не показывает.
 */

export type OfficeKind = 'note' | 'document' | 'table' | 'presentation';
export type Attachment =
  | { id: string; type: 'office'; itemId: string; kind: OfficeKind; title: string }
  | { id: string; type: 'cloud'; fileId: string; name: string; size?: number | null }
  | { id: string; type: 'file'; url: string; name: string; size?: number | null }
  | { id: string; type: 'link'; url: string; title: string };

export const newId = () => Math.random().toString(36).slice(2, 10);

export function attachmentsOf(metadata: Record<string, unknown> | undefined): Attachment[] {
  const list = metadata?.attachments;
  return Array.isArray(list) ? (list as Attachment[]).filter((a) => a && typeof a === 'object' && 'type' in a) : [];
}

const KIND: Record<OfficeKind, { label: string; icon: ReactNode }> = {
  note: { label: 'Заметка', icon: <NotebookPen size={16} /> },
  document: { label: 'Документ', icon: <FileText size={16} /> },
  table: { label: 'Таблица', icon: <FileSpreadsheet size={16} /> },
  presentation: { label: 'Презентация', icon: <Presentation size={16} /> },
};

const bytes = (n?: number | null) => (!n ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} КБ` : `${(n / 1048576).toFixed(1)} МБ`);
const host = (url: string) => { try { return new URL(url, window.location.origin).host; } catch { return ''; } };

/** Список вложений: щелчок — открыть (материал и файл из «Файлов» — внутри Шара), крестик — открепить. */
export function AttachmentList({ items, onRemove }: { items: Attachment[]; onRemove?: (id: string) => void }) {
  const navigate = useNavigate();
  if (!items.length) return null;
  const open = (a: Attachment) => {
    if (a.type === 'office') navigate(links.office(a.kind, a.itemId));
    else if (a.type === 'cloud') navigate(links.file(a.fileId));
    else {
      const inside = internalPath(a.url);
      if (inside) navigate(inside); else window.open(a.url, '_blank', 'noopener,noreferrer');
    }
  };
  return (
    <ul className="ntd-attachments" aria-label="Вложения">
      {items.map((a) => {
        const icon = a.type === 'office' ? KIND[a.kind].icon : a.type === 'cloud' ? <Cloud size={16} /> : a.type === 'file' ? <Paperclip size={16} /> : <Link2 size={16} />;
        const title = a.type === 'office' ? a.title || KIND[a.kind].label : a.type === 'link' ? a.title || a.url : a.name;
        const meta = a.type === 'office' ? KIND[a.kind].label : a.type === 'cloud' ? ['Файлы', bytes(a.size)].filter(Boolean).join(' · ') : a.type === 'file' ? bytes(a.size) : host(a.url);
        return (
          <li key={a.id} data-type={a.type}>
            <button type="button" className="ntd-attachment" onClick={() => open(a)} title={a.type === 'link' ? a.url : undefined}>
              <span className="ntd-attachment-icon" aria-hidden="true">{icon}</span>
              <span className="ntd-attachment-text"><b>{title}</b>{meta && <span>{meta}</span>}</span>
              {(a.type === 'link' || a.type === 'file') && <ExternalLink size={13} className="ntd-attachment-out" aria-hidden="true" />}
            </button>
            {onRemove && <button type="button" className="nx-icon-btn ntd-attachment-remove" onClick={() => onRemove(a.id)} aria-label={`Открепить «${title}»`} title="Открепить"><X size={14} /></button>}
          </li>
        );
      })}
    </ul>
  );
}

type OfficeHit = { id: string; kind: OfficeKind; title: string; snippet?: string; isOwner?: boolean; accessLevel?: string };
type CloudHit = { id: string; name: string; size?: number | null };

/** Выбор материала «Офиса» или файла из «Файлов»: поиск по названию (и тексту — у материалов). */
export function AttachPicker({ source, onPick, onClose }: { source: 'office' | 'cloud'; onPick: (a: Attachment, hit?: OfficeHit) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [office, setOffice] = useState<OfficeHit[] | null>(null);
  const [cloud, setCloud] = useState<CloudHit[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    const timer = window.setTimeout(async () => {
      try {
        if (source === 'office') {
          const res = await fetch(`/api/workspace/items?limit=40${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`, { cache: 'no-store' });
          const data = (await res.json()) as { items?: OfficeHit[] };
          if (alive) setOffice(data.items || []);
        } else {
          // Поиск по имени файла — тот же, что у сквозного поиска: с правами «Файлов».
          if (!q.trim()) { if (alive) setCloud([]); return; }
          const res = await fetch(`/api/search?limit=40&q=${encodeURIComponent(q.trim())}`, { cache: 'no-store' });
          const data = (await res.json()) as { files?: CloudHit[] };
          if (alive) setCloud(data.files || []);
        }
        if (alive) setFailed(false);
      } catch { if (alive) setFailed(true); }
    }, q ? 250 : 0);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [q, source]);

  const list = source === 'office' ? office : cloud;
  return (
    <Sheet title={source === 'office' ? 'Прикрепить материал из «Офиса»' : 'Прикрепить файл из «Файлов»'} onClose={onClose}>
      <label className="nx-field" data-variant="filter">
        <Search size={14} aria-hidden="true" />
        <span className="nx-sr">Найти</span>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} autoFocus autoComplete="off"
          placeholder={source === 'office' ? 'Название или слова из текста' : 'Имя файла'} />
      </label>
      {failed && <p className="nx-note" role="alert">Нет связи с сервером.</p>}
      {list === null ? <div className="nx-state"><Spinner size={18} label="Ищу" /></div>
        : !list.length ? <p className="nx-note">{source === 'cloud' && !q.trim() ? 'Введите имя файла.' : 'Ничего не нашлось.'}</p>
          : (
            <div className="ntd-pick-list">
              {source === 'office'
                ? (list as OfficeHit[]).map((h) => (
                  <button key={h.id} type="button" className="nx-pick" onClick={() => onPick({ id: newId(), type: 'office', itemId: h.id, kind: h.kind, title: h.title }, h)}>
                    <span className="ntd-attachment-icon" aria-hidden="true">{KIND[h.kind]?.icon}</span>
                    <span className="nx-pick-text"><span>{h.title || KIND[h.kind]?.label}</span><small>{[KIND[h.kind]?.label, h.snippet].filter(Boolean).join(' · ')}</small></span>
                  </button>
                ))
                : (list as CloudHit[]).map((h) => (
                  <button key={h.id} type="button" className="nx-pick" onClick={() => onPick({ id: newId(), type: 'cloud', fileId: String(h.id), name: h.name, size: h.size })}>
                    <span className="ntd-attachment-icon" aria-hidden="true"><Cloud size={16} /></span>
                    <span className="nx-pick-text"><span>{h.name}</span><small>{bytes(h.size)}</small></span>
                  </button>
                ))}
            </div>
          )}
    </Sheet>
  );
}

/** Ссылка: адрес и, по желанию, подпись. */
export function LinkSheet({ onAdd, onClose }: { onAdd: (a: Attachment) => void; onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim()) ? url.trim() : url.trim() ? `https://${url.trim()}` : '';
  const valid = (() => { try { return Boolean(normalized && new URL(normalized).host); } catch { return false; } })();
  const add = () => { if (valid) onAdd({ id: newId(), type: 'link', url: normalized, title: title.trim() }); };
  return (
    <Sheet title="Прикрепить ссылку" onClose={onClose} footer={(
      <>
        <button type="button" className="nx-ghost" onClick={onClose}>Отмена</button>
        <button type="button" className="nx-primary" disabled={!valid} onClick={add}>Прикрепить</button>
      </>
    )}>
      <div className="ntd-link-form">
        <label className="nx-label">Ссылка
          <input className="nx-field" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" autoFocus inputMode="url"
            onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        </label>
        <label className="nx-label">Подпись (необязательно)
          <input className="nx-field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например, «Договор в Яндекс.Диске»"
            onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        </label>
      </div>
    </Sheet>
  );
}
