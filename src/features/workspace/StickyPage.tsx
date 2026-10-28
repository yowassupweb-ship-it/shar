import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ExternalLink, List, Minus, Pin, PinOff, Plus, StickyNote, X } from 'lucide-react';
import { links } from '@/shared/navigation/routes';
import LinkChooserHost from '@/shared/navigation/LinkChooser';
import { installInternalLinks, officeItemOf, setLinkRouter } from '@/shared/navigation/internalLinks';
import { useSession, verifySession } from '@/shared/session/session';
import { realtime } from '@/shared/realtime/realtime';
import ToastContainer, { showToast } from '@/shared/ui/Toast';
import { workspaceApi } from './api';
import { KINDS } from './kinds';
import { NoteEditor } from './editors/NoteEditor';
import type { Item } from './types';
import { stickyBridge } from './lib/sticky';
import { useItemSession } from './useItemSession';
import { Spinner } from '@/shared/ui/Spinner';
import './workspace.css';

// Документ и таблица в отдельном окне — те же редакторы, что в «Офисе»; грузятся, только когда окно открыто.
const DocEditor = lazy(() => import('./editors/DocEditor'));
const SheetEditor = lazy(() => import('./editors/SheetEditor'));

/**
 * Окно материала на рабочем столе (/sticky/<id>): окно без рамки поверх рабочего стола — цветная шапка, правка на месте,
 * сохранение на сервер. Заметка — маленькое окно (со списком заметок, куда можно вернуться, и «+» для новой такого же
 * размера), документ и таблица — рабочее окно с тем же редактором, что в «Офисе». Это тот же материал: правки видны и в
 * списке, и у коллег, а чужие правки подтягиваются сюда сами (useItemSession). Окно создаёт главный процесс приложения.
 */

export default function StickyPage() {
  const { id = '' } = useParams();
  const { status, me } = useSession();
  const navigate = useNavigate();

  // Своё соединение окна с сервером. Совместная правка таблицы и документа шлёт и принимает правки по сокету; без него
  // окно видело чужие правки только через мост главного процесса и само ничего не отправляло — документ в окне и в Шаре
  // расходились, а в шапке висело «Сохраняю…». Окно — такой же участник правки, как и любой другой экран.
  const userId = me ? String(me.id) : '';
  useEffect(() => (userId ? realtime.start(userId) : undefined), [userId]);

  // Ссылки на Шар в окне материала: простой клик — в главном окне Шара, Ctrl/⌘+клик спрашивает «здесь или в новом окне».
  // «Здесь» — это окно становится окном того материала (его размер и закрепление переходят на новый адрес).
  useEffect(() => {
    const bridge = stickyBridge();
    const showHere = async (path: string) => {
      const item = officeItemOf(path);
      if (!item || !bridge) { void bridge?.focusMain(path); return; }
      let kind = item.kind;
      if (!kind || !['note', 'document', 'table'].includes(kind)) {
        try {
          const found = await fetch(`/api/workspace/items/${encodeURIComponent(item.id)}`, { cache: 'no-store' }).then((r) => r.json());
          kind = String(found?.item?.kind || '');
        } catch { kind = null; }
      }
      if (!kind || !['note', 'document', 'table'].includes(kind)) { void bridge.focusMain(path); return; }
      const result = await bridge.switchTo(item.id, kind);
      if (!result.focusedExisting) navigate(`/sticky/${encodeURIComponent(item.id)}`, { replace: true });
    };
    setLinkRouter({ here: (path) => void showHere(path), plain: (path) => void bridge?.focusMain(path) });
    const stop = installInternalLinks();
    return () => { stop(); setLinkRouter(null); };
  }, [navigate]);

  useEffect(() => {
    document.documentElement.classList.add('is-sticky');
    void verifySession();
    // Вошли в главном окне — окно заметки подхватывает вход, когда на него возвращаются.
    const recheck = () => { void verifySession(); };
    window.addEventListener('focus', recheck);
    return () => { window.removeEventListener('focus', recheck); document.documentElement.classList.remove('is-sticky'); };
  }, []);

  return (
    <div className="nx nws-sticky">
      {status === 'checking' ? null : me ? <ItemWindow id={id} /> : <SignedOut />}
      <ToastContainer />
      <LinkChooserHost />
    </div>
  );
}

function SignedOut() {
  const bridge = stickyBridge();
  return (
    <>
      <header className="nws-sticky-head"><span className="nws-sticky-fill" /><button type="button" className="nws-sticky-btn" onClick={() => void bridge?.close()} aria-label="Закрыть"><X size={16} /></button></header>
      <div className="nws-sticky-empty">
        <StickyNote size={28} aria-hidden="true" />
        <b>Войдите в Шар</b>
        <span>Заметки на рабочем столе работают после входа в основном окне.</span>
        <button type="button" className="nx-ghost" onClick={() => void bridge?.focusMain()}>Открыть Шар</button>
      </div>
    </>
  );
}

/**
 * Название — обычный текст ровно по ширине слов; вся остальная шапка остаётся «ручкой» для перетаскивания окна.
 * Переименовать — двойным щелчком по самому тексту (Enter — сохранить, Esc — отмена).
 */
function Title({ value, editable, onSave }: { value: string; editable: boolean; onSave: (next: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const done = (save: boolean) => {
    setEditing(false);
    if (save && draft !== value) onSave(draft.slice(0, 200));
  };
  if (editing) {
    return (
      <input
        className="nws-sticky-title is-editing"
        value={draft}
        maxLength={200}
        autoFocus
        aria-label="Название"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => done(true)}
        onKeyDown={(e) => { if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); }}
        onFocus={(e) => e.currentTarget.select()}
      />
    );
  }
  return (
    <span
      className="nws-sticky-title"
      title={editable ? 'Двойной щелчок — переименовать' : undefined}
      onDoubleClick={() => { if (editable) { setDraft(value); setEditing(true); } }}
    >{value || 'Без заголовка'}</span>
  );
}

const WINDOW_TITLE: Record<string, string> = { note: 'Заметка', document: 'Документ', table: 'Таблица' };

/** Список заметок внутри окна заметки: вернуться к нему можно из любой заметки, выбрать — окно покажет её. */
function NoteList({ currentId, onPick }: { currentId: string; onPick: (id: string) => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    let alive = true;
    workspaceApi.list('note', '', false, 200).then((list) => { if (alive) setItems(list); }).catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить заметки'); });
    return () => { alive = false; };
  }, []);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items || []).filter((item) => !q || `${item.title} ${item.snippet || ''}`.toLowerCase().includes(q));
  }, [items, query]);
  return (
    <div className="nws-sticky-list">
      <input className="nws-sticky-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти заметку" aria-label="Найти заметку" />
      {error && <p className="nws-sticky-state" role="alert">{error}</p>}
      {!items && !error && <div className="nws-sticky-state"><Spinner size={20} label="Загружаю заметки" /></div>}
      {items && !shown.length && <p className="nws-sticky-state">{query ? 'Ничего не нашлось' : 'Заметок пока нет — нажмите «+»'}</p>}
      <ul>
        {shown.map((item) => (
          <li key={item.id}>
            <button type="button" className="nws-sticky-row" data-color={item.meta?.color || 'default'} aria-current={item.id === currentId ? 'true' : undefined} onClick={() => onPick(String(item.id))}>
              <span className="nws-sticky-dot" aria-hidden="true" />
              <span className="nws-sticky-row-text"><b>{item.title || 'Без заголовка'}</b><span>{item.snippet || ''}</span></span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ItemWindow({ id }: { id: string }) {
  const session = useItemSession({ id });
  const { item, status, error } = session;
  const bridge = stickyBridge();
  const navigate = useNavigate();
  const [onTop, setOnTop] = useState(false);
  const [listing, setListing] = useState(false);
  useEffect(() => { void bridge?.state().then((state) => setOnTop(state.onTop)); }, [bridge]);
  useEffect(() => { setListing(false); }, [id]);
  const kind = item?.kind ?? 'note';
  useEffect(() => { if (item) document.title = item.title || WINDOW_TITLE[kind] || 'Шар'; }, [item?.title, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const isNote = kind === 'note';
  const gone = status === 'missing';

  // Выбрали заметку из списка: окно (его место и размер) переходит на неё. Уже открыта в другом окне — показываем то.
  const pick = async (noteId: string) => {
    if (noteId === id) { setListing(false); return; }
    const result = await bridge?.switchTo(noteId, 'note');
    if (result?.focusedExisting) return;
    navigate(`/sticky/${encodeURIComponent(noteId)}`, { replace: true });
  };
  // «+» — новая заметка в новом окне того же размера, что это.
  const addNote = async () => {
    try {
      const created = await workspaceApi.create({ kind: 'note', title: '', content: '' });
      await bridge?.open(String(created.id), null, { kind: 'note', width: window.innerWidth, height: window.innerHeight });
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : 'Не удалось создать заметку', 'error');
    }
  };

  const info = isNote ? null : KINDS[kind as 'document' | 'table'];
  const saveText = session.state === 'error' ? 'Не сохранилось' : session.state === 'saved' ? 'Сохранено' : 'Сохраняю…';
  const openInShar = () => void bridge?.focusMain(links.office(kind as 'note' | 'document' | 'table', id));
  return (
    <section className="nws-sticky-note" data-kind={kind} data-color={item?.meta.color || 'default'}>
      <header className="nws-sticky-head">
        {isNote && (
          <button type="button" className="nws-sticky-btn" aria-pressed={listing} title={listing ? 'Вернуться к заметке' : 'Список заметок'} aria-label="Список заметок" onClick={() => setListing((v) => !v)}><List size={15} /></button>
        )}
        {info && <span className="nws-kind-icon nws-sticky-logo" style={{ '--a': info.tint[0], '--b': info.tint[1] } as React.CSSProperties} aria-hidden="true"><info.icon size={14} /></span>}
        {listing ? <span className="nws-sticky-title">Заметки</span> : <Title value={item?.title ?? ''} editable={Boolean(item?.canEdit)} onSave={session.setTitle} />}
        <span className="nws-sticky-fill" />
        {!isNote && item && <span className="nws-sticky-status" data-state={session.state} role="status" title={saveText}>{saveText}</span>}
        {isNote && <button type="button" className="nws-sticky-btn" title="Новая заметка (такого же размера)" aria-label="Новая заметка" onClick={() => void addNote()}><Plus size={16} /></button>}
        <button type="button" className="nws-sticky-btn" aria-pressed={onTop} title={onTop ? 'Не держать поверх окон' : 'Держать поверх всех окон'} aria-label="Поверх всех окон"
          onClick={() => void bridge?.setOnTop().then(setOnTop)}>{onTop ? <PinOff size={15} /> : <Pin size={15} />}</button>
        <button type="button" className="nws-sticky-btn" title="Открыть в Шаре" aria-label="Открыть в Шаре" onClick={openInShar}><ExternalLink size={15} /></button>
        <button type="button" className="nws-sticky-btn" title="Свернуть" aria-label="Свернуть" onClick={() => void bridge?.minimize()}><Minus size={16} /></button>
        <button type="button" className="nws-sticky-btn" title={`Закрыть окно (${isNote ? 'заметка' : 'материал'} останется в Офисе)`} aria-label="Закрыть" onClick={() => void bridge?.close()}><X size={16} /></button>
      </header>
      <div className="nws-sticky-body">
        {listing && <NoteList currentId={id} onPick={(noteId) => void pick(noteId)} />}
        {!listing && status === 'loading' && <div className="nws-sticky-state"><Spinner size={22} label="Открываю" /></div>}
        {!listing && gone && <p className="nws-sticky-state" role="alert">Материал удалён или у вас нет доступа.</p>}
        {!listing && status === 'error' && <p className="nws-sticky-state" role="alert">{error || 'Не удалось открыть.'} <button type="button" className="nx-ghost" onClick={() => void session.reload()}>Повторить</button></p>}
        {!listing && item && isNote && <NoteEditor content={item.content} onContent={session.setContent} readOnly={!item.canEdit} loadKey={session.loadKey} title={item.title} visible />}
        {!listing && item && (kind === 'document' || kind === 'table') && (
          <Suspense fallback={<div className="nws-sticky-state"><Spinner size={22} label="Загружаю редактор" /></div>}>
            {kind === 'document'
              ? <DocEditor content={item.content} onContent={session.setContent} readOnly={!item.canEdit} loadKey={session.loadKey} title={item.title} visible live={session.live} />
              : <SheetEditor content={item.content} onContent={session.setContent} readOnly={!item.canEdit} loadKey={session.loadKey} title={item.title} visible live={session.live} />}
          </Suspense>
        )}
        {!listing && item && kind === 'presentation' && (
          <div className="nws-sticky-empty"><b>Презентации открываются в Шаре</b><button type="button" className="nx-ghost" onClick={openInShar}>Открыть в Шаре</button></div>
        )}
      </div>
      {item && !listing && isNote && <footer className="nws-sticky-foot">{session.state === 'error' ? <span className="is-error">Не сохранилось</span> : session.state === 'saved' ? 'Сохранено' : 'Сохраняю…'}</footer>}
    </section>
  );
}
