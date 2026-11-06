import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  AlertCircle, BookmarkPlus, ChevronLeft, Download, ImagePlus, Images, Pencil, Plus, Sparkles, Star, ThumbsDown, ThumbsUp, Trash2, Wand2, X,
} from 'lucide-react';
import { paths } from '@/shared/navigation/routes';
import { downloadOnClick } from '@/shared/platform/download';
import { Switch } from '@/shared/ui/controls';
import { askConfirm, Sheet } from '@/shared/ui/overlay';
import { SearchField } from '@/shared/ui/SearchField';
import { Spinner } from '@/shared/ui/Spinner';
import { showToast } from '@/shared/ui/Toast';
import { studioApi, type StudioImage, type StudioInsights, type StudioRef, type StudioState } from './api';
import './studio.css';

/**
 * Студия картинок. Три вкладки:
 *  - «Создать»: запрос, формат, референсы и «учитывать мой вкус»; результат сразу можно оценить;
 *  - «Галерея»: всё нарисованное — здесь и агентами в чате «Ядра»; оценки 👍/👎 (с причиной) и избранное;
 *  - «Референсы»: загруженные примеры (стиль, персонаж, предмет, логотип) — подставляются в запрос и доступны агентам.
 * Оценки — то, чему агент учится: выводы о вкусе видны здесь же и уходят агентам в начало каждого запуска.
 */

type Tab = 'create' | 'gallery' | 'refs';
const TABS: Array<{ id: Tab; label: string }> = [{ id: 'create', label: 'Создать' }, { id: 'gallery', label: 'Галерея' }, { id: 'refs', label: 'Референсы' }];
const ASPECT_LABEL: Record<string, string> = { '': 'Авто', '1:1': '1:1', '4:5': '4:5', '3:4': '3:4', '4:3': '4:3', '16:9': '16:9', '9:16': '9:16' };
const ASPECTS = Object.keys(ASPECT_LABEL);
const fmt = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function StudioScreen() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('create');
  const [state, setState] = useState<StudioState | null>(null);
  const [error, setError] = useState('');
  // Что подставить в «Создать»: из галереи («Доработать») и из референсов («Использовать»).
  const [seed, setSeed] = useState<{ prompt?: string; parent?: StudioImage; refs?: string[]; nonce: number } | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    studioApi.load().then((s) => { setState(s); setError(''); }).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const patchLocal = (image: StudioImage, insights?: StudioInsights) => setState((s) => (s ? {
    ...s, images: s.images.map((x) => (x.id === image.id ? image : x)), insights: insights ?? s.insights,
  } : s));
  const prepend = (image: StudioImage) => setState((s) => (s ? { ...s, images: [image, ...s.images] } : s));
  const opened = state?.images.find((i) => i.id === open) ?? null;

  const refine = (image: StudioImage) => { setSeed({ prompt: image.prompt, parent: image, refs: image.refs, nonce: Date.now() }); setOpen(null); setTab('create'); };
  const useRef_ = (ref: StudioRef) => { setSeed({ refs: [ref.id], nonce: Date.now() }); setTab('create'); };

  return (
    <div className="nx-page nx-scroll-y">
      <div className="nx-page-inner" data-wide="">
        <header className="nx-page-head">
          <button type="button" className="nx-icon-btn nx-page-back" aria-label="Назад в «Ещё»" onClick={() => navigate(paths.more)}><ChevronLeft size={20} /></button>
          <h1>Студия</h1>
        </header>
        <nav className="nx-segment nst-tabs" aria-label="Разделы студии">
          {TABS.map((t) => (
            <button key={t.id} type="button" aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}{state && t.id === 'refs' && state.refs.length ? <span className="nst-count">{state.refs.length}</span> : null}
            </button>
          ))}
        </nav>

        {error ? (
          <div className="nx-state" data-tone="danger" role="alert"><AlertCircle size={24} aria-hidden="true" /><p>{error}</p></div>
        ) : !state ? (
          <div className="nx-state"><Spinner size={22} label="Открываю студию" /></div>
        ) : (
          <>
            {!state.hasKey && (
              <p className="nst-banner" role="status">
                Картинки рисует Gemini по вашему ключу Google. Подключите его: Настройки → Ядро → Gemini (ключ из AI Studio). Без него студия хранит
                галерею и референсы, но рисовать не сможет.
              </p>
            )}
            {tab === 'create' && <CreateTab state={state} seed={seed} onDone={prepend} onOpen={setOpen} onClearSeed={() => setSeed(null)} />}
            {tab === 'gallery' && <GalleryTab state={state} onOpen={setOpen} />}
            {tab === 'refs' && <RefsTab state={state} onChange={load} onUse={useRef_} />}
          </>
        )}
      </div>
      {opened && state && (
        <ImageSheet image={opened} refs={state.refs} onClose={() => setOpen(null)} onChanged={patchLocal} onRefine={refine}
          onRemoved={() => { setOpen(null); load(); }} onRefAdded={load} />
      )}
    </div>
  );
}

// ── Создать ─────────────────────────────────────────────────────────────────

function CreateTab({ state, seed, onDone, onOpen, onClearSeed }: {
  state: StudioState; seed: { prompt?: string; parent?: StudioImage; refs?: string[]; nonce: number } | null;
  onDone: (image: StudioImage) => void; onOpen: (id: string) => void; onClearSeed: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [aspect, setAspect] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [parent, setParent] = useState<StudioImage | null>(null);
  const [useStyle, setUseStyle] = useState(state.insights.rated > 0);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<StudioImage | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!seed) return;
    if (seed.prompt !== undefined) setPrompt(seed.prompt);
    if (seed.parent) { setParent(seed.parent); setAspect(seed.parent.aspect); }
    if (seed.refs?.length) setPicked((cur) => Array.from(new Set([...(seed.parent ? [] : cur), ...seed.refs!])).slice(0, 6));
    onClearSeed();
    area.current?.focus();
  }, [seed]); // eslint-disable-line react-hooks/exhaustive-deps

  const refById = useMemo(() => new Map(state.refs.map((r) => [r.id, r])), [state.refs]);
  const chosen = picked.map((id) => refById.get(id)).filter((r): r is StudioRef => Boolean(r));

  async function run() {
    if (busy || !prompt.trim()) return;
    setBusy(true);
    try {
      const got = await studioApi.generate({ prompt: prompt.trim(), aspect, refs: picked, parentId: parent?.id, useStyle });
      setLast(got.image);
      onDone(got.image);
      setParent(null);
      if (got.note) showToast(got.note.slice(0, 160), 'info');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не получилось нарисовать', 'error');
    } finally { setBusy(false); }
  }

  const recent = state.images.filter((i) => i.id !== last?.id).slice(0, 8);
  return (
    <div className="nst-create">
      <section className="nst-form" aria-label="Что нарисовать">
        {parent && (
          <div className="nst-parent">
            <img src={parent.url} alt="" />
            <span>Дорабатываем эту картинку: опишите, что изменить</span>
            <button type="button" className="nx-icon-btn" aria-label="Рисовать с нуля" onClick={() => setParent(null)}><X size={14} /></button>
          </div>
        )}
        <textarea ref={area} className="nst-prompt" value={prompt} rows={5} onChange={(e) => setPrompt(e.target.value)}
          placeholder={parent ? 'Что изменить: «сделай фон светлее», «добавь надпись…»' : 'Что нарисовать: сюжет, стиль, свет, текст на картинке'}
          aria-label="Запрос"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void run(); } }} />
        <div className="nst-chips" role="radiogroup" aria-label="Формат">
          {ASPECTS.map((a) => (
            <button key={a || 'auto'} type="button" role="radio" aria-checked={aspect === a} className="nst-chip" onClick={() => setAspect(a)}>{ASPECT_LABEL[a]}</button>
          ))}
        </div>
        <div className="nst-refbar">
          <span className="nst-label">Референсы{chosen.length ? ` · ${chosen.length}` : ''}</span>
          <div className="nst-refstrip">
            {chosen.map((r) => (
              <span key={r.id} className="nst-refchip" title={`${r.name} — ${r.kindLabel}`}>
                <img src={r.url} alt="" /><button type="button" aria-label={`Убрать референс ${r.name}`} onClick={() => setPicked((p) => p.filter((x) => x !== r.id))}><X size={11} /></button>
              </span>
            ))}
            {picked.length < 6 && (
              <button type="button" className="nst-add" onClick={() => setPickerOpen(true)} disabled={!state.refs.length} title={state.refs.length ? 'Выбрать из библиотеки' : 'Сначала добавьте референсы на вкладке «Референсы»'}>
                <Plus size={14} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
        <label className="nst-style">
          <span className="nx-row-text">
            <span className="nx-row-label">Учитывать мой вкус</span>
            <span className="nx-row-hint">{state.insights.rated ? `По ${state.insights.rated} вашим оценкам: что нравилось, чего избегать` : 'Оцените несколько картинок — студия запомнит вкус'}</span>
          </span>
          <Switch checked={useStyle} label="Учитывать мой вкус" onChange={setUseStyle} disabled={!state.insights.rated} />
        </label>
        <button type="button" className="nx-primary nst-go" disabled={busy || !prompt.trim() || !state.hasKey} onClick={() => void run()}>
          {busy ? <Spinner size={16} /> : <Sparkles size={16} aria-hidden="true" />} {busy ? 'Рисую… до минуты' : parent ? 'Доработать' : 'Нарисовать'}
        </button>
        <span className="nst-hint">Ctrl+Enter — нарисовать</span>
      </section>

      <section className="nst-stage" aria-label="Результат">
        {busy && !last ? <div className="nst-wait"><Spinner size={28} label="Рисую" /></div> : null}
        {last ? (
          <button type="button" className="nst-result" onClick={() => onOpen(last.id)} aria-label="Открыть картинку">
            <img src={last.url} alt={last.prompt} />
            {busy && <span className="nst-result-busy"><Spinner size={22} label="Рисую новую" /></span>}
          </button>
        ) : !busy && (
          <div className="nx-state"><Wand2 size={26} aria-hidden="true" /><p>Результат появится здесь. Оценивайте картинки — студия и агенты в чате запомнят, что вам нравится.</p></div>
        )}
        <Insights insights={state.insights} />
        {recent.length > 0 && (
          <>
            <h2 className="nst-sub">Недавнее</h2>
            <div className="nst-grid" data-dense="">
              {recent.map((i) => <Thumb key={i.id} image={i} onOpen={onOpen} />)}
            </div>
          </>
        )}
      </section>

      {pickerOpen && (
        <Sheet title="Референсы в запрос" onClose={() => setPickerOpen(false)}
          footer={<button type="button" className="nx-primary" onClick={() => setPickerOpen(false)}>Готово</button>}>
          <div className="nst-picker">
            {state.refs.map((r) => {
              const on = picked.includes(r.id);
              return (
                <button key={r.id} type="button" className="nst-pick" aria-pressed={on} onClick={() => setPicked((p) => (on ? p.filter((x) => x !== r.id) : [...p, r.id].slice(0, 6)))}>
                  <img src={r.url} alt="" /><span><b>{r.name}</b><small>{r.kindLabel}</small></span>
                </button>
              );
            })}
          </div>
        </Sheet>
      )}
    </div>
  );
}

function Insights({ insights }: { insights: StudioInsights }) {
  if (!insights.rated) return null;
  return (
    <aside className="nst-insights" aria-label="Что студия знает о вашем вкусе">
      <h2 className="nst-sub"><Sparkles size={14} aria-hidden="true" /> Что студия знает о вашем вкусе</h2>
      <ul>
        {insights.aspect && <li>Чаще нравится формат <b>{insights.aspect}</b>.</li>}
        {insights.liked.slice(0, 3).map((x, n) => <li key={`l${n}`}>Нравилось: «{x.prompt}»</li>)}
        {insights.avoid.slice(0, 3).map((x, n) => <li key={`a${n}`} data-bad="">Избегать: {x.reason}</li>)}
        {insights.favoriteRefs.length > 0 && <li>Любимые референсы: {insights.favoriteRefs.join(', ')}.</li>}
      </ul>
      <p className="nst-hint">Это же видят агенты в чате «Ядра»: рисуя для вас, они учитывают ваши оценки.</p>
    </aside>
  );
}

function Thumb({ image, onOpen }: { image: StudioImage; onOpen: (id: string) => void }) {
  return (
    <button type="button" className="nst-thumb" onClick={() => onOpen(image.id)} title={image.prompt} data-rating={image.rating || undefined}>
      <img src={image.url} alt={image.prompt} loading="lazy" />
      <span className="nst-badges">
        {image.favorite && <Star size={12} fill="currentColor" aria-label="В избранном" />}
        {image.rating > 0 && <ThumbsUp size={12} aria-label="Понравилось" />}
        {image.rating < 0 && <ThumbsDown size={12} aria-label="Не понравилось" />}
        {image.source === 'chat' && <Sparkles size={12} aria-label="Нарисовано агентом в чате" />}
      </span>
    </button>
  );
}

// ── Галерея ─────────────────────────────────────────────────────────────────

const GALLERY_FILTERS = [
  { id: 'all', label: 'Все' }, { id: 'liked', label: 'Понравились' }, { id: 'fav', label: 'Избранное' }, { id: 'chat', label: 'От агентов' }, { id: 'new', label: 'Без оценки' },
] as const;

function GalleryTab({ state, onOpen }: { state: StudioState; onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState<(typeof GALLERY_FILTERS)[number]['id']>('all');
  const [q, setQ] = useState('');
  const items = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return state.images.filter((i) => {
      if (filter === 'liked' && i.rating <= 0) return false;
      if (filter === 'fav' && !i.favorite) return false;
      if (filter === 'chat' && i.source !== 'chat') return false;
      if (filter === 'new' && i.rating !== 0) return false;
      const hay = `${i.prompt} ${i.name} ${i.note} ${i.tags.join(' ')}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [state.images, filter, q]);
  return (
    <>
      <div className="nst-bar">
        <nav className="nx-segment" aria-label="Фильтр">
          {GALLERY_FILTERS.map((f) => <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}
        </nav>
        <SearchField value={q} onChange={setQ} placeholder="Запрос, имя, метка" label="Поиск по галерее" />
      </div>
      {!items.length ? (
        <div className="nx-state"><Images size={26} aria-hidden="true" /><p>{state.images.length ? 'Ничего не нашлось.' : 'Здесь появится всё, что вы и агенты нарисуете.'}</p></div>
      ) : (
        <div className="nst-grid">{items.map((i) => <Thumb key={i.id} image={i} onOpen={onOpen} />)}</div>
      )}
    </>
  );
}

// ── Референсы ───────────────────────────────────────────────────────────────

function RefsTab({ state, onChange, onUse }: { state: StudioState; onChange: () => void; onUse: (ref: StudioRef) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<StudioRef | null>(null);
  const [kind, setKind] = useState('style');

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      const { uploadFileWithProgress } = await import('@/shared/api/uploadFile');
      for (const file of Array.from(files).slice(0, 10)) {
        if (!/^image\//.test(file.type)) { showToast(`«${file.name}» — не картинка`, 'error'); continue; }
        const up = await uploadFileWithProgress(file, () => undefined);
        await studioApi.addRef({ key: up.key, kind, name: file.name.replace(/\.[^.]+$/, '') });
      }
      onChange();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не загрузилось', 'error');
    } finally { setBusy(false); if (input.current) input.current.value = ''; }
  }

  return (
    <>
      <div className="nst-bar">
        <label className="nst-kindpick">Тип новых
          <select className="nx-field" value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(state.kinds).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <button type="button" className="nx-primary" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? <Spinner size={14} /> : <ImagePlus size={15} aria-hidden="true" />} Добавить картинки
        </button>
        <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => void upload(e.target.files)} />
      </div>
      <p className="nst-hint">Референс — пример: ваш стиль, герой, продукт, логотип, фон. Он прикладывается к запросу, а агенты в чате видят библиотеку и берут нужное сами.</p>
      {!state.refs.length ? (
        <div className="nx-state"><BookmarkPlus size={26} aria-hidden="true" /><p>Референсов пока нет. Добавьте несколько — рисовать «в вашем стиле» станет проще.</p></div>
      ) : (
        <div className="nst-grid nst-refgrid">
          {state.refs.map((r) => (
            <article key={r.id} className="nst-ref">
              <img src={r.url} alt={r.name} loading="lazy" />
              <div className="nst-ref-body">
                <b title={r.name}>{r.name}</b>
                <span className="nst-kind">{r.kindLabel}{r.uses ? ` · использован ${r.uses}` : ''}</span>
                {r.note && <p>{r.note}</p>}
                <div className="nst-ref-actions">
                  <button type="button" className="nx-ghost" onClick={() => onUse(r)}><Wand2 size={13} aria-hidden="true" /> Использовать</button>
                  <button type="button" className="nx-icon-btn" aria-label={`Изменить ${r.name}`} onClick={() => setEdit(r)}><Pencil size={14} /></button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      {edit && <RefSheet ref_={edit} kinds={state.kinds} onClose={() => setEdit(null)} onChanged={() => { setEdit(null); onChange(); }} />}
    </>
  );
}

function RefSheet({ ref_, kinds, onClose, onChanged }: { ref_: StudioRef; kinds: Record<string, string>; onClose: () => void; onChanged: () => void }) {
  const [name, setName] = useState(ref_.name);
  const [kind, setKind] = useState(ref_.kind);
  const [note, setNote] = useState(ref_.note);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await studioApi.patchRef(ref_.id, { name, kind, note }); onChanged(); } catch (e) { showToast(e instanceof Error ? e.message : 'Не сохранилось', 'error'); setBusy(false); }
  };
  const remove = async () => {
    if (!await askConfirm({ title: `Удалить референс «${ref_.name}»?`, confirm: 'Удалить', tone: 'danger' })) return;
    try { await studioApi.deleteRef(ref_.id); onChanged(); } catch (e) { showToast(e instanceof Error ? e.message : 'Не удалилось', 'error'); }
  };
  return (
    <Sheet title="Референс" onClose={onClose} busy={busy}
      footer={(<>
        <button type="button" className="nx-ghost" data-tone="danger" onClick={() => void remove()}><Trash2 size={15} aria-hidden="true" /> Удалить</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="nx-ghost" onClick={onClose}>Отмена</button>
        <button type="button" className="nx-primary" disabled={busy || !name.trim()} onClick={() => void save()}>Сохранить</button>
      </>)}>
      <div className="nst-edit">
        <img src={ref_.url} alt={ref_.name} />
        <label className="nx-label">Название<input className="nx-field" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></label>
        <label className="nx-label">Что это
          <select className="nx-field" value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(kinds).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <label className="nx-label">Пояснение для модели
          <textarea className="nx-field" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={600} placeholder="Например: «оранжевая палитра, плоская графика, без теней»" />
        </label>
      </div>
    </Sheet>
  );
}

// ── Картинка ────────────────────────────────────────────────────────────────

function ImageSheet({ image, refs, onClose, onChanged, onRefine, onRemoved, onRefAdded }: {
  image: StudioImage; refs: StudioRef[]; onClose: () => void; onChanged: (image: StudioImage, insights?: StudioInsights) => void;
  onRefine: (image: StudioImage) => void; onRemoved: () => void; onRefAdded: () => void;
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
    <Sheet title="Картинка" onClose={onClose} busy={busy}>
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
          <div><dt>Откуда</dt><dd>{image.source === 'chat' ? 'Нарисовал агент в чате «Ядра»' : 'Студия'}{image.model ? ` · ${image.model}` : ''}{image.aspect ? ` · ${image.aspect}` : ''} · {fmt(image.createdAt)}</dd></div>
          {used.length > 0 && <div><dt>Референсы</dt><dd>{used.map((r) => r.name).join(', ')}</dd></div>}
        </dl>
        <label className="nx-label">Заметка
          <input className="nx-field" value={note} maxLength={600} placeholder="Для себя: где использовали, что доработать" onChange={(e) => setNote(e.target.value)}
            onBlur={() => { if (note.trim() !== image.note) void patch({ note: note.trim() }); }} />
        </label>
        <div className="nst-foot">
          <button type="button" className="nx-primary" onClick={() => onRefine(image)}><Wand2 size={14} aria-hidden="true" /> Доработать</button>
          <button type="button" className="nx-ghost" onClick={() => void makeRef()}><BookmarkPlus size={14} aria-hidden="true" /> В референсы</button>
          <a className="nx-ghost" href={image.url} download={image.name || 'картинка.png'} target="_blank" rel="noopener noreferrer" onClick={downloadOnClick(image.url, image.name || 'картинка.png')}><Download size={14} aria-hidden="true" /> Скачать</a>
          <button type="button" className="nx-ghost" data-tone="danger" onClick={() => void remove()}><Trash2 size={14} aria-hidden="true" /> Удалить</button>
        </div>
      </div>
    </Sheet>
  );
}
