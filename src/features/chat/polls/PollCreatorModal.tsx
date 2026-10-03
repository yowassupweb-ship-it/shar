import { useEffect, useState } from 'react';
import { X, BarChart3, Plus, Trash2, Check } from 'lucide-react';

export interface PollEditContext {
  messageId: string;
  question: string;
  options: string[];
  multipleChoice: boolean;
  isAnonymous: boolean;
  allowRevote: boolean;
}

interface PollCreatorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (question: string, options: string[], multipleChoice: boolean, isAnonymous: boolean, allowRevote: boolean) => Promise<void> | void;
  /** Set when editing an existing (unvoted) poll — pre-fills the form and swaps the
   * header/button copy to "Save" instead of "Create". The actual POST-vs-PATCH
   * decision lives in the caller (page.tsx), not here — this component only cares
   * about what to show and what values to submit. */
  editingPoll?: PollEditContext | null;
}

const pillBtnStyle: React.CSSProperties = {
  width: '36px', height: '36px', borderRadius: '50%', flexShrink: 0, cursor: 'pointer', padding: 0,
  display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box',
  backgroundColor: 'var(--element-bg)',
  border: 'var(--apple-border-w) solid var(--apple-border-color)',
  boxShadow: 'var(--chin-shadow)',
  color: 'var(--text-primary)',
  WebkitTapHighlightColor: 'transparent',
};

const fieldStyle: React.CSSProperties = {
  width: '100%', borderRadius: '14px', padding: '11px 14px',
  backgroundColor: 'var(--element-bg)',
  border: 'var(--apple-border-w) solid var(--apple-border-color)',
  color: 'var(--text-primary)',
  outline: 'none',
};

const MAX_OPTIONS = 10;

// Built by hand (a bordered box + a Check icon toggled by aria-checked) rather than
// a native <input type="checkbox"> — the app's global styles were suppressing the
// native checkbox's own appearance somewhere upstream, rendering it as an invisible
// box with no visible check mark. Doing it as a real div/button pair sidesteps
// whatever's resetting native form-control appearance and guarantees it always
// looks like an actual checkbox regardless of global CSS.
function Checkbox({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={{
        width: 22, height: 22, borderRadius: 6, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: `1.5px solid ${checked ? 'var(--accent-primary)' : 'var(--apple-border-color)'}`,
        backgroundColor: checked ? 'var(--accent-primary)' : 'var(--element-bg)',
        transition: 'background-color 0.12s ease, border-color 0.12s ease',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {checked && <Check className="w-3.5 h-3.5" style={{ color: '#ffffff' }} strokeWidth={3} />}
    </button>
  );
}

export default function PollCreatorModal({ isOpen, onClose, onCreate, editingPoll }: PollCreatorModalProps) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multipleChoice, setMultipleChoice] = useState(false);
  // Telegram-style default: NOT anonymous, so results plainly show who voted for
  // what unless the creator deliberately opts into anonymity.
  const [isAnonymous, setIsAnonymous] = useState(false);
  // Off by default — once you've cast a vote it's locked in, matching how most
  // real-world polls (including Telegram's) work unless explicitly allowed.
  const [allowRevote, setAllowRevote] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  // Pre-fill from editingPoll whenever the modal opens for editing (or reset to a
  // blank form when opening fresh) — keyed on isOpen+editingPoll so this only runs
  // on actual open transitions, not every render.
  useEffect(() => {
    if (!isOpen) return;
    if (editingPoll) {
      setQuestion(editingPoll.question);
      setOptions(editingPoll.options.length >= 2 ? editingPoll.options : [...editingPoll.options, '']);
      setMultipleChoice(editingPoll.multipleChoice);
      setIsAnonymous(editingPoll.isAnonymous);
      setAllowRevote(editingPoll.allowRevote);
    } else {
      setQuestion('');
      setOptions(['', '']);
      setMultipleChoice(false);
      setIsAnonymous(false);
      setAllowRevote(false);
    }
    setIsCreating(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, editingPoll?.messageId]);

  if (!isOpen) return null;

  const reset = () => {
    setQuestion('');
    setOptions(['', '']);
    setMultipleChoice(false);
    setIsAnonymous(false);
    setAllowRevote(false);
    setIsCreating(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const validOptions = options.map((o) => o.trim()).filter(Boolean);
  const canCreate = question.trim().length > 0 && validOptions.length >= 2;

  const handleCreate = async () => {
    if (!canCreate || isCreating) return;
    setIsCreating(true);
    try {
      await onCreate(question.trim(), validOptions, multipleChoice, isAnonymous, allowRevote);
      reset();
      onClose();
    } catch (err) {
      console.error('[PollCreatorModal] Error creating poll:', err);
      setIsCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] bg-black/45 flex items-end md:items-center justify-center">
      <div
        className="w-full md:max-w-[480px] max-h-[86vh] rounded-t-[28px] md:rounded-[28px] overflow-hidden flex flex-col"
        style={{
          backgroundColor: 'var(--container-bg)',
          border: 'var(--apple-border-w) solid var(--apple-border-color)',
          boxShadow: 'var(--chin-shadow), 0 20px 60px rgba(0,0,0,0.3)',
        }}
      >
        {/* Header */}
        <div
          className="h-14 px-4 flex items-center justify-between flex-shrink-0"
          style={{ borderBottom: 'var(--apple-border-w) solid var(--apple-border-color)' }}
        >
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
            <h3 className="text-[17px] max-md:text-[19px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              {editingPoll ? 'Изменить опрос' : 'Новый опрос'}
            </h3>
          </div>
          <button onClick={handleClose} style={pillBtnStyle} title="Закрыть">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Question */}
          <div>
            <div className="text-[13px] max-md:text-[14px] mb-1.5" style={{ color: 'var(--text-muted)' }}>Вопрос</div>
            <input
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Например: Куда пойдём обедать?"
              className="text-[16px] max-md:text-[17px]"
              style={fieldStyle}
              maxLength={200}
            />
          </div>

          {/* Options */}
          <div>
            <div className="text-[13px] max-md:text-[14px] mb-1.5" style={{ color: 'var(--text-muted)' }}>Варианты ответа</div>
            <div className="space-y-2">
              {options.map((opt, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={opt}
                    onChange={(e) => setOptions((prev) => prev.map((o, i) => i === idx ? e.target.value : o))}
                    placeholder={`Вариант ${idx + 1}`}
                    className="text-[16px] max-md:text-[17px]"
                    style={fieldStyle}
                    maxLength={100}
                  />
                  {options.length > 2 && (
                    <button
                      onClick={() => setOptions((prev) => prev.filter((_, i) => i !== idx))}
                      style={{ ...pillBtnStyle, width: '32px', height: '32px', color: '#ef4444' }}
                      title="Удалить вариант"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {options.length < MAX_OPTIONS && (
              <button
                onClick={() => setOptions((prev) => [...prev, ''])}
                className="mt-2 flex items-center gap-1.5 text-[14px] max-md:text-[15px] font-medium"
                style={{ color: 'var(--accent-primary)' }}
              >
                <Plus className="w-4 h-4" /> Добавить вариант
              </button>
            )}
          </div>

          {/* Anonymous toggle */}
          <label className="flex items-center justify-between py-1 cursor-pointer">
            <span className="text-[15px] max-md:text-[17px]" style={{ color: 'var(--text-primary)' }}>Анонимный опрос</span>
            <Checkbox checked={isAnonymous} onChange={setIsAnonymous} />
          </label>

          {/* Multiple choice toggle */}
          <label className="flex items-center justify-between py-1 cursor-pointer">
            <span className="text-[15px] max-md:text-[17px]" style={{ color: 'var(--text-primary)' }}>Несколько вариантов ответа</span>
            <Checkbox checked={multipleChoice} onChange={setMultipleChoice} />
          </label>

          {/* Allow revote toggle */}
          <label className="flex items-center justify-between py-1 cursor-pointer">
            <span className="text-[15px] max-md:text-[17px]" style={{ color: 'var(--text-primary)' }}>Возможность менять голос</span>
            <Checkbox checked={allowRevote} onChange={setAllowRevote} />
          </label>
        </div>

        {/* Footer */}
        <div className="p-3 flex items-center gap-2 flex-shrink-0" style={{ borderTop: 'var(--apple-border-w) solid var(--apple-border-color)' }}>
          <button
            onClick={handleClose}
            className="flex-1 h-11 rounded-2xl text-[15px] max-md:text-[17px] font-medium transition-colors"
            style={{
              backgroundColor: 'var(--element-bg)',
              border: 'var(--apple-border-w) solid var(--apple-border-color)',
              boxShadow: 'var(--chin-shadow)',
              color: 'var(--text-primary)',
            }}
          >
            Отмена
          </button>
          <button
            onClick={handleCreate}
            disabled={!canCreate || isCreating}
            className="flex-1 h-11 rounded-2xl text-[15px] max-md:text-[17px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              backgroundColor: 'var(--apple-accent, #007aff)',
              border: '1px solid rgba(0,86,179,0.4)',
              boxShadow: 'var(--accent-shadow)',
              color: '#ffffff',
            }}
          >
            {isCreating ? (editingPoll ? 'Сохранение...' : 'Создание...') : (editingPoll ? 'Сохранить' : 'Создать опрос')}
          </button>
        </div>
      </div>
    </div>
  );
}
