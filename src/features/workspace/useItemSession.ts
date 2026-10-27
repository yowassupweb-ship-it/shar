import { useCallback, useEffect, useRef, useState } from 'react';
import { realtime } from '@/shared/realtime/realtime';
import { showToast } from '@/shared/ui/Toast';
import { WorkspaceError, workspaceApi } from './api';
import { merge3 } from './lib/merge';
import { LiveChannel, type LiveStart, type LiveStatus, type Transform } from './live/channel';
import type { AccessLevel, AccessMode, Item, Kind } from './types';

/**
 * Сессия правки одного материала — общая для всех видов и для обоих способов открыть:
 * по id (после входа) и по токену ссылки (без входа).
 *
 * Правка идёт в `pending`, через ~1 с без новых правок уходит на сервер вместе с
 * `baseUpdatedAt`: если за это время материал записал кто-то другой (по ссылке, коллега),
 * сервер отвечает 409 и человек выбирает — взять чужую версию или оставить свою.
 * Ctrl+S, закрытие страницы и уход со страницы сохраняют сразу.
 *
 * Документы и таблицы, открытые после входа, правятся вместе в реальном времени (live/channel.ts): каждая правка
 * сразу уходит коллегам, содержимое сохраняет канал с номером версии — без конфликтов и без «чью версию оставить».
 * Сессия тогда только открывает материал, показывает состояние и перечитывает его, если записали мимо совместной
 * правки (версия из истории, агент по MCP).
 */

export type Source = { id: string } | { token: string };
export type SaveState = 'saved' | 'pending' | 'saving' | 'error';

export interface SessionItem {
  id: string;
  kind: Kind;
  title: string;
  content: string;
  meta: Item['meta'];
  updatedAt: string;
  canEdit: boolean;
  isOwner: boolean;
  /** Есть только у материала, открытого после входа (по ссылке владельца не видно). */
  pinned?: boolean;
  accessLevel?: AccessLevel;
  accessMode?: AccessMode;
  ownerName?: string;
  live?: LiveStart;
}

const AUTOSAVE_MS = 900;

/** Перенос правок для вида материала: модули редакторов тяжёлые и грузятся отдельно — перенос тоже. */
async function transformFor(kind: Kind): Promise<Transform | null> {
  if (kind === 'document') return (await import('./live/docOps')).docTransform;
  if (kind === 'table') return (await import('./live/sheetOps')).sheetTransform;
  if (kind === 'note') return (await import('./live/textOps')).textTransform;
  return null;
}

// Правка у сервера (в журнале и у коллег) — «Сохранено»; сервер долго не отвечает — «Сохраняю…»; нет связи — правки ждут.
const LIVE_STATE: Record<LiveStatus, SaveState> = { synced: 'saved', sending: 'saving', saving: 'saving', offline: 'pending' };

export function useItemSession(source: Source) {
  const key = 'token' in source ? `t:${source.token}` : `i:${source.id}`;
  const sourceRef = useRef(source);
  sourceRef.current = source;

  const [item, setItem] = useState<SessionItem | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [error, setError] = useState('');
  const [state, setState] = useState<SaveState>('saved');
  const [conflict, setConflict] = useState(false);
  const [loadKey, setLoadKey] = useState(0);
  const [live, setLive] = useState<LiveChannel | null>(null);
  const liveRef = useRef<LiveChannel | null>(null);
  /** Последнее содержимое из живого редактора — для экспорта и копирования (сохраняет его канал). */
  const liveContent = useRef<string | null>(null);
  const resetAt = useRef(0);
  const onLiveReset = useRef<() => void>(() => undefined);
  const kindRef = useRef<Kind | null>(null);

  const pendingContent = useRef<string | null>(null);
  const pendingTitle = useRef<string | null>(null);
  const savingRef = useRef(false);
  const baseRef = useRef('');
  const canEditRef = useRef(false);
  const savedContent = useRef('');
  /** Счётчик своих сохранений: перечитанное с сервера, пока шло наше сохранение, уже устарело. */
  const saves = useRef(0);

  const apply = useCallback((next: SessionItem, remount: boolean) => {
    setItem(next);
    baseRef.current = next.updatedAt;
    canEditRef.current = next.canEdit;
    savedContent.current = next.content;
    if (remount) setLoadKey((n) => n + 1);
  }, []);

  const fetchItem = useCallback(async (): Promise<SessionItem> => {
    const src = sourceRef.current;
    if ('token' in src) {
      const { mode, item: shared } = await workspaceApi.shared(src.token);
      return { ...shared, content: shared.content ?? '', canEdit: mode === 'edit', isOwner: false };
    }
    const full = await workspaceApi.get(src.id);
    return {
      id: full.id, kind: full.kind, title: full.title, content: full.content ?? '', meta: full.meta,
      updatedAt: full.updatedAt, canEdit: full.canEdit, isOwner: full.isOwner,
      pinned: full.pinned, accessLevel: full.accessLevel, accessMode: full.accessMode, ownerName: full.ownerName,
      live: full.live,
    };
  }, []);

  const load = useCallback(async (remount: boolean) => {
    setError('');
    try {
      const loaded = await fetchItem();
      const transform = loaded.live ? await transformFor(loaded.kind) : null;
      pendingContent.current = null;
      pendingTitle.current = null;
      liveContent.current = null;
      setConflict(false);
      setState('saved');
      liveRef.current?.close();
      liveRef.current = null;
      if (loaded.live && transform && !('token' in sourceRef.current)) {
        const savedLive = (loaded.meta as { live?: { epoch?: string; rev?: number } } | undefined)?.live;
        const savedRev = savedLive?.epoch === loaded.live.epoch ? Number(savedLive.rev) || 0 : loaded.live.rev;
        const channel = new LiveChannel({
          itemId: String(loaded.id),
          canEdit: loaded.canEdit,
          transform,
          save: async (content, mark) => {
            try {
              const res = await workspaceApi.saveLive(String(loaded.id), content, mark);
              savedContent.current = content;
              liveContent.current = content;
              setItem((cur) => (cur ? { ...cur, updatedAt: res.item.updatedAt } : cur));
              setError('');
              return res.live === 'already' ? 'already' : 'saved';
            } catch (cause) {
              // 409: материал записали мимо совместной правки — журнал сменился, открываем заново.
              if (cause instanceof WorkspaceError && cause.status === 409) onLiveReset.current();
              else setError(cause instanceof Error ? cause.message : String(cause));
              throw cause;
            }
          },
          onReset: () => onLiveReset.current(),
          onStatus: (next) => setState(LIVE_STATE[next]),
          saveEvery: 2000,
          saveIdle: loaded.kind === 'table' ? 2000 : loaded.kind === 'document' ? 1500 : undefined,
        }, loaded.live, savedRev);
        liveRef.current = channel;
        setLive(channel);
      } else setLive(null);
      kindRef.current = loaded.kind;
      apply(loaded, remount);
      setStatus('ready');
    } catch (cause) {
      if (cause instanceof WorkspaceError && (cause.status === 404 || cause.status === 403)) setStatus('missing');
      else { setStatus('error'); setError(cause instanceof Error ? cause.message : String(cause)); }
    }
  }, [apply, fetchItem]);

  useEffect(() => {
    setStatus('loading');
    setItem(null);
    void load(true);
  }, [key, load]);

  // Ушли из материала — канал совместной правки закрывается (коллеги перестают слать нам правки).
  useEffect(() => () => { liveRef.current?.close(); liveRef.current = null; }, [key]);

  /**
   * Журнал совместной правки больше не описывает материал (его записали мимо: версия из истории, агент, гость по
   * ссылке): открываем заново. Не чаще раза в 3 с — если журнал всё время «устаревший», не крутимся в цикле.
   */
  onLiveReset.current = () => {
    const unsent = liveRef.current?.pendingCount() ?? 0;
    liveRef.current?.close();
    liveRef.current = null;
    const wait = Math.max(0, 3000 - (Date.now() - resetAt.current));
    resetAt.current = Date.now() + wait;
    window.setTimeout(() => {
      // Заметку не открываем заново: её редактор сольёт новое содержимое со своим текстом на месте.
      void load(kindRef.current !== 'note');
      if (unsent) showToast('Материал изменили в обход совместной правки — он открыт заново. Последние несколько секунд правок могли не сохраниться', 'info');
    }, wait);
  };

  const save = useCallback(async () => {
    if (savingRef.current) return;
    const content = pendingContent.current;
    const title = pendingTitle.current;
    if (content === null && title === null) return;
    savingRef.current = true;
    setState('saving');
    try {
      const src = sourceRef.current;
      const body: { title?: string; content?: string; baseUpdatedAt?: string } = {};
      if (title !== null) body.title = title;
      if (content !== null) { body.content = content; body.baseUpdatedAt = baseRef.current || undefined; }
      let updatedAt: string;
      if ('token' in src) updatedAt = (await workspaceApi.saveShared(src.token, body)).item.updatedAt;
      else updatedAt = (await workspaceApi.patch(src.id, body)).updatedAt;
      saves.current += 1;
      baseRef.current = updatedAt;
      if (content !== null) savedContent.current = content;
      if (pendingContent.current === content) pendingContent.current = null;
      if (pendingTitle.current === title) pendingTitle.current = null;
      // Ни название, ни содержимое не подставляем: в редакторе они и так свежее отправленного. Подстановка
      // затирала набранное, пока шёл запрос: в названии «пропадала буква-две», а заметка принимала своё же
      // сохранение за чужую правку и при зажатой клавише откатывала текст на отправленный — набор дёргался.
      setItem((cur) => (cur ? { ...cur, updatedAt } : cur));
      setError('');
      setState(pendingContent.current !== null || pendingTitle.current !== null ? 'pending' : 'saved');
    } catch (cause) {
      if (cause instanceof WorkspaceError && cause.status === 409) { setConflict(true); setState('pending'); }
      else { setError(cause instanceof Error ? cause.message : String(cause)); setState('error'); }
    } finally {
      savingRef.current = false;
    }
  }, []);

  const setContent = useCallback((next: string) => {
    // Совместная правка: правки уходят из редактора в канал сами, здесь — только для экспорта и копирования.
    if (liveRef.current) { liveContent.current = next; return; }
    if (!canEditRef.current || next === savedContent.current) return;
    pendingContent.current = next;
    setError('');
    setState('pending');
  }, []);

  const setTitle = useCallback((next: string) => {
    if (!canEditRef.current) return;
    pendingTitle.current = next;
    setItem((cur) => (cur ? { ...cur, title: next } : cur));
    setState('pending');
  }, []);

  // Автосохранение.
  useEffect(() => {
    if (state !== 'pending' || conflict) return undefined;
    const timer = window.setTimeout(() => void save(), AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [state, save, conflict]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); liveRef.current?.saveNow(); void save(); }
    };
    const flush = () => {
      liveRef.current?.saveNow();
      if (pendingContent.current !== null || pendingTitle.current !== null) void save();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('pagehide', flush); flush(); };
  }, [save]);

  // Вернулись в окно: если без наших несохранённых правок материал уже изменили — подтягиваем свежую версию.
  const pullRemote = useCallback(async () => {
    // Живой редактор догоняет журнал сам (канал), перечитывать материал целиком не нужно.
    if (liveRef.current) return;
    if (pendingContent.current !== null || pendingTitle.current !== null || savingRef.current) return;
    try {
      const seq = saves.current;
      const fresh = await fetchItem();
      if (pendingContent.current !== null || pendingTitle.current !== null || savingRef.current || seq !== saves.current) return;
      if (fresh.updatedAt === baseRef.current) return;
      const contentChanged = fresh.content !== savedContent.current;
      apply(fresh, contentChanged);
    } catch { /* сеть моргнула — следующий возврат догонит */ }
  }, [apply, fetchItem]);

  /**
   * Коллега сохранил материал, пока он открыт у нас: подтягиваем сразу, не дожидаясь возврата в окно.
   * Нет своих несохранённых правок — берём чужую версию (у заметки редактор вольёт её на месте, без перезагрузки
   * и без прыжка курсора, у остальных видов редактор открывается заново). Свои правки есть — заметки сливаем
   * построчно и по символам (merge3), остальные виды решаются при сохранении («чужая версия / моя»).
   */
  const liveTimer = useRef(0);
  const pullLive = useCallback(async () => {
    if (liveRef.current || savingRef.current || 'token' in sourceRef.current) return;
    try {
      const seq = saves.current;
      const fresh = await fetchItem();
      // Пока читали, ушло наше сохранение: прочитанное его не содержит — дождёмся следующего события.
      if (savingRef.current || seq !== saves.current || fresh.updatedAt === baseRef.current) return;
      const mine = pendingContent.current;
      const note = fresh.kind === 'note';
      if (mine === null && pendingTitle.current === null) {
        apply(fresh, !note && fresh.content !== savedContent.current);
        return;
      }
      if (note && mine !== null) {
        const merged = merge3(savedContent.current, mine, fresh.content);
        if (merged.conflict) { setConflict(true); return; }
        baseRef.current = fresh.updatedAt;
        savedContent.current = fresh.content;
        pendingContent.current = merged.text;
        setItem((cur) => (cur ? { ...cur, content: merged.text, updatedAt: fresh.updatedAt } : cur));
        setState('pending');
      }
    } catch { /* сеть моргнула — следующее событие или возврат в окно догонят */ }
  }, [apply, fetchItem]);

  useEffect(() => {
    if ('token' in sourceRef.current) return undefined;
    const id = String(sourceRef.current.id);
    const off = realtime.subscribe((event) => {
      const e = event as { type?: string; reason?: string; itemId?: string };
      if (e.type !== 'workspace_changed' || e.reason !== 'content' || String(e.itemId) !== id) return;
      window.clearTimeout(liveTimer.current);
      liveTimer.current = window.setTimeout(() => void pullLive(), 700);
    });
    return () => { off(); window.clearTimeout(liveTimer.current); };
  }, [key, pullLive]);

  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === 'visible') void pullRemote(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus); };
  }, [pullRemote]);

  /** Конфликт: взять версию с сервера (свои правки отбрасываются) или сохранить свою поверх. */
  const resolveConflict = useCallback(async (keepMine: boolean) => {
    if (!keepMine) { await load(true); return; }
    try {
      const latest = await fetchItem();
      baseRef.current = latest.updatedAt;
      setConflict(false);
      await save();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [fetchItem, load, save]);

  /** Обновить поля материала, не связанные с содержимым (метка, закрепление, доступ). */
  const patchFields = useCallback(async (fields: Record<string, unknown>) => {
    const src = sourceRef.current;
    if ('token' in src) return;
    const updated = await workspaceApi.patch(src.id, fields);
    setItem((cur) => (cur ? {
      ...cur, meta: updated.meta, title: pendingTitle.current ?? updated.title,
      pinned: updated.pinned, accessLevel: updated.accessLevel, accessMode: updated.accessMode,
    } : cur));
    return updated;
  }, []);

  /**
   * Заменить содержимое целиком (импорт файла в открытый материал): редактор пересобирается из нового
   * содержимого, а сохранение идёт обычным путём — автосохранением, с проверкой конфликта.
   */
  const replaceContent = useCallback((next: string, title?: string) => {
    if (!canEditRef.current) return;
    const src = sourceRef.current;
    if (liveRef.current && !('token' in src)) {
      // Совместная правка: новое содержимое целиком — запись мимо журнала. Сохраняем сразу; у всех (и у нас)
      // материал откроется заново уже с ним.
      setState('saving');
      workspaceApi.patch(src.id, { content: next, ...(title !== undefined ? { title } : {}) })
        .then(() => load(true))
        .catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : String(cause)); setState('error'); });
      return;
    }
    pendingContent.current = next;
    if (title !== undefined) pendingTitle.current = title;
    setItem((cur) => (cur ? { ...cur, content: next, ...(title !== undefined ? { title } : {}) } : cur));
    setLoadKey((n) => n + 1);
    setError('');
    setState('pending');
  }, [load]);

  /** Самое свежее содержимое, в том числе ещё не отправленное на сервер (для экспорта и копирования). */
  const getContent = useCallback(() => pendingContent.current ?? liveContent.current ?? savedContent.current, []);

  /**
   * Собрать содержимое из редактора прямо сейчас (совместная правка: таблица и документ не собирают файл после каждой
   * правки — это тормозило ввод). Звать перед скачиванием, печатью, копией; дальше getContent вернёт свежее.
   */
  const refreshContent = useCallback(async () => {
    const fresh = await liveRef.current?.snapshot();
    if (typeof fresh === 'string') liveContent.current = fresh;
  }, []);

  return {
    item, status, error, state, conflict, loadKey, getContent, refreshContent, live,
    setContent, replaceContent, setTitle, save, resolveConflict, patchFields,
    reload: () => load(true),
  };
}
