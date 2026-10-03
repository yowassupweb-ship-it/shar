import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Check, Laptop, Moon, Plus, Sun } from 'lucide-react';
import { useTheme } from '@/shared/theme/ThemeContext';
import { ThemePicker } from '@/shared/theme/ThemePicker';
import { FONT_LIMITS, readAppearance, readChatPrefs, saveAppearance, saveChatPrefs } from '@/shared/settings/chatPrefs';
import {
  BUBBLE_IN_COLORS, BUBBLE_OUT_COLORS, DEFAULT_APPEARANCE, GRADIENTS, PATTERN_SCALE, BUBBLE_RADIUS,
  imageBackground, textOn, type BubbleShape, type ChatAppearance, type ThemeKey, type ThemeLook,
} from '@/shared/settings/chatAppearance';
import { askConfirm } from '@/shared/ui/overlay';
import { loadChatAssets, type ChatAssets } from '../api';
import { Group, Row, Slider } from '@/shared/ui/controls';

const PALETTE_NAMES = { light: 'светлая', gray: 'серая', graphite: 'графитовая', black: 'чёрная' } as const;
const EMPTY_ASSETS: ChatAssets = { light: { backgrounds: [], overlays: [] }, dark: { backgrounds: [], overlays: [] } };

/** Плитка выбора: образец + подпись, отмечена галочкой. */
function Tile({ selected, label, onSelect, style, children }: {
  selected: boolean; label: string; onSelect: () => void; style?: CSSProperties; children?: ReactNode;
}) {
  return (
    <button type="button" role="radio" aria-checked={selected} aria-label={label} title={label} className="nst-tile" onClick={onSelect}>
      <span className="nst-tile-swatch" style={style}>
        {children}
        {selected && <span className="nst-tile-check" aria-hidden="true"><Check size={12} strokeWidth={3} /></span>}
      </span>
      <span className="nst-tile-name">{label}</span>
    </button>
  );
}

/** Круглый образец цвета + «свой цвет» через системную палитру. */
function ColorPicker({ label, value, options, onChange, defaultLabel, defaultSwatch }: {
  label: string; value: string; options: { id: string; name: string; value: string }[];
  onChange: (hex: string) => void; defaultLabel: string; defaultSwatch: string;
}) {
  const custom = value && !options.some((o) => o.value.toLowerCase() === value.toLowerCase());
  return (
    <div className="nx-colors" role="radiogroup" aria-label={label}>
      <button type="button" role="radio" aria-checked={!value} className="nx-color" title={defaultLabel} aria-label={defaultLabel}
        style={{ background: defaultSwatch }} onClick={() => onChange('')}>
        {!value && <Check size={13} strokeWidth={3} aria-hidden="true" />}
      </button>
      {options.map((o) => {
        const on = value.toLowerCase() === o.value.toLowerCase();
        return (
          <button key={o.id} type="button" role="radio" aria-checked={on} className="nx-color" title={o.name} aria-label={o.name}
            style={{ background: o.value, color: textOn(o.value) }} onClick={() => onChange(o.value)}>
            {on && <Check size={13} strokeWidth={3} aria-hidden="true" />}
          </button>
        );
      })}
      <label className="nx-color nx-color-custom" title="Свой цвет" data-on={custom ? 'true' : undefined}
        style={custom ? { background: value, color: textOn(value) } : undefined}>
        {custom ? <Check size={13} strokeWidth={3} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
        <input type="color" aria-label={`${label}: свой цвет`} value={custom ? value : '#0071e3'} onChange={(e) => onChange(e.target.value)} />
      </label>
    </div>
  );
}

export default function AppearanceSection() {
  const { theme, palette, themePref } = useTheme();
  const [prefs, setPrefs] = useState(readChatPrefs);
  const [look, setLook] = useState<ChatAppearance>(readAppearance);
  // Какую тему оформляем. По умолчанию — ту, что сейчас на экране.
  const [edit, setEdit] = useState<ThemeKey>(theme === 'dark' ? 'dark' : 'light');
  const [assets, setAssets] = useState<ChatAssets>(EMPTY_ASSETS);

  useEffect(() => { void loadChatAssets().then(setAssets).catch(() => { /* останутся встроенные градиенты */ }); }, []);

  const px = (v: number) => `${v} px`;
  const pct = (v: number) => `${Math.round(v)}%`;
  const update = (patch: { fontSize?: number; fontSizeMobile?: number }) => setPrefs(saveChatPrefs(patch));
  const change = (next: ChatAppearance) => setLook(saveAppearance(next));
  const setTheme = (patch: Partial<ThemeLook>) => change({ ...look, [edit]: { ...look[edit], ...patch } });

  const t = look[edit];
  const bgOptions = [
    ...GRADIENTS[edit].map((g) => ({ key: g.id, name: g.name, value: g.value })),
    ...assets[edit].backgrounds.map((a) => ({ key: a.url, name: a.name, value: imageBackground(a.url) })),
  ];
  const patterns = assets[edit].overlays;

  // Образец переписки — те же правила, что у ленты, но на выбранную тему.
  const outColor = t.bubbleOut || 'var(--accent-fill)';
  const inColor = t.bubbleIn || (edit === theme ? 'var(--bubble-gray)' : edit === 'dark' ? '#3a3a3c' : '#e9e9eb');
  const radius = BUBBLE_RADIUS[look.bubbleShape];
  const alpha = (c: string) => (look.bubbleOpacity < 1 ? `color-mix(in srgb, ${c} ${Math.round(look.bubbleOpacity * 100)}%, transparent)` : c);
  const previewBase = edit === 'dark' ? '#202124' : '#f5f5f7';

  const reset = async () => {
    if (!(await askConfirm({ title: 'Сбросить оформление чата?', text: 'Фон, узор и цвета пузырей вернутся к стандартным для обеих тем.', confirm: 'Сбросить' }))) return;
    change({ ...DEFAULT_APPEARANCE, light: { ...DEFAULT_APPEARANCE.light }, dark: { ...DEFAULT_APPEARANCE.dark } });
  };

  return (
    <>
      <Group title="Оформление">
        <Row label="Тема" hint={themePref === 'system' ? `Как в системе — сейчас ${PALETTE_NAMES[palette]}` : undefined}>
          <ThemePicker />
        </Row>
      </Group>

      <section className="nx-block">
        <div className="nx-block-head">
          <h2 className="nx-block-title">Переписка</h2>
          <div className="nx-segment" role="group" aria-label="Настраиваем для темы">
            <button type="button" aria-pressed={edit === 'light'} onClick={() => setEdit('light')}><Sun size={13} aria-hidden="true" /> Для светлой</button>
            <button type="button" aria-pressed={edit === 'dark'} onClick={() => setEdit('dark')}><Moon size={13} aria-hidden="true" /> Для тёмной</button>
          </div>
        </div>

        <div className="nst-chat-preview" aria-hidden="true" style={{ background: t.background || previewBase }}>
          {t.pattern && (
            <span className="nst-chat-pattern" style={{ backgroundImage: `url("${t.pattern}")`, backgroundSize: `${look.patternScale}%`, opacity: look.patternOpacity }} />
          )}
          <span className="nst-bubble" data-side="in" style={{ background: alpha(inColor), color: t.bubbleIn ? textOn(t.bubbleIn) : edit === 'dark' ? '#f5f5f7' : '#1d1d1f', borderRadius: radius, fontSize: prefs.fontSize }}>
            Привет! Как продвигается?
          </span>
          <span className="nst-bubble" data-side="out" style={{ background: alpha(outColor), color: t.bubbleOut ? textOn(t.bubbleOut) : '#fff', borderRadius: radius, fontSize: prefs.fontSize }}>
            Почти готово, пришлю через час
          </span>
          <span className="nst-bubble" data-side="in" style={{ background: alpha(inColor), color: t.bubbleIn ? textOn(t.bubbleIn) : edit === 'dark' ? '#f5f5f7' : '#1d1d1f', borderRadius: radius, fontSize: prefs.fontSize }}>
            Отлично, жду
          </span>
        </div>
        {edit !== theme && <p className="nx-note">Сейчас на экране {theme === 'dark' ? 'тёмная' : 'светлая'} тема — выбранное появится в переписке, когда включится {edit === 'dark' ? 'тёмная' : 'светлая'}.</p>}
      </section>

      <Group title="Фон">
        <div className="nst-tiles" role="radiogroup" aria-label="Фон переписки">
          <Tile selected={!t.background} label="Без фона" onSelect={() => setTheme({ background: '' })} style={{ background: previewBase }} />
          {bgOptions.map((o) => (
            <Tile key={o.key} selected={t.background === o.value} label={o.name} onSelect={() => setTheme({ background: o.value })} style={{ background: o.value }} />
          ))}
        </div>
      </Group>

      <Group title="Узор" note={patterns.length ? undefined : 'Узоры загружаются с сервера — сейчас их список недоступен.'}>
        <div className="nst-tiles" role="radiogroup" aria-label="Узор поверх фона">
          <Tile selected={!t.pattern} label="Без узора" onSelect={() => setTheme({ pattern: '' })} style={{ background: t.background || previewBase }} />
          {patterns.map((p) => (
            <Tile key={p.url} selected={t.pattern === p.url} label={p.name} onSelect={() => setTheme({ pattern: p.url })}
              style={{ background: `url("${p.url}") center / 180% repeat, ${t.background || previewBase}` }} />
          ))}
        </div>
        {t.pattern && (
          <>
            <Row label="Размер узора" htmlFor="nst-pattern-scale">
              <Slider id="nst-pattern-scale" label="Размер узора" value={look.patternScale} min={PATTERN_SCALE.min} max={PATTERN_SCALE.max} step={5}
                format={pct} onChange={(v) => change({ ...look, patternScale: v })} />
            </Row>
            <Row label="Заметность узора" htmlFor="nst-pattern-opacity">
              <Slider id="nst-pattern-opacity" label="Заметность узора" value={Math.round(look.patternOpacity * 100)} min={5} max={100} step={5}
                format={pct} onChange={(v) => change({ ...look, patternOpacity: v / 100 })} />
            </Row>
          </>
        )}
      </Group>

      <Group title="Пузыри">
        <Row label="Форма">
          <div className="nx-segment" role="group" aria-label="Форма пузырей">
            {([['round', 'Круглые'], ['classic', 'Мягкие'], ['square', 'Строгие']] as [BubbleShape, string][]).map(([id, name]) => (
              <button key={id} type="button" aria-pressed={look.bubbleShape === id} onClick={() => change({ ...look, bubbleShape: id })}>{name}</button>
            ))}
          </div>
        </Row>
        <Row label="Мои сообщения">
          <ColorPicker label="Цвет моих сообщений" value={t.bubbleOut} options={BUBBLE_OUT_COLORS}
            defaultLabel="Как в теме" defaultSwatch="var(--accent-fill)" onChange={(v) => setTheme({ bubbleOut: v })} />
        </Row>
        <Row label="Сообщения собеседников">
          <ColorPicker label="Цвет сообщений собеседников" value={t.bubbleIn} options={BUBBLE_IN_COLORS[edit]}
            defaultLabel="Как в теме" defaultSwatch={edit === 'dark' ? '#3a3a3c' : '#e9e9eb'} onChange={(v) => setTheme({ bubbleIn: v })} />
        </Row>
        <Row label="Прозрачность" hint="Сквозь пузыри виден фон" htmlFor="nst-bubble-opacity">
          <Slider id="nst-bubble-opacity" label="Непрозрачность пузырей" value={Math.round(look.bubbleOpacity * 100)} min={50} max={100} step={5}
            format={pct} onChange={(v) => change({ ...look, bubbleOpacity: v / 100 })} />
        </Row>
      </Group>

      <Group title="Текст сообщений" note="Меняется сразу во всех открытых чатах и сохраняется в профиле.">
        <Row label="На компьютере" htmlFor="nst-font-desktop">
          <Slider id="nst-font-desktop" label="Размер текста на компьютере" value={prefs.fontSize}
            min={FONT_LIMITS.desktop.min} max={FONT_LIMITS.desktop.max} format={px} onChange={(v) => update({ fontSize: v })} />
        </Row>
        <Row label="На телефоне" htmlFor="nst-font-mobile">
          <Slider id="nst-font-mobile" label="Размер текста на телефоне" value={prefs.fontSizeMobile}
            min={FONT_LIMITS.mobile.min} max={FONT_LIMITS.mobile.max} format={px} onChange={(v) => update({ fontSizeMobile: v })} />
        </Row>
      </Group>

      <div className="nx-actions">
        <button type="button" className="nx-ghost" onClick={() => void reset()}>Сбросить оформление чата</button>
      </div>
    </>
  );
}
