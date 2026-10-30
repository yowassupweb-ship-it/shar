import { useCallback, useEffect, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Bell, Bot, ChevronLeft, ChevronRight, KeyRound, LayoutGrid, LogOut, MonitorSmartphone, Palette, RotateCw, User, Volume2 } from 'lucide-react';
import { CoreIcon } from '@/shared/ui/CoreIcon';
import { useAgentBridge } from '@/shared/core/agentBridge';
import { logout } from '@/shared/session/session';
import { adoptServerChatPrefs } from '@/shared/settings/chatPrefs';
import { paths } from '@/shared/navigation/routes';
import { useShellOptions } from '@/shared/shell/ShellContext';
import { askConfirm } from '@/shared/ui/overlay';
import { loadProfile, type Profile } from './api';
import ProfileSection from './sections/ProfileSection';
import AccountSection from './sections/AccountSection';
import DevicesSection from './sections/DevicesSection';
import AppearanceSection from './sections/AppearanceSection';
import SoundsSection from './sections/SoundsSection';
import NotificationsSection from './sections/NotificationsSection';
import SectionsSection from './sections/SectionsSection';
import McpSection from './sections/McpSection';
import CoreSection from './sections/CoreSection';
import './settings.css';

/**
 * Настройки: список разделов слева, открытый раздел справа; на телефоне —
 * по одному экрану за раз. Открытый раздел — в адресе (?section=…), поэтому
 * «Назад» работает как везде, а на раздел можно дать ссылку.
 */

type SectionId = 'profile' | 'account' | 'devices' | 'appearance' | 'sounds' | 'notifications' | 'sections' | 'core' | 'mcp';

interface SectionDef {
  id: SectionId;
  label: string;
  icon: ComponentType<{ size?: number }>;
  /** Два цвета плашки иконки — как в «Ещё». */
  tint: [string, string];
  needsProfile?: boolean;
  /** Только тем, кому включено «Ядро». */
  needsCore?: boolean;
}

const SECTIONS: SectionDef[] = [
  { id: 'profile', label: 'Профиль', icon: User, tint: ['#818cf8', '#6d28d9'], needsProfile: true },
  { id: 'account', label: 'Логин и пароль', icon: KeyRound, tint: ['#fbbf24', '#ea580c'], needsProfile: true },
  { id: 'devices', label: 'Устройства', icon: MonitorSmartphone, tint: ['#22d3ee', '#0e7490'] },
  { id: 'appearance', label: 'Внешний вид', icon: Palette, tint: ['#f472b6', '#db2777'] },
  { id: 'sounds', label: 'Звуки', icon: Volume2, tint: ['#60a5fa', '#2563eb'] },
  { id: 'notifications', label: 'Уведомления', icon: Bell, tint: ['#fb923c', '#dc2626'] },
  { id: 'sections', label: 'Разделы в меню', icon: LayoutGrid, tint: ['#34d399', '#059669'], needsProfile: true },
  { id: 'core', label: 'Ядро — агенты', icon: CoreIcon, tint: ['#c084fc', '#4338ca'], needsCore: true },
  { id: 'mcp', label: 'MCP', icon: Bot, tint: ['#a78bfa', '#4f46e5'] },
];

const isSection = (v: string | null): v is SectionId => SECTIONS.some((s) => s.id === v);

function useWide() {
  const query = '(min-width: 861px)';
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

export default function SettingsScreen() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const wide = useWide();
  const raw = params.get('section');
  const open: SectionId | null = isSection(raw) ? raw : wide ? 'profile' : null;

  const [profile, setProfile] = useState<Profile | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const p = await loadProfile();
      setProfile(p);
      adoptServerChatPrefs(p.chatSettings);
    } catch { setFailed(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // На телефоне открытый раздел прячет нижнее меню — как деталь в чатах.
  useShellOptions({ navHidden: !wide && open !== null });

  const go = (id: SectionId | null) => {
    const to = id ? `${paths.settings}?section=${id}` : paths.settings;
    // С телефона в раздел — новым шагом истории (назад вернёт к списку),
    // между разделами на компьютере — заменой.
    navigate(to, { replace: wide || id === null });
  };
  const back = () => (window.history.state?.idx > 0 ? navigate(-1) : go(null));

  const signOut = async () => {
    if (await askConfirm({ title: 'Выйти из аккаунта?', text: 'На этом устройстве придётся войти заново.', confirm: 'Выйти', tone: 'danger' })) await logout();
  };

  const coreOn = useAgentBridge((s) => s.available);
  const current = SECTIONS.find((s) => s.id === open);
  const version = window.sharDesktop?.appVersion;

  const list = (
    <nav className="nst-list nx-scroll-y" aria-label="Разделы настроек">
      <div className="nst-list-inner">
        <header className="nst-head">
          <button type="button" className="nx-icon-btn nst-back" aria-label="Назад в «Ещё»" onClick={() => navigate(paths.more)}>
            <ChevronLeft size={20} />
          </button>
          <h1>Настройки</h1>
        </header>
        <div className="nx-group">
          {SECTIONS.filter((s) => !s.needsCore || coreOn).map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                type="button"
                className="nx-row nst-nav-row"
                aria-current={open === s.id ? 'page' : undefined}
                onClick={() => go(s.id)}
              >
                <span className="nst-icon" style={{ '--a': s.tint[0], '--b': s.tint[1] } as CSSProperties} aria-hidden="true"><Icon size={16} /></span>
                <span className="nx-row-label">{s.label}</span>
                {!wide && <ChevronRight size={16} className="nst-chevron" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
        <div className="nx-group">
          <button type="button" className="nx-row nst-nav-row nst-danger" onClick={() => void signOut()}>
            <span className="nst-icon" style={{ '--a': '#f87171', '--b': '#b91c1c' } as CSSProperties} aria-hidden="true"><LogOut size={16} /></span>
            <span className="nx-row-label">Выйти из аккаунта</span>
          </button>
        </div>
        {version && <p className="nx-note">Шар для компьютера, версия {version}</p>}
      </div>
    </nav>
  );

  let body: ReactNode = null;
  if (current?.needsProfile && !profile) {
    body = failed ? (
      <div className="nx-state" role="alert">
        <RotateCw size={24} aria-hidden="true" />
        <h2>Профиль не загрузился</h2>
        <p>Нет связи с сервером.</p>
        <button type="button" className="nx-primary" onClick={() => void load()}>Попробовать снова</button>
      </div>
    ) : (
      <div className="nx-group" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="nx-row"><span className="nx-skel nx-skel-line" style={{ width: `${70 - i * 12}%` }} /></div>)}</div>
    );
  } else if (open === 'profile' && profile) body = <ProfileSection profile={profile} onChange={setProfile} />;
  else if (open === 'account' && profile) body = <AccountSection profile={profile} />;
  else if (open === 'devices') body = <DevicesSection />;
  else if (open === 'appearance') body = <AppearanceSection />;
  else if (open === 'sounds') body = <SoundsSection />;
  else if (open === 'notifications') body = <NotificationsSection />;
  else if (open === 'sections' && profile) body = <SectionsSection profile={profile} onChange={setProfile} />;
  else if (open === 'mcp') body = <McpSection />;
  else if (open === 'core') body = <CoreSection />;

  return (
    <div className="nst" data-open={open ? 'true' : undefined}>
      {(wide || !open) && list}
      {open && current && (
        <main className="nst-detail nx-scroll-y" aria-labelledby="nst-detail-title">
          <div className="nst-detail-inner">
            <header className="nst-head">
              {!wide && (
                <button type="button" className="nx-icon-btn nst-back" aria-label="К списку настроек" onClick={back}>
                  <ChevronLeft size={20} />
                </button>
              )}
              <h1 id="nst-detail-title">{current.label}</h1>
            </header>
            {body}
          </div>
        </main>
      )}
    </div>
  );
}
