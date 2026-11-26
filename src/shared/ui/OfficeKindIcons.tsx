import type { SVGProps } from 'react';

/**
 * Значки видов «Офиса» (набор владельца, E:\Projects\shar-2\office-icons): все материалы, документы, заметки,
 * слайды, таблицы. Линия 1,75, скругления — как у контурных значков Шара; цвет — currentColor. Подставляются туда же,
 * где раньше стояли значки lucide (KINDS[вид].icon): те же свойства size / className / style.
 */

export type KindIconProps = SVGProps<SVGSVGElement> & { size?: number | string };

function Svg({ size = 24, children, ...rest }: KindIconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      {children}
    </svg>
  );
}

export const OfficeAllIcon = (p: KindIconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="6.25" height="6.25" rx="1.35" /><rect x="14.25" y="3.5" width="6.25" height="6.25" rx="1.35" />
    <rect x="3.5" y="14.25" width="6.25" height="6.25" rx="1.35" /><rect x="14.25" y="14.25" width="6.25" height="6.25" rx="1.35" />
  </Svg>
);

export const OfficeDocumentIcon = (p: KindIconProps) => (
  <Svg {...p}>
    <path d="M18.25 7.5 13.8 3.05a1.1 1.1 0 0 0-.78-.32H6.15A2.15 2.15 0 0 0 4 4.88v14.24a2.15 2.15 0 0 0 2.15 2.15H16a2.25 2.25 0 0 0 2.25-2.25v-.31" />
    <path d="M13 2.75V6a1.5 1.5 0 0 0 1.5 1.5h3.75M7.75 10.75h4.75m-4.75 4h1.5" />
    <path d="m11.6 17.65.6-2.85 5.17-5.17a1.7 1.7 0 0 1 2.4 2.4l-5.17 5.17-3 .45Z" />
  </Svg>
);

export const OfficeNoteIcon = (p: KindIconProps) => (
  <Svg {...p}>
    <rect x="4.75" y="4" width="14.5" height="16.75" rx="2.25" />
    <path d="M4.75 8.5h14.5M8.75 2.75v2.5m6.5-2.5v2.5" />
    <path d="M8.5 12.75h7m-7 4h4.25" />
  </Svg>
);

export const OfficeSlidesIcon = (p: KindIconProps) => (
  <Svg {...p}>
    <path d="M2.75 4.5h18.5M4 4.5V14a2.25 2.25 0 0 0 2.25 2.25h11.5A2.25 2.25 0 0 0 20 14V4.5M12 16.25v1.5m-3.75 3.5L12 17.75l3.75 3.5" />
  </Svg>
);

export const OfficeTableIcon = (p: KindIconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2.25" />
    <path d="M3 9.25h18M3 14.625h18M9.75 9.25V20" />
  </Svg>
);
