import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, KeyRound, Trash2 } from 'lucide-react';
import { absolute } from '@/shared/navigation/routes';
import { askConfirm } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { createMcpKey, loadMcpKeys, revokeMcpKey, type McpKey } from '../api';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

async function copy(text: string, what: string) {
  try { await navigator.clipboard.writeText(text); showToast(`${what} скопирован${what.endsWith('а') ? 'а' : ''}`, 'success'); } catch { showToast('Не удалось скопировать', 'error'); }
}

/**
 * Ключи MCP: ИИ-агент (Claude, Cursor и другие) работает с «Офисом» — заметками, документами, таблицами и папками —
 * от имени человека и с его правами. Ключ виден один раз, при выпуске; на сервере хранится только его отпечаток.
 */
export default function McpSection() {
  const url = absolute('/api/mcp');
  const [keys, setKeys] = useState<McpKey[] | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);

  const load = useCallback(async () => {
    try { setKeys(await loadMcpKeys()); setError(''); } catch (e) { setKeys([]); setError(e instanceof Error ? e.message : 'Не удалось загрузить ключи'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      const { key, token } = await createMcpKey(name.trim());
      setFresh({ name: key.name, token });
      setName('');
      await load();
    } catch (e) { showToast(e instanceof Error ? e.message : 'Ключ не выпустился', 'error'); } finally { setBusy(false); }
  };

  const revoke = async (key: McpKey) => {
    if (!(await askConfirm({ title: `Отозвать ключ «${key.name}»?`, text: 'Агенты с этим ключом сразу потеряют доступ.', confirm: 'Отозвать', tone: 'danger' }))) return;
    try { await revokeMcpKey(key.id); await load(); } catch (e) { showToast(e instanceof Error ? e.message : 'Ключ не отозвался', 'error'); }
  };

  const command = fresh ? `claude mcp add --transport http shar ${url} --header "Authorization: Bearer ${fresh.token}"` : '';
  const config = fresh ? JSON.stringify({ mcpServers: { shar: { type: 'http', url, headers: { Authorization: `Bearer ${fresh.token}` } } } }, null, 2) : '';

  return (
    <>
      <section className="nx-block">
        <p className="nx-note">
          Подключите ИИ-агента — Claude, Cursor или другого с поддержкой MCP — к «Офису». Он найдёт, прочитает и поправит
          заметки, документы и таблицы, создаст новые и разложит по папкам. Работает от вашего имени и видит только то, что видите вы;
          прежние версии остаются в истории.
        </p>
        <div className="nx-group">
          <div className="nx-row">
            <span className="nx-row-text">
              <span className="nx-row-label">Адрес сервера</span>
              <span className="nx-row-hint nst-mono">{url}</span>
            </span>
            <button type="button" className="nx-icon-btn" aria-label="Скопировать адрес" onClick={() => void copy(url, 'Адрес')}><Copy size={16} /></button>
          </div>
        </div>
      </section>

      {fresh && (
        <section className="nx-block nst-mcp-fresh" aria-live="polite">
          <h2 className="nx-block-title"><Check size={14} aria-hidden="true" /> Ключ «{fresh.name}» выпущен</h2>
          <p className="nx-note">Скопируйте его сейчас: больше он показан не будет. Если потеряется — отзовите и выпустите новый.</p>
          <div className="nst-code">
            <code>{fresh.token}</code>
            <button type="button" className="nx-icon-btn" aria-label="Скопировать ключ" onClick={() => void copy(fresh.token, 'Ключ')}><Copy size={16} /></button>
          </div>
          <p className="nx-note">Claude Code — одной командой в терминале:</p>
          <div className="nst-code">
            <code>{command}</code>
            <button type="button" className="nx-icon-btn" aria-label="Скопировать команду" onClick={() => void copy(command, 'Команда')}><Copy size={16} /></button>
          </div>
          <p className="nx-note">Cursor, Claude Code (.mcp.json) и другие — в настройки MCP-серверов:</p>
          <div className="nst-code">
            <pre>{config}</pre>
            <button type="button" className="nx-icon-btn" aria-label="Скопировать настройки" onClick={() => void copy(config, 'Настройка')}><Copy size={16} /></button>
          </div>
          <div className="nx-actions"><button type="button" className="nx-ghost" onClick={() => setFresh(null)}>Готово, ключ сохранён</button></div>
        </section>
      )}

      <section className="nx-block">
        <h2 className="nx-block-title">Ключи</h2>
        {error && <p className="nx-note" role="alert">{error}</p>}
        {keys === null ? (
          <div className="nx-group" aria-busy="true"><div className="nx-row"><span className="nx-skel nx-skel-line" style={{ width: '60%' }} /></div></div>
        ) : keys.length > 0 && (
          <div className="nx-group">
            {keys.map((k) => (
              <div key={k.id} className="nx-row">
                <span className="nst-device-icon" aria-hidden="true"><KeyRound size={18} /></span>
                <span className="nx-row-text">
                  <span className="nx-row-label">{k.name}</span>
                  <span className="nx-row-hint">
                    <span className="nst-mono">{k.start}…</span> · выпущен {when(k.createdAt)}{k.lastUsedAt ? ` · последний раз ${when(k.lastUsedAt)}` : ' · ещё не использовался'}
                  </span>
                </span>
                <button type="button" className="nx-icon-btn" aria-label={`Отозвать ключ «${k.name}»`} onClick={() => void revoke(k)}><Trash2 size={16} /></button>
              </div>
            ))}
          </div>
        )}
        <form className="nst-mcp-new" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <input className="nx-field" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Для чего ключ, например «Claude на ноутбуке»" aria-label="Название ключа" />
          <button type="submit" className="nx-primary" disabled={busy}>{busy ? 'Выпускаю…' : 'Выпустить ключ'}</button>
        </form>
      </section>
    </>
  );
}
