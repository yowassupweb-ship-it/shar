import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, RefreshCw, X } from 'lucide-react';
import { Avatar } from '@/shared/ui/Avatar';
import { plural } from '@/shared/ui/format';
import { timeAgo } from './api';

interface UsageCell { visits: number; seconds: number }
interface UsageSection { section: string; users: number; visits: number; seconds: number }
interface UsageUser {
  userId: string; name: string; department: string; avatar: string;
  visits: number; seconds: number; lastAt: string; activeDays: number;
  sections: Record<string, UsageCell>;
}
interface UsageReport { days: number; ready: boolean; sections: UsageSection[]; users: UsageUser[]; daily: Array<{ day: string; users: number; seconds: number }> }

/** Подписи разделов — по ключам из paths (shared/navigation/routes). Неизвестный ключ показываем как есть. */
const LABELS: Record<string, string> = {
  chats: 'Чаты', tasks: 'Задачи', calendar: 'Календарь', contacts: 'Контакты', files: 'Файлы', mail: 'Почта', office: 'Офис',
  more: 'Ещё', settings: 'Настройки', admin: 'Админка', utm: 'Генератор UTM', leads: 'Заявки', social: 'Соцсети',
  guide: 'Инструкция', core: 'Ядро',
};
const label = (key: string) => LABELS[key] || key;

function duration(seconds: number): string {
  if (seconds < 60) return seconds ? '< 1 мин' : '—';
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  return `${h} ч${m % 60 ? ` ${m % 60} мин` : ''}`;
}

const PERIODS = [7, 30, 90] as const;

/**
 * Кто, чем и сколько пользуется: разделы (люди, заходы, время) и люди (время всего и по разделам). Время —
 * активное: вкладка видна, окно в фокусе, без простоя дольше 5 минут (shared/usage/tracker.ts).
 */
export default function UsageTab() {
  const [days, setDays] = useState<number>(30);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [section, setSection] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/usage?days=${days}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      setReport(await res.json());
      setFailed(false);
    } catch { setFailed(true); }
  }, [days]);
  useEffect(() => { void load(); }, [load]);

  const maxSeconds = Math.max(1, ...(report?.sections.map((s) => s.seconds) ?? [1]));
  const users = useMemo(() => {
    const list = report?.users ?? [];
    if (!section) return list;
    return list.filter((u) => u.sections[section]).sort((a, b) => (b.sections[section]?.seconds ?? 0) - (a.sections[section]?.seconds ?? 0));
  }, [report, section]);
  const total = report?.users.reduce((sum, u) => sum + u.seconds, 0) ?? 0;

  return (
    <section className="nx-block nad-usage">
      <div className="nx-block-head">
        <h2 className="nx-block-title">Статистика разделов</h2>
        <span className="nad-usage-tools">
          <nav className="nx-segment" aria-label="Период">
            {PERIODS.map((p) => <button key={p} type="button" aria-pressed={days === p} onClick={() => setDays(p)}>{p} дн</button>)}
          </nav>
          <button type="button" className="nx-icon-btn" aria-label="Обновить" onClick={() => void load()}><RefreshCw size={15} /></button>
        </span>
      </div>
      {failed && <p className="nx-error" role="alert">Статистика не загрузилась.</p>}
      {report && !report.ready && <p className="nx-note">Учёт ещё не включён на сервере — нужна выкладка со схемой.</p>}
      {!report && !failed && <div className="nx-group" aria-busy="true"><div className="nx-row"><span className="nx-skel nx-skel-line" style={{ width: '60%' }} /></div></div>}
      {report?.ready && (
        <>
          <div className="nad-usage-summary">
            <span><b>{report.users.length}</b> активных за {report.days} дн</span>
            <span><b>{duration(total)}</b> всего</span>
            {report.sections[0] && <span>Чаще всего — <b>{label(report.sections[0].section)}</b></span>}
          </div>

          <h3 className="nad-usage-h">Разделы</h3>
          {report.sections.length === 0 ? (
            <div className="nx-state"><h2>Пока пусто</h2><p>Данные появятся, когда сотрудники поработают в Шаре с новой версией.</p></div>
          ) : (
            <div className="nx-group">
              {report.sections.map((s) => (
                <button key={s.section} type="button" className="nx-row nad-usage-row" aria-pressed={section === s.section}
                  onClick={() => setSection(section === s.section ? null : s.section)} title="Показать, кто пользуется этим разделом">
                  <span className="nad-usage-name">{label(s.section)}</span>
                  <span className="nad-usage-bar" aria-hidden="true"><i style={{ width: `${Math.max(2, Math.round((s.seconds / maxSeconds) * 100))}%` }} /></span>
                  <span className="nad-usage-num">{duration(s.seconds)}</span>
                  <span className="nad-usage-num nad-usage-muted">{s.users} чел. · {s.visits} {plural(s.visits, ['заход', 'захода', 'заходов'])}</span>
                </button>
              ))}
            </div>
          )}

          <h3 className="nad-usage-h">
            Люди{section && <> — {label(section)} <button type="button" className="nx-icon-btn" onClick={() => setSection(null)} aria-label="Показать всех"><X size={14} /></button></>}
          </h3>
          <div className="nx-group">
            {users.map((u) => {
              const own = Object.entries(u.sections).sort((a, b) => b[1].seconds - a[1].seconds);
              const shown = section ? u.sections[section] : null;
              return (
                <div key={u.userId} className="nad-usage-person">
                  <button type="button" className="nx-row nad-usage-row" aria-expanded={open === u.userId} onClick={() => setOpen(open === u.userId ? null : u.userId)}>
                    <span className="nad-usage-who">
                      <Avatar name={u.name} seed={u.userId} src={u.avatar || undefined} person size={28} />
                      <span className="nx-row-text">
                        <span className="nx-row-label">{u.name}</span>
                        <span className="nx-row-hint">{[u.department, `${u.activeDays} ${plural(u.activeDays, ['день', 'дня', 'дней'])} активности`, u.lastAt && `был(а) ${timeAgo(u.lastAt)}`].filter(Boolean).join(' · ')}</span>
                      </span>
                    </span>
                    <span className="nad-usage-chips">
                      {own.slice(0, 3).map(([key, cell]) => <span key={key} className="nad-usage-chip">{label(key)} · {duration(cell.seconds)}</span>)}
                    </span>
                    <span className="nad-usage-num">{duration(shown ? shown.seconds : u.seconds)}</span>
                    <ChevronDown size={14} className="nad-usage-chevron" aria-hidden="true" />
                  </button>
                  {open === u.userId && (
                    <div className="nad-usage-detail">
                      {own.map(([key, cell]) => (
                        <span key={key}><b>{label(key)}</b> {duration(cell.seconds)} · {cell.visits} {plural(cell.visits, ['заход', 'захода', 'заходов'])}</span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {!users.length && <div className="nx-row"><span className="nx-row-hint">Никого за этот период</span></div>}
          </div>
        </>
      )}
    </section>
  );
}
