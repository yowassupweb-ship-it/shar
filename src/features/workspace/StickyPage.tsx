import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { ExternalLink, Minus, Pin, PinOff, StickyNote, X } from 'lucide-react';
import { links } from '@/shared/navigation/routes';
import { useSession, verifySession } from '@/shared/session/session';
import ToastContainer from '@/shared/ui/Toast';
import { NoteEditor } from './editors/NoteEditor';
import { stickyBridge } from './lib/sticky';
import { useItemSession } from './useItemSession';
import { Spinner } from '@/shared/ui/Spinner';
import './workspace.css';

/**
 * Окно заметки на рабочем столе (/sticky/<id>): маленькое окно без рамки поверх рабочего стола — цветная шапка,
 * правка на месте, сохранение на сервер. Это та же заметка «Офиса»: правки видны и в списке, и у коллег, а чужие
 * правки подтягиваются сюда сами (useItemSession). Окно создаёт главный процесс приложения для компьютера.
 */

export default function StickyPage() {
  const { id = '' } = useParams();
  const { status, me } = useSession();

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
      {status === 'checking' ? null : me ? <Note id={id} /> : <SignedOut />}
      <ToastContainer />
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

function Note({ id }: { id: string }) {
  const session = useItemSession({ id });
  const { item, status, error } = session;
  const bridge = stickyBridge();
  const [onTop, setOnTop] = useState(false);
  useEffect(() => { void bridge?.state().then((state) => setOnTop(state.onTop)); }, [bridge]);
  useEffect(() => { if (item) document.title = item.title || 'Заметка'; }, [item?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  const gone = status === 'missing';
  return (
    <section className="nws-sticky-note" data-color={item?.meta.color || 'default'}>
      <header className="nws-sticky-head">
        <Title value={item?.title ?? ''} editable={Boolean(item?.canEdit)} onSave={session.setTitle} />
        <span className="nws-sticky-fill" />
        <button type="button" className="nws-sticky-btn" aria-pressed={onTop} title={onTop ? 'Не держать поверх окон' : 'Держать поверх всех окон'} aria-label="Поверх всех окон"
          onClick={() => void bridge?.setOnTop().then(setOnTop)}>{onTop ? <PinOff size={15} /> : <Pin size={15} />}</button>
        <button type="button" className="nws-sticky-btn" title="Открыть в Шаре" aria-label="Открыть в Шаре" onClick={() => void bridge?.focusMain(links.office('note', id))}><ExternalLink size={15} /></button>
        <button type="button" className="nws-sticky-btn" title="Свернуть" aria-label="Свернуть" onClick={() => void bridge?.minimize()}><Minus size={16} /></button>
        <button type="button" className="nws-sticky-btn" title="Закрыть окно (заметка останется в Офисе)" aria-label="Закрыть" onClick={() => void bridge?.close()}><X size={16} /></button>
      </header>
      <div className="nws-sticky-body">
        {status === 'loading' && <div className="nws-sticky-state"><Spinner size={22} label="Открываю" /></div>}
        {gone && <p className="nws-sticky-state" role="alert">Заметка удалена или у вас нет доступа.</p>}
        {status === 'error' && <p className="nws-sticky-state" role="alert">{error || 'Не удалось открыть.'} <button type="button" className="nx-ghost" onClick={() => void session.reload()}>Повторить</button></p>}
        {item && <NoteEditor content={item.content} onContent={session.setContent} readOnly={!item.canEdit} loadKey={session.loadKey} title={item.title} visible />}
      </div>
      {item && <footer className="nws-sticky-foot">{session.state === 'error' ? <span className="is-error">Не сохранилось</span> : session.state === 'saved' ? 'Сохранено' : 'Сохраняю…'}</footer>}
    </section>
  );
}
