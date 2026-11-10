import { useState } from 'react';
import { ArrowLeft, ArrowRight, RotateCcw, Settings2, X } from 'lucide-react';
import { SharEmojiPicker } from '@/shared/emoji/SharEmojiPicker';
import { getAppleEmojiUrl } from '@/shared/emoji/appleEmoji';
import { DEFAULT_PINNED, MAX_PINNED, resetPinnedReactions, setPinnedReactions, usePinnedReactions } from '../reactionPrefs';

/**
 * Панель реакций: полный выбор эмодзи и настройка закреплённых.
 * Обычный режим — выбранный эмодзи ставится реакцией. «Настроить» — сверху ряд закреплённых (их видно в меню сообщения
 * сразу): убрать, сдвинуть, вернуть набор по умолчанию; выбранный в списке эмодзи добавляется в ряд, а не ставится.
 */
export function ReactionPicker({ onReact }: { onReact: (emoji: string) => void }) {
  const pinned = usePinnedReactions();
  const [editing, setEditing] = useState(false);

  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= pinned.length) return;
    const next = pinned.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setPinnedReactions(next);
  };
  const add = (emoji: string) => {
    if (pinned.includes(emoji) || pinned.length >= MAX_PINNED) return;
    setPinnedReactions([...pinned, emoji]);
  };
  const isDefault = pinned.length === DEFAULT_PINNED.length && pinned.every((e, i) => e === DEFAULT_PINNED[i]);

  return (
    <div className="cxm-rp">
      <div className="cxm-rp-head">
        <b>{editing ? 'Закреплённые реакции' : 'Реакция'}</b>
        <button type="button" className="cxm-rp-toggle" aria-pressed={editing} onClick={() => setEditing((v) => !v)} title={editing ? 'Готово' : 'Настроить закреплённые'}>
          {editing ? 'Готово' : <><Settings2 size={13} aria-hidden="true" /> Настроить</>}
        </button>
      </div>
      {editing && (
        <div className="cxm-rp-edit">
          <div className="cxm-rp-slots" role="list" aria-label="Закреплённые реакции">
            {pinned.map((e, i) => (
              <span key={e} className="cxm-rp-slot" role="listitem">
                <img src={getAppleEmojiUrl(e)} alt={e} draggable={false} />
                <span className="cxm-rp-slot-tools">
                  <button type="button" aria-label="Сдвинуть влево" disabled={i === 0} onClick={() => move(i, -1)}><ArrowLeft size={11} /></button>
                  <button type="button" aria-label="Убрать" onClick={() => setPinnedReactions(pinned.filter((x) => x !== e))}><X size={11} /></button>
                  <button type="button" aria-label="Сдвинуть вправо" disabled={i === pinned.length - 1} onClick={() => move(i, 1)}><ArrowRight size={11} /></button>
                </span>
              </span>
            ))}
            {Array.from({ length: Math.max(0, MAX_PINNED - pinned.length) }, (_, i) => <span key={`empty${i}`} className="cxm-rp-slot" data-empty="true" aria-hidden="true" />)}
          </div>
          <p className="cxm-rp-hint">
            {pinned.length >= MAX_PINNED ? `Закреплено ${MAX_PINNED} — уберите лишнюю, чтобы добавить новую.` : 'Нажмите на эмодзи ниже, чтобы закрепить его.'}
            {!isDefault && <button type="button" className="cxm-rp-reset" onClick={resetPinnedReactions}><RotateCcw size={11} aria-hidden="true" /> По умолчанию</button>}
          </p>
        </div>
      )}
      <SharEmojiPicker autoFocus={!editing} onPick={editing ? add : onReact} />
    </div>
  );
}
