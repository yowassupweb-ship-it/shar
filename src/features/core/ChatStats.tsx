import { Hourglass } from 'lucide-react';
import { plural } from '@/shared/ui/format';
import type { CoreLimit, CoreMessage, CoreThread } from './api';
import { formatTokens, modelLabel } from './parts';

const AGENT_NAME: Record<string, string> = { gemini: 'Gemini', claude: 'Claude', codex: 'GPT' };
const WINDOW_NAME: Record<string, string> = { five_hour: '5 ч', seven_day: 'неделя', seven_day_opus: 'неделя Opus', seven_day_sonnet: 'неделя Sonnet' };

/** Лимиты подписки агента — в шапке чата: кольцо израсходованного окна и процент; когда сбросится — в подсказке. */
export function LimitBadges({ limits, agent }: { limits?: CoreLimit[]; agent: string }) {
  if (!limits?.length) return null;
  return (
    <span className="ncore-limits" aria-label={`Лимиты подписки ${agent}`}>
      {limits.map((l) => {
        const reset = l.resetsAt ? new Date(l.resetsAt * 1000).toLocaleString('ru-RU', { weekday: l.type.startsWith('seven') ? 'short' : undefined, hour: '2-digit', minute: '2-digit' }) : '';
        const tone = /reject|block|exceed/i.test(l.status) || l.used >= 100 ? 'bad' : l.used >= 80 ? 'warn' : undefined;
        const used = Math.min(100, Math.max(0, l.used));
        return (
          <span key={l.type} className="ncore-limit-badge" data-tone={tone} title={`${agent}: ${WINDOW_NAME[l.type] || l.type} — израсходовано ${l.used}%${reset ? `, сбросится ${reset}` : ''}${l.overage ? ', идёт перерасход' : ''}`}>
            <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
              <circle cx="7" cy="7" r="5.5" pathLength="100" />
              <circle cx="7" cy="7" r="5.5" pathLength="100" strokeDasharray={`${used} 100`} />
            </svg>
            <span className="ncore-limit-name">{WINDOW_NAME[l.type] || l.type}</span> {l.used}%
          </span>
        );
      })}
    </span>
  );
}

function seconds(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} мин ${s % 60} с` : `${s} с`;
}

/**
 * Статистика чата — по открытым сообщениям: загрузка контекста (сколько агент перечитывает на каждом шаге), токены,
 * доля из кэша, ответы и их время по агентам, последний лимит подписки. Денег нет: Claude и GPT — по подписке,
 * расход Gemini по ключу — в Настройки → Ядро.
 */
export function ChatStats({ thread, messages }: { thread: CoreThread | null; messages: CoreMessage[] }) {
  const answers = messages.filter((m) => m.role === 'agent' && m.status !== 'queued' && m.status !== 'working');
  const total = { input: 0, cached: 0, output: 0, ms: 0, steps: 0, failed: 0 };
  const byAgent = new Map<string, { runs: number; ms: number; model: string }>();
  for (const m of answers) {
    const w = m.props.work || {};
    total.input += w.input_tokens || 0;
    total.cached += w.cached_input_tokens || 0;
    total.output += (w.output_tokens || 0) + (w.thinking_tokens || 0);
    total.ms += w.duration_ms || 0;
    total.steps += (m.props.steps || []).filter((s) => s.kind === 'tool').length;
    if (m.status === 'failed' || m.props.failed) total.failed += 1;
    const key = m.props.provider || m.actor;
    const row = byAgent.get(key) || { runs: 0, ms: 0, model: '' };
    row.runs += 1;
    row.ms += w.duration_ms || 0;
    row.model = m.props.model || row.model;
    byAgent.set(key, row);
  }
  const context = thread?.lastWork?.context_tokens || 0;
  const window = thread?.lastWork?.context_window || 0;
  const share = window ? Math.min(1, context / window) : 0;
  const limit = [...answers].reverse().find((m) => m.props.rateLimit)?.props.rateLimit;

  return (
    <section className="ncore-stats" aria-label="Статистика чата">
      <div className="ncore-stat" data-wide="">
        <span className="ncore-stat-label">Контекст</span>
        <b>{context ? formatTokens(context) : '—'}{window ? <small> из {formatTokens(window)}</small> : null}</b>
        <i className="ncore-stat-bar" data-heavy={share >= 0.6 || undefined}><i style={{ width: `${Math.max(1, Math.round(share * 100))}%` }} /></i>
        <span className="ncore-stat-hint">{share >= 0.6 ? 'Тяжёлый — /compact сожмёт или начните новый чат' : 'Столько агент перечитывает на каждом шаге'}</span>
      </div>
      <div className="ncore-stat">
        <span className="ncore-stat-label">Токены</span>
        <b>{formatTokens(total.input + total.output)}</b>
        <span className="ncore-stat-hint">вход {formatTokens(total.input)} · выход {formatTokens(total.output)}</span>
      </div>
      <div className="ncore-stat">
        <span className="ncore-stat-label">Из кэша</span>
        <b>{total.input ? `${Math.round((total.cached / total.input) * 100)}%` : '—'}</b>
        <span className="ncore-stat-hint">чем больше, тем дешевле и быстрее</span>
      </div>
      <div className="ncore-stat">
        <span className="ncore-stat-label">Ответы</span>
        <b>{answers.length}</b>
        <span className="ncore-stat-hint">
          {answers.length ? `в среднем ${seconds(total.ms / answers.length)} · ${total.steps} ${plural(total.steps, ['шаг', 'шага', 'шагов'])}` : 'ещё не было'}
          {total.failed ? ` · ${total.failed} без ответа` : ''}
        </span>
      </div>
      {byAgent.size > 0 && (
        <div className="ncore-stat" data-wide="">
          <span className="ncore-stat-label">Агенты</span>
          <span className="ncore-stat-agents">
            {[...byAgent].map(([key, row]) => (
              <span key={key}><b>{AGENT_NAME[key] || key}</b>{row.model ? ` ${modelLabel(row.model)}` : ''} · {row.runs} · {seconds(row.ms / row.runs)}</span>
            ))}
          </span>
        </div>
      )}
      {limit && (
        <div className="ncore-stat" data-wide="" data-tone="warn">
          <span className="ncore-stat-label"><Hourglass size={11} aria-hidden="true" /> Лимит подписки</span>
          <span className="ncore-stat-hint">{limit.provider ? `${limit.provider}: ` : ''}{limit.used_percent ?? 100}%{limit.detail ? ` · ${limit.detail}` : ''}</span>
        </div>
      )}
    </section>
  );
}
