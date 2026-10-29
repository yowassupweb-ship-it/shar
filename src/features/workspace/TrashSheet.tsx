import { useCallback, useEffect, useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { askConfirm, Sheet } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { Spinner } from '@/shared/ui/Spinner';
import { workspaceApi } from './api';
import { KINDS } from './kinds';
import type { TrashItem, TrashState } from './types';

/** Postgres отдаёт «2026-10-16 16:20:25.039012+03»: приводим к виду, который понимает Date. */
const parseWhen = (iso: string) => Date.parse(iso.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1').replace(/([+-]\d{2})$/, '$1:00'));

const daysLeft = (iso: string) => Math.max(0, Math.ceil((parseWhen(iso) - Date.now()) / 86_400_000));

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  return `${n} ${m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many}`;
};

/**
 * Корзина «Офиса»: удалённое лежит здесь state.days дней — у автора, у того, кто удалил, и у владельца папки, где
 * материал лежал. «Вернуть» ставит материал на прежнее место; «Стереть навсегда» — автору и владельцу папки.
 */
export function TrashSheet({ onClose, onRestored }: { onClose: () => void; onRestored: () => void }) {
  const [state, setState] = useState<TrashState | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    workspaceApi.trash().then(setState).catch((cause) => setError(cause instanceof Error ? cause.message : 'Не удалось открыть корзину'));
  }, []);
  useEffect(load, [load]);

  async function restore(item: TrashItem) {
    setBusy(item.id);
    try {
      await workspaceApi.restoreFromTrash(item.id);
      setState((cur) => cur && { ...cur, items: cur.items.filter((i) => i.id !== item.id) });
      showToast(`Возвращено: «${item.title || KINDS[item.kind].untitled}»`, 'success');
      onRestored();
    } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось вернуть', 'error'); } finally { setBusy(''); }
  }

  async function purge(item: TrashItem) {
    const ok = await askConfirm({ title: `Стереть «${item.title || KINDS[item.kind].untitled}» навсегда?`, text: 'Вернуть будет нельзя: пропадут и история версий, и комментарии.', confirm: 'Стереть', tone: 'danger' });
    if (!ok) return;
    setBusy(item.id);
    try {
      await workspaceApi.purgeFromTrash(item.id);
      setState((cur) => cur && { ...cur, items: cur.items.filter((i) => i.id !== item.id) });
    } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось стереть', 'error'); } finally { setBusy(''); }
  }

  return (
    <Sheet title="Корзина" onClose={onClose}>
      <div className="nws-trash">
        <p className="nx-note">
          {state && !state.ready
            ? 'Корзина ещё не включена на сервере: удалённое стирается сразу.'
            : `Удалённое хранится ${plural(state?.days ?? 30, 'день', 'дня', 'дней')}, потом стирается само. Вернуть может автор, тот, кто удалил, и владелец папки.`}
        </p>
        {error && <p className="nws-error" role="alert">{error}</p>}
        {!state && !error && <div className="nws-loading"><Spinner size={20} label="Загружаю" /></div>}
        {state?.ready && !state.items.length && <p className="nws-trash-empty">Корзина пуста</p>}
        {state?.items.map((item) => {
          const info = KINDS[item.kind];
          const left = daysLeft(item.purgeAt);
          return (
            <div key={item.id} className="nx-row nws-trash-row">
              <info.icon size={18} aria-hidden="true" className="nws-trash-icon" />
              <span className="nx-row-text">
                <span className="nx-row-label">{item.title || info.untitled}</span>
                <span className="nx-row-hint">
                  {item.isOwner ? '' : `${item.ownerName || 'Коллега'} · `}
                  удалил(а) {item.deletedBy && item.deletedByName ? item.deletedByName : 'кто-то'} · {left ? `сотрётся через ${plural(left, 'день', 'дня', 'дней')}` : 'сотрётся сегодня'}
                </span>
              </span>
              <div className="nx-row-control">
                <button type="button" className="nx-ghost" disabled={Boolean(busy)} onClick={() => void restore(item)}>
                  {busy === item.id ? <Spinner size={13} /> : <RotateCcw size={14} aria-hidden="true" />} Вернуть
                </button>
                {item.canPurge && (
                  <button type="button" className="nx-icon-btn" disabled={Boolean(busy)} onClick={() => void purge(item)} aria-label={`Стереть навсегда: ${item.title || info.untitled}`} title="Стереть навсегда">
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Sheet>
  );
}
