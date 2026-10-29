import { useEffect, useMemo, useState } from 'react';
import { Building2, X } from 'lucide-react';
import { createChat, sendText, useChatStore } from '@/features/chat';
import { useContacts } from '@/features/contacts/data';
import { Group } from '@/shared/ui/controls';
import { Sheet } from '@/shared/ui/overlay';
import { Select } from '@/shared/ui/Select';
import { showToast } from '@/shared/ui/Toast';
import { myId } from '@/shared/session/session';
import { workspaceApi } from './api';
import { InheritedShares } from './InheritedShares';
import type { DeptShareEntry, Folder, FolderRole, InheritedShare, ShareEntry } from './types';

/** Три права на папку — по возрастанию; «Перемещение и редактирование» — по умолчанию: люди раскладывают сами. */
const ROLE_OPTIONS: Array<{ value: FolderRole; label: string }> = [
  { value: 'move', label: 'Перемещение и редактирование' },
  { value: 'edit', label: 'Редактирование' },
  { value: 'view', label: 'Просмотр' },
];
const ROLE_MESSAGE: Record<FolderRole, string> = {
  move: 'можно перекладывать материалы и папки внутри, добавлять свои и править документы',
  edit: 'можно править документы внутри',
  view: 'для просмотра',
};

/**
 * Доступ к папке — как к документу, только сразу на всё содержимое: вложенные папки и всё, что владелец туда
 * положит потом. Человек или отдел видят папку у себя в «Офисе» целиком, с той же раскладкой и порядком, и все
 * изменения приходят им сразу. «Редактирование» — правит документы внутри; «Перемещение и редактирование» — ещё
 * перекладывает материалы и папки внутри, заводит папки и кладёт туда свои материалы. Доступ и удаление — у владельца.
 */
export function FolderShareDialog({ folder, onClose, onChanged }: { folder: Folder; onClose: () => void; onChanged: () => void }) {
  const users = useChatStore((s) => s.users);
  const { departments } = useContacts();
  const [shares, setShares] = useState<ShareEntry[]>([]);
  const [deptShares, setDeptShares] = useState<DeptShareEntry[]>([]);
  const [inherited, setInherited] = useState<InheritedShare[]>([]);
  const [pick, setPick] = useState('');
  const [role, setRole] = useState<FolderRole>('move');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
  const apply = (next: { shares: ShareEntry[]; departments: DeptShareEntry[]; inherited?: InheritedShare[] }) => { setShares(next.shares); setDeptShares(next.departments); setInherited(next.inherited ?? []); onChanged(); };

  useEffect(() => {
    workspaceApi.folderShares(folder.id).then((next) => { setShares(next.shares); setDeptShares(next.departments); setInherited(next.inherited ?? []); }).catch(fail);
  }, [folder.id]);

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

  async function setShare(target: { userId: string } | { departmentId: string }, next: FolderRole | null) {
    setError('');
    try { apply(await workspaceApi.setFolderShare(folder.id, target, next)); } catch (cause) { fail(cause); }
  }

  /** Человеку — доступ и сообщение в личный чат; отделу — папка просто появляется у всех его сотрудников. */
  async function give() {
    if (!pick) return;
    setBusy(true);
    setError('');
    try {
      if (pick.startsWith('d:')) {
        const next = await workspaceApi.setFolderShare(folder.id, { departmentId: pick.slice(2) }, role);
        apply(next);
        const entry = next.departments.find((d) => d.departmentId === pick.slice(2));
        showToast(`Папка открыта отделу «${entry?.name || ''}»: ${entry?.members ?? 0} чел. увидят её в «Офисе»`, 'success');
      } else {
        apply(await workspaceApi.setFolderShare(folder.id, { userId: pick }, role));
        const chatId = await createChat([pick]);
        if (chatId) sendText(chatId, `Открыл(а) вам папку «${folder.title}» в «Офисе» — ${ROLE_MESSAGE[role]}.`);
        showToast(`Папка открыта: ${people.find((p) => p.id === pick)?.name || 'коллеге'}`, 'success');
      }
      setPick('');
    } catch (cause) { fail(cause); } finally { setBusy(false); }
  }

  return (
    <Sheet title={`Доступ к папке: ${folder.title}`} onClose={onClose}>
      <div className="nws-share">
        <Group title="Открыть папку" note="Видно всё содержимое, включая вложенные папки и то, что вы положите в неё позже. Перекладывать внутри и добавлять своё могут те, у кого «Перемещение и редактирование».">
          <div className="nx-row nws-add-row">
            <Select
              className="nws-select nws-pick"
              label="Кому открыть"
              placeholder="Человек или отдел"
              value={pick}
              onChange={setPick}
              groups={[
                ...(freeDepartments.length > 0 ? [{ label: 'Отделы', options: freeDepartments.map((d) => ({ value: `d:${d.id}`, label: d.name, indent: Boolean(d.parentId) })) }] : []),
                { label: 'Люди', options: people.map((p) => ({ value: p.id, label: p.name })) },
              ]}
            />
            <Select
              className="nws-select"
              label="Права"
              value={role}
              onChange={(v) => setRole(v as FolderRole)}
              groups={[{ options: ROLE_OPTIONS }]}
            />
            <button type="button" className="nx-primary" disabled={!pick || busy} onClick={() => void give()}>Открыть</button>
          </div>
        </Group>

        <Group title="Кому открыта">
          {deptShares.map((share) => (
            <div key={share.departmentId} className="nx-row">
              <span className="nx-row-text">
                <span className="nx-row-label"><Building2 size={14} aria-hidden="true" className="nws-dept-icon" /> {share.name}</span>
                <span className="nx-row-hint">Отдел · {share.members} чел.</span>
              </span>
              <div className="nx-row-control">
                <select className="nws-select" value={share.role} onChange={(e) => void setShare({ departmentId: share.departmentId }, e.target.value as FolderRole)} aria-label={`Права отдела: ${share.name}`}>
                  {ROLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <button type="button" className="nx-icon-btn" onClick={() => void setShare({ departmentId: share.departmentId }, null)} aria-label={`Закрыть папку отделу: ${share.name}`}><X size={15} /></button>
              </div>
            </div>
          ))}
          {shares.map((share) => (
            <div key={share.userId} className="nx-row">
              <span className="nx-row-text"><span className="nx-row-label">{share.name || share.userId}</span></span>
              <div className="nx-row-control">
                <select className="nws-select" value={share.role} onChange={(e) => void setShare({ userId: share.userId }, e.target.value as FolderRole)} aria-label={`Права: ${share.name}`}>
                  {ROLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <button type="button" className="nx-icon-btn" onClick={() => void setShare({ userId: share.userId }, null)} aria-label={`Закрыть папку: ${share.name}`}><X size={15} /></button>
              </div>
            </div>
          ))}
          <InheritedShares entries={inherited} />
          {!shares.length && !deptShares.length && !inherited.length && <div className="nx-row"><span className="nx-row-hint">Папка пока только у вас</span></div>}
        </Group>
        {error && <p className="nws-error" role="alert">{error}</p>}
      </div>
    </Sheet>
  );
}
