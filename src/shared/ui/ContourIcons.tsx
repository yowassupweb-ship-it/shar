import type { SVGProps } from 'react';

/**
 * Контурные значки Шара (public/icons/conture-icons): та же линия 1,8 и скругления, что у остального набора,
 * но свои — для шапки «Файлов» (фильтр, сортировка, плитки/список, новая папка, загрузка). Цвет — currentColor.
 */

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 20, children, ...rest }: P) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...rest}>
      <g fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">{children}</g>
    </svg>
  );
}

export const CFilter = (p: P) => <Svg {...p}><path d="M3.9 4.5h16.2c.7 0 1.05.8.59 1.34l-6.83 7.81v5.45c0 .58-.62.93-1.12.64l-2.6-1.51v-4.58L3.31 5.84c-.46-.54-.11-1.34.59-1.34Z" /></Svg>;
export const CChevronDown = (p: P) => <Svg {...p}><path d="m5 9 7 7 7-7" strokeWidth={2.25} /></Svg>;
export const CSort = (p: P) => <Svg {...p}><path d="M7.7 19.4V4.4m-3.85 3.9 3.85-3.9 3.85 3.9M16.3 4.6v15m-3.85-3.9 3.85 3.9 3.85-3.9" /></Svg>;
export const CGrid = (p: P) => (
  <Svg {...p}>
    <rect x="3.8" y="3.8" width="6.8" height="6.8" rx="1.65" /><rect x="13.4" y="3.8" width="6.8" height="6.8" rx="1.65" />
    <rect x="3.8" y="13.4" width="6.8" height="6.8" rx="1.65" /><rect x="13.4" y="13.4" width="6.8" height="6.8" rx="1.65" />
  </Svg>
);
export const CList = (p: P) => (
  <Svg {...p}>
    <path d="M8.5 5.8h11.7M8.5 12h11.7M8.5 18.2h11.7" />
    <circle cx="4.15" cy="5.8" r="1.14" fill="currentColor" stroke="none" /><circle cx="4.15" cy="12" r="1.14" fill="currentColor" stroke="none" />
    <circle cx="4.15" cy="18.2" r="1.14" fill="currentColor" stroke="none" />
  </Svg>
);
export const CFolderPlus = (p: P) => (
  <Svg {...p}>
    <path d="M2.65 7.05c0-1.45.93-2.4 2.38-2.4h4.03c.72 0 1.14.22 1.67.8l1.31 1.42h6.98c1.46 0 2.33.92 2.33 2.35v8.04c0 1.44-.9 2.34-2.35 2.34H5c-1.45 0-2.35-.9-2.35-2.34Z" />
    <path d="M12.1 10.4v6m-3-3h6" />
  </Svg>
);
export const CUpload = (p: P) => <Svg {...p}><path d="M12 15.05V3.35m-4.1 4.2L12 3.35l4.1 4.2M3.6 14.2v3.15c0 1.99 1.05 3.05 3.03 3.05h10.74c1.98 0 3.03-1.06 3.03-3.05V14.2" /></Svg>;
