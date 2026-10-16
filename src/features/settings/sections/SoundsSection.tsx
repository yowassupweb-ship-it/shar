import { useEffect, useRef, useState } from 'react';
import { Check, Play, Square, Upload } from 'lucide-react';
import { showToast } from '@/shared/ui/Toast';
import {
  BUILTIN_RINGTONES, getCustomRingtone, getNotificationVolume, getRingtoneId, messageSoundsEnabled, playMessageSound,
  previewRingtone, setCustomRingtone, setMessageSoundsEnabled, setNotificationVolume, setRingtoneId,
} from '@/shared/platform/push/sounds';
import { Group, Row, Slider, Switch } from '@/shared/ui/controls';

const MAX_RINGTONE = 2 * 1024 * 1024;

export default function SoundsSection() {
  const [messages, setMessages] = useState(messageSoundsEnabled);
  const [volume, setVolume] = useState(() => Math.round(getNotificationVolume() * 100));
  const desktop = typeof window !== 'undefined' && Boolean(window.sharDesktop);
  const previewTimer = useRef(0);
  const [ringtone, setRingtone] = useState(getRingtoneId);
  const [hasCustom, setHasCustom] = useState(() => Boolean(getCustomRingtone()));
  const [playing, setPlaying] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => stopRef.current?.(), []);

  const toggleMessages = (on: boolean) => {
    setMessages(on);
    setMessageSoundsEnabled(on);
    if (on) playMessageSound('in');
  };

  const choose = (id: string) => { setRingtone(id); setRingtoneId(id); };

  // Громкость применяется сразу; после паузы в движении ползунка проигрываем сигнал — слышно, что получилось.
  const changeVolume = (percent: number) => {
    setVolume(percent);
    setNotificationVolume(percent / 100);
    window.clearTimeout(previewTimer.current);
    previewTimer.current = window.setTimeout(() => { if (percent > 0) playMessageSound('in'); }, 220);
  };

  const preview = (id: string) => {
    stopRef.current?.();
    stopRef.current = null;
    if (playing === id) { setPlaying(null); return; }
    stopRef.current = previewRingtone(id);
    setPlaying(id);
    window.setTimeout(() => setPlaying((cur) => (cur === id ? null : cur)), 2200);
  };

  const upload = (file: File) => {
    if (!file.type.startsWith('audio/')) { showToast('Нужен аудиофайл: MP3 или M4A', 'error'); return; }
    if (file.size > MAX_RINGTONE) { showToast('Файл больше 2 МБ — выберите покороче', 'error'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || '');
      if (!url) return;
      setCustomRingtone(url);
      setHasCustom(true);
      choose('custom');
    };
    reader.readAsDataURL(file);
  };

  const options = [...BUILTIN_RINGTONES.map((r) => ({ id: r.id, name: r.name })), ...(hasCustom ? [{ id: 'custom', name: 'Свой рингтон' }] : [])];

  return (
    <>
      <Group>
        <Row label="Звук сообщений" hint="Тихий сигнал при отправке и получении">
          <Switch checked={messages} onChange={toggleMessages} label="Звук сообщений" />
        </Row>
        {desktop && (
          <Row label="Громкость уведомлений" hint="Сигнал карточек в углу экрана и сообщений. 0% — без звука, до 200% — громче обычного">
            <Slider id="notify-volume" value={volume} min={0} max={200} step={5} label="Громкость уведомлений" format={(v) => `${v}%`} onChange={changeVolume} />
          </Row>
        )}
      </Group>

      <Group title="Рингтон звонка" note="Хранится на этом устройстве. MP3 или M4A, до 2 МБ.">
        <div role="radiogroup" aria-label="Рингтон звонка">
          {options.map((r) => (
            <div key={r.id} className="nx-row nst-choice">
              <button type="button" className="nx-icon-btn" aria-label={playing === r.id ? `Остановить: ${r.name}` : `Прослушать: ${r.name}`} onClick={() => preview(r.id)}>
                {playing === r.id ? <Square size={14} /> : <Play size={14} />}
              </button>
              <button type="button" role="radio" aria-checked={ringtone === r.id} className="nst-choice-label" onClick={() => choose(r.id)}>
                {r.name}
                {ringtone === r.id && <Check size={16} aria-hidden="true" />}
              </button>
            </div>
          ))}
        </div>
        <div className="nx-row nx-row-end">
          <button type="button" className="nx-ghost" onClick={() => fileRef.current?.click()}>
            <Upload size={15} aria-hidden="true" /> {hasCustom ? 'Заменить свой рингтон' : 'Загрузить свой'}
          </button>
          <input ref={fileRef} type="file" accept="audio/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.currentTarget.value = ''; if (f) upload(f); }} />
        </div>
      </Group>
    </>
  );
}
