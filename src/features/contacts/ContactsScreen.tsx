import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { AlertCircle, Check, ChevronDown, Plus, RotateCw, Search, Users } from 'lucide-react';
import { useShellOptions } from '@/shared/shell/ShellContext';
import { SearchField } from '@/shared/ui/SearchField';
import { SectionIcon } from '@/shared/ui/SectionIcon';
import { Avatar } from '@/shared/ui/Avatar';
import { plural } from '@/shared/ui/format';
import { askConfirm, Menu, MenuItem, type MenuAnchor } from '@/shared/ui/overlay';
import Splitter from '@/shared/ui/Splitter';
import { showToast } from '@/shared/ui/Toast';
import ContactDetail from './ContactDetail';
import { contactName, matches, useContacts, useGroups, type Contact, type Group } from './data';
import { PersonalDetail, PersonalEditor, PersonalRow, PersonalShareSheet } from './PersonalContacts';
import { personalApi, personalTitle, usePersonalContacts, type PersonalContact } from './personal';

type Scope = 'team' | 'mine';
const SCOPE_KEY = 'nx:contacts-scope';
function readScope(): Scope {
  try { return localStorage.getItem(SCOPE_KEY) === 'mine' ? 'mine' : 'team'; } catch { return 'team'; }
}

/**
 * Раздел «Контакты» нового шара: мастер-деталь, как чаты.
 *
 * Слева — поиск, фильтр «Все / В сети», выбор отдела и список по отделам с
 * липкими заголовками. Справа — карточка сотрудника. На телефоне (≤640px) —
 * одна область за раз: карточка открывается новым экраном, «назад» — к списку.
 *
 * Адрес карточки — `?user=<id>`: ссылкой можно поделиться, «назад» в браузере
 * работает.
 */

const NARROW = '(max-width: 640px)';
const subscribeMedia = (cb: () => void) => {
  const mq = window.matchMedia(NARROW);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
};
const subscribeNoop = () => () => {};

function readUserParam(): string | null {
  return typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('user');
}

function writeUserParam(id: string | null, push: boolean) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set('user', id); else url.searchParams.delete('user');
  const state = { ntUser: id, ntPushed: Boolean(id) && (push || Boolean(window.history.state?.ntPushed)) };
  if (push) window.history.pushState(state, '', url); else window.history.replaceState(state, '', url);
}

const Row = memo(function Row({ c, active, onOpen }: { c: Contact; active: boolean; onOpen: (id: string) => void }) {
  const name = contactName(c);
  return (
    <button
      type="button"
      className="ctl-row"
      data-contact-id={c.id}
      aria-current={active ? 'true' : undefined}
      onClick={() => onOpen(c.id)}
    >
      <Avatar name={name} seed={c.id} src={c.avatar} person online={Boolean(c.isOnline)} size={40} />
      <span className="ctl-row-text">
        <span className="ctl-row-name">{name}</span>
        <span className="ctl-row-sub">{c.position || c.email || c.username || ''}</span>
      </span>
      {c.isDepartmentHead && <span className="ctl-head-chip">Руководитель</span>}
    </button>
  );
});

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Загружаю контакты">
      {Array.from({ length: 9 }, (_, i) => (
        <div key={i} className="nx-skel-row">
          <span className="nx-skel nx-skel-avatar" />
          <span className="nx-skel-lines">
            <span className="nx-skel nx-skel-line" style={{ '--w': `${45 + ((i * 17) % 35)}%` } as CSSProperties} />
            <span className="nx-skel nx-skel-line" style={{ '--w': `${25 + ((i * 23) % 40)}%` } as CSSProperties} />
          </span>
        </div>
      ))}
    </div>
  );
}

function GroupBlock({ g, activeId, onOpen }: { g: Group; activeId: string | null; onOpen: (id: string) => void }) {
  return (
    <section className="ctl-group" aria-label={g.name} style={g.color ? ({ '--dept': g.color } as CSSProperties) : undefined}>
      <h3 className="ctl-group-head">
        <i aria-hidden="true" />
        <span>{g.name}</span>
        <span className="ctl-group-count">{g.total}</span>
      </h3>
      {g.members.map((c) => <Row key={c.id} c={c} active={c.id === activeId} onOpen={onOpen} />)}
      {g.subs.map((s) => (
        <div key={s.id} className="ctl-sub" style={s.color ? ({ '--dept': s.color } as CSSProperties) : undefined}>
          <h4 className="ctl-sub-head"><i aria-hidden="true" />{s.name}</h4>
          {s.members.map((c) => <Row key={c.id} c={c} active={c.id === activeId} onOpen={onOpen} />)}
        </div>
      ))}
    </section>
  );
}

export default function ContactsScreen() {
  const mounted = useSyncExternalStore(subscribeNoop, () => true, () => false);
  const narrow = useSyncExternalStore(subscribeMedia, () => window.matchMedia(NARROW).matches, () => false);
  const { contacts, departments, phase, reload } = useContacts();
  const [activeId, setActiveId] = useState<string | null>(readUserParam);
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query.trim().toLowerCase());
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [dept, setDept] = useState<string | null>(null);
  const [deptAnchor, setDeptAnchor] = useState<MenuAnchor | null>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // «Сотрудники» — справочник компании; «Мои контакты» — личная записная книжка с доступом, как у документов.
  const [scope, setScopeState] = useState<Scope>(readScope);
  const mine = scope === 'mine';
  const setScope = (next: Scope) => {
    try { localStorage.setItem(SCOPE_KEY, next); } catch { /* приватное окно — просто не запомним */ }
    setScopeState(next);
  };
  const personal = usePersonalContacts(mine);
  const [pActive, setPActive] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ contact: PersonalContact | null } | null>(null);
  const [sharing, setSharing] = useState<PersonalContact | null>(null);
  const pFiltered = useMemo(() => {
    if (!deferred) return personal.contacts;
    return personal.contacts.filter((c) => [c.name, c.company, c.position, c.phone, c.email, c.telegram, c.note].some((v) => v.toLowerCase().includes(deferred)));
  }, [personal.contacts, deferred]);
  const pOpen = pActive ? personal.contacts.find((c) => c.id === pActive) : undefined;
  const saved = (c: PersonalContact) => {
    personal.setContacts((all) => (all.some((x) => x.id === c.id) ? all.map((x) => (x.id === c.id ? { ...x, ...c, shared: x.shared } : x)) : [...all, c])
      .sort((a, b) => personalTitle(a).localeCompare(personalTitle(b), 'ru')));
    setPActive(c.id);
  };
  const removePersonal = async (c: PersonalContact) => {
    if (!(await askConfirm({ title: `Удалить «${personalTitle(c)}»?`, text: c.shared ? 'Контакт пропадёт и у тех, кому вы его открыли.' : undefined, confirm: 'Удалить', tone: 'danger' }))) return;
    try {
      await personalApi.remove(c.id);
      personal.setContacts((all) => all.filter((x) => x.id !== c.id));
      setPActive(null);
    } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалил контакт', 'error'); }
  };

  const deptName = useCallback((id: string) => departments.find((d) => d.id === id)?.name || id, [departments]);
  const visible = useMemo(
    () => contacts.filter((c) => (!onlineOnly || c.isOnline) && matches(c, deferred, deptName)),
    [contacts, onlineOnly, deferred, deptName],
  );
  const allGroups = useGroups(visible, departments);
  const groups = dept ? allGroups.filter((g) => g.id === dept) : allGroups;
  const shown = new Set(groups.flatMap((g) => [...g.members, ...g.subs.flatMap((s) => s.members)].map((c) => c.id))).size;
  const onlineCount = contacts.filter((c) => c.isOnline).length;
  const active = !mine && activeId ? contacts.find((c) => c.id === activeId) : undefined;

  useEffect(() => {
    const onPop = () => setActiveId(readUserParam());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Адрес пишем до setState, а не внутри его функции: pushState трогает
  // роутер Next, и из «обновителя» состояния это давало ошибку
  // «Cannot update Router while rendering ContactsScreen».
  const open = useCallback((id: string) => {
    const cur = readUserParam();
    if (cur === id) return;
    writeUserParam(id, window.matchMedia(NARROW).matches && !cur);
    setActiveId(id);
  }, []);

  const back = useCallback(() => {
    if (window.history.state?.ntPushed) window.history.back();
    else { writeUserParam(null, false); setActiveId(null); }
  }, []);

  // Стрелки вверх/вниз ходят по строкам списка, Enter открывает (строки — кнопки).
  useShellOptions({
    navHidden: narrow && Boolean(mine ? pOpen : active),
    onReselect: () => { if (mine) setPActive(null); else if (readUserParam()) back(); },
  });

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('.ctl-row') || []);
    if (!rows.length) return;
    e.preventDefault();
    const i = rows.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
    rows[next].focus();
    rows[next].scrollIntoView({ block: 'nearest' });
  };

  if (!mounted) return null;

  const deptLabel = dept ? allGroups.find((g) => g.id === dept)?.name || deptName(dept) : 'Все отделы';
  const filtered = Boolean(deferred || onlineOnly || dept);

  let body;
  if (mine) {
    if (personal.phase === 'loading' || personal.phase === 'idle') {
      body = <Skeleton />;
    } else if (personal.phase === 'error') {
      body = (
        <div className="nx-state" data-tone="danger" role="alert">
          <AlertCircle size={28} aria-hidden="true" />
          <h2>Не загрузил контакты</h2>
          <p>{personal.error || 'Сервер не ответил.'}</p>
          <button type="button" className="nx-ghost" onClick={() => void personal.reload()}><RotateCw size={14} aria-hidden="true" /> Повторить</button>
        </div>
      );
    } else if (!personal.ready) {
      body = (
        <div className="nx-state">
          <Users size={28} aria-hidden="true" />
          <h2>Личные контакты скоро включатся</h2>
          <p>На сервере ещё не применена схема для этого раздела — после выпуска можно будет заводить свои контакты.</p>
        </div>
      );
    } else if (!pFiltered.length) {
      body = (
        <div className="nx-state">
          {deferred ? <Search size={28} aria-hidden="true" /> : <Users size={28} aria-hidden="true" />}
          <h2>{deferred ? 'Ничего не нашёл' : 'Своих контактов пока нет'}</h2>
          <p>{deferred ? 'Ищу по имени, организации, телефону, почте и заметке.' : 'Добавьте клиента или подрядчика — и откройте его тем, кому он нужен.'}</p>
          {!deferred && <button type="button" className="nx-primary" onClick={() => setEditor({ contact: null })}><Plus size={15} aria-hidden="true" /> Новый контакт</button>}
        </div>
      );
    } else {
      body = pFiltered.map((c) => <PersonalRow key={c.id} c={c} active={c.id === pActive} onOpen={setPActive} />);
    }
  // Пока не известны и люди, и отделы — скелет: иначе группы перестроились бы на глазах.
  } else if (phase === 'loading') {
    body = <Skeleton />;
  } else if (!contacts.length && phase === 'error') {
    body = (
      <div className="nx-state" data-tone="danger" role="alert">
        <AlertCircle size={28} aria-hidden="true" />
        <h2>Не загрузил контакты</h2>
        <p>Сервер не ответил. Проверьте связь и повторите.</p>
        <button type="button" className="nx-ghost" onClick={() => void reload()}><RotateCw size={14} aria-hidden="true" /> Повторить</button>
      </div>
    );
  } else if (!shown) {
    body = (
      <div className="nx-state">
        {deferred ? <Search size={28} aria-hidden="true" /> : <Users size={28} aria-hidden="true" />}
        <h2>{deferred ? 'Никого не нашёл' : onlineOnly ? 'Сейчас никого нет в сети' : 'Здесь пока никого'}</h2>
        <p>{deferred ? 'Ищу по имени, должности, почте и отделу — попробуйте иначе.' : 'Снимите фильтры, чтобы увидеть всех сотрудников.'}</p>
        <button type="button" className="nx-ghost" onClick={() => { setQuery(''); setOnlineOnly(false); setDept(null); }}>Сбросить фильтры</button>
      </div>
    );
  } else {
    body = groups.map((g) => <GroupBlock key={g.id} g={g} activeId={activeId} onOpen={open} />);
  }

  return (
    <>
      <div ref={layoutRef} className="ctn" data-pane={(mine ? pOpen : active) ? 'detail' : 'list'}>
        <aside className="ctl" aria-label="Сотрудники">
          <header className="ctl-head">
            <div className="ctl-title">
              <h1>Контакты</h1>
              <span className="ctl-total" aria-live="polite">
                {mine
                  ? (personal.phase === 'ready' && personal.ready ? `${pFiltered.length}${deferred ? ` из ${personal.contacts.length}` : ''} ${plural(pFiltered.length, ['контакт', 'контакта', 'контактов'])}` : '')
                  : filtered ? `${shown} из ${contacts.length}` : `${contacts.length} ${plural(contacts.length, ['сотрудник', 'сотрудника', 'сотрудников'])}`}
              </span>
            </div>
            <div className="nx-segment ctl-scope" role="group" aria-label="Какие контакты">
              <button type="button" aria-pressed={!mine} onClick={() => setScope('team')}>Сотрудники</button>
              <button type="button" aria-pressed={mine} onClick={() => setScope('mine')}>Мои контакты</button>
            </div>
            <div className="ctl-search-row">
              <SearchField
                value={query}
                onChange={setQuery}
                placeholder={mine ? 'Имя, организация, телефон' : 'Имя, должность, отдел'}
                label={mine ? 'Поиск контакта' : 'Поиск сотрудника'}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); listRef.current?.querySelector<HTMLElement>('.ctl-row')?.focus(); }
                }}
              />
              {mine && personal.ready && (
                <button type="button" className="nx-primary ctl-add" onClick={() => setEditor({ contact: null })} aria-label="Новый контакт" title="Новый контакт">
                  <Plus size={16} aria-hidden="true" />
                </button>
              )}
            </div>
            {!mine && (
              <div className="ctl-filters">
                <div className="nx-segment" role="group" aria-label="Кого показать">
                  <button type="button" aria-pressed={!onlineOnly} onClick={() => setOnlineOnly(false)}>Все</button>
                  <button type="button" aria-pressed={onlineOnly} onClick={() => setOnlineOnly(true)}>
                    В сети{onlineCount > 0 && <span className="ctl-seg-count">{onlineCount}</span>}
                  </button>
                </div>
                <button
                  type="button"
                  className="nx-ghost ctl-dept-btn"
                  aria-haspopup="menu"
                  aria-expanded={Boolean(deptAnchor)}
                  data-active={dept ? 'true' : undefined}
                  onClick={(e) => setDeptAnchor(deptAnchor ? null : { element: e.currentTarget, align: 'end' })}
                >
                  <span className="ctl-dept-label">{deptLabel}</span>
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
              </div>
            )}
          </header>

          <div ref={listRef} className="ctl-list nx-scroll-y" onKeyDown={onListKey}>
            {body}
          </div>
        </aside>

        {!narrow && (
          <Splitter
            containerRef={layoutRef}
            cssVar="--ctn-list"
            storageKey="nx:contacts-list-width"
            min={300}
            max={560}
            initial={380}
            label="Ширина списка контактов"
          />
        )}

        {mine ? (
          pOpen ? (
            <PersonalDetail
              key={pOpen.id}
              contact={pOpen}
              onBack={() => setPActive(null)}
              onEdit={() => setEditor({ contact: pOpen })}
              onShare={() => setSharing(pOpen)}
              onDelete={() => void removePersonal(pOpen)}
            />
          ) : (
            <section className="ctd" aria-label="Карточка контакта">
              <div className="nx-state ctd-empty-state">
                <SectionIcon name="contacts" size={72} />
                <h2>Выберите контакт</h2>
                <p>Свои контакты видите вы и те, кому вы их откроете: людям или целым отделам — как документы.</p>
              </div>
            </section>
          )
        ) : active ? (
          <ContactDetail key={active.id} contact={active} departments={departments} onBack={back} />
        ) : (
          <section className="ctd" aria-label="Карточка сотрудника">
            <div className="nx-state ctd-empty-state">
              <SectionIcon name="contacts" size={72} />
              <h2>{activeId && phase !== 'ready' ? 'Загружаю карточку' : 'Выберите сотрудника'}</h2>
              <p>Здесь будут контакты, отдел и быстрые действия: написать, поставить задачу, позвонить.</p>
            </div>
          </section>
        )}
      </div>

      {editor && <PersonalEditor initial={editor.contact} onSaved={saved} onClose={() => setEditor(null)} />}
      {sharing && (
        <PersonalShareSheet
          contact={sharing}
          onClose={() => setSharing(null)}
          onChanged={(count) => personal.setContacts((all) => all.map((x) => (x.id === sharing.id ? { ...x, shared: count } : x)))}
        />
      )}
      {deptAnchor && (
        <Menu anchor={deptAnchor} label="Отдел" onClose={() => setDeptAnchor(null)}>
          <MenuItem icon={dept ? <span className="ctl-menu-gap" /> : <Check size={16} />} onSelect={() => { setDept(null); setDeptAnchor(null); }}>
            Все отделы
          </MenuItem>
          <div className="nx-menu-sep" />
          {allGroups.map((g) => (
            <MenuItem
              key={g.id}
              icon={dept === g.id ? <Check size={16} /> : <span className="ctl-menu-dot" style={{ '--dept': g.color || 'var(--note-gray)' } as CSSProperties} />}
              onSelect={() => { setDept(g.id); setDeptAnchor(null); listRef.current?.scrollTo({ top: 0 }); }}
            >
              {g.name} <span className="ctl-menu-count">{g.total}</span>
            </MenuItem>
          ))}
        </Menu>
      )}
    </>
  );
}
