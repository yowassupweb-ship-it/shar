import appleEmojiData from '@/shared/emoji/data/appleEmojiData.json';
import appleEmojiCharMap from '@/shared/emoji/data/appleEmojiCharMap.json';

const CHAR_MAP: Record<string, string> = appleEmojiCharMap;
const EMOJI_FILES: Record<string, string> = appleEmojiData.emojis;
const BASE_URL = appleEmojiData.baseUrl; // '/emojis/apple/' — self-hosted, not a CDN

/** Apple-style emoji image URL for a literal emoji character. Self-hosted (see
 * public/emojis/apple/, generated from react-apple-emojis' data set) — not a CDN, so this
 * has no external-network dependency or rate limit. Falls back to a first-codepoint lookup
 * for characters not in the direct map (e.g. an unexpected variation-selector combo), and
 * finally to an empty string if truly unknown — callers should keep the plain character as
 * a fallback `alt`/text when this returns ''. */
export function getAppleEmojiUrl(emoji: string): string {
  const name = CHAR_MAP[emoji];
  if (name && EMOJI_FILES[name]) {
    return `${BASE_URL}${EMOJI_FILES[name]}`;
  }
  // Retry without variation selectors / joiners the direct map might not have this exact
  // combination of (e.g. ZWJ sequences with a skin-tone modifier not individually indexed).
  const stripped = Array.from(emoji)
    .filter(ch => {
      const cp = ch.codePointAt(0) || 0;
      return cp !== 0xfe0f && cp !== 0x200d;
    })
    .join('');
  const strippedName = CHAR_MAP[stripped];
  if (strippedName && EMOJI_FILES[strippedName]) {
    return `${BASE_URL}${EMOJI_FILES[strippedName]}`;
  }
  return '';
}
