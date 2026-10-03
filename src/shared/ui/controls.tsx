import type { ReactNode } from 'react';

/** Группа строк с заголовком — как в «Системных настройках» macOS. */
export function Group({ title, note, children }: { title?: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="nx-block">
      {title && <h2 className="nx-block-title">{title}</h2>}
      <div className="nx-group">{children}</div>
      {note && <p className="nx-note">{note}</p>}
    </section>
  );
}

/** Строка: подпись слева, управление справа. */
export function Row({ label, hint, children, htmlFor }: {
  label: ReactNode; hint?: ReactNode; children?: ReactNode; htmlFor?: string;
}) {
  const Label = htmlFor ? 'label' : 'span';
  return (
    <div className="nx-row">
      <Label className="nx-row-text" {...(htmlFor ? { htmlFor } : {})}>
        <span className="nx-row-label">{label}</span>
        {hint && <span className="nx-row-hint">{hint}</span>}
      </Label>
      {children !== undefined && <div className="nx-row-control">{children}</div>}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="nx-switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="nx-switch-knob" aria-hidden="true" />
    </button>
  );
}

export function Slider({ id, value, min, max, step = 1, format, onChange, label }: {
  id: string; value: number; min: number; max: number; step?: number; label: string;
  format: (v: number) => string; onChange: (v: number) => void;
}) {
  return (
    <div className="nx-slider">
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        aria-valuetext={format(value)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <output htmlFor={id}>{format(value)}</output>
    </div>
  );
}
