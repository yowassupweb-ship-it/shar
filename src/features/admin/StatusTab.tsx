import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Download, Eraser, HardDrive, MemoryStick, RefreshCw, RotateCw, Terminal } from 'lucide-react';
import { askConfirm } from '@/shared/ui/overlay';
import { formatBytes, loadSystemStatus, runSystemAction, timeAgo, type SystemStatus } from './api';

function uptime(seconds: number): string {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d} дн ${h} ч` : h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
}

/** Заполненность: до 75% — спокойно, до 90% — внимание, выше — тревога. */
function Usage({ label, used, total, icon }: { label: string; used: number; total: number; icon: ReactNode }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const tone = pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : 'ok';
  return (
    <div className="nad-usage" data-tone={tone}>
      <div className="nad-usage-head">
        <span>{icon}{label}</span>
        <span>{formatBytes(used)} из {formatBytes(total)} · <b>{pct}%</b></span>
      </div>
      <div className="nad-usage-bar" role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Line({ label, value }: { label: string; value: ReactNode }) {
  if (value === undefined || value === null || value === '') return null;
  return <div className="nx-row"><span className="nx-row-text"><span className="nx-row-label">{label}</span></span><span className="nx-value">{value}</span></div>;
}

interface ActionDef { id: string; label: string; hint: string; icon: ReactNode; confirm?: string }
const KNOWN: Record<string, Omit<ActionDef, 'id'>> = {
  pull: { label: 'Обновить', hint: 'Забрать код, собрать и перезапустить сервисы', icon: <Download size={15} />, confirm: 'Сервисы перезапустятся — сайт ненадолго станет недоступен.' },
  restart: { label: 'Перезапуск', hint: 'Перезапустить сервисы без обновления кода', icon: <RotateCw size={15} />, confirm: 'Сайт на несколько секунд станет недоступен.' },
  clean: { label: 'Глубокая очистка', hint: 'Логи, кэши, старые бэкапы', icon: <Eraser size={15} /> },
  clear: { label: 'Очистка', hint: 'Кэш сборки и временные файлы', icon: <RefreshCw size={15} /> },
};
const actionDef = (id: string): ActionDef => ({ id, ...(KNOWN[id] || { label: id, hint: 'Команда из SHAR_ADMIN_ACTIONS', icon: <Terminal size={15} />, confirm: 'Выполнить команду на сервере?' }) });

export default function StatusTab() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const [running, setRunning] = useState<string | null>(null);
  const [log, setLog] = useState<string | null>(null);

  // Обновляем при открытии, при возврате в окно и по кнопке — без таймера.
  const load = useCallback(async () => {
    try { setStatus(await loadSystemStatus()); setError(null); setLoadedAt(Date.now()); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось получить состояние сервера'); }
  }, []);
  useEffect(() => {
    void load();
    const onFocus = () => { void load(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const run = async (a: ActionDef) => {
    if (running) return;
    if (a.confirm && !(await askConfirm({ title: `${a.label}?`, text: a.confirm, confirm: a.label, tone: 'danger' }))) return;
    setRunning(a.id);
    setLog(null);
    try {
      const r = await runSystemAction(a.id);
      setLog(r.output || `Готово (код ${r.exitCode ?? '?'})`);
    } catch (e) { setLog(e instanceof Error ? e.message : 'Команда не ответила. Проверьте сервер вручную.'); }
    finally { setRunning(null); void load(); }
  };

  const db = status?.database;
  const s3 = status?.storage;
  const redis = status?.redis;

  return (
    <>
      <section className="nx-block">
        <div className="nx-block-head">
          <h2 className="nx-block-title">Сервер{loadedAt ? ` · обновлено ${timeAgo(loadedAt)}` : ''}</h2>
          <button type="button" className="nx-icon-btn" aria-label="Обновить" onClick={() => void load()}><RefreshCw size={15} /></button>
        </div>
        {error && <p className="nx-error" role="alert">{error}</p>}
        {!status && !error && <div className="nx-group" aria-busy="true"><div className="nx-row"><span className="nx-skel nx-skel-line" style={{ width: '60%' }} /></div></div>}
        {status?.memory && status.disk && !status.error && (
          <>
            <div className="nx-group nad-usages">
              <Usage label="Память" used={status.memory.used} total={status.memory.total} icon={<MemoryStick size={14} aria-hidden="true" />} />
              <Usage label="Диск" used={status.disk.used} total={status.disk.total} icon={<HardDrive size={14} aria-hidden="true" />} />
              {status.memory.swapTotal > 0 && <Usage label="Swap" used={status.memory.swapUsed} total={status.memory.swapTotal} icon={<MemoryStick size={14} aria-hidden="true" />} />}
            </div>
            <div className="nad-services">
              {Object.entries(status.services || {}).map(([name, state]) => (
                <span key={name} className="nad-service" data-ok={state === 'active' ? 'true' : undefined}>
                  <i aria-hidden="true" /> <b>{name}</b> <small>{state}</small>
                </span>
              ))}
            </div>
            <div className="nx-group">
              <Line label="Работает без перезагрузки" value={uptime(status.uptimeSeconds)} />
              <Line label="Нагрузка (1 / 5 / 15 мин)" value={(status.loadAverage || []).map((n) => n.toFixed(2)).join(' / ')} />
              <Line label="Свободно на диске" value={formatBytes(status.disk.free)} />
              <Line label="Журналы systemd" value={status.journal} />
              <Line label="Коммит" value={<code>{status.commit}</code>} />
            </div>
          </>
        )}
      </section>

      {status && (db || s3 || redis) && (
        <div className="nad-cols">
          <section className="nx-block">
            <h2 className="nx-block-title">База данных{db?.kind === 'postgresql' ? ' · PostgreSQL' : ''}</h2>
            <div className="nx-group">
              {db?.error && <p className="nx-error">{db.error}</p>}
              <Line label="Имя" value={db?.name} />
              <Line label="Версия" value={db?.version} />
              <Line label="Размер" value={formatBytes(db?.sizeBytes)} />
              <Line label="Подключений" value={db?.connections} />
              {db?.topTables?.map((t) => <Line key={t.name} label={t.name} value={`${t.rows.toLocaleString('ru-RU')} строк`} />)}
            </div>
          </section>
          <section className="nx-block">
            <h2 className="nx-block-title">Файлы · {s3?.enabled ? 'S3' : 'на диске'}</h2>
            <div className="nx-group">
              {s3?.error && <p className="nx-error">{s3.error}</p>}
              <Line label="Бакет" value={s3?.bucket} />
              <Line label="Регион" value={s3?.region} />
              <Line label="Эндпоинт" value={s3?.endpoint} />
              {s3?.localUploads && <Line label="Локально" value={`${formatBytes(s3.localUploads.sizeBytes)} · ${s3.localUploads.files.toLocaleString('ru-RU')} файлов`} />}
            </div>
          </section>
          <section className="nx-block">
            <h2 className="nx-block-title">Redis · {redis?.connected ? 'подключён' : 'недоступен'}</h2>
            <div className="nx-group">
              {redis?.error && <p className="nx-error">{redis.error}</p>}
              <Line label="Версия" value={redis?.version} />
              <Line label="Память" value={formatBytes(redis?.usedMemoryBytes)} />
              <Line label="Клиентов" value={redis?.clients} />
              <Line label="Работает" value={redis?.uptimeDays !== undefined ? `${redis.uptimeDays} дн` : undefined} />
            </div>
          </section>
        </div>
      )}

      {(status?.actions?.length ?? 0) > 0 && <section className="nx-block">
        <h2 className="nx-block-title">Обслуживание</h2>
        <div className="nx-group">
          {(status?.actions || []).map(actionDef).map((a) => (
            <div key={a.id} className="nx-row">
              <span className="nx-row-text"><span className="nx-row-label">{a.label}</span><span className="nx-row-hint">{a.hint}</span></span>
              <button type="button" className="nx-ghost" disabled={Boolean(running)} onClick={() => void run(a)}>
                {a.icon} {running === a.id ? 'Выполняется…' : 'Запустить'}
              </button>
            </div>
          ))}
        </div>
        {running === 'pull' && <p className="nx-note">Идёт сборка — несколько минут. Во время перезапуска страница может ненадолго пропасть.</p>}
        {log && (
          <figure className="nad-log">
            <figcaption><Terminal size={13} aria-hidden="true" /> Вывод команды</figcaption>
            <pre>{log}</pre>
          </figure>
        )}
      </section>}
    </>
  );
}
