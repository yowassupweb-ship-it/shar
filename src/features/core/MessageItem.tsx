import { memo, useEffect, useState } from 'react';
import { AlertTriangle, Brain, Copy, CornerDownRight, FileText, Forward, Hourglass, Reply, RotateCw, ShieldCheck, Square, X } from 'lucide-react';
import { CoreMini } from '@/shared/ui/CoreIcon';
import { formatTime } from '@/shared/ui/format';
import { Menu, MenuItem, type MenuAnchor } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import type { CoreMessage } from './api';
import { BrandMark } from './brands';
import { Chain, EFFORT_LABEL, formatBytes, formatTokens, MarkdownText, modelLabel, workParts } from './parts';

export interface MessageHandlers {
  reply: (message: CoreMessage) => void;
  answer: (message: CoreMessage, value: string) => void;
  cancel: (message: CoreMessage) => void;
  retry: (message: CoreMessage) => void;
  jump: (id: string) => void;
  /** Переслать текст в чат Шара (меню по правой кнопке). */
  forward: (message: CoreMessage) => void;
}

/** Под ответом — коротко: время и сколько токенов; подробности — в подсказке и статистике чата. */
function workBrief(work: CoreMessage['props']['work']): string {
  if (!work) return '';
  const s = Math.round((work.duration_ms || 0) / 1000);
  const tokens = (work.input_tokens || 0) + (work.output_tokens || 0);
  return [s ? (s >= 60 ? `${Math.floor(s / 60)} мин ${s % 60} с` : `${s} с`) : '', tokens ? `${formatTokens(tokens)} токенов` : ''].filter(Boolean).join(' · ');
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

/** Когда обновится окно лимита. Момент сброса — из события провайдера (resets_at); у старых сообщений его нет —
 *  считаем от времени самого сообщения, а не от «сейчас» (иначе старая карточка «уезжала» вперёд при каждом показе). */
function resetMoment(limit: NonNullable<CoreMessage['props']['rateLimit']>, sentAt: string): number {
  if (limit.resets_at) return limit.resets_at * 1000;
  if (limit.wait_seconds) return new Date(sentAt).getTime() + limit.wait_seconds * 1000;
  return 0;
}

function rateLimitText(limit: NonNullable<CoreMessage['props']['rateLimit']>, sentAt: string) {
  const who = limit.provider ? `Лимит ${limit.provider}` : 'Лимит подписки';
  const at = resetMoment(limit, sentAt);
  if (at && at <= Date.now()) return `${who}: окно с тех пор обновилось`;
  const sameDay = at && new Date(at).toDateString() === new Date().toDateString();
  const until = at ? new Date(at).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', ...(sameDay ? {} : { day: 'numeric', month: 'short' }) }) : '';
  const used = limit.used_percent ?? 100;
  // Окно почти выбрано, но ещё не кончилось — это предупреждение, а не отказ.
  if (used < 100 && !/reject|block|exceed/i.test(limit.status || '')) {
    return `${who}: израсходовано ${used}%${limit.detail ? ` (${limit.detail})` : ''}${until ? ` — обновится в ${until}` : ''}`;
  }
  return `${who} исчерпан${limit.detail ? `: ${limit.detail}` : ''}${until ? ` — снова можно в ${until}` : ''}`;
}

/** Агент просит разрешения (режим «Осторожно» / «Спрашивать всегда»): без «Разрешить» сервер действие не пустит. */
function PermissionCard({ message, onAnswer }: { message: CoreMessage; onAnswer: (value: string) => void }) {
  const ask = message.props.ask!;
  const answered = message.props.answered;
  return (
    <div className="ncore-permit" data-state={answered ? (answered.startsWith('Разреш') ? 'allowed' : 'denied') : 'pending'} role="group" aria-label="Разрешение агенту">
      <span className="ncore-permit-icon" aria-hidden="true"><ShieldCheck size={18} /></span>
      <div className="ncore-permit-body">
        <b>{answered ? (answered.startsWith('Разреш') ? 'Разрешено' : 'Запрещено') : 'Агент просит разрешения'}</b>
        <p>{ask.question}</p>
      </div>
      {!answered && (
        <div className="ncore-permit-actions">
          <button type="button" className="ncore-action" onClick={() => onAnswer('Запретить')}>Запретить</button>
          <button type="button" className="ncore-action" data-primary="" onClick={() => onAnswer('Разрешить')}>Разрешить</button>
        </div>
      )}
    </div>
  );
}

/** Пересланное из чатов у своего сообщения: кто, когда, что — то, что видит агент. */
function Forwarded({ items }: { items: NonNullable<CoreMessage['props']['forwarded']> }) {
  return (
    <details className="ncore-fwd">
      <summary><Forward size={12} aria-hidden="true" /> Переслано агенту: {items.length}</summary>
      {items.map((item, i) => (
        <p key={i}><b>{item.author}</b> <time>{item.at}</time><br />{item.text}{item.files.length ? ` [${item.files.join(', ')}]` : ''}</p>
      ))}
    </details>
  );
}

function AskButtons({ message, onAnswer }: { message: CoreMessage; onAnswer: (value: string) => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const actions = message.props.actions ?? [];
  if (message.props.ask?.kind === 'permission') return <PermissionCard message={message} onAnswer={onAnswer} />;
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
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const onContextMenu = (e: React.MouseEvent) => {
    // Выделенный текст копируют как обычно — своё меню только без выделения.
    if (message.local || working || window.getSelection()?.toString()) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  if (message.role === 'system') {
    return <div className="ncore-system" data-msg-id={message.id}>{message.body}</div>;
  }

  return (
    <div className="ncore-row" data-mine={mine || undefined} data-msg-id={message.id} data-status={message.local || message.status} onContextMenu={onContextMenu}>
      {menu && (
        <Menu anchor={menu} onClose={() => setMenu(null)} label="Действия с сообщением" compact>
          {!!message.body && <MenuItem icon={<Forward size={15} />} onSelect={() => { setMenu(null); h.forward(message); }}>Переслать в чат</MenuItem>}
          {!!message.body && <MenuItem icon={<Copy size={15} />} onSelect={() => { setMenu(null); copy(); }}>Копировать текст</MenuItem>}
          <MenuItem icon={<Reply size={15} />} onSelect={() => { setMenu(null); h.reply(message); }}>Ответить</MenuItem>
        </Menu>
      )}
      {!mine && (
        <span className="ncore-agent-avatar" aria-hidden="true">{p.provider ? <BrandMark id={p.provider} size={18} /> : <CoreMini size={18} />}</span>
      )}
      <div className="ncore-col">
        {!mine && (
          <div className="ncore-head">
            <b>{message.actor || 'Агент'}</b>
            {p.model && <span className="ncore-chip">{modelLabel(p.model)}</span>}
            {p.effort && p.effort !== 'medium' && <span className="ncore-chip">{EFFORT_LABEL[p.effort] || p.effort}</span>}
            <time title={new Date(message.createdAt).toLocaleString('ru-RU')}>{formatTime(message.createdAt)}</time>
          </div>
        )}
        {!!p.steps?.length && (
          <Chain steps={p.steps} live={working} durationMs={p.work?.duration_ms}
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
        {mine && !!p.forwarded?.length && <Forwarded items={p.forwarded} />}
        {mine && (
          <div className="ncore-meta">
            {message.local === 'sending' && <span>отправляется…</span>}
            {message.local === 'failed' && (
              <button type="button" className="ncore-retry" onClick={() => h.retry(message)}><RotateCw size={11} aria-hidden="true" /> не отправлено — повторить</button>
            )}
            {!message.local && (
              <span className="ncore-tools">
                {!!message.body && <button type="button" onClick={copy} aria-label="Копировать" title="Копировать текст"><Copy size={13} aria-hidden="true" /></button>}
                {!!message.body && <button type="button" onClick={() => h.forward(message)} aria-label="Переслать в чат" title="Переслать в чат Шара"><Forward size={13} aria-hidden="true" /></button>}
                <button type="button" onClick={() => h.reply(message)} aria-label="Ответить" title="Ответить на это сообщение"><Reply size={13} aria-hidden="true" /></button>
              </span>
            )}
            {!message.local && <time>{formatTime(message.createdAt)}</time>}
          </div>
        )}
        {p.rateLimit && <p className="ncore-limit" role="status"><Hourglass size={12} aria-hidden="true" /> {rateLimitText(p.rateLimit, message.createdAt)}</p>}
        {!!p.reasoning?.length && (
          <details className="ncore-reasoning">
            <summary><Brain size={12} aria-hidden="true" /> Ход мысли</summary>
            {p.reasoning.map((text, i) => <p key={i}>{text}</p>)}
          </details>
        )}
        {!!p.ask?.question && p.ask.kind !== 'permission' && !working && !p.answered && <p className="ncore-ask">{p.ask.question}</p>}
        {!!p.actions?.length && !working && <AskButtons message={message} onAnswer={(value) => h.answer(message, value)} />}
        {!mine && !message.local && !working && (
          <div className="ncore-tools">
            {!!message.body && <button type="button" onClick={copy} aria-label="Копировать" title="Копировать текст"><Copy size={13} aria-hidden="true" /></button>}
            {!!message.body && <button type="button" onClick={() => h.forward(message)} aria-label="Переслать в чат" title="Переслать в чат Шара"><Forward size={13} aria-hidden="true" /></button>}
            <button type="button" onClick={() => h.reply(message)} aria-label="Ответить" title="Ответить на это сообщение"><Reply size={13} aria-hidden="true" /></button>
            {stats.length > 0 && <span className="ncore-tools-meta" title={stats.join(' · ')}>{workBrief(p.work)}</span>}
          </div>
        )}
      </div>
    </div>
  );
});
