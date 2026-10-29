import { memo, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { AlertTriangle, Check, ChevronRight, Copy, FileText, Globe, Pencil, Search, Table2, Wrench } from 'lucide-react';
import { plural } from '@/shared/ui/format';
import type { CoreStep, CoreWork } from './api';

export const EFFORT_LABEL: Record<string, string> = { low: 'быстро', medium: 'обычно', high: 'тщательно' };

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace('.', ',')} млн`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace('.', ',')} тыс.`;
  return String(n);
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
  if (n >= 1024) return `${Math.round(n / 1024)} КБ`;
  return `${n} Б`;
}

/** «вход 41 тыс. · кэш 34 тыс. · выход 2,4 тыс. · 12 с» — сколько стоила работа, без денег (подписка). */
export function workParts(work?: CoreWork): string[] {
  if (!work) return [];
  const parts: string[] = [];
  const add = (value: number | undefined, label: string) => { if (value) parts.push(`${label} ${formatTokens(value)}`); };
  add(work.input_tokens, 'вход');
  add(work.cached_input_tokens, 'кэш');
  add(work.output_tokens, 'выход');
  add(work.thinking_tokens, 'размышление');
  const seconds = Math.round((work.duration_ms || 0) / 1000);
  if (seconds) parts.push(seconds >= 60 ? `${Math.floor(seconds / 60)} мин ${seconds % 60} с` : `${seconds} с`);
  return parts;
}

// ── Markdown ответа ─────────────────────────────────────────────────────────

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = String((children as { props?: { children?: unknown } })?.props?.children ?? '').replace(/\n$/, '');
  return (
    <div className="ncore-code">
      <button type="button" className="ncore-code-copy" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1400); }); }}
        aria-label="Скопировать код" title="Скопировать">
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <pre>{children}</pre>
    </div>
  );
}

/** Ответ агента: Markdown с таблицами и кодом. Ссылки — в новом окне; таблица широкая — прокручивается сама. */
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <div className="ncore-md">
      <Markdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          table: ({ children }) => <div className="ncore-table"><table>{children}</table></div>,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
});

// ── Цепочка шагов ───────────────────────────────────────────────────────────

/** Сколько шагов видно без разворота: последние — это и есть «что происходит сейчас». */
const VISIBLE_STEPS = 4;

const STEP_ICON: Array<[RegExp, typeof Search]> = [
  [/search|find|grep|glob/i, Search],
  [/table|sheet|cell/i, Table2],
  [/write|edit|update|create|patch/i, Pencil],
  [/web|fetch|http|browser/i, Globe],
  [/read|doc|note|item|file/i, FileText],
];
const iconFor = (name = '') => STEP_ICON.find(([re]) => re.test(name))?.[1] ?? Wrench;

/** Что агент делал: шаги с аргументами и результатом. Длинную цепочку сворачиваем до последних шагов. */
export function Chain({ steps, live, status }: { steps: CoreStep[]; live?: boolean; status?: ReactNode }) {
  const [full, setFull] = useState(false);
  const [open, setOpen] = useState(true);
  const hidden = full ? 0 : Math.max(0, steps.length - VISIBLE_STEPS);
  const shown = hidden ? steps.slice(hidden) : steps;
  const tools = steps.filter((s) => s.kind === 'tool').length;
  const errors = steps.filter((s) => s.is_error).length;
  return (
    <div className="ncore-chain" data-live={live || undefined}>
      <button type="button" className="ncore-chain-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <ChevronRight size={13} className="ncore-chain-chevron" aria-hidden="true" />
        {status ?? <strong>Ход работы</strong>}
        <span className="ncore-chain-count">
          {tools} {plural(tools, ['шаг', 'шага', 'шагов'])}{errors ? ` · ${errors} ${plural(errors, ['ошибка', 'ошибки', 'ошибок'])}` : ''}
        </span>
      </button>
      {open && (
        <>
          {hidden > 0 && (
            <button type="button" className="ncore-chain-more" onClick={() => setFull(true)}>
              ещё {hidden} {plural(hidden, ['шаг', 'шага', 'шагов'])} выше
            </button>
          )}
          <ol className="ncore-chain-list">
            {shown.map((step, index) => {
              if (step.kind === 'text') {
                return <li key={hidden + index} className="ncore-chain-say"><p>{step.text}</p></li>;
              }
              const Icon = iconFor(step.name);
              return (
                <li key={hidden + index} data-error={step.is_error || undefined}>
                  <details className="ncore-chain-step">
                    <summary title={step.name}>
                      <Icon size={13} className="ncore-chain-icon" aria-hidden="true" />
                      <b>{step.hint || step.name}</b>
                      {step.is_error && <em className="ncore-chain-err"><AlertTriangle size={11} aria-hidden="true" /> ошибка</em>}
                      {step.ms ? <time>{step.ms >= 1000 ? `${Math.round(step.ms / 1000)} с` : `${step.ms} мс`}</time> : null}
                    </summary>
                    {step.input && <pre className="ncore-chain-io" data-label="Вход">{step.input}</pre>}
                    {step.output && <pre className="ncore-chain-io" data-label="Результат">{step.output}</pre>}
                  </details>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </div>
  );
}
