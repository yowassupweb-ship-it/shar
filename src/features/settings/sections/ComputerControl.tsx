import { useEffect, useState } from 'react';
import { askConfirm } from '@/shared/ui/overlay';
import { Group, Row, Switch } from '@/shared/ui/controls';

/**
 * Управление этим компьютером агентом «Ядра» — только в Shar OS. По умолчанию выключено; включает сам человек.
 * Пока агент действует — плашка поверх окон с «Стоп»; Ctrl+Alt+Q — то же с клавиатуры, выключает совсем.
 */
export function ComputerControl() {
  const api = typeof window !== 'undefined' ? window.sharDesktop?.computer : undefined;
  const [info, setInfo] = useState<{ enabled: boolean; supported: boolean; name: string; stopKey: string } | null>(null);

  useEffect(() => {
    if (!api) return undefined;
    void api.get().then((i) => setInfo({ enabled: i.enabled, supported: i.supported, name: i.name, stopKey: i.stopKey })).catch(() => undefined);
    return api.onChanged((d) => setInfo((cur) => (cur ? { ...cur, enabled: d.enabled } : cur)));
  }, [api]);

  if (!api || !info) return null;

  const toggle = async (on: boolean) => {
    if (on && !(await askConfirm({
      title: 'Разрешить агенту управлять этим компьютером?',
      text: `Агент «Ядра» сможет видеть экран, двигать мышь и печатать — только в ваших с ним чатах. Пока он действует, сверху видна плашка; «Стоп» на ней или ${info.stopKey} сразу выключают управление.`,
      confirm: 'Разрешить',
    }))) return;
    const enabled = await api.set(on);
    setInfo((cur) => (cur ? { ...cur, enabled } : cur));
  };

  return (
    <Group
      title="Управление компьютером"
      note={info.supported
        ? `Агент работает на сервере, а действует здесь, у вас на глазах. Ничего не покупает, не отправляет и не вводит пароли без вашей прямой просьбы. Стоп — кнопка на плашке или ${info.stopKey}.`
        : 'Управление мышью и клавиатурой есть только в Shar OS для Windows.'}
    >
      <Row label="Агент может управлять этим компьютером" hint={info.enabled ? `Включено на «${info.name}»` : 'Выключено'}>
        <Switch checked={info.enabled} disabled={!info.supported} onChange={(v) => void toggle(v)} label="Управление компьютером агентом" />
      </Row>
    </Group>
  );
}
