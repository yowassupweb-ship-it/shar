import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { chatTitle, useChatStore } from '@/features/chat';
import { useTasks } from '@/features/tasks/api';
import { links } from '@/shared/navigation/routes';
import { recordVisit } from './history';

/**
 * Пишет историю посещений по адресу: какой чат, задача, карточка человека или файл открыты.
 * Материалы «Офиса» пишет сам ItemView — у него есть название и вид. Если название пока не известно
 * (список чатов ещё грузится), ждём, пока оно появится.
 */
export function useVisitTracker() {
  const { pathname, search } = useLocation();

  useEffect(() => {
    const params = new URLSearchParams(search);
    let stop: (() => void) | null = null;

    if (pathname === '/chats' && params.get('chat')) {
      const id = params.get('chat')!;
      const write = () => {
        const { chats, me, users } = useChatStore.getState();
        const chat = chats[id];
        if (!chat) return false;
        const title = chatTitle(chat, me, users);
        if (id.startsWith('notifications-') || !title) return true;
        recordVisit({ id, kind: 'chat', title, subtitle: chat.isGroup || (chat.participantIds?.length ?? 0) > 2 ? 'Групповой чат' : 'Личный чат', path: links.chat(id) });
        return true;
      };
      if (!write()) { const off = useChatStore.subscribe(() => { if (write()) off(); }); stop = off; }
    } else if (pathname === '/tasks' && params.get('task')) {
      const id = params.get('task')!;
      const write = () => {
        const task = useTasks.getState().tasks[id];
        if (!task) return false;
        recordVisit({ id, kind: 'task', title: task.title || 'Задача', subtitle: 'Задача', path: links.task(id) });
        return true;
      };
      if (!write()) { const off = useTasks.subscribe(() => { if (write()) off(); }); stop = off; }
    } else if (pathname === '/contacts' && params.get('user')) {
      const id = params.get('user')!;
      const write = () => {
        const user = useChatStore.getState().users[id];
        if (!user) return false;
        recordVisit({ id, kind: 'person', title: user.name || user.username || id, subtitle: (user as { position?: string }).position || 'Сотрудник', path: links.contact(id) });
        return true;
      };
      if (!write()) { const off = useChatStore.subscribe(() => { if (write()) off(); }); stop = off; }
    }
    return () => stop?.();
  }, [pathname, search]);
}
