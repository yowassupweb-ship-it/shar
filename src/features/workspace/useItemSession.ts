import { useCallback, useEffect, useRef, useState } from 'react';
import { realtime } from '@/shared/realtime/realtime';
import { WorkspaceError, workspaceApi } from './api';
import { merge3 } from './lib/merge';
import type { AccessLevel, AccessMode, Item, Kind } from './types';

/**
 * Сессия правки одного материала — общая для всех видов и для обоих способов открыть:
 * по id (после входа) и по токену ссылки (без входа).
 *
 * Правка идёт в `pending`, через ~1 с без новых правок уходит на сервер вместе с
 * `baseUpdatedAt`: если за это время материал записал кто-то другой (по ссылке, коллега),
 * сервер отвечает 409 и человек выбирает — взять чужую версию или оставить свою.
 * Ctrl+S, закрытие страницы и уход со страницы сохраняют сразу.
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
}

const AUTOSAVE_MS = 900;

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

  const pendingContent = useRef<string | null>(null);
  const pendingTitle = useRef<string | null>(null);
  const savingRef = useRef(false);
  const baseRef = useRef('');
  const canEditRef = useRef(false);
  const savedContent = useRef('');

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
    };
  }, []);

  const load = useCallback(async (remount: boolean) => {
    setError('');
    try {
      const loaded = await fetchItem();
      pendingContent.current = null;
      pendingTitle.current = null;
      setConflict(false);
      setState('saved');
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
      baseRef.current = updatedAt;
      if (content !== null) savedContent.current = content;
      if (pendingContent.current === content) pendingContent.current = null;
      if (pendingTitle.current === title) pendingTitle.current = null;
      setItem((cur) => (cur ? { ...cur, updatedAt, ...(title !== null ? { title } : {}), ...(content !== null ? { content } : {}) } : cur));
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
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
    };
    const flush = () => { if (pendingContent.current !== null || pendingTitle.current !== null) void save(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('pagehide', flush); flush(); };
  }, [save]);

  // Вернулись в окно: если без наших несохранённых правок материал уже изменили — подтягиваем свежую версию.
  const pullRemote = useCallback(async () => {
    if (pendingContent.current !== null || pendingTitle.current !== null || savingRef.current) return;
    try {
      const fresh = await fetchItem();
      if (pendingContent.current !== null || pendingTitle.current !== null || savingRef.current) return;
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
    if (savingRef.current || 'token' in sourceRef.current) return;
    try {
      const fresh = await fetchItem();
      if (savingRef.current || fresh.updatedAt === baseRef.current) return;
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
    pendingContent.current = next;
    if (title !== undefined) pendingTitle.current = title;
    setItem((cur) => (cur ? { ...cur, content: next, ...(title !== undefined ? { title } : {}) } : cur));
    setLoadKey((n) => n + 1);
    setError('');
    setState('pending');
  }, []);

  /** Самое свежее содержимое, в том числе ещё не отправленное на сервер (для экспорта и копирования). */
  const getContent = useCallback(() => pendingContent.current ?? savedContent.current, []);

  return {
    item, status, error, state, conflict, loadKey, getContent,
    setContent, replaceContent, setTitle, save, resolveConflict, patchFields,
    reload: () => load(true),
  };
}
