import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { realtime } from '@/shared/realtime/realtime';
import { workspaceApi } from './api';
import type { Comment, CommentAnchor, ReplyRef } from './types';

/** Ветка: комментарий верхнего уровня и ответы на него по порядку. */
export interface Thread {
  root: Comment;
  replies: Comment[];
}

/** Откуда комментарии: материал «Офиса» или задача — одинаковые ветки, разные адреса и событие сокета. */
export interface CommentSource {
  key: string | null;
  list: () => Promise<{ comments: Comment[]; ready: boolean }>;
  add: (body: string, anchor?: CommentAnchor | ReplyRef | null, parentId?: string | null) => Promise<Comment>;
  change: (commentId: string, patch: { body?: string; resolved?: boolean }) => Promise<Comment>;
  remove: (commentId: string) => Promise<unknown>;
  /** Живое событие «у этого источника поменялись комментарии». */
  isEvent: (event: Record<string, unknown>) => boolean;
}

const workspaceSource = (itemId: string | null): CommentSource => ({
  key: itemId,
  list: () => workspaceApi.comments(itemId!),
  add: (body, anchor, parentId) => workspaceApi.addComment(itemId!, body, anchor, parentId),
  change: (commentId, patch) => workspaceApi.changeComment(itemId!, commentId, patch),
  remove: (commentId) => workspaceApi.deleteComment(itemId!, commentId),
  isEvent: (e) => e.type === 'workspace_comments' && String(e.itemId) === itemId,
});

export function useComments(itemId: string | null) {
  const source = useMemo(() => workspaceSource(itemId), [itemId]);
  return useCommentSource(source);
}

/**
 * Комментарии материала, как в Google Docs. Список грузится при открытии и пересобирается по живому событию
 * `workspace_comments` (коллега написал, ответил, закрыл ветку). Свои действия применяются сразу, без ожидания сервера.
 * itemId = null (по ссылке без входа) — комментариев нет.
 */
export function useCommentSource(source: CommentSource) {
  const itemId = source.key;
  const src = useRef(source);
  src.current = source;
  const [comments, setComments] = useState<Comment[]>([]);
  const [ready, setReady] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const alive = useRef(0);

  const load = useCallback(async () => {
    if (!itemId) return;
    const mine = ++alive.current;
    try {
      const result = await src.current.list();
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
      if (!src.current.isEvent(event as Record<string, unknown>)) return;
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

  const add = useCallback(async (body: string, anchor?: CommentAnchor | ReplyRef | null, parentId?: string | null) => {
    if (!itemId) return;
    const comment = await src.current.add(body, anchor, parentId);
    setComments((cur) => (cur.some((c) => c.id === comment.id) ? cur : [...cur, comment]));
  }, [itemId]);

  const change = useCallback(async (commentId: string, patch: { body?: string; resolved?: boolean }) => {
    if (!itemId) return;
    const comment = await src.current.change(commentId, patch);
    setComments((cur) => cur.map((c) => (c.id === comment.id ? comment : c)));
  }, [itemId]);

  const remove = useCallback(async (commentId: string) => {
    if (!itemId) return;
    await src.current.remove(commentId);
    setComments((cur) => cur.filter((c) => c.id !== commentId && c.parentId !== commentId));
  }, [itemId]);

  const open = useMemo(() => threads.filter((t) => !t.root.resolved), [threads]);
  return { threads, open, ready, loaded, add, change, remove };
}
