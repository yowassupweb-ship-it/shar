import { useState } from 'react';
import { CornerDownRight, Search } from 'lucide-react';
import { Sheet } from '@/shared/ui/overlay';

export function SheetNavigation({ ready, readOnly, onGo, onFind }: { ready: boolean; readOnly: boolean; onGo: (range: string) => string | null; onFind: () => void }) {
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState('');
  const [error, setError] = useState('');
  return <>
    <div className="office-sheet-tools" aria-label="Навигация по таблице">
      <button type="button" disabled={!ready} onClick={() => { setOpen(true); setError(''); }}><CornerDownRight size={15} aria-hidden="true" />К диапазону</button>
      <span>{readOnly ? 'Только просмотр' : 'Enter — принять · Esc — отменить ввод'}</span>
      <button type="button" disabled={!ready} onClick={onFind}><Search size={15} aria-hidden="true" />Найти</button>
    </div>
    {open && <Sheet title="Перейти к диапазону" onClose={() => setOpen(false)} footer={<>
      <button type="button" className="nx-ghost" onClick={() => setOpen(false)}>Отмена</button>
      <button type="submit" form="office-range-form" className="nx-primary" disabled={!range.trim() || !ready}>Перейти</button>
    </>}>
      <form id="office-range-form" className="office-input-form" onSubmit={(e) => {
        e.preventDefault();
        const issue = onGo(range);
        if (issue) setError(issue); else setOpen(false);
      }}>
        <label htmlFor="office-range">Ячейка или диапазон на текущем листе</label>
        <input id="office-range" autoFocus value={range} placeholder="A1 или B2:D20" spellCheck={false} autoComplete="off" aria-invalid={Boolean(error)} aria-describedby="office-range-help"
          onChange={(e) => { setRange(e.target.value); setError(''); }} />
        <p id="office-range-help" role={error ? 'alert' : undefined}>{error || 'Диапазон будет выделен, а таблица прокрутится к его началу.'}</p>
      </form>
    </Sheet>}
  </>;
}
