import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, History, KeyRound, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { absolute } from '@/shared/navigation/routes';
import { askConfirm } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { loadMcpKeys, loadMcpLog, revokeMcpKey, type McpKey, type McpLogEntry } from '../api';
import McpKeySheet, { ACCESS, KINDS } from './McpKeySheet';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const day = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });

const TOOL_LABEL: Record<string, string> = {
  read_item: 'Прочитал', edit_note: 'Поправил заметку', update_note: 'Переписал заметку', edit_document: 'Поправил документ',
  update_document: 'Дополнил документ', update_table: 'Изменил таблицу', rename_item: 'Переименовал', create_note: 'Создал заметку',
  create_document: 'Создал документ', create_table: 'Создал таблицу', move_item: 'Переложил', create_folder: 'Создал папку',
};

async function copy(text: string, what: string) {
  try { await navigator.clipboard.writeText(text); showToast(`${what} — скопировано`, 'success'); } catch { showToast('Не удалось скопировать', 'error'); }
}

/** Доступ ключа словами: что можно, какие материалы, где, чьи. */
function scopeText(key: McpKey): string {
  const s = key.scope;
  const access = ACCESS.find((a) => a.value === s.access)?.label ?? s.access;
  const kinds = s.kinds.length === KINDS.length ? 'все материалы' : KINDS.filter((k) => s.kinds.includes(k.value)).map((k) => k.label.replace(/ \(.*\)$/, '').toLowerCase()).join(', ');
  const where = s.folders === null ? 'весь «Офис»' : `папок: ${s.folders.length}`;
  return [access, kinds, where, s.shared ? 'свои и чужие' : 'только свои'].join(' · ');
}

function KeyLog({ keyId }: { keyId: string }) {
  const [log, setLog] = useState<McpLogEntry[] | null>(null);
  useEffect(() => { loadMcpLog(keyId).then(setLog).catch(() => setLog([])); }, [keyId]);
  if (log === null) return <p className="nx-note">Загружаю журнал…</p>;
  if (!log.length) return <p className="nx-note">Агент этим ключом ещё ничего не делал.</p>;
  return (
    <ol className="nst-mcp-log">
      {log.map((e, i) => (
        <li key={i} data-tone={e.ok ? undefined : 'bad'}>
          <time>{when(e.at)}</time>
          <span>{TOOL_LABEL[e.tool] ?? e.tool}{e.title ? ` «${e.title}»` : e.itemId ? ` #${e.itemId}` : ''}{!e.ok && ` — ${e.error}`}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Ключи MCP: ИИ-агент (Claude, Cursor и другие) работает с «Офисом» от имени человека — и только там, куда тот его
 * пустил: уровень (читать / править / создавать), виды материалов, папки, чужие материалы, срок. Ключ виден один раз,
 * на сервере хранится только его отпечаток; доступ меняется без замены ключа; всё, что агент сделал, — в журнале.
 */
export default function McpSection() {
  const url = absolute('/api/mcp');
  const [keys, setKeys] = useState<McpKey[] | null>(null);
  const [error, setError] = useState('');
  const [sheet, setSheet] = useState<{ edit?: McpKey } | null>(null);
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const [openLog, setOpenLog] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setKeys(await loadMcpKeys()); setError(''); } catch (e) { setKeys([]); setError(e instanceof Error ? e.message : 'Не удалось загрузить ключи'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

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
          заметки, документы и таблицы, создаст новые и разложит по папкам — от вашего имени и только там, куда вы его пустите.
          Перед каждой его правкой сохраняется версия: прежнее можно вернуть из истории материала.
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
          <p className="nx-note">Скопируйте его сейчас: больше он показан не будет. Потеряется — отзовите и выпустите новый.</p>
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
            <button type="button" className="nx-icon-btn" aria-label="Скопировать настройки" onClick={() => void copy(config, 'Настройки')}><Copy size={16} /></button>
          </div>
          <div className="nx-actions"><button type="button" className="nx-ghost" onClick={() => setFresh(null)}>Готово, ключ сохранён</button></div>
        </section>
      )}

      <section className="nx-block">
        <div className="nx-block-head">
          <h2 className="nx-block-title">Ключи</h2>
          <button type="button" className="nx-primary" onClick={() => setSheet({})}><Plus size={15} aria-hidden="true" /> Новый ключ</button>
        </div>
        {error && <p className="nx-note" role="alert">{error}</p>}
        {keys === null ? (
          <div className="nx-group" aria-busy="true"><div className="nx-row"><span className="nx-skel nx-skel-line" style={{ width: '60%' }} /></div></div>
        ) : !keys.length && !error ? (
          <p className="nx-note">Ключей пока нет. Выпустите ключ и выберите, что агенту можно и где.</p>
        ) : (
          <div className="nx-group">
            {keys.map((k) => (
              <div key={k.id} className="nst-mcp-key" data-expired={k.expired || undefined}>
                <div className="nx-row">
                  <span className="nst-device-icon" aria-hidden="true"><KeyRound size={18} /></span>
                  <span className="nx-row-text">
                    <span className="nx-row-label">{k.name}{k.expired && <span className="nst-badge nst-badge-bad">Истёк</span>}</span>
                    <span className="nx-row-hint">{scopeText(k)}</span>
                    <span className="nx-row-hint">
                      <span className="nst-mono">{k.start}…</span>
                      {k.lastUsedAt ? ` · последний раз ${when(k.lastUsedAt)}` : ' · ещё не использовался'}
                      {k.expiresAt && !k.expired ? ` · до ${day(k.expiresAt)}` : ''}
                    </span>
                  </span>
                  <span className="nx-row-actions">
                    <button type="button" className="nx-icon-btn" aria-label={`Доступ ключа «${k.name}»`} title="Доступ" onClick={() => setSheet({ edit: k })}><SlidersHorizontal size={16} /></button>
                    <button type="button" className="nx-icon-btn" aria-label={`Журнал ключа «${k.name}»`} title="Что делал агент" aria-expanded={openLog === k.id}
                      onClick={() => setOpenLog(openLog === k.id ? null : k.id)}><History size={16} /></button>
                    <button type="button" className="nx-icon-btn" aria-label={`Отозвать ключ «${k.name}»`} title="Отозвать" onClick={() => void revoke(k)}><Trash2 size={16} /></button>
                  </span>
                </div>
                {openLog === k.id && <KeyLog keyId={k.id} />}
              </div>
            ))}
          </div>
        )}
      </section>

      {sheet && (
        <McpKeySheet
          edit={sheet.edit}
          onClose={() => setSheet(null)}
          onCreated={(key, token) => { setSheet(null); setFresh({ name: key.name, token }); void load(); }}
          onSaved={() => { setSheet(null); showToast('Доступ ключа изменён', 'success'); void load(); }}
        />
      )}
    </>
  );
}
