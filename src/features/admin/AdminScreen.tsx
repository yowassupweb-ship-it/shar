import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Activity, AlertTriangle, Building2, ChevronLeft, LayoutDashboard, ScrollText, Settings2, ShieldOff, Users } from 'lucide-react';
import { paths } from '@/shared/navigation/routes';
import { loadMe } from './api';
import UsersTab from './UsersTab';
import DepartmentsTab from './DepartmentsTab';
import StatusTab from './StatusTab';
import ErrorsTab from './ErrorsTab';
import SettingsTab from './SettingsTab';
import OverviewTab from './OverviewTab';
import AuditTab from './AuditTab';
import './admin.css';

/**
 * Админка: обзор, пользователи, отделы, состояние сервера, ошибки клиентов,
 * журнал действий, настройки. Вкладка — в адресе (?tab=…).
 *
 * Доступ проверяем по профилю с сервера; сами данные сервер отдаёт только
 * админу — экран «нет доступа» здесь лишь для понятности, не для защиты.
 */

const TABS = [
  { id: 'overview', label: 'Обзор', icon: LayoutDashboard },
  { id: 'users', label: 'Пользователи', icon: Users },
  { id: 'departments', label: 'Отделы', icon: Building2 },
  { id: 'status', label: 'Сервер', icon: Activity },
  { id: 'errors', label: 'Ошибки', icon: AlertTriangle },
  { id: 'audit', label: 'Журнал', icon: ScrollText },
  { id: 'settings', label: 'Настройки', icon: Settings2 },
] as const;
type TabId = (typeof TABS)[number]['id'];

export default function AdminScreen() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const raw = params.get('tab');
  const tab: TabId = TABS.some((t) => t.id === raw) ? (raw as TabId) : 'overview';
  const [access, setAccess] = useState<'checking' | 'ok' | 'denied'>('checking');

  useEffect(() => {
    void loadMe().then((me) => setAccess(me?.role === 'admin' ? 'ok' : 'denied'));
  }, []);

  const head = (
    <header className="nx-page-head">
      <button type="button" className="nx-icon-btn nx-page-back" aria-label="Назад в «Ещё»" onClick={() => navigate(paths.more)}>
        <ChevronLeft size={20} />
      </button>
      <h1>Админка</h1>
    </header>
  );

  if (access !== 'ok') {
    return (
      <div className="nx-page nx-scroll-y">
        <div className="nx-page-inner">
          {head}
          {access === 'denied' && (
            <div className="nx-state" role="alert">
              <ShieldOff size={28} aria-hidden="true" />
              <h2>Нет доступа</h2>
              <p>Админка открыта только администраторам.</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="nx-page nx-scroll-y">
      <div className="nx-page-inner" data-wide="">
        {head}
        <nav className="nad-tabs nx-segment" aria-label="Разделы админки">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button key={t.id} type="button" aria-pressed={tab === t.id} onClick={() => setParams(t.id === 'overview' ? {} : { tab: t.id }, { replace: true })}>
                <Icon size={14} aria-hidden="true" /> <span>{t.label}</span>
              </button>
            );
          })}
        </nav>
        {tab === 'overview' && <OverviewTab onOpen={(id) => setParams({ tab: id }, { replace: true })} />}
        {tab === 'users' && <UsersTab />}
        {tab === 'departments' && <DepartmentsTab />}
        {tab === 'status' && <StatusTab />}
        {tab === 'errors' && <ErrorsTab />}
        {tab === 'audit' && <AuditTab />}
        {tab === 'settings' && <SettingsTab />}
      </div>
    </div>
  );
}
