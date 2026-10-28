import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { realtime } from '@/shared/realtime/realtime';
import { workspaceApi } from './api';
import type { Comment, CommentAnchor } from './types';

/** Ветка: комментарий верхнего уровня и ответы на него по порядку. */
export interface Thread {
  root: Comment;
  replies: Comment[];
}

/**
 * Комментарии материала, как в Google Docs. Список грузится при открытии и пересобирается по живому событию
 * `workspace_comments` (коллега написал, ответил, закрыл ветку). Свои действия применяются сразу, без ожидания сервера.
 * itemId = null (по ссылке без входа) — комментариев нет.
 */
export function useComments(itemId: string | null) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [ready, setReady] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const alive = useRef(0);

  const load = useCallback(async () => {
    if (!itemId) return;
    const mine = ++alive.current;
    try {
      const result = await workspaceApi.comments(itemId);
      if (mine !== alive.current) return;
      setComments(result.comments);
      setReady(result.ready);
    } catch { /* нет связи — останется прежний список */ } finally {
      if (mine === alive.current) setLoaded(true);
    }
  }, [itemId]);

  useEffect(() => {
    setComments([]);
    setLoaded(false);
    void load();
    if (!itemId) return undefined;
    let timer = 0;
    const off = realtime.subscribe((event) => {
      const e = event as { type?: string; itemId?: string };
      if (e.type !== 'workspace_comments' || String(e.itemId) !== itemId) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 150);
    });
    return () => { off(); window.clearTimeout(timer); alive.current += 1; };
  }, [itemId, load]);

  const threads = useMemo<Thread[]>(() => {
    const replies = new Map<string, Comment[]>();
    for (const c of comments) if (c.parentId) replies.set(c.parentId, [...(replies.get(c.parentId) || []), c]);
    return comments.filter((c) => !c.parentId).map((root) => ({ root, replies: replies.get(root.id) || [] }));
  }, [comments]);

  const add = useCallback(async (body: string, anchor?: CommentAnchor | null, parentId?: string | null) => {
    if (!itemId) return;
    const comment = await workspaceApi.addComment(itemId, body, anchor, parentId);
    setComments((cur) => (cur.some((c) => c.id === comment.id) ? cur : [...cur, comment]));
  }, [itemId]);

  const change = useCallback(async (commentId: string, patch: { body?: string; resolved?: boolean }) => {
    if (!itemId) return;
    const comment = await workspaceApi.changeComment(itemId, commentId, patch);
    setComments((cur) => cur.map((c) => (c.id === comment.id ? comment : c)));
  }, [itemId]);

  const remove = useCallback(async (commentId: string) => {
    if (!itemId) return;
    await workspaceApi.deleteComment(itemId, commentId);
    setComments((cur) => cur.filter((c) => c.id !== commentId && c.parentId !== commentId));
  }, [itemId]);

  const open = useMemo(() => threads.filter((t) => !t.root.resolved), [threads]);
  return { threads, open, ready, loaded, add, change, remove };
}
