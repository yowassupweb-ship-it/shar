import { forwardRef } from 'react';
import type { LucideIcon, LucideProps } from 'lucide-react';

const SRC = '/icons/nav-v2/core.png?v=8';

/**
 * Знак «Ядра» (агенты Шара) — объёмный атом, та же картинка, что на кнопке «Агент» в нижней панели.
 * Встаёт везде вместо значка lucide (те же size и className). Плитки с цветной подложкой (Ещё, Настройки, поиск,
 * нижнее меню) для него подложку не рисуют — см. isImageIcon: картинка сама и есть плитка.
 */
const CoreImage = forwardRef<SVGSVGElement, LucideProps>(function CoreIcon({ size = 24, className }, _ref) {
  return <img className={className ? `nx-core-icon ${className}` : 'nx-core-icon'} src={SRC} alt="" aria-hidden="true" width={size} height={size} draggable={false} />;
});

export const CoreIcon = CoreImage as unknown as LucideIcon;

/** Значок — картинка, а не линия: плитке не нужна цветная подложка, картинка встаёт во весь её размер. */
export const isImageIcon = (icon: unknown): boolean => icon === CoreIcon;
