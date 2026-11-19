import type { ProviderId } from './api';

/**
 * Нагрузка (effort) — словами того агента, что отвечает. Нода переводит одни и те же три ступени в настройку каждого
 * CLI: Claude --effort, GPT model_reasoning_effort, Kimi — свой режим мышления (low / high / max). Как в Senate.
 */

export interface EffortOption { value: string; label: string; hint?: string }

const BY: Record<'claude' | 'codex' | 'kimi', { title: string; def: string; low: string; medium: string; high: string; names?: [string, string, string] }> = {
  claude: { title: 'Claude · effort', def: 'Claude решает сам: глубже на трудном', low: 'effort low — быстро, бережёт лимит', medium: 'effort medium', high: 'effort high — глубоко, дороже по лимиту' },
  codex: { title: 'GPT · reasoning effort', def: 'как по умолчанию у модели', low: 'reasoning low — быстро', medium: 'reasoning medium', high: 'reasoning high — дольше и дороже' },
  // У Kimi ровно три уровня, и называет он их сам: low, high (его обычный), max.
  kimi: { title: 'Kimi · thinking', def: 'как у самого Kimi: High', low: 'быстрее всего, думает мало', medium: 'обычный режим Kimi', high: 'самый глубокий и самый медленный', names: ['Low', 'High', 'Max'] },
};

export function effortProvider(agentId?: string): 'claude' | 'codex' | 'kimi' | '' {
  return agentId === 'claude' || agentId === 'codex' || agentId === 'kimi' ? agentId : '';
}

export function effortTitle(agentId?: string): string {
  const p = effortProvider(agentId);
  return p ? BY[p].title : 'Нагрузка: как долго думать перед ответом';
}

export function effortOptions(agentId?: string): EffortOption[] {
  const p = effortProvider(agentId);
  if (!p) {
    return [
      { value: '', label: 'Обычно', hint: 'Как настроено у агента' },
      { value: 'low', label: 'Быстро', hint: 'Самый быстрый режим агента' },
      { value: 'medium', label: 'Средне' },
      { value: 'high', label: 'Тщательно', hint: 'Дольше думает, дороже по лимитам' },
    ];
  }
  const b = BY[p];
  return [
    { value: '', label: 'По умолчанию', hint: b.def },
    { value: 'low', label: b.names?.[0] ?? 'Быстро', hint: b.low },
    { value: 'medium', label: b.names?.[1] ?? 'Средне', hint: b.medium },
    { value: 'high', label: b.names?.[2] ?? 'Тщательно', hint: b.high },
  ];
}

/** У каких агентов есть окна подписки (5 часов, неделя, месяц). */
export const LIMIT_PROVIDERS: ProviderId[] = ['claude', 'codex', 'kimi'];
