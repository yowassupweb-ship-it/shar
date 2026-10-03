import { create } from 'zustand';
import { showToast } from '@/shared/ui/Toast';
import EventEditor, { newDraft, ScopeHost, type EditorState } from './EventEditor';
import { addMinutes, normalize } from './model';

/**
 * Редактор события из любого раздела: «Напоминание…» у сообщения в чате,
 * «Открыть событие» в уведомлении. Живёт в корне нового Шара (NxRoot), как
 * OverlayHost; календарь пользуется тем же вопросом «только это / всю серию».
 */

const useHost = create<{ state: EditorState | null }>(() => ({ state: null }));

export function openEventEditor(state: EditorState) {
  useHost.setState({ state });
}

/** Новое напоминание с готовым текстом — на ближайшие полчаса. */
export function openReminderFromText(text: string) {
  const start = new Date();
  start.setMinutes(Math.ceil((start.getMinutes() + 1) / 30) * 30, 0, 0);
  const lines = text.trim().split('\n');
  const first = lines.shift() || '';
  const title = first.length > 90 ? `${first.slice(0, 90)}…` : first;
  const rest = [first.length > 90 ? first : '', ...lines].filter(Boolean).join('\n').trim();
  openEventEditor({ mode: 'new', draft: { ...newDraft(start, addMinutes(start, 30)), title, description: rest || undefined } });
}

export async function openEventById(id: string) {
  try {
    const res = await fetch(`/api/events/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const event = normalize((await res.json()) as Record<string, unknown>);
    if (!event) throw new Error('bad event');
    openEventEditor({ mode: 'edit', event });
  } catch {
    showToast('Событие не открылось — возможно, его удалили.', 'error');
  }
}

export function EventEditorHost() {
  const state = useHost((s) => s.state);
  return (
    <>
      {state && (
        <EventEditor
          key={state.mode === 'edit' ? state.event.id : state.draft.start + state.draft.title}
          state={state}
          onClose={() => useHost.setState({ state: null })}
        />
      )}
      <ScopeHost />
    </>
  );
}
