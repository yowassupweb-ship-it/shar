import { Suspense, useEffect, useLayoutEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import type { User } from '@/shared/types/chat';
import { boot, isMuted, shutdown, unreadChatsTotal, useChatStore } from '@/features/chat';
import { startSocialWaiting, useSocialWaiting } from '@/features/social/waiting';
import { EventEditorHost } from '@/features/calendar';
import { BrowserPushService } from '@/shared/platform/push/browserPushService';
import { OverlayHost } from '@/shared/ui/overlay';
import { setNavigator } from '@/shared/navigation/navigate';
import { fromLegacyUrl, links, paths } from '@/shared/navigation/routes';
import AppShell from './shell/AppShell';
import { ShellContext, type ShellOptions } from '@/shared/shell/ShellContext';
import { sectionFor } from './shell/sections';
import { useSession, verifySession } from '@/shared/session/session';
import LoginScreen from './LoginScreen';
import ElectronTitlebar from './electron/ElectronTitlebar';
import { startWorkspaceToasts } from '@/features/workspace/live';
import { SpotlightHost, useVisitTracker } from '@/features/spotlight';

/**
 * Корень Шара v2 — живёт над всеми разделами и не пересоздаётся при переходе
 * между ними. Здесь то, что должно работать в любом разделе: сессия,
 * соединение с сервером и список чатов (счётчик на «Чатах», мгновенный возврат
 * в переписку), мигание вкладки, уведомления и команды Electron.
 */

/** Мигание заголовка вкладки, пока есть непрочитанные и окно не в фокусе. */
function useTitleBlink(unread: number) {
  useEffect(() => {
    const original = document.title;
    if (unread === 0 || document.hasFocus()) return;
    let alt = false;
    const blink = window.setInterval(() => {
      document.title = alt ? original : `(${unread}) Новое сообщение`;
      alt = !alt;
    }, 1000);
    const stop = () => { window.clearInterval(blink); document.title = original; };
    window.addEventListener('focus', stop, { once: true });
    return () => { window.removeEventListener('focus', stop); stop(); };
  }, [unread]);
}

/** Открыть чат: в самих «Чатах» — на месте (ловит ChatsScreen), иначе — переходом. */
function openChat(chatId: string, go: (to: string) => void) {
  if (!chatId) return;
  if (window.location.pathname === paths.chats) window.dispatchEvent(new CustomEvent('nx:open-chat', { detail: chatId }));
  else go(links.chat(chatId));
}

type DesktopBridge = {
  onOpenChat?: (cb: (chatId: string) => void) => (() => void) | void;
  onOpenRoute?: (cb: (url: string) => void) => (() => void) | void;
};

function Workspace({ me }: { me: User }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const section = sectionFor(pathname);
  const [opts, setOpts] = useState<ShellOptions>({});
  const unreadChats = useChatStore((s) => unreadChatsTotal(s.chats));
  // Диалоги «Соцсетей», ждущие ответа, — тоже непрочитанное: на логотипе вместе с чатами, в меню — на «Ещё».
  const socialWaiting = useSocialWaiting((s) => s.total);
  const unread = unreadChats + socialWaiting;
  const meFull = useChatStore((s) => s.users[String(me.id)]) as
    (User & { position?: string; visibleTabs?: Record<string, boolean> }) | undefined;

  // Layout-эффект, а не обычный: эффекты родителя идут после эффектов детей, и
  // раздел «Чаты» открыл бы чат из адреса раньше, чем стор поднят, — а boot()
  // сбрасывает ленты. Layout-эффекты все выполняются до обычных.
  useLayoutEffect(() => {
    boot(me);
    return () => shutdown();
  }, [me]);
  useEffect(() => startSocialWaiting(), [me]);

  useTitleBlink(unread);

  // Значок на кнопке приложения (панель задач, трей): число чатов с непрочитанным
  // берём прямо из стора, а не через опрос — иначе значок появлялся не сразу или
  // не появлялся вовсе. Сбрасываем при выходе из аккаунта.
  useEffect(() => { window.sharDesktop?.setBadgeCount?.(unread); }, [unread]);
  useEffect(() => () => { window.sharDesktop?.setBadgeCount?.(0); }, []);

  // «Вам открыли документ» — тост в любом разделе; сам список «Офиса» обновляется отдельно.
  useEffect(() => startWorkspaceToasts(), []);
  // История посещений для поиска (Ctrl+K).
  useVisitTracker();

  // Главный процесс сам показывает карточки о сообщениях и о мьюте ничего не
  // знает — передаём ему список чатов с выключенными уведомлениями.
  useEffect(() => {
    const push = window.sharDesktop?.realtime?.setMutedChats;
    if (!push) return undefined;
    const uid = String(me.id);
    let last: string | null = null;
    const sync = () => {
      const ids = Object.values(useChatStore.getState().chats).filter((c) => isMuted(c, uid)).map((c) => String(c.id)).sort();
      const key = ids.join('|');
      if (key === last) return;
      last = key;
      push(ids);
    };
    sync();
    return useChatStore.subscribe(sync);
  }, [me]);

  // Сервис уведомлений: в Electron включает карточки о сообщениях в главном
  // процессе и сообщает, какой чат открыт; плюс напоминания о событиях.
  useEffect(() => {
    const service = new BrowserPushService();
    void service.start({
      userId: String(me.id),
      userName: me.name,
      getContext: () => {
        const onChats = window.location.pathname === paths.chats;
        const active = onChats ? useChatStore.getState().activeChatId : null;
        return { activeTab: onChats ? 'messages' : 'other', isChatOpen: Boolean(active), activeChatId: active || undefined };
      },
    });
    return () => service.stop();
  }, [me]);

  // Команды Electron: клик по уведомлению, переход по ссылке из главного процесса.
  useEffect(() => {
    const desk = (window as unknown as { sharDesktop?: DesktopBridge }).sharDesktop;
    if (!desk) return undefined;
    const go = (to: string) => navigate(to);
    const offChat = desk.onOpenChat?.((chatId) => openChat(chatId, go));
    const offRoute = desk.onOpenRoute?.((url) => {
      const chat = (() => { try { return new URL(url, window.location.origin).searchParams.get('chat'); } catch { return null; } })();
      if (chat) { openChat(chat, go); return; }
      // Свой адрес (/office?…, например из окна заметки на столе) открываем как есть.
      if (url.startsWith('/')) { go(url); return; }
      const target = fromLegacyUrl(url);
      if (target) go(target);
    });
    return () => { if (typeof offChat === 'function') offChat(); if (typeof offRoute === 'function') offRoute(); };
  }, [navigate]);

  // Нажали на уведомление, пока открыт другой раздел, — переходим в чаты.
  // В самих чатах это событие ловит ChatsScreen и открывает чат на месте.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = String((e as CustomEvent).detail || '');
      if (id && sectionFor(window.location.pathname).id !== 'chats') navigate(links.chat(id));
    };
    window.addEventListener('nx:open-chat', onOpen);
    return () => window.removeEventListener('nx:open-chat', onOpen);
  }, [navigate]);

  return (
    <ShellContext.Provider value={setOpts}>
      <AppShell
        section={section.id}
        badges={{ chats: unreadChats, more: socialWaiting }}
        visibleTabs={meFull?.visibleTabs}
        navHidden={opts.navHidden}
        onReselect={opts.onReselect}
        account={{
          id: String(me.id),
          name: meFull?.name || me.name || me.username || 'Вы',
          avatar: meFull?.avatar || me.avatar,
          subtitle: meFull?.position || meFull?.email || undefined,
        }}
      >
        {/* Смена раздела — короткое проявление, без белой вспышки и перезагрузки. */}
        <div key={section.id} className="nx-section">
          <Suspense fallback={null}>
            <Outlet />
          </Suspense>
        </div>
      </AppShell>
      <OverlayHost />
      <SpotlightHost />
      <EventEditorHost />
    </ShellContext.Provider>
  );
}

export default function AppRoot() {
  const { status, me } = useSession();
  const navigate = useNavigate();

  // Сверка с сервером при старте и когда сокет сказал «сессия не признана»
  // (код 1008): истёкшая сессия ведёт на вход, а не в вечное переподключение.
  useEffect(() => {
    void verifySession();
    const recheck = () => { void verifySession(); };
    window.addEventListener('shar:ws-unauthorized', recheck);
    return () => window.removeEventListener('shar:ws-unauthorized', recheck);
  }, []);

  // Навигатор роутера — для сторов и сервисов (shared/navigation/navigate).
  useEffect(() => {
    setNavigator((to, o) => navigate(to, { replace: o?.replace }));
    return () => setNavigator(null);
  }, [navigate]);

  return (
    <>
      <ElectronTitlebar />
      {status === 'checking' ? null : me ? <Workspace key={String(me.id)} me={me} /> : <LoginScreen />}
    </>
  );
}
