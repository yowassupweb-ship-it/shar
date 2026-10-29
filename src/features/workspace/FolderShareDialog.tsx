import { useEffect, useState } from 'react';
import { Building2, X } from 'lucide-react';
import { createChat, sendText } from '@/features/chat';
import { Group } from '@/shared/ui/controls';
import { Sheet } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { myId } from '@/shared/session/session';
import { workspaceApi } from './api';
import { InheritedShares } from './InheritedShares';
import { PeoplePicker, PersonLabel, type PickTarget } from './PeoplePicker';
import type { DeptShareEntry, Folder, FolderRole, InheritedShare, ShareEntry } from './types';

/** Три права на папку — по возрастанию; «Перемещение и редактирование» — по умолчанию: люди раскладывают сами. */
const ROLE_OPTIONS: Array<{ value: FolderRole; label: string }> = [
  { value: 'move', label: 'Перемещение и редактирование' },
  { value: 'edit', label: 'Редактирование' },
  { value: 'view', label: 'Просмотр' },
];
/** В строке «У кого есть доступ» места мало — подписи короче (полные — в выборе при выдаче). */
const ROW_LABEL: Record<FolderRole, string> = { move: 'Перемещение', edit: 'Редактирование', view: 'Просмотр' };
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
  const [shares, setShares] = useState<ShareEntry[]>([]);
  const [deptShares, setDeptShares] = useState<DeptShareEntry[]>([]);
  const [inherited, setInherited] = useState<InheritedShare[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
  const apply = (next: { shares: ShareEntry[]; departments: DeptShareEntry[]; inherited?: InheritedShare[] }) => { setShares(next.shares); setDeptShares(next.departments); setInherited(next.inherited ?? []); onChanged(); };

  useEffect(() => {
    workspaceApi.folderShares(folder.id).then((next) => { setShares(next.shares); setDeptShares(next.departments); setInherited(next.inherited ?? []); }).catch(fail);
  }, [folder.id]);

  async function setShare(target: { userId: string } | { departmentId: string }, next: FolderRole | null) {
    setError('');
    try { apply(await workspaceApi.setFolderShare(folder.id, target, next)); } catch (cause) { fail(cause); }
  }

  /** Сразу нескольким. Человеку — доступ и сообщение в личный чат; отделу — папка просто появляется у всех его сотрудников. */
  async function give(targets: PickTarget[], giveRole: string): Promise<boolean> {
    const role = giveRole as FolderRole;
    setBusy(true);
    setError('');
    const done: string[] = [];
    try {
      for (const target of targets) {
        if (target.kind === 'department') {
          apply(await workspaceApi.setFolderShare(folder.id, { departmentId: target.id }, role));
        } else {
          apply(await workspaceApi.setFolderShare(folder.id, { userId: target.id }, role));
          const chatId = await createChat([target.id]);
          if (chatId) sendText(chatId, `Открыл(а) вам папку «${folder.title}» в «Офисе» — ${ROLE_MESSAGE[role]}.`);
        }
        done.push(target.name);
      }
      showToast(`Папка открыта: ${done.join(', ')}`, 'success');
      return true;
    } catch (cause) {
      fail(cause);
      if (done.length) showToast(`Успели открыть: ${done.join(', ')}`, 'info');
      return false;
    } finally { setBusy(false); }
  }

  return (
    <Sheet title={`Доступ к папке: ${folder.title}`} onClose={onClose}>
      <div className="nws-share">
        <Group title="Открыть папку" note="Видно всё содержимое, включая вложенные папки и то, что вы положите в неё позже. Перекладывать внутри и добавлять своё могут те, у кого «Перемещение и редактирование».">
          <PeoplePicker
            excludeUsers={shares.map((s) => s.userId)}
            excludeDepartments={deptShares.map((d) => d.departmentId)}
            roles={ROLE_OPTIONS}
            defaultRole="move"
            busy={busy}
            submitLabel={() => 'Открыть'}
            onSubmit={give}
          />
        </Group>

        <Group title="У кого есть доступ">
          <div className="nx-row">
            <PersonLabel userId={myId()} />
            <span className="nx-row-hint">Владелец</span>
          </div>
          {deptShares.map((share) => (
            <div key={share.departmentId} className="nx-row">
              <span className="nws-person">
                <span className="nws-picker-dept" aria-hidden="true"><Building2 size={16} /></span>
                <span className="nx-row-text">
                  <span className="nx-row-label">{share.name}</span>
                  <span className="nx-row-hint">Отдел · {share.members} чел.</span>
                </span>
              </span>
              <div className="nx-row-control">
                <select className="nws-select" value={share.role} onChange={(e) => void setShare({ departmentId: share.departmentId }, e.target.value as FolderRole)} aria-label={`Права отдела: ${share.name}`}>
                  {ROLE_OPTIONS.map((o) => <option key={o.value} value={o.value} title={o.label}>{ROW_LABEL[o.value]}</option>)}
                </select>
                <button type="button" className="nx-icon-btn" onClick={() => void setShare({ departmentId: share.departmentId }, null)} aria-label={`Закрыть папку отделу: ${share.name}`}><X size={15} /></button>
              </div>
            </div>
          ))}
          {shares.map((share) => (
            <div key={share.userId} className="nx-row">
              <PersonLabel userId={share.userId} name={share.name} />
              <div className="nx-row-control">
                <select className="nws-select" value={share.role} onChange={(e) => void setShare({ userId: share.userId }, e.target.value as FolderRole)} aria-label={`Права: ${share.name}`}>
                  {ROLE_OPTIONS.map((o) => <option key={o.value} value={o.value} title={o.label}>{ROW_LABEL[o.value]}</option>)}
                </select>
                <button type="button" className="nx-icon-btn" onClick={() => void setShare({ userId: share.userId }, null)} aria-label={`Закрыть папку: ${share.name}`}><X size={15} /></button>
              </div>
            </div>
          ))}
          <InheritedShares entries={inherited} />
        </Group>
        {error && <p className="nws-error" role="alert">{error}</p>}
      </div>
    </Sheet>
  );
}
