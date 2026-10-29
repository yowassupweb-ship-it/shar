import { memo, useEffect, useState } from 'react';
import { AlertTriangle, Atom, Brain, Copy, CornerDownRight, FileText, Hourglass, Reply, RotateCw, Square, X } from 'lucide-react';
import { formatTime } from '@/shared/ui/format';
import { showToast } from '@/shared/ui/Toast';
import type { CoreMessage } from './api';
import { Chain, EFFORT_LABEL, formatBytes, MarkdownText, workParts } from './parts';

export interface MessageHandlers {
  reply: (message: CoreMessage) => void;
  answer: (message: CoreMessage, value: string) => void;
  cancel: (message: CoreMessage) => void;
  retry: (message: CoreMessage) => void;
  jump: (id: string) => void;
}

const isImage = (type: string, name: string) => type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(name);

function Attachments({ files }: { files: NonNullable<CoreMessage['props']['attachments']> }) {
  return (
    <div className="ncore-atts">
      {files.map((file) => (isImage(file.type, file.name) ? (
        <a key={file.key} className="ncore-att-image" href={file.url} target="_blank" rel="noreferrer noopener" title={file.name}>
          <img src={file.url} alt={file.name} loading="lazy" decoding="async" />
        </a>
      ) : (
        <a key={file.key} className="ncore-att" href={file.url} target="_blank" rel="noreferrer noopener" title={file.name}>
          <FileText size={16} aria-hidden="true" />
          <span className="ncore-att-name">{file.name}</span>
          <span className="ncore-att-size">{formatBytes(file.size)}</span>
        </a>
      )))}
    </div>
  );
}

/** «Думает… 12 с» — секунды идут сами, пока агент работает. */
function Elapsed({ since }: { since: string }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => tick((n) => n + 1), 1000); return () => window.clearInterval(t); }, []);
  const s = Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 1000));
  return <>{s >= 60 ? `${Math.floor(s / 60)} мин ${s % 60} с` : `${s} с`}</>;
}

function rateLimitText(limit: NonNullable<CoreMessage['props']['rateLimit']>) {
  const who = limit.provider ? `Лимит подписки ${limit.provider}` : 'Лимит подписки';
  if (!limit.wait_seconds) return `${who} исчерпан${limit.detail ? `: ${limit.detail}` : ''}`;
  const until = new Date(Date.now() + limit.wait_seconds * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return `${who} исчерпан — снова можно примерно в ${until}`;
}

function AskButtons({ message, onAnswer }: { message: CoreMessage; onAnswer: (value: string) => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const actions = message.props.actions ?? [];
  if (message.props.answered) {
    return <p className="ncore-answered"><CornerDownRight size={12} aria-hidden="true" /> Ответ: {message.props.answered}</p>;
  }
  if (message.props.ask?.kind === 'multi') {
    return (
      <div className="ncore-actions">
        {actions.map((a) => {
          const on = picked.includes(a.value);
          return (
            <button key={a.value} type="button" className="ncore-action" aria-pressed={on}
              onClick={() => setPicked((cur) => (on ? cur.filter((v) => v !== a.value) : [...cur, a.value]))}>{a.label}</button>
          );
        })}
        <button type="button" className="ncore-action" data-primary="" disabled={!picked.length} onClick={() => onAnswer(picked.join(', '))}>Отправить выбранное</button>
      </div>
    );
  }
  return (
    <div className="ncore-actions">
      {actions.map((a) => <button key={a.value} type="button" className="ncore-action" onClick={() => onAnswer(a.value)}>{a.label}</button>)}
    </div>
  );
}

/**
 * Сообщение «Ядра». Свои — пузырём справа, как в чатах Шара. Ответ агента — слева: над ним цепочка шагов
 * (что делал), в пузыре — ответ, под ним — ход работы, ход мысли, вопрос с кнопками. Пока агент работает,
 * цепочка растёт на глазах, рядом — «думает… N с» и кнопка «Остановить».
 */
export const MessageItem = memo(function MessageItem({ message, quote, h }: {
  message: CoreMessage;
  /** Цитата нужна, только когда исходное сообщение стоит не прямо над ответом. */
  quote: boolean;
  h: MessageHandlers;
}) {
  const p = message.props;
  const mine = message.role === 'user';
  const working = message.role === 'agent' && (message.status === 'working' || message.status === 'queued');
  const failed = message.status === 'failed' || p.failed;
  const copy = () => { void navigator.clipboard?.writeText(message.body).then(() => showToast('Скопировано', 'success')); };
  const stats = workParts(p.work);

  if (message.role === 'system') {
    return <div className="ncore-system" data-msg-id={message.id}>{message.body}</div>;
  }

  return (
    <div className="ncore-row" data-mine={mine || undefined} data-msg-id={message.id} data-status={message.local || message.status}>
      {!mine && (
        <span className="ncore-agent-avatar" aria-hidden="true"><Atom size={16} /></span>
      )}
      <div className="ncore-col">
        {!mine && (
          <div className="ncore-head">
            <b>{message.actor || 'Агент'}</b>
            {p.model && <span className="ncore-chip">{p.model}</span>}
            {p.effort && <span className="ncore-chip">{EFFORT_LABEL[p.effort] || p.effort}</span>}
            <time title={new Date(message.createdAt).toLocaleString('ru-RU')}>{formatTime(message.createdAt)}</time>
          </div>
        )}
        {!!p.steps?.length && (
          <Chain steps={p.steps} live={working}
            status={working ? <strong className="ncore-phase">{p.phase || 'работает'}… <Elapsed since={message.createdAt} /></strong> : undefined} />
        )}
        {working && !p.steps?.length && (
          <div className="ncore-thinking" role="status">
            <span className="ncore-dots" aria-hidden="true"><i /><i /><i /></span>
            {message.status === 'queued' ? 'в очереди' : p.phase || 'думает'}… <Elapsed since={message.createdAt} />
          </div>
        )}
        {working && (
          <button type="button" className="ncore-stop" onClick={() => h.cancel(message)} title="Остановить: агент перестанет ждать этот ответ">
            <Square size={10} aria-hidden="true" /> Остановить
          </button>
        )}
        {message.status === 'cancelled' && <p className="ncore-note"><X size={12} aria-hidden="true" /> Остановлено</p>}
        {(message.body || p.attachments?.length || (quote && p.replyTo)) && (
          <div className="ncore-bubble" data-failed={failed || undefined}>
            {quote && p.replyTo && (
              <button type="button" className="ncore-quote" onClick={() => h.jump(p.replyTo!.id)} title="Показать исходное сообщение">
                <CornerDownRight size={11} aria-hidden="true" />
                <b>{p.replyTo.actor || 'Вы'}</b>
                <span>{p.replyTo.text}</span>
              </button>
            )}
            {failed && <span className="ncore-failed-title"><AlertTriangle size={13} aria-hidden="true" /> Ответ не получен</span>}
            {message.body && (mine ? <div className="ncore-text">{message.body}</div> : <MarkdownText text={message.body} />)}
            {!!p.attachments?.length && <Attachments files={p.attachments} />}
          </div>
        )}
        {mine && (
          <div className="ncore-meta">
            {message.local === 'sending' && <span>отправляется…</span>}
            {message.local === 'failed' && (
              <button type="button" className="ncore-retry" onClick={() => h.retry(message)}><RotateCw size={11} aria-hidden="true" /> не отправлено — повторить</button>
            )}
            {!message.local && <time>{formatTime(message.createdAt)}</time>}
          </div>
        )}
        {!mine && !working && stats.length > 0 && <p className="ncore-work">Ход работы · {stats.join(' · ')}</p>}
        {p.rateLimit && <p className="ncore-limit" role="status"><Hourglass size={12} aria-hidden="true" /> {rateLimitText(p.rateLimit)}</p>}
        {!!p.reasoning?.length && (
          <details className="ncore-reasoning">
            <summary><Brain size={12} aria-hidden="true" /> Ход мысли</summary>
            {p.reasoning.map((text, i) => <p key={i}>{text}</p>)}
          </details>
        )}
        {!!p.actions?.length && !working && <AskButtons message={message} onAnswer={(value) => h.answer(message, value)} />}
        {!message.local && !working && (
          <div className="ncore-tools">
            {!!message.body && <button type="button" onClick={copy} title="Скопировать текст"><Copy size={12} aria-hidden="true" /> копировать</button>}
            <button type="button" onClick={() => h.reply(message)} title="Ответить на это сообщение"><Reply size={12} aria-hidden="true" /> ответить</button>
          </div>
        )}
      </div>
    </div>
  );
});
