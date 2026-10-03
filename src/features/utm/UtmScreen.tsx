import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ChevronLeft, History, Link2, SlidersHorizontal } from 'lucide-react';
import { paths } from '@/shared/navigation/routes';
import { loadPresets, type Preset } from './api';
import GeneratorTab from './GeneratorTab';
import HistoryTab from './HistoryTab';
import PresetsTab from './PresetsTab';
import './utm.css';

const TABS = [
  { id: 'generate', label: 'Генерация', icon: Link2 },
  { id: 'history', label: 'История', icon: History },
  { id: 'presets', label: 'Пресеты', icon: SlidersHorizontal },
] as const;
type TabId = (typeof TABS)[number]['id'];

/** Генератор UTM-меток. Вкладка — в адресе (?tab=…), форма генерации живёт, пока открыт экран. */
export default function UtmScreen() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const raw = params.get('tab');
  const tab: TabId = TABS.some((t) => t.id === raw) ? (raw as TabId) : 'generate';
  const [presets, setPresets] = useState<Preset[] | null>(null);

  useEffect(() => { void loadPresets().then(setPresets); }, []);

  return (
    <div className="nx-page nx-scroll-y">
      <div className="nx-page-inner" data-wide="">
        <header className="nx-page-head">
          <button type="button" className="nx-icon-btn nx-page-back" aria-label="Назад в «Ещё»" onClick={() => navigate(paths.more)}>
            <ChevronLeft size={20} />
          </button>
          <h1>Генератор UTM</h1>
          <nav className="nx-segment nx-page-tools" aria-label="Разделы генератора">
            {TABS.map((t) => {
              const Icon = t.icon;
              return (
                <button key={t.id} type="button" aria-pressed={tab === t.id} onClick={() => setParams(t.id === 'generate' ? {} : { tab: t.id }, { replace: true })}>
                  <Icon size={13} aria-hidden="true" /> {t.label}
                </button>
              );
            })}
          </nav>
        </header>
        {/* Генерация остаётся смонтированной — введённое не теряется при переходе в историю. */}
        <div hidden={tab !== 'generate'}><GeneratorTab presets={presets || []} /></div>
        {tab === 'history' && <HistoryTab />}
        {tab === 'presets' && <PresetsTab presets={presets} onChange={setPresets} />}
      </div>
    </div>
  );
}
