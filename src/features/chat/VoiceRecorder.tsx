import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Trash2 } from 'lucide-react';
import { pingActivity, sendVoice } from './store';
import { computePeaksFromAudioBuffer } from './bubbles/VoiceMessagePlayer';

/**
 * Запись голосового. Живая волна — по уровню микрофона (AnalyserNode),
 * итоговая волна для плеера — по декодированному звуку, как в старом чате.
 * Собеседник всё время записи видит «записывает голосовое».
 */

const BARS = 36;

function pickMime(): string | undefined {
  const opts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return opts.find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(t));
}

function fmt(sec: number) {
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function VoiceRecorder({ chatId, onDone }: { chatId: string; onDone: () => void }) {
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0.08));
  const [error, setError] = useState('');
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const started = useRef(0);
  const sendOnStop = useRef(false);

  useEffect(() => {
    let raf = 0;
    let ctx: AudioContext | null = null;
    let cancelled = false;
    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return; }
        stream.current = s;
        const mime = pickMime();
        const r = new MediaRecorder(s, mime ? { mimeType: mime } : undefined);
        rec.current = r;
        r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
        r.onstop = () => { void finish(r.mimeType || mime || 'audio/webm'); };
        r.start(250);
        started.current = performance.now();
        pingActivity(chatId, 'voice');

        ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        ctx.createMediaStreamSource(s).connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        let lastBar = 0;
        const tick = (now: number) => {
          setElapsed((now - started.current) / 1000);
          if (now - lastBar > 90) {
            lastBar = now;
            analyser.getByteTimeDomainData(buf);
            let peak = 0;
            for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128);
            setLevels((l) => [...l.slice(1), Math.max(0.08, Math.min(1, peak * 2.2))]);
            pingActivity(chatId, 'voice');
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch {
        setError('Нет доступа к микрофону. Разрешите его в настройках браузера.');
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ctx?.close().catch(() => {});
      if (rec.current?.state === 'recording') rec.current.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
      pingActivity(chatId, 'voice', true);
    };
  }, [chatId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function finish(mime: string) {
    stream.current?.getTracks().forEach((t) => t.stop());
    if (!sendOnStop.current) { chunks.current = []; return; }
    const duration = (performance.now() - started.current) / 1000;
    const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
    const blob = new Blob(chunks.current, { type: mime });
    chunks.current = [];
    if (duration < 0.5 || !blob.size) return;
    const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: mime });
    let peaks: number[] | undefined;
    try {
      const arr = await blob.arrayBuffer();
      const ac = new AudioContext();
      peaks = computePeaksFromAudioBuffer(await ac.decodeAudioData(arr));
      ac.close().catch(() => {});
    } catch { /* волну достроит плеер */ }
    sendVoice(chatId, file, duration, peaks);
  }

  const stop = (send: boolean) => {
    sendOnStop.current = send;
    if (rec.current && rec.current.state !== 'inactive') rec.current.stop();
    onDone();
  };

  if (error) {
    return (
      <div className="cxc-rec" role="alert">
        <span className="cxc-rec-error">{error}</span>
        <button type="button" className="nx-ghost" onClick={onDone}>Понятно</button>
      </div>
    );
  }

  return (
    <div className="cxc-rec" role="group" aria-label="Запись голосового сообщения">
      <button type="button" className="nx-icon-btn" onClick={() => stop(false)} aria-label="Удалить запись">
        <Trash2 size={18} aria-hidden="true" />
      </button>
      <span className="cxc-rec-dot" aria-hidden="true" />
      <span className="cxc-rec-time" aria-live="off">{fmt(elapsed)}</span>
      <span className="cxc-rec-wave" aria-hidden="true">
        {levels.map((l, i) => <i key={i} style={{ transform: `scaleY(${l})` }} />)}
      </span>
      <button type="button" className="cxn-send cxc-rec-send" onClick={() => stop(true)} aria-label="Отправить голосовое">
        <ArrowUp size={18} strokeWidth={2.6} aria-hidden="true" />
      </button>
    </div>
  );
}
