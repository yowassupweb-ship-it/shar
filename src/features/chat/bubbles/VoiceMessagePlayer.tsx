import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Play, Pause, Mic, AlertTriangle } from 'lucide-react';

interface VoiceMessagePlayerProps {
  url: string;
  duration?: number; // seconds, known up-front from recording — used before metadata/waveform loads
  /** Precomputed peaks (0..1, BAR_COUNT long) from analyzing the just-recorded Blob
   * client-side, before upload even starts. Skips the fetch+decode round trip through
   * `url` entirely — without this, the optimistic/sending bubble had nothing to show but
   * a flat placeholder, then "popped" to the real waveform once the network fetch
   * resolved, reading as if the message had been replaced by a different one. */
  initialPeaks?: number[];
  /** True when this is the message's only content — the player fills the whole bubble
   * edge-to-edge (bubble's own background/shape doubles as the player's), instead of
   * sitting as an inset card inside a padded bubble. */
  fillBubble?: boolean;
  textColor?: string;
  /** Incoming voice message not yet played by the current user — shows a small
   * unlistened dot (WhatsApp/Telegram-style), cleared by calling onListened the first
   * time playback starts. Own messages never show this — it's the RECIPIENT's dot. */
  showUnlistenedDot?: boolean;
  onListened?: () => void;
  /** Stable identity for this player (e.g. `${messageId}-voice-${idx}`) — required
   * for the consecutive-auto-play chain below to be able to address this instance. */
  playKey?: string;
  /** playKey of the NEXT voice message immediately following this one in the
   * timeline, if any — when this message finishes playing, that one starts
   * automatically, chaining through a run of consecutive voice messages the way
   * Telegram/WhatsApp do, instead of stopping after just the one that was tapped. */
  nextVoiceKey?: string;
  /** Short label shown in the floating mini-player when this bubble scrolls out of
   * view while playing (e.g. the sender's name). Falls back to a generic label. */
  senderLabel?: string;
  /** Scrolls the timeline back to this message — wired to the mini-player's tap
   * target so tapping it jumps back to where the audio actually is. */
  onJumpToSelf?: () => void;
  /** Bigger play button/waveform/touch target on phones — small controls sized for
   * a mouse cursor are hard to hit precisely with a fingertip. */
  isMobileView?: boolean;
}

export const VOICE_WAVEFORM_BAR_COUNT = 42;
const BAR_COUNT = VOICE_WAVEFORM_BAR_COUNT;

// Only one voice message plays at a time across the whole app — module-level (not
// component state) since players live in entirely separate message bubbles with no
// shared parent that would make sense to lift this into. Starting a new one pauses
// whatever else was playing.
let activeVoicePlayer: { audio: HTMLAudioElement; stop: () => void } | null = null;

// Lets one player instance start ANOTHER one by playKey, for the consecutive-auto-
// play chain — each mounted player registers a "start me" callback here, keyed by
// its own playKey, and unregisters on unmount. A finished player looks up its
// nextVoiceKey in this map and invokes it, rather than needing prop-drilled
// parent-mediated control between sibling bubbles that don't otherwise know about
// each other.
const voicePlayerRegistry = new Map<string, () => void>();

const PLAYBACK_RATES = [1, 1.5, 2] as const;
const PLAYBACK_RATE_STORAGE_KEY = 'shar_voice_playback_rate';

function loadStoredPlaybackRate(): number {
  if (typeof window === 'undefined') return 1;
  const raw = Number(window.localStorage.getItem(PLAYBACK_RATE_STORAGE_KEY));
  return (PLAYBACK_RATES as readonly number[]).includes(raw) ? raw : 1;
}

// ── Floating mini-player (shown when the currently-playing bubble scrolls out of
// view) ──────────────────────────────────────────────────────────────────────
// A plain module-level store + useSyncExternalStore, not React context — the
// player instances live in completely separate message bubbles all over the
// timeline with no shared ancestor that would make sense to lift this into, same
// reasoning as activeVoicePlayer/voicePlayerRegistry above.
interface MiniPlayerState {
  audio: HTMLAudioElement;
  label: string;
  isPlaying: boolean;
  onJump: () => void;
  onTogglePlay: () => void;
}
let miniPlayerState: MiniPlayerState | null = null;
const miniPlayerListeners = new Set<() => void>();
function setMiniPlayerState(next: MiniPlayerState | null) {
  miniPlayerState = next;
  miniPlayerListeners.forEach(l => l());
}
function subscribeMiniPlayer(listener: () => void) {
  miniPlayerListeners.add(listener);
  return () => { miniPlayerListeners.delete(listener); };
}
function getMiniPlayerSnapshot() { return miniPlayerState; }

/** Mount once near the bottom of the chat timeline. Renders nothing unless a
 * voice message is actively playing AND its own bubble has scrolled out of view —
 * lets you keep listening (and jump back with one tap) without losing your place
 * the moment you scroll away from it, the way Telegram/WhatsApp's persistent
 * "now playing" bar does. */
export function VoiceMiniPlayer({ bottomOffset }: { bottomOffset: number }) {
  const state = useSyncExternalStore(subscribeMiniPlayer, getMiniPlayerSnapshot, () => null);
  if (!state) return null;
  return (
    <div
      className="absolute left-1/2 flex items-center gap-2.5"
      style={{
        bottom: `${bottomOffset}px`,
        transform: 'translateX(-50%)',
        zIndex: 20,
        maxWidth: 'min(88%, 380px)',
        padding: '7px 14px 7px 7px',
        borderRadius: 9999,
        backgroundColor: 'var(--container-bg)',
        border: 'var(--apple-border-w) solid var(--apple-border-color)',
        boxShadow: 'var(--container-inset), 0 6px 20px rgba(0,0,0,0.22)',
        cursor: 'pointer',
      }}
      onClick={state.onJump}
    >
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); state.onTogglePlay(); }}
        className="flex items-center justify-center flex-shrink-0"
        style={{
          width: 30, height: 30, borderRadius: '50%',
          background: 'linear-gradient(180deg, color-mix(in srgb, var(--accent-primary) 92%, white 8%) 0%, var(--accent-primary) 100%)',
          color: '#ffffff',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.4), 0 1px 2px rgba(0,0,0,0.15)',
        }}
      >
        {state.isPlaying
          ? <Pause className="w-3.5 h-3.5" fill="currentColor" strokeWidth={0} />
          : <Play className="w-3.5 h-3.5" style={{ marginLeft: 1.5 }} fill="currentColor" strokeWidth={0} />
        }
      </button>
      <Mic className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
      <span className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
        {state.label}
      </span>
    </div>
  );
}

function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Downsamples a decoded audio buffer's channel data into BAR_COUNT peak values
// (0..1), the way Telegram/WhatsApp render a voice message's waveform — each bar
// is the max absolute sample amplitude in its slice of the track, not a fake
// random pattern.
export function computePeaksFromAudioBuffer(audioBuffer: AudioBuffer): number[] {
  const channel = audioBuffer.getChannelData(0);
  const blockSize = Math.max(1, Math.floor(channel.length / BAR_COUNT));
  const peaks: number[] = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    const start = i * blockSize;
    let max = 0;
    for (let j = 0; j < blockSize; j++) {
      const v = Math.abs(channel[start + j] || 0);
      if (v > max) max = v;
    }
    peaks.push(max);
  }
  const peak = Math.max(...peaks, 0.01);
  return peaks.map(p => Math.max(0.12, p / peak)); // normalize, floor so silence isn't a flat 0px line
}

function WaveformBars({ peaks, progress }: { peaks: number[]; progress: number }) {
  // Single row of bars, each fading between unplayed/played opacity — a second
  // overlaid copy of the track (clip-revealed by width) read as a stretching
  // duplicate rather than progress, so there's only ever one waveform on screen.
  // The transition bar's opacity is blended by its exact fractional position (not
  // a hard round-to-nearest-bar), which is what keeps it smooth frame-to-frame
  // instead of visibly stepping bar-by-bar.
  const exactPlayed = progress * peaks.length;
  return (
    <div className="flex items-center h-full w-full" style={{ gap: 2 }}>
      {peaks.map((peak, i) => {
        const barProgress = Math.max(0, Math.min(1, exactPlayed - i));
        const opacity = 0.35 + barProgress * 0.6;
        return (
          // No minWidth floor: with BAR_COUNT bars in a narrow bubble, a fixed minWidth
          // per bar could exceed the container's actual width and push the last bars past
          // the bubble's right edge/padding. flex:1 with no floor always fits exactly.
          <div
            key={i}
            style={{ flex: 1, height: `${Math.max(12, peak * 100)}%`, borderRadius: 1, background: 'currentColor', opacity }}
          />
        );
      })}
    </div>
  );
}

export default function VoiceMessagePlayer({ url, duration, initialPeaks, fillBubble, textColor, showUnlistenedDot, onListened, playKey, nextVoiceKey, senderLabel, onJumpToSelf, isMobileView }: VoiceMessagePlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [totalDuration, setTotalDuration] = useState(duration || 0);
  const [peaks, setPeaks] = useState<number[] | null>(initialPeaks || null);
  // Set when playback clearly isn't working — the known duration (from recording,
  // passed in as `duration`) is a real positive number, but currentTime has run
  // past it without the browser ever firing 'ended'. This happens on iOS Safari
  // for voice notes recorded as WebM/Opus on another platform: Safari can't parse
  // the container at all, so it never reaches end-of-stream, currentTime free-runs,
  // and there's no sound — previously that just looked like the timer counting up
  // forever in silence. Caught here and treated as a hard stop instead.
  const [playbackBroken, setPlaybackBroken] = useState(false);
  // `preload="metadata"` makes the browser start fetching the file the moment this
  // component mounts, with no user gesture involved — a transient hiccup in THAT
  // passive load (cold connection right after upload, a flaky redirect hop, etc.)
  // used to be indistinguishable from a real "can't play this" failure and showed
  // the broken state on a perfectly fine, just-sent voice note before anyone had
  // even tried to play it. Only failures that happen once the user actually asked
  // to play (or currentTime free-runs mid-playback, see the watchdog above) count.
  const hasAttemptedPlayRef = useRef(false);
  // Persisted across messages/reloads, like Telegram — picking 1.5x once means every
  // voice message plays at 1.5x from then on, not just this one.
  const [playbackRate, setPlaybackRate] = useState(loadStoredPlaybackRate);
  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const isUploading = !url;
  const isVisibleRef = useRef(true);

  useEffect(() => {
    if (!url || initialPeaks) return; // already have peaks from the local recording — no need to re-derive from the network copy
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(url);
        const arrayBuffer = await res.arrayBuffer();
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        const ctx = new AudioCtx();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        if (!cancelled) setPeaks(computePeaksFromAudioBuffer(audioBuffer));
        ctx.close();
      } catch {
        // Decoding failed (unsupported codec, network hiccup) — fall back to a flat
        // bar row below rather than leaving the player blank.
        if (!cancelled) setPeaks(new Array(BAR_COUNT).fill(0.35));
      }
    })();
    return () => { cancelled = true; };
  }, [url, initialPeaks]);

  // Smooth progress while playing: timeupdate only fires a few times a second (browser-
  // dependent, often as coarse as ~4Hz), which made the played/unplayed waveform boundary
  // visibly step rather than glide. A rAF loop samples audio.currentTime every frame instead.
  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }
    const tick = () => {
      const audio = audioRef.current;
      if (audio) {
        // A known, finite duration (from the recording itself, always present) is the
        // source of truth for how long this clip actually is — currentTime should
        // never legitimately exceed it. When the browser can't parse the container
        // (WebM played on iOS Safari, notably) it may never fire 'ended' and just
        // keeps advancing currentTime past the real end in silence; a >1.5s overrun
        // past the known duration is treated as broken playback rather than trusted.
        if (totalDuration > 0 && audio.currentTime > totalDuration + 1.5) {
          audio.pause();
          setIsPlaying(false);
          setPlaybackBroken(true);
          setCurrentTime(totalDuration);
          if (activeVoicePlayer?.audio === audio) activeVoicePlayer = null;
          return;
        }
        setCurrentTime(audio.currentTime);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [isPlaying, totalDuration]);

  // Starts playback (used by both the play button and the auto-advance chain below —
  // pulled out of togglePlay so a finished sibling player can trigger this one
  // directly via the registry without going through a click). `fromStart` is only
  // true for the auto-advance path — a manual play-button tap must resume from
  // wherever this particular message was previously paused, not jump back to 0.
  const startPlaying = (fromStart = false) => {
    const audio = audioRef.current;
    if (!audio || isUploading) return;
    if (activeVoicePlayer && activeVoicePlayer.audio !== audio) activeVoicePlayer.stop();
    if (fromStart) audio.currentTime = 0;
    // A prior passive preload failure leaves the element in a hard error state —
    // .play() alone won't retry the network fetch at that point, it just rejects
    // again immediately. .load() resets it so this tap gets a genuine fresh attempt.
    if (audio.error) audio.load();
    setPlaybackBroken(false);
    hasAttemptedPlayRef.current = true;
    audio.play().catch(() => setPlaybackBroken(true));
    setIsPlaying(true);
    activeVoicePlayer = { audio, stop: () => { audio.pause(); setIsPlaying(false); } };
    if (showUnlistenedDot) onListened?.();
  };

  // Registers this instance under playKey so a PRECEDING voice message's onEnd can
  // find and start this one — see nextVoiceKey below.
  useEffect(() => {
    if (!playKey) return;
    const starter = () => startPlaying(true);
    voicePlayerRegistry.set(playKey, starter);
    return () => {
      if (voicePlayerRegistry.get(playKey) === starter) voicePlayerRegistry.delete(playKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playKey, isUploading, showUnlistenedDot]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onLoaded = () => { if (isFinite(audio.duration)) setTotalDuration(audio.duration); };
    const onEnd = () => {
      setIsPlaying(false);
      setCurrentTime(0);
      if (activeVoicePlayer?.audio === audio) activeVoicePlayer = null;
      // Chain into the next consecutive voice message, Telegram/WhatsApp-style —
      // a run of voice notes sent back to back plays straight through instead of
      // stopping after whichever one was tapped.
      if (nextVoiceKey) voicePlayerRegistry.get(nextVoiceKey)?.();
    };
    // Explicit decode/network failure (unsupported codec, 404, etc.) — same broken
    // state as the runaway-timer watchdog above, so the button doesn't just look
    // stuck without any feedback. Only surfaced once the user has actually tried
    // to play — see hasAttemptedPlayRef above for why a passive preload failure
    // doesn't count.
    const onError = () => {
      if (!hasAttemptedPlayRef.current) return;
      setIsPlaying(false);
      setPlaybackBroken(true);
      if (activeVoicePlayer?.audio === audio) activeVoicePlayer = null;
    };
    audio.addEventListener('loadedmetadata', onLoaded);
    audio.addEventListener('durationchange', onLoaded);
    audio.addEventListener('ended', onEnd);
    audio.addEventListener('error', onError);
    return () => {
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.removeEventListener('durationchange', onLoaded);
      audio.removeEventListener('ended', onEnd);
      audio.removeEventListener('error', onError);
      // Unmounting mid-playback (message list scrolled away, chat switched) — drop the
      // singleton reference so a stale audio element can't block the next play.
      if (activeVoicePlayer?.audio === audio) activeVoicePlayer = null;
      if (miniPlayerState?.audio === audio) setMiniPlayerState(null);
    };
  }, [nextVoiceKey]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio || isUploading) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
      if (activeVoicePlayer?.audio === audio) activeVoicePlayer = null;
    } else {
      startPlaying();
    }
  };

  // Applies the persisted rate to the actual <audio> element — a state change alone
  // doesn't affect playback, HTMLMediaElement.playbackRate has to be set directly.
  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.playbackRate = playbackRate;
  }, [playbackRate, url]);

  const cyclePlaybackRate = () => {
    const idx = PLAYBACK_RATES.indexOf(playbackRate as typeof PLAYBACK_RATES[number]);
    const next = PLAYBACK_RATES[(idx + 1) % PLAYBACK_RATES.length];
    setPlaybackRate(next);
    try { window.localStorage.setItem(PLAYBACK_RATE_STORAGE_KEY, String(next)); } catch { /* ignore */ }
  };

  // Keeps the module-level mini-player in sync with this instance whenever either
  // "is this playing" or "is this bubble visible on screen" changes. Only the
  // currently-active player (audio === activeVoicePlayer.audio, implicitly true
  // since only one plays at a time) ever sets it; any other instance's sync call
  // only clears the mini-player if IT was the one that had set it (checked via the
  // audio-element identity), so two players' effects can't stomp on each other.
  const isPlayingRef = useRef(false);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  const syncMiniPlayer = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlayingRef.current && !isVisibleRef.current) {
      setMiniPlayerState({
        audio,
        label: senderLabel || 'Голосовое сообщение',
        isPlaying: true,
        onJump: () => onJumpToSelf?.(),
        onTogglePlay: () => togglePlay(),
      });
    } else if (miniPlayerState?.audio === audio) {
      setMiniPlayerState(null);
    }
  };
  useEffect(() => { syncMiniPlayer();   }, [isPlaying]);

  // Tracks whether this bubble is actually on screen — the mini-player should only
  // appear once you've scrolled the real bubble out of view, not the instant
  // playback starts.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    // Default root (null) measures against the browser VIEWPORT, not whatever
    // scrollable ancestor actually clips this element — the chat timeline scrolls
    // inside its own nested `overflow-y-auto` div, so a bubble scrolled out of that
    // container was still geometrically inside the page's viewport and kept
    // reporting isIntersecting:true forever, meaning the mini-player's "scrolled out
    // of view" condition never triggered. Walk up to the real scrolling ancestor and
    // use that as root instead.
    const findScrollParent = (node: HTMLElement | null): HTMLElement | null => {
      let p = node?.parentElement ?? null;
      while (p) {
        const style = getComputedStyle(p);
        if (/(auto|scroll)/.test(style.overflowY)) return p;
        p = p.parentElement;
      }
      return null; // falls back to viewport root if nothing scrollable found
    };
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      isVisibleRef.current = !!entry?.isIntersecting;
      syncMiniPlayer();
    }, { root: findScrollParent(el), threshold: 0 });
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const seekToClientX = (clientX: number) => {
    const audio = audioRef.current;
    const container = containerRef.current;
    if (!audio || !container || !totalDuration || isUploading) return;
    const rect = container.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    audio.currentTime = ratio * totalDuration;
    setCurrentTime(audio.currentTime);
  };

  const progress = totalDuration > 0 ? Math.min(1, currentTime / totalDuration) : 0;
  const displayPeaks = peaks || new Array(BAR_COUNT).fill(0.2);
  // Clamped so a runaway currentTime (see the rAF watchdog above) never shows past
  // the clip's real length even in the brief window before the watchdog stops it.
  const clampedCurrentTime = totalDuration > 0 ? Math.min(currentTime, totalDuration) : currentTime;
  // Small touch targets sized for a mouse cursor are hard to hit precisely with a
  // fingertip — bumped up across the board on mobile.
  const buttonSize = isMobileView ? 46 : 36;
  const iconSizeClass = isMobileView ? 'w-5 h-5' : 'w-4 h-4';
  const waveformHeight = isMobileView ? 36 : 28;

  return (
    <div
      ref={rootRef}
      className="flex items-center gap-2.5"
      style={{
        padding: fillBubble ? '10px 14px' : (isMobileView ? '10px 14px 10px 10px' : '8px 12px 8px 8px'),
        borderRadius: fillBubble ? 0 : 20,
        background: fillBubble ? 'transparent' : 'rgba(0,0,0,0.08)',
        width: fillBubble ? '100%' : undefined,
        minWidth: isMobileView ? 240 : 220,
        boxSizing: 'border-box',
        color: textColor,
        opacity: isUploading ? 0.6 : 1,
      }}
    >
      {url && <audio ref={audioRef} src={url} preload="metadata" />}
      <div className="relative flex-shrink-0">
        <button
          type="button"
          onClick={togglePlay}
          disabled={isUploading}
          className="flex items-center justify-center"
          title={playbackBroken ? 'Не удалось воспроизвести — нажмите, чтобы повторить' : undefined}
          style={{
            width: buttonSize, height: buttonSize, borderRadius: '50%', cursor: isUploading ? 'default' : 'pointer',
            // Signature convex/pill treatment (same bevel language as the app's
            // pillBtnStyle buttons elsewhere) instead of a flat tinted circle: a
            // top-to-bottom gradient for the curvature itself, an inset top highlight
            // catching light, an inset bottom shadow for depth, and a soft outer drop
            // shadow lifting it slightly off the bubble. Built from currentColor so it
            // adapts to both the accent-blue own-bubble and the neutral other-bubble.
            background: 'linear-gradient(180deg, color-mix(in srgb, currentColor 24%, transparent) 0%, color-mix(in srgb, currentColor 13%, transparent) 100%)',
            boxShadow: [
              'inset 0 1px 0 color-mix(in srgb, currentColor 45%, transparent)',
              'inset 0 -1.5px 2px rgba(0,0,0,0.16)',
              '0 1px 2px rgba(0,0,0,0.12)',
            ].join(', '),
          }}
        >
          {playbackBroken
            ? <AlertTriangle className={iconSizeClass} style={{ color: '#dc2626' }} />
            : isPlaying
              ? <Pause className={iconSizeClass} fill="currentColor" strokeWidth={0} />
              : <Play className={iconSizeClass} style={{ marginLeft: 2 }} fill="currentColor" strokeWidth={0} />
          }
        </button>
        {showUnlistenedDot && (
          <span
            style={{
              position: 'absolute', top: -1, right: -1, width: 11, height: 11, borderRadius: '50%',
              backgroundColor: '#0a84ff', border: '2px solid var(--bubble-bg, transparent)', boxSizing: 'content-box',
            }}
          />
        )}
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div
          ref={containerRef}
          onClick={(e) => seekToClientX(e.clientX)}
          className="relative"
          style={{ height: waveformHeight, cursor: isUploading ? 'default' : 'pointer' }}
        >
          <WaveformBars peaks={displayPeaks} progress={progress} />
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className={`opacity-70 tabular-nums ${isMobileView ? 'text-[12px]' : 'text-[11px]'}`}>
            {isUploading
              ? 'Отправка…'
              : playbackBroken
                ? 'Не удалось воспроизвести'
                : formatTime(isPlaying || clampedCurrentTime > 0 ? clampedCurrentTime : totalDuration)}
          </span>
          {!isUploading && (
            <button
              type="button"
              onClick={cyclePlaybackRate}
              className="flex-shrink-0 font-semibold tabular-nums"
              style={{
                padding: isMobileView ? '3px 7px' : '2px 6px', borderRadius: 8,
                fontSize: isMobileView ? '11px' : '10px',
                background: 'color-mix(in srgb, currentColor 14%, transparent)',
                opacity: playbackRate === 1 ? 0.65 : 1,
              }}
              title="Скорость воспроизведения"
            >
              {playbackRate}×
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
