'use client';

// Lightweight client-error telemetry. Ships uncaught errors, unhandled promise
// rejections, and React error-boundary crashes to /api/client-errors so on-device
// failures (iOS keyboard, PWA offline, routing, render crashes) surface as real
// data instead of "a user said it broke". Deliberately tiny and defensive:
//  • fire-and-forget, keepalive (still sends during unload),
//  • dedupes identical signatures within a window (no spamming the same error),
//  • rate-limited per minute (a render loop can't flood the backend),
//  • wrapped so telemetry itself can never throw into the app.

type Kind = 'error' | 'unhandledrejection' | 'react' | 'manual';

const DEDUPE_MS = 30_000;
const MAX_PER_MIN = 20;
const recentSignatures = new Map<string, number>(); // signature -> last-sent ts
let windowStart = 0;
let sentInWindow = 0;
let installed = false;

// Transient/environmental noise that isn't an app bug and self-heals on reload or
// when the network comes back — filtered out so the admin console stays a list of
// real defects, not a wall of "user's phone blinked offline" / "chunk was stale
// during a deploy or HMR rebuild".
const NOISE_PATTERNS: RegExp[] = [
  /ResizeObserver loop/i,
  /ChunkLoadError/i,
  /Loading (?:CSS )?chunk \d+ failed/i,
  /Failed to load chunk/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /Failed to fetch/i,               // network dropped / backend momentarily down
  /NetworkError when attempting to fetch/i,
  /The network connection was lost/i,
  /Load failed/i,                   // Safari's wording for a failed fetch
  /AbortError/i,                    // in-flight request cancelled (navigation/timeout)
];

function isTransientNoise(message: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(message));
}

function appVersion(): string | undefined {
  try {
    const meta = document.querySelector('meta[name="app-version"]') as HTMLMetaElement | null;
    return meta?.content || undefined;
  } catch {
    return undefined;
  }
}

function context(): Record<string, unknown> {
  let userId: string | undefined;
  let userName: string | undefined;
  try {
    const a = JSON.parse(localStorage.getItem('myAccount') || 'null');
    userId = a?.id ? String(a.id) : undefined;
    userName = a?.name || a?.username || undefined;
  } catch { /* ignore */ }
  return {
    url: typeof location !== 'undefined' ? location.href : undefined,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    userId,
    userName,
    appVersion: appVersion(),
  };
}

export function reportClientError(kind: Kind, err: unknown, extra?: Record<string, unknown>): void {
  try {
    const message = err instanceof Error
      ? err.message
      : String((err as { message?: unknown })?.message ?? err ?? 'Unknown error');
    const stack = err instanceof Error ? err.stack : undefined;

    if (isTransientNoise(message)) return; // environmental/transient, not a real bug

    const now = Date.now();
    const signature = `${kind}:${message}`.slice(0, 200);
    const last = recentSignatures.get(signature);
    if (last && now - last < DEDUPE_MS) return; // same error just reported — skip
    recentSignatures.set(signature, now);
    if (recentSignatures.size > 200) recentSignatures.clear();

    if (now - windowStart > 60_000) { windowStart = now; sentInWindow = 0; }
    if (sentInWindow >= MAX_PER_MIN) return; // rate cap
    sentInWindow += 1;

    const ctx = context();
    const standalone = (() => {
      try {
        return window.matchMedia?.('(display-mode: standalone)').matches
          || Boolean((navigator as unknown as { standalone?: boolean }).standalone);
      } catch { return undefined; }
    })();
    const viewport = (() => {
      try { return `${window.innerWidth}x${window.innerHeight}`; } catch { return undefined; }
    })();

    const body = JSON.stringify({
      kind,
      message,
      stack,
      url: ctx.url,
      userAgent: ctx.userAgent,
      userId: ctx.userId,
      userName: ctx.userName,
      appVersion: ctx.appVersion,
      extra: { ...(extra || {}), standalone, viewport },
    });

    fetch('/api/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true, // survive an unload/navigation mid-report
    }).catch(() => { /* never let telemetry throw */ });
  } catch { /* never let telemetry throw */ }
}

export function initTelemetry(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (e: ErrorEvent) => {
    // ResizeObserver loop warnings are benign browser noise, not real errors.
    if (e.message && /ResizeObserver loop/i.test(e.message)) return;
    reportClientError('error', e.error || e.message, {
      filename: e.filename, lineno: e.lineno, colno: e.colno,
    });
  });

  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    reportClientError('unhandledrejection', e.reason);
  });
}
