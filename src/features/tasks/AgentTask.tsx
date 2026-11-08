import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Bot, CheckCircle2, ExternalLink, Play } from 'lucide-react';
import { navigate } from '@/shared/navigation/navigate';
import { Sheet } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { repeatIdOf, repeatLabel } from './repeat';
import { parseDue } from './due';
import { runTaskAgent, saveTaskAgent, taskAgent, useAgentReportTick, type Task, type TaskAgent } from './api';

/**
 * Поручить задачу агенту «Ядра». Агент просыпается по сроку задачи (в его время; у повторяющейся — на каждое наступление),
 * выполняет её от имени человека с его правами, пишет отчёт сюда и засыпает. Весь ход работы — в отдельном чате «Ядра».
 */

const EFFORTS: { id: 'low' | 'medium' | 'high'; label: string }[] = [{ id: 'low', label: 'Быстро' }, { id: 'medium', label: 'Обычно' }, { id: 'high', label: 'Вдумчиво' }];

const stamp = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
};

/** Что будет, словами — до сохранения: по сроку и повтору задачи. */
function plan(task: Task, time: string): string {
  const rep = repeatIdOf(task);
  const due = parseDue(task.dueDate);
  const at = due?.time || time;
  if (rep !== 'none') return `Будет просыпаться ${repeatLabel(rep).toLowerCase()} в ${at}.`;
  if (!due) return 'У задачи нет срока — агент выполнит её сразу после сохранения.';
  const [h, m] = at.split(':').map(Number);
  const when = new Date(due.day.getFullYear(), due.day.getMonth(), due.day.getDate(), h, m);
  const label = `${when.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })} в ${at}`;
  return when.getTime() <= Date.now() ? `Срок (${label}) уже прошёл — агент выполнит задачу сразу.` : `Выполнит один раз: ${label}.`;
}

export function AgentSheet({ task, state, onClose, onChanged }: { task: Task; state: TaskAgent; onClose: () => void; onChanged: (s: TaskAgent) => void }) {
  const [provider, setProvider] = useState(state.provider || state.agents[0]?.provider || '');
  const [effort, setEffort] = useState<'low' | 'medium' | 'high'>(state.effort || 'medium');
  const [time, setTime] = useState(state.time || '09:00');
  const [complete, setComplete] = useState(state.completeOnSuccess ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const repeating = repeatIdOf(task) !== 'none';

  const save = async (runNow: boolean) => {
    setBusy(true);
    setError('');
    try {
      const next = await saveTaskAgent(task.id, { enabled: true, provider: provider.split(':')[0], effort, time, completeOnSuccess: complete, runNow });
      onChanged(next);
      showToast(runNow ? 'Агент приступил к задаче' : 'Задача поручена агенту', 'success');
      onClose();
    } catch (e) { setError(e instanceof Error ? e.message : 'Не сохранилось'); setBusy(false); }
  };
  const stop = async () => {
    setBusy(true);
    try { onChanged(await saveTaskAgent(task.id, { enabled: false })); onClose(); } catch (e) { setError(e instanceof Error ? e.message : 'Не сохранилось'); setBusy(false); }
  };

  return (
    <Sheet
      title="Поручить агенту"
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          {state.enabled && <button type="button" className="nx-ghost" disabled={busy} onClick={() => void stop()}>Снять с агента</button>}
          <button type="button" className="nx-ghost" disabled={busy || !provider} onClick={() => void save(true)}><Play size={14} aria-hidden="true" /> Выполнить сейчас</button>
          <button type="button" className="nx-primary" disabled={busy || !provider} onClick={() => void save(false)}>{state.enabled ? 'Сохранить' : 'Поручить'}</button>
        </>
      )}
    >
      {!state.ready && <p className="nx-hint" data-tone="danger">Поручения агенту ещё не включены на сервере: нужна схема (выкладка с -Schema).</p>}
      {state.ready && state.agents.length === 0 && <p className="nx-hint">Сначала подключите агента: Настройки → Ядро.</p>}
      <div className="nta">
        {state.agents.length > 1 && (
          <div className="nta-row">
            <span>Кто</span>
            <div className="nx-segment" role="group" aria-label="Агент">
              {state.agents.map((a) => <button key={a.provider} type="button" aria-pressed={provider.split(':')[0] === a.provider} onClick={() => setProvider(a.provider)}>{a.label}</button>)}
            </div>
          </div>
        )}
        <div className="nta-row">
          <span>Как</span>
          <div className="nx-segment" role="group" aria-label="Глубина работы">
            {EFFORTS.map((e) => <button key={e.id} type="button" aria-pressed={effort === e.id} onClick={() => setEffort(e.id)}>{e.label}</button>)}
          </div>
        </div>
        <label className="nta-row">
          <span>Время запуска</span>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value || '09:00')} aria-label="Время запуска" />
        </label>
        <p className="nx-hint">Если у срока задачи есть время, агент проснётся в него; это время — когда у срока его нет.</p>
        {!repeating && (
          <label className="nta-check">
            <input type="checkbox" checked={complete} onChange={(e) => setComplete(e.target.checked)} />
            <span>Закрыть задачу, когда агент отчитается об успехе</span>
          </label>
        )}
        <p className="nta-plan"><Bot size={14} aria-hidden="true" /> {state.enabled && state.summary ? state.summary : plan(task, time)}</p>
        <p className="nx-hint">Агент работает от вашего имени и с вашими правами, ход работы виден в отдельном чате «Ядра». Отчёт («Готово» или «Сбой») появится в этой задаче; при сбое придёт уведомление.</p>
        {error && <p className="nx-hint" data-tone="danger" role="alert">{error}</p>}
      </div>
    </Sheet>
  );
}

/** Состояние агента и его отчёты под текстом задачи. Не показывается, пока задачу не поручали. */
export function AgentReports({ task, version, onOpen }: { task: Task; version: number; onOpen: () => void }) {
  const [state, setState] = useState<TaskAgent | null>(null);
  const tick = useAgentReportTick((s) => s.tick);
  const load = useCallback(() => { taskAgent(task.id).then(setState).catch(() => undefined); }, [task.id]);
  useEffect(load, [load, tick, version]);
  if (!state || (!state.enabled && !state.reports.length)) return null;
  const run = async () => {
    try { setState(await runTaskAgent(task.id)); } catch (e) { showToast(e instanceof Error ? e.message : 'Не запустилось', 'error'); }
  };
  return (
    <section className="nta-reports" aria-label="Агент">
      <header>
        <h3><Bot size={15} aria-hidden="true" /> Агент</h3>
        <span className="nta-sum">{state.enabled ? state.summary || 'Поручено' : 'Снято с агента'}</span>
        <span className="nta-actions">
          {state.enabled && <button type="button" className="nx-ghost" onClick={() => void run()}><Play size={13} aria-hidden="true" /> Сейчас</button>}
          <button type="button" className="nx-ghost" onClick={onOpen}>Настроить</button>
          {state.threadId && <button type="button" className="nx-ghost" onClick={() => navigate(`/core?thread=${state.threadId}`)}><ExternalLink size={13} aria-hidden="true" /> Чат</button>}
        </span>
      </header>
      {state.reports.length === 0 ? <p className="nx-hint">Отчётов пока нет: они появятся после первого запуска.</p> : (
        <ul className="nta-list">
          {state.reports.map((r) => (
            <li key={r.id} data-status={r.status}>
              <details>
                <summary>
                  {r.status === 'ok' ? <CheckCircle2 size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}
                  <b>{r.status === 'ok' ? 'Выполнено' : 'Сбой'}</b>
                  <span>{stamp(r.runAt)}</span>
                  <em>{r.text.split('\n').find((l, i) => i > 0 && l.trim())?.slice(0, 90) || r.text.slice(0, 90)}</em>
                </summary>
                <pre>{r.text}</pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
