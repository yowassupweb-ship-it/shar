import { useCallback, useEffect, useState } from 'react';
import { LogOut, Monitor, ShieldCheck, Smartphone, Tablet } from 'lucide-react';
import { askConfirm } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { ApiError, loadDevices, revokeDevice, revokeOtherDevices, type Device } from '../api';

function when(unixSeconds: number): string {
  if (!unixSeconds) return '—';
  const mins = Math.floor((Date.now() - unixSeconds * 1000) / 60000);
  if (mins < 1) return 'только что';
  if (mins < 60) return `${mins} мин назад`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'вчера';
  if (days < 30) return `${days} дн назад`;
  return new Date(unixSeconds * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function DeviceIcon({ name }: { name: string }) {
  const d = name.toLowerCase();
  if (d.includes('iphone') || d.includes('android')) return <Smartphone size={18} />;
  if (d.includes('ipad')) return <Tablet size={18} />;
  return <Monitor size={18} />;
}

/** Активные входы. Источник — серверные сессии: здесь ровно то, что пускают в аккаунт. */
export default function DevicesSection() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDevices(await loadDevices());
      setError(null);
    } catch (e) {
      setDevices([]);
      setError(e instanceof ApiError && e.status === 401
        ? 'Список появится после следующего входа.'
        : 'Не удалось загрузить список — нет связи с сервером.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const revoke = async (d: Device) => {
    if (!(await askConfirm({ title: `Завершить сеанс «${d.device}»?`, text: 'На этом устройстве придётся войти заново.', confirm: 'Завершить', tone: 'danger' }))) return;
    setBusy(d.id);
    try { await revokeDevice(d.id); await load(); } catch { showToast('Сеанс не завершился — попробуйте ещё раз', 'error'); } finally { setBusy(null); }
  };

  const revokeOthers = async () => {
    if (!(await askConfirm({ title: 'Завершить все другие сеансы?', text: 'Останется только это устройство.', confirm: 'Завершить', tone: 'danger' }))) return;
    setBusy('others');
    try { await revokeOtherDevices(); await load(); } catch { showToast('Сеансы не завершились — попробуйте ещё раз', 'error'); } finally { setBusy(null); }
  };

  if (devices === null) {
    return <div className="nx-group" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="nx-row"><span className="nx-skel nx-skel-line" style={{ width: `${60 - i * 10}%` }} /></div>)}</div>;
  }

  const others = devices.filter((d) => !d.current);
  return (
    <section className="nx-block">
      <h2 className="nx-block-title">Где выполнен вход</h2>
      {error && <p className="nx-note">{error}</p>}
      {devices.length > 0 && (
        <div className="nx-group">
          {devices.map((d) => (
            <div key={d.id} className="nx-row nst-device">
              <span className="nst-device-icon" aria-hidden="true"><DeviceIcon name={d.device} /></span>
              <span className="nx-row-text">
                <span className="nx-row-label">
                  {d.device}
                  {d.current && <span className="nst-badge"><ShieldCheck size={12} aria-hidden="true" /> Это устройство</span>}
                </span>
                <span className="nx-row-hint">{[d.ip, d.current ? 'сейчас' : when(d.lastSeenAt)].filter(Boolean).join(' · ')}</span>
              </span>
              {!d.current && (
                <button type="button" className="nx-icon-btn" aria-label={`Завершить сеанс: ${d.device}`} disabled={busy === d.id} onClick={() => void revoke(d)}>
                  <LogOut size={16} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="nx-actions">
          <button type="button" className="nx-ghost nst-danger" disabled={busy === 'others'} onClick={() => void revokeOthers()}>
            Завершить другие сеансы
          </button>
        </div>
      )}
    </section>
  );
}
