// ── UI sounds ────────────────────────────────────────────────────────────────
// Message send/receive chimes and call ringtones, synthesized with the Web Audio
// API so there are zero binary assets to ship. All state lives in localStorage so
// it works without a network round-trip and is readable from anywhere (chat page,
// incoming-call modal, settings).

const LS_MSG_SOUNDS   = 'shar_message_sounds';   // 'on' | 'off'  (default on)
const LS_RINGTONE     = 'shar_ringtone';         // builtin id | 'custom'
const LS_RINGTONE_CUS = 'shar_ringtone_custom';  // data: URL of an uploaded file
const LS_NOTIFY_VOLUME = 'shar_notification_volume'; // 0…2 (1 = как раньше), громкость сигналов сообщений и уведомлений

let _ctx: AudioContext | null = null;
function ctx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    if (!_ctx) _ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (_ctx.state === 'suspended') void _ctx.resume();
    return _ctx;
  } catch { return null; }
}

// Browsers create the AudioContext SUSPENDED until the user interacts with the page —
// so a sound triggered purely by an incoming SSE event (a notification arriving while
// the user is just reading) is silently dropped. Resume it on the first real gesture and
// keep it warm on every gesture after, so notification sounds actually play.
if (typeof window !== 'undefined') {
  const unlock = () => {
    try { const c = ctx(); if (c && c.state === 'suspended') void c.resume(); } catch { /* ignore */ }
  };
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
    window.addEventListener(ev, unlock, { passive: true })
  );
}

// ── Message sounds ──────────────────────────────────────────────────────────

/** Громкость сигналов уведомлений: 0 — тишина, 1 — как раньше, до 2 — вдвое громче. */
export function getNotificationVolume(): number {
  if (typeof window === 'undefined') return 1;
  const stored = localStorage.getItem(LS_NOTIFY_VOLUME);
  const raw = Number(stored);
  return stored !== null && Number.isFinite(raw) ? Math.max(0, Math.min(2, raw)) : 1;
}
export function setNotificationVolume(volume: number): void {
  if (typeof window === 'undefined') return;
  const clamped = Math.max(0, Math.min(2, volume));
  localStorage.setItem(LS_NOTIFY_VOLUME, String(clamped));
  // Карточки уведомлений рисует главный процесс Electron — звук в них играет он, ему и сообщаем.
  try { window.sharDesktop?.notifications?.setVolume(clamped); } catch { /* не Electron */ }
}

export function messageSoundsEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  return localStorage.getItem(LS_MSG_SOUNDS) !== 'off';
}
export function setMessageSoundsEnabled(on: boolean): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(LS_MSG_SOUNDS, on ? 'on' : 'off');
}

// A short two-note chime. 'out' (sent) rises brightly; 'in' (received) is softer
// and lands a touch lower so the two never sound identical.
function chime(freqs: number[], opts: { gain?: number; dur?: number; type?: OscillatorType } = {}): void {
  const ac = ctx();
  if (!ac) return;
  const now = ac.currentTime;
  const dur = opts.dur ?? 0.12;
  const peak = Math.min(0.9, (opts.gain ?? 0.09) * getNotificationVolume());
  if (peak <= 0.0002) return;
  freqs.forEach((f, i) => {
    const t0 = now + i * (dur * 0.8);
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = opts.type ?? 'sine';
    osc.frequency.setValueAtTime(f, t0);
    // Soft attack + exponential release so it reads as a gentle "ding", not a beep.
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(ac.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  });
}

// A single note with a smooth frequency glide + soft bell envelope. Reads as one
// warm "swoosh"/"bloop" rather than discrete beeps — much gentler than two tones.
function glide(fFrom: number, fTo: number, opts: { gain?: number; dur?: number; type?: OscillatorType } = {}): void {
  const ac = ctx();
  if (!ac) return;
  const now = ac.currentTime;
  const dur = opts.dur ?? 0.15;
  const peak = Math.min(0.9, (opts.gain ?? 0.06) * getNotificationVolume());
  if (peak <= 0.0002) return;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = opts.type ?? 'triangle';
  osc.frequency.setValueAtTime(fFrom, now);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, fTo), now + dur);
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(peak, now + 0.02);   // soft attack
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);  // gentle release
  osc.connect(g); g.connect(ac.destination);
  osc.start(now); osc.stop(now + dur + 0.03);
}

export function playMessageSound(dir: 'in' | 'out'): void {
  if (!messageSoundsEnabled()) return;
  // Sent — a soft, airy upward "swoosh" (one gliding triangle note). Warm, not beepy.
  if (dir === 'out') glide(493.88, 783.99, { type: 'triangle', dur: 0.16, gain: 0.05 });
  // Received — a gentle two-note fall, kept soft so it's distinct but unobtrusive.
  else               chime([523.25, 415.3], { gain: 0.07, dur: 0.14, type: 'sine' });
}

// A struck-bell "clang" for «Колокольчик» notifications: a sharp attack, several
// INHARMONIC partials (what makes metal sound like a bell, not a tone) and a long
// exponential ring-out. Still synthesized — no audio asset to ship.
let _lastBellAt = 0;
export function playBellStrike(): void {
  if (!messageSoundsEnabled()) return;
  // The SSE handler and the polling push-service can both detect the same notification;
  // debounce so it never double-strikes.
  const nowMs = Date.now();
  if (nowMs - _lastBellAt < 800) return;
  _lastBellAt = nowMs;
  const volume = getNotificationVolume();
  if (volume <= 0.01) return;
  const ac = ctx();
  if (!ac) return;
  const now = ac.currentTime;
  const fundamental = 587.33; // a touch higher — reads as a crisp notification "ding"
  // mult ratios are the classic inharmonic bell series (hum/prime/tierce/quint/nominal…).
  // Short ring-out so it lands like a notification, not a church bell.
  const partials = [
    { mult: 1.0,  gain: 0.16, dur: 0.5 },
    { mult: 2.0,  gain: 0.10, dur: 0.38 },
    { mult: 2.76, gain: 0.08, dur: 0.3 },
    { mult: 5.4,  gain: 0.045, dur: 0.2 },
    { mult: 8.1,  gain: 0.025, dur: 0.14 },
  ];
  partials.forEach(p => {
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(fundamental * p.mult, now);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(Math.min(0.9, p.gain * volume), now + 0.004); // sharp metallic strike
    g.gain.exponentialRampToValueAtTime(0.0001, now + p.dur); // long ring-out
    osc.connect(g); g.connect(ac.destination);
    osc.start(now); osc.stop(now + p.dur + 0.05);
  });
}

// ── Ringtones ───────────────────────────────────────────────────────────────

export type RingtoneDef = { id: string; name: string; pattern: number[]; type?: OscillatorType };

// Each ringtone is a short melodic loop (Hz per step, 0 = rest). Kept musical and
// distinct so they're easy to tell apart when previewing in Settings.
export const BUILTIN_RINGTONES: RingtoneDef[] = [
  { id: 'classic', name: 'Классический', pattern: [880, 0, 880, 0, 660, 880, 0, 0] },
  { id: 'marimba', name: 'Маримба',      pattern: [523, 659, 784, 659, 523, 0, 0, 0], type: 'triangle' },
  { id: 'pulse',   name: 'Пульс',        pattern: [440, 440, 0, 440, 440, 0, 0, 0], type: 'square' },
  { id: 'chimes',  name: 'Колокольчики', pattern: [1046, 784, 1318, 1046, 0, 0, 0, 0], type: 'sine' },
  { id: 'ripple',  name: 'Рябь',         pattern: [659, 784, 988, 784, 659, 523, 0, 0], type: 'triangle' },
];

export function getRingtoneId(): string {
  if (typeof window === 'undefined') return 'classic';
  return localStorage.getItem(LS_RINGTONE) || 'classic';
}
export function setRingtoneId(id: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(LS_RINGTONE, id);
}
export function getCustomRingtone(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(LS_RINGTONE_CUS);
}
export function setCustomRingtone(dataUrl: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(LS_RINGTONE_CUS, dataUrl);
}

// Play a synthesized ringtone loop. Returns a stop() function. `once` plays a
// single pass (used for the Settings preview); otherwise it loops until stopped.
function playSynthRingtone(def: RingtoneDef, once = false): () => void {
  const ac = ctx();
  if (!ac) return () => {};
  let stopped = false;
  const step = 0.16;
  const schedulePass = (start: number) => {
    def.pattern.forEach((f, i) => {
      if (!f) return;
      const t0 = start + i * step;
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.type = def.type ?? 'sine';
      osc.frequency.setValueAtTime(f, t0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.14, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + step * 0.9);
      osc.connect(g); g.connect(ac.destination);
      osc.start(t0); osc.stop(t0 + step);
    });
  };
  const passLen = def.pattern.length * step + 0.25;
  schedulePass(ac.currentTime + 0.02);
  let timer: ReturnType<typeof setInterval> | null = null;
  if (!once) {
    timer = setInterval(() => { if (!stopped) schedulePass(ac.currentTime + 0.02); }, passLen * 1000);
  }
  return () => { stopped = true; if (timer) clearInterval(timer); };
}

// Preview a ringtone by id (built-in synth, or the uploaded custom file).
// Returns a stop() function.
export function previewRingtone(id: string): () => void {
  if (id === 'custom') {
    const src = getCustomRingtone();
    if (!src || typeof Audio === 'undefined') return () => {};
    const a = new Audio(src);
    a.play().catch(() => {});
    return () => { a.pause(); a.currentTime = 0; };
  }
  const def = BUILTIN_RINGTONES.find(r => r.id === id) || BUILTIN_RINGTONES[0];
  return playSynthRingtone(def, true);
}

// Start the currently-selected ringtone as a loop (used by the incoming-call UI).
// Returns a stop() function.
export function startSelectedRingtone(): () => void {
  const id = getRingtoneId();
  if (id === 'custom') {
    const src = getCustomRingtone();
    if (src && typeof Audio !== 'undefined') {
      const a = new Audio(src);
      a.loop = true;
      a.play().catch(() => {});
      return () => { a.pause(); a.currentTime = 0; };
    }
    // fall through to a builtin if there's no uploaded file
  }
  const def = BUILTIN_RINGTONES.find(r => r.id === id) || BUILTIN_RINGTONES[0];
  return playSynthRingtone(def, false);
}
