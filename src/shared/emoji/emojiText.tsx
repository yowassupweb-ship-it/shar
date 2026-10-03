import React from 'react';
import { getAppleEmojiUrl } from '@/shared/emoji/appleEmoji';

// Replaces emoji character runs within arbitrary text with Twemoji images, so
// wherever message text is shown (bubbles, chat list previews, reaction tooltips)
// it looks the same as what the emoji picker shows — native OS emoji fonts differ
// enough between platforms (Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji)
// that the same character looked like a visually different emoji depending on
// where in the app it rendered.
//
// \p{Emoji_Component} is deliberately NOT used as a standalone match target: that
// Unicode property also covers the plain ASCII digits 0-9 and #, * (they're only
// emoji as part of a keycap sequence, digit+️?+⃣), so matching them bare
// turned a plain "5" in message text into a broken-image Twemoji lookup. Keycap
// sequences are their own explicit alternative requiring the real combining
// enclosing-keycap character.
export const EMOJI_RUN_REGEX = /\p{Regional_Indicator}{2}|[0-9#*]️?⃣|\p{Extended_Pictographic}️?(?:‍\p{Extended_Pictographic}️?)*/gu;

export function renderTextWithEmoji(text: string, keyPrefix: string, size = '1.15em'): React.ReactNode {
  if (!text) return text;
  EMOJI_RUN_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  let idx = 0;
  const parts: React.ReactNode[] = [];
  while ((match = EMOJI_RUN_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const emoji = match[0];
    const url = getAppleEmojiUrl(emoji);
    parts.push(
      url ? (
        <img
          key={`${keyPrefix}-em${idx++}`}
          src={url}
          alt={emoji}
          draggable={false}
          style={{ height: size, width: size, verticalAlign: '-0.2em', objectFit: 'contain', display: 'inline-block' }}
        />
      ) : (
        <React.Fragment key={`${keyPrefix}-em${idx++}`}>{emoji}</React.Fragment>
      )
    );
    lastIndex = match.index + emoji.length;
  }
  if (parts.length === 0) return text;
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}
