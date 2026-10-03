import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ban, KeyRound, LogOut, MoreHorizontal, Pencil, Plus, RotateCcw, RotateCw, ShieldCheck, Trash2, Users } from 'lucide-react';
import { Avatar } from '@/shared/ui/Avatar';
import { SearchField } from '@/shared/ui/SearchField';
import { askConfirm, Menu, MenuItem, type MenuAnchor } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { GRANTABLE_TOOLS } from '@/features/more';
import { deleteUser, loadDepartments, loadUsers, resetUserPassword, revokeUserSessions, updateUser, type AdminUser, type Department } from './api';
import UserSheet from './UserSheet';
import AccessSheet from './AccessSheet';
import CredentialSheet from './CredentialSheet';

function matches(u: AdminUser, q: string) {
  return [u.name, u.username, u.email, u.position, u.department].some((v) => (v || '').toLowerCase().includes(q));
}

export default function UsersTab() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [credential, setCredential] = useState<{ user: AdminUser; password: string } | null>(null);
  const [sheet, setSheet] = useState<{ kind: 'create' } | { kind: 'edit' | 'access'; user: AdminUser } | null>(null);
  const [menu, setMenu] = useState<{ user: AdminUser; anchor: MenuAnchor } | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const [u, d] = await Promise.all([loadUsers(), loadDepartments().catch(() => [])]);
      setUsers(u);
      setDepartments(d);
    } catch { setFailed(true); setUsers((prev) => prev ?? []); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const q = query.trim().toLowerCase();
  const list = useMemo(() => (users || []).filter((u) => !q || matches(u, q)), [users, q]);
  const deptNames = (u: AdminUser) => {
    const ids = u.departmentIds?.length ? u.departmentIds : u.department ? [u.department] : [];
    return ids.map((id) => departments.find((d) => d.id === id)?.name || id);
  };

  const toggleDisabled = async (u: AdminUser) => {
    try {
      await updateUser(u.id, { isDisabled: !u.isDisabled });
      showToast(u.isDisabled ? 'Пользователь включён' : 'Пользователь отключён', 'success');
      void load();
    } catch (e) { showToast(e instanceof Error ? e.message : 'Не получилось', 'error'); }
  };

  const resetPassword = async (u: AdminUser) => {
    if (!(await askConfirm({ title: `Сбросить пароль ${u.name || u.username}?`, text: 'Пользователь выйдет со всех устройств. Новый временный пароль покажется один раз.', confirm: 'Сбросить', tone: 'danger' }))) return;
    try { const r = await resetUserPassword(u.id); setCredential({ user: u, password: r.password }); }
    catch (e) { showToast(e instanceof Error ? e.message : 'Не получилось', 'error'); }
  };

  const signOut = async (u: AdminUser) => {
    try { const r = await revokeUserSessions(u.id); showToast(r.revoked ? `Завершено сеансов: ${r.revoked}` : 'Активных сеансов нет', 'success'); }
    catch (e) { showToast(e instanceof Error ? e.message : 'Не получилось', 'error'); }
  };

  const toggleRole = async (u: AdminUser) => {
    const next = u.role === 'admin' ? 'user' : 'admin';
    if (!(await askConfirm({ title: next === 'admin' ? `Сделать ${u.name || u.username} администратором?` : `Снять права администратора с ${u.name || u.username}?`, confirm: 'Да', tone: next === 'admin' ? undefined : 'danger' }))) return;
    try { await updateUser(u.id, { role: next }); void load(); }
    catch (e) { showToast(e instanceof Error ? e.message : 'Не получилось', 'error'); }
  };

  const remove = async (u: AdminUser) => {
    if (!(await askConfirm({ title: `Удалить ${u.name || u.username}?`, text: 'Аккаунт удалится насовсем. Если нужно просто закрыть доступ — отключите пользователя.', confirm: 'Удалить', tone: 'danger' }))) return;
    try { await deleteUser(u.id); showToast('Пользователь удалён', 'success'); void load(); }
    catch (e) { showToast(e instanceof Error ? e.message : 'Не удалилось', 'error'); }
  };

  return (
    <>
      <div className="nad-toolbar">
        <SearchField value={query} onChange={setQuery} placeholder="Имя, логин, почта, отдел" label="Поиск пользователей" className="nad-search" />
        <div className="nad-toolbar-actions">
          <button type="button" className="nx-icon-btn" title="Обновить" aria-label="Обновить" onClick={() => void load()}>
            <RotateCw size={16} />
          </button>
          <button type="button" className="nx-primary" onClick={() => setSheet({ kind: 'create' })}>
            <Plus size={15} aria-hidden="true" /> Пользователь
          </button>
        </div>
      </div>

      {users === null ? (
        <div className="nx-group" aria-busy="true">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="nx-row"><span className="nx-skel nx-skel-line" style={{ width: `${70 - i * 8}%` }} /></div>)}</div>
      ) : failed && !users.length ? (
        <div className="nx-state" role="alert">
          <RotateCw size={24} aria-hidden="true" />
          <h2>Список не загрузился</h2>
          <p>Нет связи с сервером или нет прав администратора.</p>
          <button type="button" className="nx-primary" onClick={() => void load()}>Попробовать снова</button>
        </div>
      ) : list.length === 0 ? (
        <div className="nx-state">
          <Users size={24} aria-hidden="true" />
          <h2>{q ? 'Никого не нашлось' : 'Пользователей нет'}</h2>
          {q && <button type="button" className="nx-ghost" onClick={() => setQuery('')}>Сбросить поиск</button>}
        </div>
      ) : (
        <section className="nx-block">
          <h2 className="nx-block-title">{list.length} {q ? 'найдено' : 'в системе'}</h2>
          <div className="nx-group">
            {list.map((u) => (
              <div key={u.id} className="nx-row nad-user" data-disabled={u.isDisabled ? 'true' : undefined}>
                <Avatar name={u.name || u.username || '?'} seed={u.id} src={u.avatar} person size={36} />
                <span className="nx-row-text">
                  <span className="nx-row-label">
                    {u.name || u.username || 'Без имени'}
                    {u.role === 'admin' && <span className="nx-tag" data-tone="accent">Админ</span>}
                    {u.isDisabled && <span className="nx-tag" data-tone="warn">Отключён</span>}
                  </span>
                  <span className="nx-row-hint">
                    {[`@${u.username || u.email || '—'}`, u.position, ...deptNames(u)].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="nx-row-actions">
                  <button type="button" className="nx-icon-btn" aria-label={`Изменить: ${u.name || u.username}`} title="Изменить" onClick={() => setSheet({ kind: 'edit', user: u })}>
                    <Pencil size={15} />
                  </button>
                  {GRANTABLE_TOOLS.length > 0 && u.role !== 'admin' && (
                    <button type="button" className="nx-icon-btn" aria-label={`Инструменты: ${u.name || u.username}`} title="Инструменты" onClick={() => setSheet({ kind: 'access', user: u })}>
                      <KeyRound size={15} />
                    </button>
                  )}
                  {(
                    <button type="button" className="nx-icon-btn" aria-label="Ещё" aria-haspopup="menu" aria-expanded={menu?.user.id === u.id}
                      onClick={(e) => setMenu({ user: u, anchor: { element: e.currentTarget, align: 'end' } })}>
                      <MoreHorizontal size={16} />
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {menu && (
        <Menu anchor={menu.anchor} label={menu.user.name || menu.user.username || 'Пользователь'} onClose={() => setMenu(null)} compact>
          <MenuItem icon={menu.user.isDisabled ? <RotateCcw size={16} /> : <Ban size={16} />} onSelect={() => { const u = menu.user; setMenu(null); void toggleDisabled(u); }}>
            {menu.user.isDisabled ? 'Включить' : 'Отключить (скрыть везде)'}
          </MenuItem>
          <MenuItem icon={<KeyRound size={16} />} onSelect={() => { const u = menu.user; setMenu(null); void resetPassword(u); }}>Сбросить пароль</MenuItem>
          <MenuItem icon={<LogOut size={16} />} onSelect={() => { const u = menu.user; setMenu(null); void signOut(u); }}>Выйти со всех устройств</MenuItem>
          <MenuItem icon={<ShieldCheck size={16} />} onSelect={() => { const u = menu.user; setMenu(null); void toggleRole(u); }}>
            {menu.user.role === 'admin' ? 'Снять права админа' : 'Сделать админом'}
          </MenuItem>
          <MenuItem icon={<Trash2 size={16} />} tone="danger" onSelect={() => { const u = menu.user; setMenu(null); void remove(u); }}>Удалить</MenuItem>
        </Menu>
      )}

      {credential && <CredentialSheet user={credential.user} password={credential.password} onClose={() => setCredential(null)} />}
      {sheet?.kind === 'create' && <UserSheet departments={departments} onClose={() => setSheet(null)} onSaved={() => { setSheet(null); void load(); }} />}
      {sheet?.kind === 'edit' && <UserSheet user={sheet.user} departments={departments} onClose={() => setSheet(null)} onSaved={() => { setSheet(null); void load(); }} />}
      {sheet?.kind === 'access' && <AccessSheet user={sheet.user} onClose={() => setSheet(null)} onSaved={() => { setSheet(null); void load(); }} />}
    </>
  );
}
