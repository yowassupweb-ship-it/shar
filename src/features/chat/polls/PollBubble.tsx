import { Check, Users as UsersIcon } from 'lucide-react';
import type { User } from '@/shared/types/chat';

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

// Telegram-style poll bubble: question, tappable option rows with a proportional
// fill bar and vote count, own vote(s) marked with a check. Non-anonymous polls
// additionally list who voted for each option (reusing the same info the vote
// data already carries — see the isAnonymous note on handleVotePoll's metadata
// shape); anonymous polls only ever show counts/percentages, never names.
export default function PollBubble({ poll, messageId, currentUserId, usersById, textColor, onVote }: PollBubbleProps) {
  const totalVotes = poll.options.reduce((sum, o) => sum + (o.voters?.length || 0), 0);
  const uid = currentUserId ? String(currentUserId) : '';
  const votedAnywhere = !!uid && poll.options.some(o => (o.voters || []).includes(uid));
  // Matches handleVotePoll's own lock check (page.tsx) — shown here purely as a
  // visual cue (dimmed, non-interactive cursor) so a click that page.tsx will
  // ignore anyway doesn't look like the button is just broken.
  const locked = votedAnywhere && !poll.allowRevote;

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
          const voterNames = !poll.isAnonymous
            ? (opt.voters || []).map(id => usersById.get(String(id))?.name || usersById.get(String(id))?.username).filter(Boolean) as string[]
            : [];

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
              {voterNames.length > 0 && (
                <div className="flex items-center gap-1 mt-1.5 text-[11px] opacity-70">
                  <UsersIcon className="w-3 h-3 flex-shrink-0" />
                  <span className="truncate">{voterNames.join(', ')}</span>
                </div>
              )}
            </button>
          );
        })}
      </div>

      <div className="text-[11px] opacity-60">
        {totalVotes === 0 ? 'Нет голосов' : `${totalVotes} ${pluralVotes(totalVotes)}`}
      </div>
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
