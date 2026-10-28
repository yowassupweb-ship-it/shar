import { useCallback, useEffect, useMemo, useState } from 'react';
import { Building2, Check, Copy, Link2, RefreshCw, X } from 'lucide-react';
import { createChat, sendText, useChatStore } from '@/features/chat';
import { useContacts } from '@/features/contacts/data';
import { absolute, links as routeLinks } from '@/shared/navigation/routes';
import { Group, Row } from '@/shared/ui/controls';
import { askConfirm, Sheet } from '@/shared/ui/overlay';
import { Select } from '@/shared/ui/Select';
import { showToast } from '@/shared/ui/Toast';
import { myId } from '@/shared/session/session';
import { workspaceApi } from './api';
import { KINDS, sharedUrl } from './kinds';
import { InheritedShares } from './InheritedShares';
import type { AccessLevel, AccessMode, DeptShareEntry, InheritedShare, Item, LinkEntry, ShareEntry } from './types';

/**
 * «Поделиться» — одно на все виды материалов. Три способа, от широкого к узкому:
 *  - ссылки без входа в Шар: одна на просмотр, одна на правку; перевыпуск делает старую мёртвой;
 *  - все в Шаре: уровень доступа и что остальным можно;
 *  - поимённо или целому отделу: выбрать человека/отдел и дать чтение или правку — материал сразу
 *    появляется у них в «Офисе», без обновления страницы.
 * Менять доступ может только владелец; остальные видят, что им разрешено.
 */

function since(iso: string | null): string {
  if (!iso) return 'ещё не открывали';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60000);
  if (min < 1) return 'открывали только что';
  if (min < 60) return `открывали ${min} мин назад`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `открывали ${hours} ч назад`;
  return `открывали ${Math.round(hours / 24)} дн назад`;
}

export function ShareDialog({ item, onClose, onChanged }: {
  item: Pick<Item, 'id' | 'kind' | 'title' | 'accessLevel' | 'accessMode' | 'isOwner' | 'canEdit'>;
  onClose: () => void;
  /** Доступ изменился — список и шапка обновят свои значки. */
  onChanged: (fields: { accessLevel?: AccessLevel; accessMode?: AccessMode; linked?: boolean }) => void;
}) {
  const info = KINDS[item.kind];
  const owner = item.isOwner;
  const users = useChatStore((s) => s.users);
  const [level, setLevel] = useState<AccessLevel>(item.accessLevel);
  const [mode, setMode] = useState<AccessMode>(item.accessMode);
  const [links, setLinks] = useState<LinkEntry[]>([]);
  const [shares, setShares] = useState<ShareEntry[]>([]);
  const [deptShares, setDeptShares] = useState<DeptShareEntry[]>([]);
  const [inherited, setInherited] = useState<InheritedShare[]>([]);
  const { departments } = useContacts();
  const [pick, setPick] = useState('');
  const [role, setRole] = useState<'view' | 'edit'>('edit');
  const [busy, setBusy] = useState('');
  const [copied, setCopied] = useState('');
  const [error, setError] = useState('');

  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
  const applyShares = (next: { shares: ShareEntry[]; departments: DeptShareEntry[]; inherited?: InheritedShare[] }) => { setShares(next.shares); setDeptShares(next.departments); setInherited(next.inherited ?? []); };

  useEffect(() => {
    if (!owner) return;
    workspaceApi.links(item.id).then(setLinks).catch(fail);
    workspaceApi.shares(item.id).then(applyShares).catch(fail);
  }, [item.id, owner]);

  const people = useMemo(
    () => Object.values(users)
      .filter((u) => String(u.id) !== myId() && !shares.some((s) => s.userId === String(u.id)))
      .map((u) => ({ id: String(u.id), name: u.name || u.username || String(u.id) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    [users, shares],
  );

  const freeDepartments = useMemo(
    () => departments.filter((d) => !deptShares.some((s) => s.departmentId === d.id)).sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    [departments, deptShares],
  );

  const copy = useCallback(async (link: LinkEntry) => {
    try { await navigator.clipboard.writeText(sharedUrl(item.kind, link.token)); showToast('Ссылка скопирована', 'success'); } catch { /* ссылка видна в поле */ }
    setCopied(link.mode);
    window.setTimeout(() => setCopied(''), 1600);
  }, [item.kind]);

  async function createLink(linkMode: 'view' | 'edit', regenerate = false) {
    setBusy(linkMode);
    setError('');
    try {
      const result = await workspaceApi.createLink(item.id, linkMode, regenerate);
      setLinks(result.links);
      onChanged({ linked: result.links.length > 0 });
      await copy(result.link);
    } catch (cause) { fail(cause); } finally { setBusy(''); }
  }

  async function revoke(linkMode: 'view' | 'edit') {
    const ok = await askConfirm({
      title: linkMode === 'edit' ? 'Отозвать ссылку на правку?' : 'Отозвать ссылку на просмотр?',
      text: 'Она перестанет открываться.', confirm: 'Отозвать', tone: 'danger',
    });
    if (!ok) return;
    setBusy(linkMode);
    try {
      const next = await workspaceApi.revokeLink(item.id, linkMode);
      setLinks(next);
      onChanged({ linked: next.length > 0 });
    } catch (cause) { fail(cause); } finally { setBusy(''); }
  }

  async function saveAccess(next: { accessLevel?: AccessLevel; accessMode?: AccessMode }) {
    setError('');
    if (next.accessLevel) setLevel(next.accessLevel);
    if (next.accessMode) setMode(next.accessMode);
    try {
      await workspaceApi.patch(item.id, next);
      onChanged(next);
    } catch (cause) { fail(cause); }
  }

  async function setShare(userId: string, next: 'view' | 'edit' | null) {
    setError('');
    try { applyShares(await workspaceApi.setShare(item.id, { userId }, next)); } catch (cause) { fail(cause); }
  }

  async function setDeptShare(departmentId: string, next: 'view' | 'edit' | null) {
    setError('');
    try { applyShares(await workspaceApi.setShare(item.id, { departmentId }, next)); } catch (cause) { fail(cause); }
  }

  /** Отделу чат не пишем: материал просто появляется у всех его сотрудников в «Офисе» (и приходит уведомление). */
  async function giveDepartment(departmentId: string, giveRole: 'view' | 'edit') {
    setBusy('send');
    setError('');
    try {
      const next = await workspaceApi.setShare(item.id, { departmentId }, giveRole);
      applyShares(next);
      const entry = next.departments.find((d) => d.departmentId === departmentId);
      showToast(`Доступ открыт отделу «${entry?.name || departmentId}»: ${entry?.members ?? 0} чел. увидят материал в «Офисе»`, 'success');
      setPick('');
    } catch (cause) { fail(cause); } finally { setBusy(''); }
  }

  /** «Отправить коллеге»: выдать доступ и одним сообщением положить ссылку ему в личный чат. */
  async function sendTo(userId: string, sendRole: 'view' | 'edit') {
    setBusy('send');
    setError('');
    try {
      // При «Все в Шаре» с правкой отдельное разрешение не нужно; в остальных случаях выдаём выбранное.
      const covered = level === 'all' && (mode === 'edit' || sendRole === 'view');
      if (!covered) applyShares(await workspaceApi.setShare(item.id, { userId }, sendRole));
      const chatId = await createChat([userId]);
      if (!chatId) throw new Error('Не удалось открыть чат — нет связи с сервером');
      sendText(chatId, `Поделился с вами: «${item.title || info.untitled}»
${absolute(routeLinks.office(item.kind, item.id))}`);
      const person = people.find((p) => p.id === userId)?.name || 'коллеге';
      showToast(`Отправлено: ${person}`, 'success');
      setPick('');
    } catch (cause) { fail(cause); } finally { setBusy(''); }
  }

  const rows: Array<{ mode: 'view' | 'edit'; label: string; hint: string }> = [
    { mode: 'view', label: 'Просмотр по ссылке', hint: 'Открыть без входа в Шар' },
    { mode: 'edit', label: 'Правка по ссылке', hint: 'Менять без входа в Шар' },
  ];

  return (
    <Sheet title={`Поделиться: ${item.title || info.untitled}`} onClose={onClose}>
      <div className="nws-share">
        {!owner && (
          <p className="nx-note">Материал открыт вам {item.canEdit ? 'для правки' : 'только для просмотра'}. Доступом управляет владелец.</p>
        )}
        {owner && (
          <>
            <Group title="Дать доступ" note="Человеку — дадим доступ и пришлём ссылку в личный чат. Отделу — материал сразу появится у всех его сотрудников в «Офисе».">
              <div className="nx-row nws-add-row">
                <Select
                  className="nws-select nws-pick"
                  label="Кому дать доступ"
                  placeholder="Выберите человека или отдел"
                  value={pick}
                  onChange={setPick}
                  groups={[
                    ...(freeDepartments.length > 0 ? [{ label: 'Отделы', options: freeDepartments.map((d) => ({ value: `d:${d.id}`, label: d.name, indent: Boolean(d.parentId) })) }] : []),
                    { label: 'Люди', options: people.map((p) => ({ value: String(p.id), label: p.name })) },
                  ]}
                />
                <Select
                  className="nws-select"
                  label="Права"
                  value={role}
                  onChange={(v) => setRole(v as 'view' | 'edit')}
                  groups={[{ options: [{ value: 'edit', label: 'Может править' }, { value: 'view', label: 'Только смотреть' }] }]}
                />
                <button
                  type="button"
                  className="nx-primary"
                  disabled={!pick || busy === 'send'}
                  onClick={() => (pick.startsWith('d:') ? void giveDepartment(pick.slice(2), role) : void sendTo(pick, role))}
                >{pick.startsWith('d:') ? 'Открыть' : 'Отправить'}</button>
              </div>
            </Group>

            <Group title="Ссылки" note="Открываются в любом браузере без входа. Отозвать или перевыпустить можно в любой момент.">
              {rows.map((row) => {
                const link = links.find((l) => l.mode === row.mode);
                return (
                  <div key={row.mode} className="nx-row nws-link-row">
                    <span className="nx-row-text">
                      <span className="nx-row-label">{row.label}</span>
                      <span className="nx-row-hint">{link ? since(link.lastUsedAt) : row.hint}</span>
                    </span>
                    {link ? (
                      <div className="nws-link-box">
                        <input readOnly value={sharedUrl(item.kind, link.token)} onFocus={(e) => e.currentTarget.select()} aria-label={row.label} />
                        <button type="button" className="nx-icon-btn" onClick={() => void copy(link)} title="Скопировать" aria-label="Скопировать ссылку">
                          {copied === row.mode ? <Check size={15} /> : <Copy size={15} />}
                        </button>
                        <button type="button" className="nx-icon-btn" disabled={busy === row.mode} onClick={() => void createLink(row.mode, true)} title="Новая ссылка, старая перестанет работать" aria-label="Перевыпустить">
                          <RefreshCw size={15} />
                        </button>
                        <button type="button" className="nx-icon-btn" disabled={busy === row.mode} onClick={() => void revoke(row.mode)} title="Отозвать" aria-label="Отозвать ссылку">
                          <X size={15} />
                        </button>
                      </div>
                    ) : (
                      <button type="button" className="nx-ghost" disabled={busy === row.mode} onClick={() => void createLink(row.mode)}>
                        <Link2 size={14} aria-hidden="true" /> Создать
                      </button>
                    )}
                  </div>
                );
              })}
            </Group>

            <Group title="Доступ в Шаре">
              <Row label="Кто видит" hint={level === 'all' ? 'Все, кто входит в Шар' : 'Только вы и те, кому выдан доступ ниже'}>
                <Select
                  className="nws-select"
                  label="Кто видит"
                  value={level}
                  onChange={(v) => void saveAccess({ accessLevel: v as AccessLevel })}
                  groups={[{ options: [{ value: 'private', label: 'Только я' }, { value: 'all', label: 'Все в Шаре' }] }]}
                />
              </Row>
              {level === 'all' && (
                <Row label="Остальные могут">
                  <Select
                    className="nws-select"
                    label="Права остальных"
                    value={mode}
                    onChange={(v) => void saveAccess({ accessMode: v as AccessMode })}
                    groups={[{ options: [{ value: 'edit', label: 'Редактировать' }, { value: 'view', label: 'Только смотреть' }] }]}
                  />
                </Row>
              )}
            </Group>

            <Group title="Кому выдан доступ">
              {deptShares.map((share) => (
                <div key={share.departmentId} className="nx-row">
                  <span className="nx-row-text">
                    <span className="nx-row-label"><Building2 size={14} aria-hidden="true" className="nws-dept-icon" /> {share.name}</span>
                    <span className="nx-row-hint">Отдел · {share.members} чел.</span>
                  </span>
                  <div className="nx-row-control">
                    <select className="nws-select" value={share.role} onChange={(e) => void setDeptShare(share.departmentId, e.target.value as 'view' | 'edit')} aria-label={`Права отдела: ${share.name}`}>
                      <option value="edit">Редакторы</option>
                      <option value="view">Читатели</option>
                    </select>
                    <button type="button" className="nx-icon-btn" onClick={() => void setDeptShare(share.departmentId, null)} aria-label={`Убрать доступ отделу: ${share.name}`}><X size={15} /></button>
                  </div>
                </div>
              ))}
              {shares.map((share) => (
                <div key={share.userId} className="nx-row">
                  <span className="nx-row-text"><span className="nx-row-label">{share.name || share.userId}</span></span>
                  <div className="nx-row-control">
                    <select className="nws-select" value={share.role} onChange={(e) => void setShare(share.userId, e.target.value as 'view' | 'edit')} aria-label={`Права: ${share.name}`}>
                      <option value="edit">Редактор</option>
                      <option value="view">Читатель</option>
                    </select>
                    <button type="button" className="nx-icon-btn" onClick={() => void setShare(share.userId, null)} aria-label={`Убрать доступ: ${share.name}`}><X size={15} /></button>
                  </div>
                </div>
              ))}
              <InheritedShares entries={inherited} />
              {!shares.length && !deptShares.length && !inherited.length && <div className="nx-row"><span className="nx-row-hint">Пока никому не выдан — ни людям, ни отделам</span></div>}
            </Group>
          </>
        )}
        {error && <p className="nws-error" role="alert">{error}</p>}
      </div>
    </Sheet>
  );
}
