import { useState } from 'react';
import { showToast } from '@/shared/ui/Toast';
import { isTabVisible, type TabKey } from '@/shared/navigation/visibility';
import { saveVisibleTabs, type Profile } from '../api';
import { Group, Row, Switch } from '@/shared/ui/controls';

const TOGGLES: { key: TabKey; label: string; hint?: string }[] = [
  { key: 'tasks', label: 'Задачи' },
  { key: 'calendar', label: 'Календарь' },
  { key: 'contacts', label: 'Контакты' },
  { key: 'files', label: 'Файлы' },
  { key: 'mail', label: 'Почта', hint: 'Если подключён почтовый ящик' },
];

export default function SectionsSection({ profile, onChange }: { profile: Profile; onChange: (p: Profile) => void }) {
  const [saving, setSaving] = useState(false);
  const tabs = profile.visibleTabs || {};

  const toggle = async (key: string, on: boolean) => {
    const next = { ...tabs, [key]: on };
    onChange({ ...profile, visibleTabs: next });
    setSaving(true);
    try { await saveVisibleTabs(next); } catch {
      onChange({ ...profile, visibleTabs: tabs });
      showToast('Не сохранилось — нет связи с сервером', 'error');
    } finally { setSaving(false); }
  };

  return (
    <Group title="Разделы в меню" note="«Чаты» и «Ещё» видны всегда. Скрытый раздел по-прежнему открывается по ссылке.">
      {TOGGLES.map((t) => (
        <Row key={t.key} label={t.label} hint={t.hint}>
          <Switch checked={isTabVisible(tabs, t.key)} onChange={(v) => void toggle(t.key, v)} label={t.label} disabled={saving} />
        </Row>
      ))}
    </Group>
  );
}
