/**
 * Значки панели редактора документов (public/icons/office-icons, SHAR, 30 шт.): линия 1,8, скругления как у набора Шара.
 * Сгенерировано из SVG; у «Цвета текста» и «Цвета маркера» полоска — цвет --swatch (выбранный цвет), иначе currentColor.
 */
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function make(body: string) {
  return function OfficeIcon({ size = 18, ...rest }: P) {
    return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...rest} dangerouslySetInnerHTML={{ __html: body }} />;
  };
}

export const OAlignCenter = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 5.1h17.6M6 9.7h12M3.2 14.3h17.6M6 18.9h12" /></g>`);
export const OAlignJustify = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 5.1h17.6M3.2 9.7h17.6M3.2 14.3h17.6M3.2 18.9h17.6" /></g>`);
export const OAlignLeft = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 5.1h17.6M3.2 9.7h12M3.2 14.3h17.6M3.2 18.9h12" /></g>`);
export const OAlignRight = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 5.1h17.6M8.8 9.7h12M3.2 14.3h17.6M8.8 18.9h12" /></g>`);
export const OBold = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6.4 4.2h6.05c3.22 0 4.94 1.64 4.94 3.91 0 1.97-1.42 3.62-4.48 3.62H6.4m6.35 0c3.6 0 5.52 1.49 5.52 4.03 0 2.56-1.96 4.04-5.45 4.04H6.4V4.2" stroke-width="2.45"/></g>`);
export const OBulletedList = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 5.6h10.6M10 12h10.6M10 18.4h10.6" /><circle cx="4.9" cy="5.6" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.9" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.9" cy="18.4" r="1.2" fill="currentColor" stroke="none"/></g>`);
export const OChecklist = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 5.6h10.6M10 12h10.6M10 18.4h10.6" /><path d="m2.65 5.6 1.35 1.4 2.7-3.05m-4.05 8.1 1.35 1.4 2.7-3.05m-4.05 8.1 1.35 1.4 2.7-3.05" stroke-width="1.65"/></g>`);
export const OChevronDown = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 9 7 7 7-7" stroke-width="2.25"/></g>`);
export const OClearFormat = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.55 5.15h13.6M10.95 5.15 7.7 18.8M4.55 18.8h6.25m3.55-5.45 5.6 5.6m0-5.6-5.6 5.6" /></g>`);
export const ODecreaseIndent = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.3 4.7h17.4M10.2 9.55h10.5M10.2 14.45h10.5M3.3 19.3h17.4" /><path d="m6.65 9.15-3 2.85 3 2.85" /></g>`);
export const OEmoji = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.9"/><circle cx="8.85" cy="9.55" r="0.98" fill="currentColor" stroke="none"/><circle cx="15.15" cy="9.55" r="0.98" fill="currentColor" stroke="none"/><path d="M7.9 14.05c.93 1.65 2.28 2.54 4.1 2.54s3.17-.89 4.1-2.54" /></g>`);
export const OFontSizeMinus = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5.2 12h13.6" /></g>`);
export const OFontSizePlus = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5.2 12h13.6M12 5.2v13.6" /></g>`);
export const OHighlightColor = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m14.1 3.1 5.25 5.25-8.4 8.4-4.57-.6-.64-4.6ZM6.38 16.15l-1.52 1.3H2.87l2.98-3.28M12.3 4.95l5.25 5.25" /><rect x="2.8" y="19.5" width="18.4" height="2.7" rx="1.15" fill="var(--swatch, currentColor)" class="swatch" stroke="none"/></g>`);
export const OIncreaseIndent = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.3 4.7h17.4M10.2 9.55h10.5M10.2 14.45h10.5M3.3 19.3h17.4" /><path d="m3.55 9.15 3 2.85-3 2.85" /></g>`);
export const OInsertImage = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13.95 4.3H6.1c-2.05 0-3.05 1.05-3.05 3.05v9.55c0 2.05 1.02 3.1 3.05 3.1h11.8c2.03 0 3.05-1.05 3.05-3.1v-6.25M4.05 18.75l4.74-4.85c.68-.7 1.17-.72 1.88 0l1.36 1.4 2.6-2.7c.76-.78 1.23-.77 2.02.03l4.08 4.18M18.85 2.55v5.8m-2.9-2.9h5.8" /><circle cx="8.3" cy="8.85" r="1.35" fill="currentColor" stroke="none"/></g>`);
export const OInsertLink = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m10.1 8.25 2.8-2.8a4.15 4.15 0 0 1 5.87 5.87l-2.8 2.8M13.9 15.75l-2.8 2.8a4.15 4.15 0 1 1-5.87-5.87l2.8-2.8M8.95 15.05l6.1-6.1" /></g>`);
export const OItalic = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.65 4.15h7.6M5.75 19.85h7.6M14.45 4.15l-4.9 15.7" /></g>`);
export const OLineSpacing = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5.35 3.65v16.7M2.7 6.5l2.65-2.85L8 6.5M2.7 17.5l2.65 2.85L8 17.5M11.5 5.5h9.6M11.5 12h9.6M11.5 18.5h9.6" /></g>`);
export const ONumberedList = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 5.6h10.6M10 12h10.6M10 18.4h10.6" /><path d="m3.8 4.5 1.4-1.03v4.15M3.63 10.98c.24-.63.75-.97 1.48-.97.92 0 1.45.58 1.45 1.32 0 .55-.32.96-.94 1.5l-1.88 1.64h2.97M3.7 17.24c.42-.43.86-.58 1.5-.58.87 0 1.37.4 1.37 1.04 0 .62-.53 1.04-1.4 1.04.99 0 1.57.39 1.57 1.11 0 .74-.64 1.2-1.59 1.2-.67 0-1.17-.17-1.6-.58" stroke-width="1.25"/></g>`);
export const OPaintFormat = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.95" y="3.15" width="14.4" height="6.15" rx="1.9"/><path d="M17.4 6.2h1.25c1.45 0 2.1.71 2.1 2.05v2.2c0 1.08-.6 1.73-1.7 1.95l-6.9 1.3c-.79.16-1.15.6-1.15 1.4v.6" /><rect x="9.25" y="15.7" width="3.5" height="5.25" rx="1.25"/></g>`);
export const OPrint = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6.9 8.4V4.7c0-.86.47-1.4 1.35-1.4h7.5c.88 0 1.35.54 1.35 1.4v3.7M6.6 17.2H4.9c-1.32 0-2.1-.77-2.1-2.1v-4.35c0-1.5.9-2.35 2.4-2.35h13.6c1.5 0 2.4.85 2.4 2.35v4.35c0 1.33-.78 2.1-2.1 2.1h-1.7" /><rect x="6.6" y="14.4" width="10.8" height="6.3" rx="1.1"/><circle cx="17.85" cy="11.5" r="0.82" fill="currentColor" stroke="none"/></g>`);
export const ORedo = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><g transform="translate(24 0) scale(-1 1)"><path d="M8.3 4.9 3.7 9.4l4.6 4.45M4.2 9.4h9.7c3.8 0 6.1 1.95 6.1 5.07s-2.28 5.08-5.85 5.08h-4.1" /></g></g>`);
export const OSpecialCharacter = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.45 16.85v2.75h6.2v-2.38c-2.9-1.44-4.55-3.62-4.55-6.48 0-3.77 2.98-6.65 6.9-6.65s6.9 2.88 6.9 6.65c0 2.86-1.65 5.04-4.55 6.48v2.38h6.2v-2.75" /></g>`);
export const OStrikethrough = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.55 6.15c-1.2-1.48-2.98-2.16-5.15-2.16-3.13 0-5.35 1.62-5.35 3.92 0 1.42.75 2.41 2.12 3.07m5.16 2.05c1.97.67 3.05 1.69 3.05 3.27 0 2.23-2.13 3.78-5.45 3.78-2.2 0-4.38-.82-5.68-2.28M3.4 12h17.2" /></g>`);
export const OSubscript = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3.7 8.9 8.1 9.15m0-9.15-8.1 9.15" /><path d="M14.5 15.95c.18-1.17 1.02-1.85 2.23-1.85 1.31 0 2.17.8 2.17 1.96 0 .81-.39 1.46-1.4 2.33l-3.06 2.63h4.83" stroke-width="1.55"/></g>`);
export const OSuperscript = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3.7 8.9 8.1 9.15m0-9.15-8.1 9.15" /><path d="M14.5 4.7c.18-1.17 1.02-1.85 2.23-1.85 1.31 0 2.17.8 2.17 1.96 0 .81-.39 1.46-1.4 2.33l-3.06 2.63h4.83" stroke-width="1.55"/></g>`);
export const OTextColor = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5.9 15.7 5.55-12.5q.55-1.15 1.1 0l5.55 12.5M8 11.4h8" /><rect x="2.8" y="19.5" width="18.4" height="2.7" rx="1.15" fill="var(--swatch, currentColor)" class="swatch" stroke="none"/></g>`);
export const OUnderline = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6.4 3.8v6.7c0 3.54 2.21 5.77 5.6 5.77s5.6-2.23 5.6-5.77V3.8M4.35 20.15h15.3" /></g>`);
export const OUndo = make(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8.3 4.9 3.7 9.4l4.6 4.45M4.2 9.4h9.7c3.8 0 6.1 1.95 6.1 5.07s-2.28 5.08-5.85 5.08h-4.1" /></g>`);

// ── Значки панели таблиц — в том же стиле (линия 1,8, сетка 24, скругления), порядок кнопок как у Google Таблиц. ──
const g = (d: string, extra = '') => `<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${d}" />${extra}</g>`;
export const OCurrency = make(g('M8.5 20V4.5h5.25a4.1 4.1 0 0 1 0 8.2H5.5M5.5 16.4h8.5'));
export const OPercent = make(g('M18.6 5.4 5.4 18.6', '<circle cx="7.3" cy="7.3" r="2.3"/><circle cx="16.7" cy="16.7" r="2.3"/>'));
export const OBorders = make(g('M12 4.2v15.6M4.2 12h15.6', '<rect x="4.2" y="4.2" width="15.6" height="15.6" rx="2"/>'));
export const OMerge = make(g('M3.6 5v14M20.4 5v14M6.6 12h4m-2.2-2.6L11 12l-2.6 2.6M17.4 12h-4m2.2-2.6L13 12l2.6 2.6'));
export const OVAlignTop = make(g('M4.5 4.2h15M12 8.2v11.6M8.4 11.6 12 8l3.6 3.6'));
export const OVAlignMiddle = make(g('M4.5 12h15M12 3.4v5.4M9.3 6.4 12 9l2.7-2.6M12 20.6v-5.4M9.3 17.6 12 15l2.7 2.6'));
export const OVAlignBottom = make(g('M4.5 19.8h15M12 4.2v11.6M8.4 12.4 12 16l3.6-3.6'));
export const OWrap = make(g('M4 5.6h16M4 12h12.6a3.2 3.2 0 0 1 0 6.4H12.4m2.2-2.4-2.4 2.4 2.4 2.4M4 18.4h5'));
export const ORotate = make(g('M4.2 19.8h7M6 15.6l4.6-11.2 4.6 11.2M7.6 11.8h6M18.6 19.6V8.4m-2.6 2.6 2.6-2.6 2.6 2.6'));
export const OComment = make(g('M5.6 4.4h12.8a1.8 1.8 0 0 1 1.8 1.8v9.2a1.8 1.8 0 0 1-1.8 1.8H9.4l-4.4 3.4V6.2a1.8 1.8 0 0 1 1.8-1.8ZM12 7.8v6M9 10.8h6'));
export const OChart = make(g('M8 16.4v-4.2M12 16.4V7.6M16 16.4v-6', '<rect x="3.6" y="3.6" width="16.8" height="16.8" rx="2.4"/>'));
export const OFilter = make(g('M4 6h16M7 12h10M10.4 18h3.2'));
export const OFunctions = make(g('M17.4 5H6.6l6 7-6 7h10.8'));
export const OMoreVertical = make(`<g fill="currentColor"><circle cx="12" cy="5.4" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="18.6" r="1.7"/></g>`);
export const OFillColor = make(g('M4.7 10.1 10 4.8l6.1 6.1-5.4 5.4a1.5 1.5 0 0 1-2.1 0l-3.9-3.9a1.5 1.5 0 0 1 0-2.3ZM8 2.6l2.2 2M4.9 10.9h11.1M19.2 12.4s1.6 1.9 1.6 2.9a1.6 1.6 0 0 1-3.2 0c0-1 1.6-2.9 1.6-2.9Z', '<rect x="2.8" y="19.5" width="18.4" height="2.7" rx="1.15" fill="var(--swatch, currentColor)" class="swatch" stroke="none"/>'));
export const ODecimalDecrease = make(g('M20 19.4h-7m2.2-2.2L13 19.4l2.2 2.2', '<circle cx="4.4" cy="13.4" r="1.25" fill="currentColor" stroke="none"/><ellipse cx="10" cy="9.6" rx="2.7" ry="3.9"/>'));
export const ODecimalIncrease = make(g('M12.6 19.4h7.4m-2.2-2.2 2.2 2.2-2.2 2.2', '<circle cx="3.6" cy="13.4" r="1.25" fill="currentColor" stroke="none"/><ellipse cx="8.6" cy="9.6" rx="2.5" ry="3.9"/><ellipse cx="15.6" cy="9.6" rx="2.5" ry="3.9"/>'));
