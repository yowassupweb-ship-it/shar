import { Suspense, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { startUsageTracker, trackSection } from '@/shared/usage/tracker';
import { Outlet, useLocation, useNavigate } from 'react-router';
import type { User } from '@/shared/types/chat';
import { boot, isMuted, shutdown, unreadChatsTotal, useChatStore } from '@/features/chat';
import { availableTools } from '@/features/more/tools';
import { startToolBadges, toolBadgesTotal, useToolBadges } from '@/features/more/toolBadges';
import { addNavTool, removeNavTool } from '@/features/more/navTools';
import { EventEditorHost } from '@/features/calendar';
import { BrowserPushService } from '@/shared/platform/push/browserPushService';
import { OverlayHost } from '@/shared/ui/overlay';
import { setNavigator } from '@/shared/navigation/navigate';
import { fromLegacyUrl, links, paths } from '@/shared/navigation/routes';
import { installInternalLinks } from '@/shared/navigation/internalLinks';
import LinkChooserHost from '@/shared/navigation/LinkChooser';
import AppShell from './shell/AppShell';
import { ShellContext, type ShellOptions } from '@/shared/shell/ShellContext';
import { sectionFor } from './shell/sections';
import { useSession, verifySession } from '@/shared/session/session';
import LoginScreen from './LoginScreen';
import ElectronTitlebar from './electron/ElectronTitlebar';
import { startWorkspaceToasts } from '@/features/workspace/live';
import { checkMailAccess, useMail } from '@/features/mail/api';
import { startMailBadge, useMailBadge } from '@/features/mail/badge';
import { showToast } from '@/shared/ui/Toast';
import { SpotlightHost, useVisitTracker } from '@/features/spotlight';
import { ChatFrame, chatFrameEnabled, subscribeChatFrame } from '@/features/chat';
import CorePanel, { CORE_PANEL_ID } from '@/features/core/CorePanel';
import { toggleCorePanel, useCorePanel } from '@/features/core/panel';
import { setAgentAvailable } from '@/shared/core/agentBridge';
import { realtime } from '@/shared/realtime/realtime';

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
  const chatFrame = useSyncExternalStore(subscribeChatFrame, chatFrameEnabled, () => false);
  const [opts, setOpts] = useState<ShellOptions>({});
  const unreadChats = useChatStore((s) => unreadChatsTotal(s.chats));
  // Невзятые заявки и диалоги «Соцсетей» без ответа — тоже непрочитанное: на логотипе вместе с чатами,
  // каждое — на иконке своего инструмента; что не вынесено в нижнее меню — на «Ещё».
  const toolCounts = useToolBadges((s) => s.counts);
  const unread = unreadChats + toolBadgesTotal(toolCounts);
  const meFull = useChatStore((s) => s.users[String(me.id)]) as
    (User & { position?: string; visibleTabs?: Record<string, boolean>; navTools?: string[]; enabledTools?: string[]; role?: string }) | undefined;
  // Пункты, вынесенные в нижнее меню, приходят с профилем (/api/users) — уже после первой отрисовки: меню
  // дорисовывалось и съезжало. Помним их на устройстве и рисуем сразу, профиль потом только уточняет.
  const navKey = `nx:nav-tools:${me.id}`;
  const [navCache] = useState<{ navTools?: string[]; enabledTools?: string[]; role?: string } | null>(() => {
    try { return JSON.parse(localStorage.getItem(navKey) || 'null'); } catch { return null; }
  });
  const navSource = meFull ?? navCache;
  useEffect(() => {
    if (!meFull) return;
    try { localStorage.setItem(navKey, JSON.stringify({ navTools: meFull.navTools || [], enabledTools: meFull.enabledTools || [], role: meFull.role })); } catch { /* приватный режим */ }
  }, [navKey, meFull?.navTools, meFull?.enabledTools, meFull?.role]); // eslint-disable-line react-hooks/exhaustive-deps
  const tools = useMemo(
    () => availableTools({ role: navSource?.role || me.role, enabledTools: navSource?.enabledTools }),
    [navSource?.enabledTools, navSource?.role, me.role],
  );
  // «Ядро» — не страница, а выдвижная панель справа: значок в меню её открывает и закрывает.
  const coreAvailable = tools.some((t) => t.id === 'core');
  const coreOpen = useCorePanel((s) => s.open);
  // Чаты показывают «Переслать агенту» только тем, кому «Ядро» включено; пересланное открывает панель.
  useEffect(() => { setAgentAvailable(coreAvailable); }, [coreAvailable]);
  useEffect(() => {
    if (!coreAvailable) return undefined;
    const open = () => useCorePanel.setState({ open: true });
    window.addEventListener('shar:agent-forward', open);
    // Агент открывает человеку материал или раздел (open_in_shar; переписки сервер ему не даёт).
    const off = realtime.subscribe((event) => {
      const e = event as { type?: string; url?: string; window?: boolean };
      if (e.type !== 'core_open' || !e.url?.startsWith('/') || /^\/(chats|mail|social)/.test(e.url)) return;
      if (e.window) window.open(e.url, '_blank'); else navigate(e.url);
    });
    return () => { window.removeEventListener('shar:agent-forward', open); off(); };
  }, [coreAvailable, navigate]);
  const navTools = useMemo(() => (navSource?.navTools || [])
    .map((id) => tools.find((t) => t.id === id && !t.external && t.href.startsWith('/')))
    .filter((t): t is NonNullable<typeof t> => Boolean(t))
    .map((t) => ({
      id: t.id, label: t.name, href: t.href, icon: t.icon, tint: t.tint, count: toolCounts[t.id] || 0,
      ...(t.id === 'core' ? { onToggle: toggleCorePanel, expanded: coreOpen, controls: CORE_PANEL_ID } : {}),
    })), [navSource?.navTools, tools, toolCounts, coreOpen]);
  const moreCount = Object.entries(toolCounts).reduce((sum, [id, n]) => sum + (navTools.some((t) => t.id === id) ? 0 : n || 0), 0);

  // Layout-эффект, а не обычный: эффекты родителя идут после эффектов детей, и
  // раздел «Чаты» открыл бы чат из адреса раньше, чем стор поднят, — а boot()
  // сбрасывает ленты. Layout-эффекты все выполняются до обычных.
  useLayoutEffect(() => {
    boot(me);
    return () => shutdown();
  }, [me]);
  useEffect(() => startToolBadges(), [me]);
  // Статистика разделов для админки: кто, чем и сколько пользуется (shared/usage/tracker.ts).
  useEffect(() => startUsageTracker(), [me]);
  useEffect(() => { trackSection(pathname); }, [pathname]);
  // Ссылки на Шар (любой домен семейства) открываются в этом же окне, а не во внешнем браузере.
  useEffect(() => installInternalLinks(), []);
  // Непрочитанные во «Входящих» — единичка на «Почте» в меню (на значок приложения не идут: там чаты и заявки).
  useEffect(() => startMailBadge(), [me]);
  const unreadMail = useMailBadge((s) => s.unread);

  // Шар выбило из почтового ящика (пароль сменили или его нечем расшифровать) — сразу видно:
  // красный «!» на «Почте» и предупреждение при входе, а не плашка, которую замечаешь через неделю.
  const lockedMail = useMail((s) => s.accounts.filter((a) => a.needsPassword).map((a) => a.email).join(', '));
  useEffect(() => {
    let alive = true;
    void checkMailAccess().then((emails) => {
      if (!alive || !emails.length || sectionFor(window.location.pathname).id === 'mail') return;
      showToast(`Шар вышел из ящика ${emails.join(', ')}: пароль больше не подходит. Откройте «Почту» и введите его заново.`, 'error');
    });
    return () => { alive = false; };
  }, [me]);
  const alerts = useMemo(() => (lockedMail ? { mail: `Нужно войти в ящик заново: ${lockedMail}` } : undefined), [lockedMail]);

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
        badges={{ chats: unreadChats, mail: unreadMail, more: moreCount }}
        alerts={alerts}
        navTools={navTools}
        onNavToolDrop={(id) => void addNavTool(id)}
        onNavToolRemove={(id) => void removeNavTool(id)}
        visibleTabs={meFull?.visibleTabs}
        side={coreAvailable ? <CorePanel /> : null}
        agent={coreAvailable ? { open: coreOpen, onToggle: toggleCorePanel, controls: CORE_PANEL_ID } : undefined}
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
      {/* Плавающий чат (Настройки → Внешний вид): в самом разделе «Чаты» он не нужен. */}
      {chatFrame && section.id !== 'chats' && <ChatFrame unread={unreadChats} />}
      <OverlayHost />
      <LinkChooserHost />
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
