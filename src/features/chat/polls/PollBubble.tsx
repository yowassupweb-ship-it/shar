import { useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Check } from 'lucide-react';
import type { User } from '@/shared/types/chat';
import { Avatar } from '@/shared/ui/Avatar';
import { Sheet } from '@/shared/ui/overlay';

export interface PollOption {
  id: string;
  text: string;
  voters: string[];
}

export interface PollData {
  question: string;
  options: PollOption[];
  multipleChoice: boolean;
  isAnonymous: boolean;
  /** Whether a voter can change/retract their vote after casting it. Off by
   * default — handleVotePoll (page.tsx) enforces this by ignoring further clicks
   * once the current user has any vote recorded and this is false. */
  allowRevote: boolean;
}

interface PollBubbleProps {
  poll: PollData;
  messageId: string;
  currentUserId?: string;
  usersById: Map<string, User>;
  textColor?: string;
  onVote?: (messageId: string, optionId: string) => void;
}

/** Имя для списка проголосовавших: «Вы» — первым. */
function voterName(u: User | undefined, id: string, uid: string): string {
  if (id === uid) return 'Вы';
  return (u?.name || u?.username || 'Сотрудник').trim();
}

/**
 * «Кто проголосовал» — окном (модалкой), а не всплывашкой: список длинный, его нужно листать, а всплывашка
 * исчезает вместе с наведением. Варианты по порядку, у каждого — число и люди с аватарками («Вы» первым).
 * Открывается щелчком по строке с аватарками под вариантом или по счётчику голосов внизу; openOption — вариант,
 * к которому прокрутить.
 */
function VotersModal({ poll, usersById, uid, openOption, onClose }: {
  poll: PollData; usersById: Map<string, User>; uid: string; openOption: string | null; onClose: () => void;
}) {
  const total = poll.options.reduce((sum, o) => sum + (o.voters?.length || 0), 0);
  return (
    <Sheet title={poll.question || 'Опрос'} onClose={onClose} footer={<button type="button" className="nx-primary" onClick={onClose}>Закрыть</button>}>
      <div className="cxm-voters">
        <p className="nx-note">{total ? `${total} ${pluralVotes(total)}` : 'Пока никто не проголосовал'}</p>
        {poll.options.map((opt) => {
          const ids = [...new Set((opt.voters || []).map(String))].sort((a, b) => Number(b === uid) - Number(a === uid));
          return (
            <section
              key={opt.id}
              className="cxm-voters-group"
              data-open={opt.id === openOption || undefined}
              ref={(el) => { if (el && opt.id === openOption) el.scrollIntoView({ block: 'nearest' }); }}
            >
              <h3>
                <span>{opt.text}</span>
                <b>{ids.length}{total ? ` · ${Math.round((ids.length / total) * 100)}%` : ''}</b>
              </h3>
              {ids.length === 0 ? <p className="cxm-voters-empty">Нет голосов</p> : ids.map((id) => {
                const u = usersById.get(id);
                const name = voterName(u, id, uid);
                return (
                  <div key={id} className="cxm-voters-person">
                    <Avatar name={name} seed={id} src={u?.avatar} person size={28} />
                    <span>{name}</span>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>
    </Sheet>
  );
}

// Telegram-style poll bubble: question, tappable option rows with a proportional
// fill bar and vote count, own vote(s) marked with a check. Non-anonymous polls
// additionally show who voted for each option (стопка аватарок под вариантом; полный список — в окне
// «Кто проголосовал»); anonymous polls only ever show counts/percentages, never names.
export default function PollBubble({ poll, messageId, currentUserId, usersById, textColor, onVote }: PollBubbleProps) {
  const totalVotes = poll.options.reduce((sum, o) => sum + (o.voters?.length || 0), 0);
  const uid = currentUserId ? String(currentUserId) : '';
  const votedAnywhere = !!uid && poll.options.some(o => (o.voters || []).includes(uid));
  // Matches handleVotePoll's own lock check (page.tsx) — shown here purely as a
  // visual cue (dimmed, non-interactive cursor) so a click that page.tsx will
  // ignore anyway doesn't look like the button is just broken.
  const locked = votedAnywhere && !poll.allowRevote;
  // Окно проголосовавших: null — закрыто; '' — открыто с начала; id — прокрутить к варианту.
  const [voters, setVoters] = useState<string | null>(null);
  const showVoters = !poll.isAnonymous && totalVotes > 0;

  return (
    <div className="flex flex-col gap-2.5" style={{ color: textColor, minWidth: 220 }}>
      <div className="flex items-start gap-1.5">
        <span className="text-[15px] font-semibold leading-snug">{poll.question}</span>
      </div>
      <div className="text-[11px] opacity-70">
        {poll.isAnonymous ? 'Анонимный опрос' : 'Опрос'}{poll.multipleChoice ? ' · можно выбрать несколько' : ''}
      </div>

      <div className="flex flex-col gap-1.5">
        {poll.options.map((opt) => {
          const votes = opt.voters?.length || 0;
          const pct = totalVotes > 0 ? Math.round((votes / totalVotes) * 100) : 0;
          const votedByMe = !!uid && (opt.voters || []).includes(uid);
          const voterIds = !poll.isAnonymous ? (opt.voters || []).map(String) : [];
          // Строка с аватарками лежит внутри кнопки варианта: вложенную кнопку нельзя, поэтому span с ролью кнопки;
          // щелчок по ней не голосует, а открывает окно.
          const openVoters = (e: MouseEvent | KeyboardEvent) => { e.stopPropagation(); e.preventDefault(); setVoters(opt.id); };

          return (
            <button
              key={opt.id}
              type="button"
              disabled={locked}
              onClick={() => onVote?.(messageId, opt.id)}
              className="relative w-full text-left"
              style={{
                borderRadius: 12,
                padding: '8px 10px',
                border: `1px solid ${votedByMe ? 'color-mix(in srgb, currentColor 45%, transparent)' : 'color-mix(in srgb, currentColor 14%, transparent)'}`,
                background: 'color-mix(in srgb, currentColor 6%, transparent)',
                cursor: locked ? 'default' : 'pointer',
                opacity: locked && !votedByMe ? 0.6 : 1,
              }}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="flex items-start gap-1.5 min-w-0">
                  {votedByMe && (
                    <span
                      className="flex items-center justify-center flex-shrink-0"
                      style={{ width: 16, height: 16, borderRadius: '50%', background: 'currentColor', marginTop: 1 }}
                    >
                      <Check className="w-2.5 h-2.5" style={{ color: textColor, mixBlendMode: 'difference' }} strokeWidth={3} />
                    </span>
                  )}
                  {/* Was `truncate` (single line, ellipsis) — option text needs to be
                      fully readable, not cut off, so it wraps across as many lines as
                      it needs instead. */}
                  <span className="text-[14px] break-words">{opt.text}</span>
                </span>
                <span className="text-[12px] font-semibold opacity-80 flex-shrink-0">{totalVotes > 0 ? `${pct}%` : ''}</span>
              </div>
              {/* A translucent overlay behind the text was nearly invisible on a
                  same-hue bubble (couldn't tell which option had more votes at a
                  glance) — a dedicated track+fill bar underneath, with the fill at
                  FULL currentColor opacity against a faint track, reads clearly
                  regardless of bubble color or theme. */}
              <div
                className="w-full mt-1.5"
                style={{ height: 4, borderRadius: 2, background: 'color-mix(in srgb, currentColor 18%, transparent)', overflow: 'hidden' }}
              >
                <div
                  style={{
                    height: '100%', width: `${pct}%`, borderRadius: 2,
                    background: 'currentColor', opacity: 0.85,
                    transition: 'width 0.3s ease',
                  }}
                />
              </div>
              {voterIds.length > 0 && (
                <span
                  role="button"
                  tabIndex={0}
                  className="cxm-voters-open flex items-center gap-1.5 mt-1.5 text-[11px]"
                  aria-label={`Кто проголосовал за «${opt.text}»: ${voterIds.length}`}
                  onClick={openVoters}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openVoters(e); }}
                >
                  <span className="inline-flex">
                    {voterIds.slice(0, 5).map((id, i) => {
                      const u = usersById.get(id);
                      return (
                        <span key={id} style={{ marginLeft: i ? -5 : 0, borderRadius: '50%', boxShadow: '0 0 0 1px var(--element-bg)' }}>
                          <Avatar name={voterName(u, id, uid)} seed={id} src={u?.avatar} person size={16} />
                        </span>
                      );
                    })}
                  </span>
                  <span className="truncate">
                    {voterIds.length <= 2
                      ? voterIds.map((id) => voterName(usersById.get(id), id, uid)).join(', ')
                      : `${voterIds.length} чел.`}
                  </span>
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="text-[11px] opacity-60">
        {totalVotes === 0 ? 'Нет голосов' : showVoters ? (
          <button type="button" className="cxm-voters-link" onClick={() => setVoters('')}>{totalVotes} {pluralVotes(totalVotes)} · кто проголосовал</button>
        ) : `${totalVotes} ${pluralVotes(totalVotes)}`}
      </div>
      {voters !== null && <VotersModal poll={poll} usersById={usersById} uid={uid} openOption={voters || null} onClose={() => setVoters(null)} />}
    </div>
  );
}

function pluralVotes(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'голос';
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'голоса';
  return 'голосов';
}
