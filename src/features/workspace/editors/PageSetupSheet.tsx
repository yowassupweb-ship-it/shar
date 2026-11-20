import { useState } from 'react';
import { Sheet } from '@/shared/ui/overlay';
import { Group, Row } from '@/shared/ui/controls';
import { PX_PER_CM, type PageBox } from './DocRulers';

/** Листы, которые бывают в документах: A4 (по умолчанию), A5, Letter. Пиксели — при 96 dpi, как в снимке. */
const SIZES = [
  { id: 'a4', label: 'A4 (21 × 29,7 см)', w: 794, h: 1123 },
  { id: 'a5', label: 'A5 (14,8 × 21 см)', w: 559, h: 794 },
  { id: 'letter', label: 'Letter (21,6 × 27,9 см)', w: 816, h: 1056 },
];

const toCm = (px: number) => Math.round((px / PX_PER_CM) * 100) / 100;
const toPx = (value: number) => Math.round(value * PX_PER_CM);

/** «Файл → Параметры страницы»: ориентация, размер листа, поля и колонтитулы в сантиметрах. */
export function PageSetupSheet({ page, onApply, onClose }: { page: PageBox; onApply: (next: PageBox) => void; onClose: () => void }) {
  const landscape0 = page.width > page.height;
  const size0 = SIZES.find((s) => (Math.abs(s.w - Math.min(page.width, page.height)) < 4 && Math.abs(s.h - Math.max(page.width, page.height)) < 4))?.id ?? 'a4';
  const [landscape, setLandscape] = useState(landscape0);
  const [size, setSize] = useState(size0);
  const [cm, setCm] = useState({
    marginTop: toCm(page.marginTop), marginBottom: toCm(page.marginBottom), marginLeft: toCm(page.marginLeft), marginRight: toCm(page.marginRight),
    marginHeader: toCm(page.marginHeader), marginFooter: toCm(page.marginFooter),
  });
  const field = (key: keyof typeof cm, label: string) => (
    <Row label={label} htmlFor={`ps-${key}`}>
      <span className="fdoc-ps-cm">
        <input id={`ps-${key}`} type="number" min={0} max={10} step={0.1} value={cm[key]}
          onChange={(e) => setCm((c) => ({ ...c, [key]: Math.max(0, Math.min(10, Number(e.target.value) || 0)) }))} />
        см
      </span>
    </Row>
  );
  const apply = () => {
    const s = SIZES.find((x) => x.id === size) ?? SIZES[0];
    const width = landscape ? s.h : s.w;
    const height = landscape ? s.w : s.h;
    const px = Object.fromEntries(Object.entries(cm).map(([k, v]) => [k, toPx(v)])) as Record<keyof typeof cm, number>;
    // Текст должен поместиться: поля не больше листа без 2 см.
    const fitX = Math.max(0, width - toPx(2));
    const fitY = Math.max(0, height - toPx(2));
    if (px.marginLeft + px.marginRight > fitX) { const k = fitX / (px.marginLeft + px.marginRight); px.marginLeft = Math.round(px.marginLeft * k); px.marginRight = Math.round(px.marginRight * k); }
    if (px.marginTop + px.marginBottom > fitY) { const k = fitY / (px.marginTop + px.marginBottom); px.marginTop = Math.round(px.marginTop * k); px.marginBottom = Math.round(px.marginBottom * k); }
    px.marginHeader = Math.min(px.marginHeader, Math.max(0, px.marginTop - 8));
    px.marginFooter = Math.min(px.marginFooter, Math.max(0, px.marginBottom - 8));
    onApply({ width, height, ...px });
    onClose();
  };
  return (
    <Sheet title="Параметры страницы" onClose={onClose} footer={(
      <>
        <button type="button" className="nx-ghost" onClick={onClose}>Отмена</button>
        <button type="button" className="nx-primary" onClick={apply}>Применить</button>
      </>
    )}>
      <Group title="Лист">
        <Row label="Ориентация">
          <div className="nx-segment" role="radiogroup" aria-label="Ориентация">
            <button type="button" role="radio" aria-checked={!landscape} aria-pressed={!landscape} onClick={() => setLandscape(false)}>Книжная</button>
            <button type="button" role="radio" aria-checked={landscape} aria-pressed={landscape} onClick={() => setLandscape(true)}>Альбомная</button>
          </div>
        </Row>
        <Row label="Размер" htmlFor="ps-size">
          <select id="ps-size" className="nws-select" value={size} onChange={(e) => setSize(e.target.value)}>
            {SIZES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </Row>
      </Group>
      <Group title="Поля" note="Поля можно тянуть и прямо на линейках над листом и слева от него.">
        {field('marginTop', 'Сверху')}
        {field('marginBottom', 'Снизу')}
        {field('marginLeft', 'Слева')}
        {field('marginRight', 'Справа')}
      </Group>
      <Group title="Колонтитулы" note="Расстояние от края листа до верхнего и нижнего колонтитула.">
        {field('marginHeader', 'Верхний')}
        {field('marginFooter', 'Нижний')}
      </Group>
    </Sheet>
  );
}
