// Bumped v1 -> v2: the old static cache could keep serving a stale JS chunk (e.g.
// the removed fixed-position debug panel that covered the mobile chat header,
// blocking the profile-open tap) to phones that had it cached from before a fix
// landed. The version bump makes activate()'s cleanup below delete the old cache
// outright instead of leaving it around indefinitely under an unchanging name.
// Bumped v3 -> v4: the fetch handler below serves cached script/style/image
// responses cache-first with no revalidation (line ~70: `if (cached) return
// cached`), which — combined with dev-mode chunk URLs frequently staying
// identical across rebuilds — meant a whole session's worth of mail-UI fixes
// kept being masked by a cache pinned from the very first page load, even on
// localhost, even with a hard refresh (a hard refresh reloads the page but
// doesn't unregister/invalidate an already-installed service worker's own
// caches). Bumping again so activate() drops the stale v3 caches outright.
// Bumped v4 -> v5 AND changed the static-asset strategy itself (see fetch
// handler below): v4's one-time bump only fixed the cache that existed at
// that moment — every reload after that first one re-populated the SAME v4
// cache with whatever was current then, and every code change after THAT
// point went right on being invisible, indefinitely, without another manual
// bump. The static-asset handler was cache-first ("if cached, return it,
// don't even wait for the network check") — correct for a shipped PWA's
// offline support, actively hostile to iterating on the app itself. Switched
// it to network-first-with-cache-fallback: always serves the live network
// response when one's reachable (and refreshes the cache from it), only
// falls back to the cache when the network request actually fails — so this
// class of bug can't recur no matter how many more times the app changes.
// Bumped v5 -> v6 alongside the navigate-handler fix above: v5's APP_CACHE could
// already be holding a bad document (an error/partial page cached during a DPI
// hiccup, back when navigations were cached unconditionally). That poisoned entry
// would keep being served on every offline fallback — reloads couldn't clear it.
// The version bump makes activate() delete the v5 caches outright so no client
// carries a pre-fix broken document forward.
// Bumped v6 -> v7: offline.html itself was a dead end — it claimed "Shar OS will
// reconnect automatically" but had zero script behind that, so anyone routed to it
// during even a brief real blip (confirmed: office-network users hit this after a
// ~1min connectivity hiccup) stayed stuck on a static page indefinitely until they
// personally thought to hard-refresh — which read as "the service is down" for
// however long that took, even though the origin recovered in seconds. offline.html
// now actually polls and self-reloads; this bump makes existing clients drop their
// old script-less cached copy instead of continuing to serve it forever.
// Bumped v7 -> v8: the anti-DPI failover was removed. A device that ran the failover
// build could be holding a shell/chunks cached from the box MIRROR (cross-origin,
// during a failover episode); this bump makes activate() drop those v7 caches outright
// so every client re-populates cleanly from its own origin.
const APP_CACHE = 'shar-app-cache-v8';
const STATIC_CACHE = 'shar-static-cache-v8';
const CORE_ASSETS = ['/', '/offline.html', '/favicon.png', '/apple-touch-icon.png', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key !== APP_CACHE && key !== STATIC_CACHE)
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

// Carrier DPI doesn't only reset connections — it also silently STALLS them: the
// TCP session stays half-open and fetch() neither resolves nor rejects, sometimes
// for tens of seconds. With no bound on the wait, that hung request is exactly what
// pins the app on a blank white/black screen with F5 doing nothing. These timeouts
// turn an indefinite stall into a fast, deterministic fallback to the cached shell.
const NAV_TIMEOUT_MS = 4000;
const STATIC_TIMEOUT_MS = 6000;

// Reject after `ms` if the network hasn't answered. The underlying fetch keeps
// running (we don't abort it) so a slow-but-alive connection can still finish and
// repopulate the cache in the background for next time.
function fetchOrTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('sw-timeout')); }
    }, ms);
    fetch(request).then(
      (res) => { clearTimeout(timer); if (!settled) { settled = true; resolve(res); } },
      (err) => { clearTimeout(timer); if (!settled) { settled = true; reject(err); } }
    );
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const appCache = await caches.open(APP_CACHE);
      const cached = (await appCache.match(request)) || (await caches.match(request));

      // One network attempt, cached only if it's a GOOD, complete document. The
      // previous version cached every navigation response unconditionally —
      // including an nginx 5xx / redirect / error page served during a DPI hiccup —
      // and then served that poison on every later fallback, so F5 couldn't recover.
      // Guarding on .ok + type==='basic' means the cache only ever holds a real
      // same-origin document. (opaqueredirect / cross-origin have ok=false.)
      const networkFetch = fetch(request).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          appCache.put(request, res.clone()).catch(() => undefined);
        }
        return res;
      });

      if (cached) {
        // We already hold a good shell — never let a DPI-stalled network hold a
        // blank screen. Give the network a short head start; if it doesn't answer
        // in time (or errors, or returns an error page), serve the cached shell
        // immediately while the network attempt keeps running in the background to
        // refresh the cache for next launch.
        try {
          const res = await Promise.race([
            networkFetch,
            new Promise((_, rej) => setTimeout(() => rej(new Error('sw-nav-timeout')), NAV_TIMEOUT_MS)),
          ]);
          if (res && res.ok) return res;
          return cached;
        } catch {
          networkFetch.catch(() => undefined); // keep background refresh, swallow
          return cached;
        }
      }

      // First visit — no shell cached yet, so we must wait for the network; only
      // fall through to the offline page if it genuinely fails.
      try {
        return await networkFetch;
      } catch {
        const fallback = await caches.match('/offline.html');
        return fallback || Response.error();
      }
    })());
    return;
  }

  const isStatic = isSameOrigin && ['script', 'style', 'font', 'image'].includes(request.destination);
  if (!isStatic) return;

  event.respondWith((async () => {
    const cache = await caches.open(STATIC_CACHE);
    // Network-first (so a real deploy's changed assets always win when reachable),
    // but bounded: a DPI stall on a single JS chunk used to hang the entire app
    // load forever with no fallback. Now it times out and serves the cached copy —
    // which, for content-hashed chunk URLs, is by definition the exact right bytes.
    try {
      const networkResponse = await fetchOrTimeout(request, STATIC_TIMEOUT_MS);
      if (networkResponse && networkResponse.ok) {
        cache.put(request, networkResponse.clone()).catch(() => undefined);
        return networkResponse;
      }
      const cached = await cache.match(request);
      return cached || networkResponse;
    } catch {
      const cached = await cache.match(request);
      return cached || Response.error();
    }
  })());
});

// Determine notification type from tag or url
function getNotifKind(payload) {
  const tag = String(payload.tag || '');
  const url = String(payload.url || '');
  if (tag.startsWith('chat-') || url.includes('tab=messages')) return 'message';
  if (tag.startsWith('task-') || url.includes('tab=tasks')) return 'task';
  if (tag.startsWith('event-') || url.includes('tab=calendar')) return 'calendar';
  return 'system';
}

// Keep the app-icon badge equal to the number of notifications still on screen. Clicking
// or reading ONE chat shouldn't zero the whole badge when others are still pending — that
// asymmetry (push never set it, click cleared all of it) was why the count was "not always
// right". Called after every push/close/click so the badge always matches what's actually
// waiting.
async function syncBadge() {
  try {
    if (!('setAppBadge' in self.registration) && !('setAppBadge' in self.navigator)) return;
    const setter = self.registration.setAppBadge ? self.registration : self.navigator;
    const clearer = self.registration.clearAppBadge ? self.registration : self.navigator;
    const notifs = await self.registration.getNotifications();
    const n = notifs.filter(x => !(x.data && x.data.silentBadge)).length;
    if (n > 0) await setter.setAppBadge(n).catch(() => {});
    else if (clearer.clearAppBadge) await clearer.clearAppBadge().catch(() => {});
  } catch (_) { /* badging unsupported */ }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const action = event.action;
  const targetUrl = event.notification?.data?.url || '/account';

  event.waitUntil(
    Promise.all([
      // Re-sync the badge to whatever notifications remain (this one is already closed
      // above) — clicking one message must not wrongly zero the count for the others.
      syncBadge(),
      // Navigate unless user explicitly dismissed
      action !== 'dismiss'
        ? self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
            // Parse chatId from URL so open clients can react without a full page reload
            let chatId = null;
            let tab = null;
            try {
              const u = new URL(targetUrl, self.location.origin);
              chatId = u.searchParams.get('chat');
              tab = u.searchParams.get('tab');
            } catch {}

            // If a window is already open — just message it and focus (no navigate = no reload).
            // Prefer the actually-visible/focused tab over array order — picking an arbitrary
            // background tab would silently update a window the user isn't looking at.
            const existingClient = clients.find(c => 'focus' in c && c.visibilityState === 'visible')
              || clients.find(c => 'focus' in c && c.focused)
              || clients.find(c => 'focus' in c);
            if (existingClient) {
              existingClient.postMessage({ type: 'notification-navigate', url: targetUrl, chatId, tab });
              return existingClient.focus();
            }

            // No window open — open a new one with the full URL (page load handles chatId via searchParams).
            // Tagged with fromNotif=1 so the client can tell "cold launch from a
            // notification, trust this deep link" apart from "user manually hit
            // reload while a chat happened to be open" — those need opposite
            // behavior (open straight into the chat vs bounce back to the list),
            // but on some Android WebView/PWA setups a suspended app being resumed
            // via openWindow() can report as a 'reload'/'back_forward' navigation
            // in the Performance Navigation Timing API, indistinguishable from a
            // real manual reload by type alone.
            if (self.clients.openWindow) {
              try {
                const withMarker = new URL(targetUrl, self.location.origin);
                withMarker.searchParams.set('fromNotif', '1');
                return self.clients.openWindow(withMarker.pathname + withMarker.search);
              } catch {
                return self.clients.openWindow(targetUrl);
              }
            }
          })
        : Promise.resolve(),
    ])
  );
});

// Muted chats map: userId → Set<chatId>
const mutedChatsByUser = {};

// Same asymmetric rule the bottom-nav badge uses (see BottomNav.tsx/MainBottomNav.tsx):
// "appearing" (a new notification) waits 3s and can be cancelled if the chat gets
// marked read before that window closes; "disappearing" (mark-as-read closing an
// already-shown notification) is always instant. Badge and notification are two
// views of the same "do you have something unread here" fact and should follow one
// rule, not two — chatId → true once a pending (not-yet-shown) push for it should be
// cancelled when its delay elapses.
const pendingPushCancel = {};

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data) return;

  if (data.type === 'sync-muted-chats') {
    // Full sync on page load
    const uid = String(data.userId || '');
    const ids = Array.isArray(data.mutedChatIds) ? data.mutedChatIds : [];
    mutedChatsByUser[uid] = new Set(ids);
  }

  if (data.type === 'mute-chat') {
    const uid = String(data.userId || '');
    const cid = String(data.chatId || '');
    if (!uid || !cid) return;
    if (!mutedChatsByUser[uid]) mutedChatsByUser[uid] = new Set();
    if (data.muted) {
      mutedChatsByUser[uid].add(cid);
    } else {
      mutedChatsByUser[uid].delete(cid);
    }
  }

  if (data.type === 'close-notifications') {
    // Sent when the chat was marked read (locally, or via a Redis-pushed
    // notifications_read event from another of this user's own devices) — close
    // any OS notification still showing for it. Tag format ("chat-{chatId}")
    // matches what the backend sets when it sends the push (see main.py). Also
    // cancels a pending (not-yet-shown, still inside its 3s grace window) push for
    // the same chat — the "instant to disappear" half of the badge's own rule.
    const cid = String(data.chatId || '');
    if (!cid) return;
    pendingPushCancel[cid] = true;
    event.waitUntil(
      // Match by tag OR data.chatId — a `{ tag }` filter alone silently returns
      // nothing if the shown notification's tag differs by even a char, which is why
      // read notifications kept lingering. Scan all and close anything for this chat.
      self.registration.getNotifications().then((list) => {
        list.forEach((n) => {
          const tag = String(n.tag || '');
          const nChatId = String((n.data && n.data.chatId) || '');
          if (tag === `chat-${cid}` || nChatId === cid) n.close();
        });
      }).then(() => syncBadge()).catch(() => undefined)
    );
  }
});

function isChatMutedForAnyUser(chatId) {
  if (!chatId) return false;
  for (const uid of Object.keys(mutedChatsByUser)) {
    if (mutedChatsByUser[uid].has(String(chatId))) return true;
  }
  return false;
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    payload = {};
  }

  const kind = getNotifKind(payload);
  const title = payload.title || 'Новое уведомление';
  const body = payload.body || ' '; // FCM requires non-empty body to show notification

  const isAndroid = /android/i.test((self.navigator && self.navigator.userAgent) || '');

  // Android (FCM): use minimal safe options — many advanced fields cause silent drops
  // iOS/Desktop: use richer notification with actions
  let options;
  if (isAndroid) {
    options = {
      body,
      icon: self.registration.scope + 'favicon.png', // absolute URL required on Android
      tag: String(payload.tag || 'shar-msg'),
      renotify: true,
      // Уведомление должно висеть, пока его не закроют руками или пока чат не
      // будет прочитан (тогда его снимает close-notifications выше). Здесь
      // стояло false, и на Android оно пропадало само через несколько секунд —
      // сообщение можно было пропустить, просто не посмотрев на экран вовремя.
      requireInteraction: true,
      data: { url: payload.url || '/' },
    };
  } else {
    const vibrateByKind = {
      message: [300, 100, 300, 100, 300],
      task: [200, 80, 200],
      calendar: [150, 100, 150],
      system: [100],
    };
    const actionsByKind = {
      message: [{ action: 'open', title: 'Открыть' }, { action: 'dismiss', title: 'Закрыть' }],
      task: [{ action: 'open', title: 'Открыть задачу' }, { action: 'dismiss', title: 'Закрыть' }],
      calendar: [{ action: 'open', title: 'Открыть' }, { action: 'dismiss', title: 'Закрыть' }],
      system: [{ action: 'open', title: 'Открыть' }],
    };
    options = {
      body,
      icon: '/favicon.png',
      badge: '/favicon.png',
      tag: payload.tag || 'generic-notification',
      renotify: payload.renotify !== false,
      requireInteraction: payload.requireInteraction !== false,
      silent: payload.silent === true,
      timestamp: Date.now(),
      vibrate: payload.vibrate || vibrateByKind[kind] || [200, 100, 200],
      actions: actionsByKind[kind] || actionsByKind.system,
      data: { url: payload.url || '/account', kind },
    };
  }

  // Extract chatId from payload or tag (tag format: "chat-{chatId}", see main.py)
  const chatId = payload.chatId || (String(payload.tag || '').replace(/^chat-/, '') || null);
  // Stamp chatId onto the notification data so close-notifications can match by it
  // even if the tag ever differs from `chat-{chatId}`.
  if (options && options.data && chatId) options.data.chatId = chatId;

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Suppress the OS notification only when a Shar window is actually FOCUSED (the user is
    // looking at it — the in-app bell/badge covers that). Previously this used just
    // visibilityState === 'visible', but a desktop PWA/tab stays "visible" even when its
    // window is behind another app (e.g. sending a test from a terminal), so real pushes
    // were being swallowed while the user wasn't looking at Shar at all.
    const hasVisibleClient = allClients.some(c => c.visibilityState === 'visible' && c.focused);

    // Always sync open clients with fresh data
    if (kind === 'message' && chatId) {
      const syncPayload = {
        type: 'push-sync',
        chatId,
        body: payload.body || '',
        senderName: payload.senderName || String(payload.title || '').split(' в ')[0] || '',
        timestamp: new Date().toISOString(),
      };
      for (const client of allClients) {
        client.postMessage(syncPayload);
      }
    }

    // If the app is visible, skip OS notification — client-side polling handles it with full context
    if (hasVisibleClient) return;

    // Skip if the user muted this chat — UNLESS the message is marked important with
    // a leading '!', which must reach everyone regardless of mute.
    const isImportant = String(payload.body || '').trimStart().startsWith('!');
    if (chatId && !isImportant && isChatMutedForAnyUser(chatId)) return;

    // Same 3s grace period as the bottom-nav badge's own "appearing" rule — if a
    // close-notifications message for this chat arrives before the wait is up (the
    // user read it via another device, or the badge-clearing tab-visibility race
    // resolves in that window), skip showing entirely instead of popping up a
    // notification for something already read.
    if (chatId) {
      pendingPushCancel[chatId] = false;
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const cancelled = pendingPushCancel[chatId];
      delete pendingPushCancel[chatId];
      if (cancelled) return;
    }

    await self.registration.showNotification(title, options).catch((err) => {
      // Fallback: minimal notification if full options fail (common on some Android OEMs)
      console.warn('[SW] showNotification failed with full options, trying minimal:', err);
      return self.registration.showNotification(title, {
        body: options.body,
        icon: options.icon,
        tag: options.tag,
        data: options.data,
      });
    });

    // Badge = number of notifications now on screen (the backend doesn't send a per-user
    // total, and the old code fell back to a numberless flag that fought the client's
    // count). syncBadge keeps it consistent with the click/close handlers.
    await syncBadge();
  })());
});

// Auto-resubscribe when FCM/browser rotates the push subscription key
// (common on Android after browser updates or when subscription expires)
self.addEventListener('pushsubscriptionchange', (event) => {
  const changeEvent = event;
  changeEvent.waitUntil((async () => {
    try {
      const newSubscription = await self.registration.pushManager.subscribe(
        changeEvent.oldSubscription?.options || { userVisibleOnly: true }
      );
      // Notify the app client so it can re-register with the server
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        client.postMessage({ type: 'push-resubscribed', subscription: newSubscription.toJSON() });
      }
    } catch (err) {
      console.warn('[SW] pushsubscriptionchange re-subscribe failed:', err);
    }
  })());
});
