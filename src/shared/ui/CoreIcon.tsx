import { createLucideIcon } from 'lucide-react';

/**
 * Знак «Ядра» (агенты Шара): шестигранная оболочка и заполненное ядро в центре. Свой, чтобы не путать с атомом
 * в логотипе Шара. Собран как значок lucide — принимает size, strokeWidth и className, встаёт везде вместо Atom.
 */
export const CoreIcon = createLucideIcon('shar-core', [
  ['path', { d: 'M12 2.6 20.2 7.3v9.4L12 21.4l-8.2-4.7V7.3Z', key: 'shell' }],
  ['circle', { cx: '12', cy: '12', r: '3.4', fill: 'currentColor', key: 'core' }],
]);
