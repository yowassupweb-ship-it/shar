import { useState } from 'react';
import { Sheet } from '@/shared/ui/overlay';
import { normalizeDocumentLink } from './officeInput';

export function DocLinkSheet({ initial, onApply, onClose }: { initial: string; onApply: (url: string) => void; onClose: () => void }) {
  const [url, setUrl] = useState(initial);
  const [error, setError] = useState('');
  const submit = () => {
    const normalized = normalizeDocumentLink(url);
    if (normalized) onApply(normalized);
    else setError('Введите адрес сайта, например example.ru, или ссылку https://…');
  };
  return (
    <Sheet title={initial ? 'Изменить ссылку' : 'Вставить ссылку'} onClose={onClose} footer={<>
      {initial && <button type="button" className="nx-ghost" onClick={() => onApply('')}>Убрать ссылку</button>}
      <button type="button" className="nx-ghost" onClick={onClose}>Отмена</button>
      <button type="submit" form="fdoc-link-form" className="nx-primary" disabled={!url.trim()}>Применить</button>
    </>}>
      <form id="fdoc-link-form" className="office-input-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label htmlFor="fdoc-link-url">Адрес ссылки</label>
        <input id="fdoc-link-url" autoFocus value={url} placeholder="https://example.ru" autoComplete="url" spellCheck={false} aria-invalid={Boolean(error)} aria-describedby="fdoc-link-help"
          onChange={(e) => { setUrl(e.target.value); setError(''); }} />
        <p id="fdoc-link-help" role={error ? 'alert' : undefined}>{error || 'Текст документа останется прежним. Адрес можно вставить без https://.'}</p>
      </form>
    </Sheet>
  );
}
