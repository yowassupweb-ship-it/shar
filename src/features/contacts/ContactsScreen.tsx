import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { AlertCircle, Check, ChevronDown, RotateCw, Search, Users } from 'lucide-react';
import { useShellOptions } from '@/shared/shell/ShellContext';
import { SearchField } from '@/shared/ui/SearchField';
import { SectionIcon } from '@/shared/ui/SectionIcon';
import { Avatar } from '@/shared/ui/Avatar';
import { plural } from '@/shared/ui/format';
import { Menu, MenuItem, type MenuAnchor } from '@/shared/ui/overlay';
import Splitter from '@/shared/ui/Splitter';
import ContactDetail from './ContactDetail';
import { contactName, matches, useContacts, useGroups, type Contact, type Group } from './data';

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

  const deptName = useCallback((id: string) => departments.find((d) => d.id === id)?.name || id, [departments]);
  const visible = useMemo(
    () => contacts.filter((c) => (!onlineOnly || c.isOnline) && matches(c, deferred, deptName)),
    [contacts, onlineOnly, deferred, deptName],
  );
  const allGroups = useGroups(visible, departments);
  const groups = dept ? allGroups.filter((g) => g.id === dept) : allGroups;
  const shown = new Set(groups.flatMap((g) => [...g.members, ...g.subs.flatMap((s) => s.members)].map((c) => c.id))).size;
  const onlineCount = contacts.filter((c) => c.isOnline).length;
  const active = activeId ? contacts.find((c) => c.id === activeId) : undefined;

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
    navHidden: narrow && Boolean(active),
    onReselect: () => { if (readUserParam()) back(); },
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
  // Пока не известны и люди, и отделы — скелет: иначе группы перестроились бы на глазах.
  if (phase === 'loading') {
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
      <div ref={layoutRef} className="ctn" data-pane={active ? 'detail' : 'list'}>
        <aside className="ctl" aria-label="Сотрудники">
          <header className="ctl-head">
            <div className="ctl-title">
              <h1>Контакты</h1>
              <span className="ctl-total" aria-live="polite">
                {filtered ? `${shown} из ${contacts.length}` : `${contacts.length} ${plural(contacts.length, ['сотрудник', 'сотрудника', 'сотрудников'])}`}
              </span>
            </div>
            <SearchField
              value={query}
              onChange={setQuery}
              placeholder="Имя, должность, отдел"
              label="Поиск сотрудника"
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); listRef.current?.querySelector<HTMLElement>('.ctl-row')?.focus(); }
              }}
            />
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

        {active ? (
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
