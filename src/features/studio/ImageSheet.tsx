import { useEffect, useState } from 'react';
import { BookmarkPlus, Download, Star, ThumbsDown, ThumbsUp, Trash2 } from 'lucide-react';
import { downloadOnClick } from '@/shared/platform/download';
import { askConfirm, Sheet } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { studioApi, type StudioImage, type StudioInsights, type StudioRef } from './api';

const fmt = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const SOURCE_LABEL: Record<StudioImage['source'], string> = { studio: 'Студия', chat: 'Нарисовал агент в чате «Ядра»', upload: 'Своё фото' };

/** Сведения о картинке: запрос, откуда, оценка с причиной, заметка, «в референсы», скачать, удалить. Оценка — то, чему учатся студия и агенты. */
export function ImageSheet({ image, refs, onClose, onChanged, onRemoved, onRefAdded }: {
  image: StudioImage; refs: StudioRef[]; onClose: () => void; onChanged: (image: StudioImage, insights?: StudioInsights) => void;
  onRemoved: () => void; onRefAdded: () => void;
}) {
  const [reason, setReason] = useState(image.reason);
  const [note, setNote] = useState(image.note);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setReason(image.reason); setNote(image.note); }, [image.id, image.reason, image.note]);
  const used = refs.filter((r) => image.refs.includes(r.id));

  const patch = async (change: Parameters<typeof studioApi.patchImage>[1]) => {
    setBusy(true);
    try { const got = await studioApi.patchImage(image.id, change); onChanged(got.image, got.insights); } catch (e) { showToast(e instanceof Error ? e.message : 'Не сохранилось', 'error'); } finally { setBusy(false); }
  };
  const rate = (value: 1 | -1) => void patch({ rating: image.rating === value ? 0 : value });
  const remove = async () => {
    if (!await askConfirm({ title: 'Удалить картинку из галереи?', text: 'Файл останется в «Файлах → Агенты», если он оттуда.', confirm: 'Удалить', tone: 'danger' })) return;
    try { await studioApi.deleteImage(image.id); onRemoved(); } catch (e) { showToast(e instanceof Error ? e.message : 'Не удалилось', 'error'); }
  };
  const makeRef = async () => {
    try { await studioApi.addRef({ imageId: image.id, kind: 'style' }); onRefAdded(); showToast('Добавлено в референсы', 'success'); } catch (e) { showToast(e instanceof Error ? e.message : 'Не добавилось', 'error'); }
  };

  return (
    <Sheet title="Сведения о картинке" onClose={onClose} busy={busy}>
      <div className="nst-detail">
        <img className="nst-detail-img" src={image.url} alt={image.prompt} />
        <div className="nst-actions">
          <button type="button" className="nst-act" aria-pressed={image.rating > 0} onClick={() => rate(1)}><ThumbsUp size={15} aria-hidden="true" /> Нравится</button>
          <button type="button" className="nst-act" aria-pressed={image.rating < 0} data-bad="" onClick={() => rate(-1)}><ThumbsDown size={15} aria-hidden="true" /> Не то</button>
          <button type="button" className="nst-act" aria-pressed={image.favorite} onClick={() => void patch({ favorite: !image.favorite })}><Star size={15} fill={image.favorite ? 'currentColor' : 'none'} aria-hidden="true" /> Избранное</button>
        </div>
        {image.rating < 0 && (
          <label className="nx-label">Что не так? <span className="nst-hint">Студия и агенты запомнят — и не повторят</span>
            <textarea className="nx-field" rows={2} value={reason} maxLength={400} placeholder="Слишком мрачно, лишние пальцы, не тот стиль…"
              onChange={(e) => setReason(e.target.value)} onBlur={() => { if (reason.trim() !== image.reason) void patch({ reason: reason.trim() }); }} />
          </label>
        )}
        <dl className="nst-meta">
          {image.prompt && <div><dt>Запрос</dt><dd>{image.prompt}<button type="button" className="nst-copy" onClick={() => { void navigator.clipboard?.writeText(image.prompt); showToast('Скопировано', 'success'); }}>Копировать</button></dd></div>}
          <div><dt>Откуда</dt><dd>{SOURCE_LABEL[image.source]}{image.model ? ` · ${image.model}` : ''}{image.aspect ? ` · ${image.aspect}` : ''} · {fmt(image.createdAt)}</dd></div>
          {used.length > 0 && <div><dt>Референсы</dt><dd>{used.map((r) => r.name).join(', ')}</dd></div>}
          {image.marks.length > 0 && <div><dt>Метки</dt><dd>{image.marks.map((m, i) => `${i + 1}) ${m.note || 'без пояснения'}`).join(' · ')}</dd></div>}
        </dl>
        <label className="nx-label">Заметка
          <input className="nx-field" value={note} maxLength={600} placeholder="Для себя: где использовали, что доработать" onChange={(e) => setNote(e.target.value)}
            onBlur={() => { if (note.trim() !== image.note) void patch({ note: note.trim() }); }} />
        </label>
        <div className="nst-foot">
          <button type="button" className="nx-ghost" onClick={() => void makeRef()}><BookmarkPlus size={14} aria-hidden="true" /> В референсы</button>
          <a className="nx-ghost" href={image.url} download={image.name || 'картинка.png'} target="_blank" rel="noopener noreferrer" onClick={downloadOnClick(image.url, image.name || 'картинка.png')}><Download size={14} aria-hidden="true" /> Скачать</a>
          <button type="button" className="nx-ghost" data-tone="danger" onClick={() => void remove()}><Trash2 size={14} aria-hidden="true" /> Удалить</button>
        </div>
      </div>
    </Sheet>
  );
}
