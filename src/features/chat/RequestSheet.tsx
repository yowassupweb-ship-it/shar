import { useEffect, useState, type CSSProperties } from 'react';
import { ChevronRight } from 'lucide-react';
import { Sheet } from '@/shared/ui/overlay';
import { createRequest, loadRequestDepartments, type Department } from './actions';
import { Spinner } from '@/shared/ui/Spinner';

/** Новая заявка в отдел — перенос RequestModal. */
export default function RequestSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (chatId: string) => void }) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [depts, setDepts] = useState<Department[]>([]);
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = () => {
    setPhase('loading');
    loadRequestDepartments()
      .then((list) => { setDepts(list); setPhase('ready'); })
      .catch(() => setPhase('error'));
  };
  useEffect(load, []);

  const pick = async (id: string) => {
    if (creating) return;
    setCreating(id);
    setError('');
    const chatId = await createRequest(id);
    setCreating(null);
    if (chatId) onCreated(chatId);
    else setError('Заявка не создалась: сервер не ответил. Повторите.');
  };

  return (
    <Sheet title="Новая заявка" onClose={onClose} busy={Boolean(creating)}>
      <p className="nx-hint">Выберите отдел. Будет создан чат со всеми его сотрудниками.</p>
      {error && <p className="nx-error" role="alert">{error}</p>}
      {phase === 'loading' && (
        <div className="nx-state" aria-busy="true"><Spinner size={20} /><p>Загружаю отделы</p></div>
      )}
      {phase === 'error' && (
        <div className="nx-state" data-tone="danger" role="alert">
          <h2>Не загрузил отделы</h2>
          <p>Сервер не ответил.</p>
          <button type="button" className="nx-ghost" onClick={load}>Повторить</button>
        </div>
      )}
      {phase === 'ready' && depts.length === 0 && (
        <div className="nx-state">
          <h2>Нет отделов для заявок</h2>
          <p>Отделы, принимающие заявки, настраиваются в админке.</p>
        </div>
      )}
      {phase === 'ready' && depts.map((d) => (
        <button key={d.id} type="button" className="nx-pick" disabled={Boolean(creating)} onClick={() => void pick(d.id)}>
          <span className="cxs-dept-dot" style={{ '--dot': d.color || 'var(--note-gray)' } as CSSProperties} aria-hidden="true" />
          <span className="nx-pick-text"><span>{d.name}</span></span>
          {creating === d.id ? <Spinner size={16} label="Создаю" /> : <ChevronRight size={16} aria-hidden="true" />}
        </button>
      ))}
    </Sheet>
  );
}
