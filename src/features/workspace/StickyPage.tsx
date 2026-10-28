import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { ExternalLink, List, Minus, Pin, PinOff, Plus, StickyNote, X } from 'lucide-react';
import { links } from '@/shared/navigation/routes';
import LinkChooserHost from '@/shared/navigation/LinkChooser';
import { installInternalLinks, officeItemOf, setLinkRouter } from '@/shared/navigation/internalLinks';
import { useSession, verifySession } from '@/shared/session/session';
import { realtime } from '@/shared/realtime/realtime';
import { boot as bootChats, shutdown as shutdownChats } from '@/features/chat';
import type { User } from '@/shared/types/chat';
import ToastContainer, { showToast } from '@/shared/ui/Toast';
import { workspaceApi } from './api';
import { ItemView } from './ItemView';
import { NoteEditor } from './editors/NoteEditor';
import type { Item } from './types';
import { stickyBridge } from './lib/sticky';
import { useItemSession } from './useItemSession';
import { Spinner } from '@/shared/ui/Spinner';
import './workspace.css';
import './office-apple.css';


/**
 * Окно материала на рабочем столе (/sticky/<id>): окно без рамки поверх рабочего стола — цветная шапка, правка на месте,
 * сохранение на сервер. Заметка — маленькое окно (со списком заметок, куда можно вернуться, и «+» для новой такого же
 * размера), документ и таблица — рабочее окно: та же шапка (импорт, доступ, скачать, история…) и редактор, что в «Офисе». Это тот же материал: правки видны и в
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
      if (!result.focusedExisting) navigate(`/sticky/${encodeURIComponent(item.id)}?kind=${kind}`, { replace: true });
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
      {status === 'checking' ? null : me ? <Window id={id} /> : <SignedOut />}
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

/** Кнопки окна без рамки: поверх всех окон, открыть в Шаре, свернуть, закрыть. Общие для окна заметки и окна «Офиса». */
function WindowButtons({ kind, id, onTop, setOnTop }: { kind: string; id: string; onTop: boolean; setOnTop: (v: boolean) => void }) {
  const bridge = stickyBridge();
  return (
    <>
      <button type="button" className="nws-sticky-btn" aria-pressed={onTop} title={onTop ? 'Не держать поверх окон' : 'Держать поверх всех окон'} aria-label="Поверх всех окон"
        onClick={() => void bridge?.setOnTop().then(setOnTop)}>{onTop ? <PinOff size={15} /> : <Pin size={15} />}</button>
      <button type="button" className="nws-sticky-btn" title="Открыть в Шаре" aria-label="Открыть в Шаре" onClick={() => void bridge?.focusMain(links.office(kind as 'note' | 'document' | 'table', id))}><ExternalLink size={15} /></button>
      <button type="button" className="nws-sticky-btn" title="Свернуть" aria-label="Свернуть" onClick={() => void bridge?.minimize()}><Minus size={16} /></button>
      <button type="button" className="nws-sticky-btn" title="Закрыть окно (материал останется в Офисе)" aria-label="Закрыть" onClick={() => void bridge?.close()}><X size={16} /></button>
    </>
  );
}

/** Какое окно рисовать: вид материала приходит в адресе (?kind=…). Заметка — своё маленькое окно, остальное — «Офис». */
function Window({ id }: { id: string }) {
  const [params] = useSearchParams();
  const kind = params.get('kind') || 'note';
  return kind === 'document' || kind === 'table' ? <OfficeWindow key={id} id={id} kind={kind} /> : <NoteWindow key={id} id={id} />;
}

/** Документ и таблица в своём окне: вся шапка и редактор «Офиса» (ItemView), плюс кнопки окна справа. */
function OfficeWindow({ id, kind }: { id: string; kind: string }) {
  const bridge = stickyBridge();
  const { me } = useSession();
  // «Отправить в чат» и «Поделиться» берут чаты и людей из хранилища чатов, а оно поднимается только в главном окне —
  // без него в окне нечего было выбирать («Ничего не нашлось»). Поднимаем и здесь, пока окно документа открыто.
  useEffect(() => {
    if (!me) return undefined;
    bootChats(me as unknown as User);
    return () => shutdownChats();
  }, [me]);
  const [onTop, setOnTop] = useState(false);
  useEffect(() => { void bridge?.state().then((state) => setOnTop(state.onTop)); }, [bridge]);
  return (
    <section className="nws-sticky-item" data-kind={kind}>
      <ItemView
        source={{ id }}
        onDeleted={() => void bridge?.forget(id)}
        onOpen={(copyId, copyKind) => { void bridge?.open(copyId, null, { kind: copyKind }); }}
        windowControls={<span className="nws-sticky-window"><WindowButtons kind={kind} id={id} onTop={onTop} setOnTop={setOnTop} /></span>}
      />
    </section>
  );
}

function NoteWindow({ id }: { id: string }) {
  const session = useItemSession({ id });
  const { item, status, error } = session;
  const bridge = stickyBridge();
  const navigate = useNavigate();
  const [onTop, setOnTop] = useState(false);
  const [listing, setListing] = useState(false);
  useEffect(() => { void bridge?.state().then((state) => setOnTop(state.onTop)); }, [bridge]);
  useEffect(() => { document.title = item?.title || 'Заметка'; }, [item?.title]);
  // Адрес без вида, а материал — документ или таблица (старая ссылка, перезапуск): переоткрываем как рабочее окно.
  useEffect(() => {
    if (item && (item.kind === 'document' || item.kind === 'table')) {
      void bridge?.switchTo(id, item.kind);
      navigate(`/sticky/${encodeURIComponent(id)}?kind=${item.kind}`, { replace: true });
    }
  }, [item?.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const gone = status === 'missing';
  // Выбрали заметку из списка: окно (его место и размер) переходит на неё. Уже открыта в другом окне — показываем то.
  const pick = async (noteId: string) => {
    if (noteId === id) { setListing(false); return; }
    const result = await bridge?.switchTo(noteId, 'note');
    if (result?.focusedExisting) return;
    navigate(`/sticky/${encodeURIComponent(noteId)}?kind=note`, { replace: true });
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

  return (
    <section className="nws-sticky-note" data-kind="note" data-color={item?.meta.color || 'default'}>
      <header className="nws-sticky-head">
        <button type="button" className="nws-sticky-btn" aria-pressed={listing} title={listing ? 'Вернуться к заметке' : 'Список заметок'} aria-label="Список заметок" onClick={() => setListing((v) => !v)}><List size={15} /></button>
        {listing ? <span className="nws-sticky-title">Заметки</span> : <Title value={item?.title ?? ''} editable={Boolean(item?.canEdit)} onSave={session.setTitle} />}
        <span className="nws-sticky-fill" />
        <button type="button" className="nws-sticky-btn" title="Новая заметка (такого же размера)" aria-label="Новая заметка" onClick={() => void addNote()}><Plus size={16} /></button>
        <WindowButtons kind="note" id={id} onTop={onTop} setOnTop={setOnTop} />
      </header>
      <div className="nws-sticky-body">
        {listing && <NoteList currentId={id} onPick={(noteId) => void pick(noteId)} />}
        {!listing && status === 'loading' && <div className="nws-sticky-state"><Spinner size={22} label="Открываю" /></div>}
        {!listing && gone && <p className="nws-sticky-state" role="alert">Заметка удалена или у вас нет доступа.</p>}
        {!listing && status === 'error' && <p className="nws-sticky-state" role="alert">{error || 'Не удалось открыть.'} <button type="button" className="nx-ghost" onClick={() => void session.reload()}>Повторить</button></p>}
        {!listing && item && item.kind === 'note' && <NoteEditor content={item.content} onContent={session.setContent} readOnly={!item.canEdit} loadKey={session.loadKey} title={item.title} visible />}
      </div>
      {item && !listing && <footer className="nws-sticky-foot">{session.state === 'error' ? <span className="is-error">Не сохранилось</span> : session.state === 'saved' ? 'Сохранено' : 'Сохраняю…'}</footer>}
    </section>
  );
}
