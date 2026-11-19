import { forwardRef } from 'react';
import { Atom, type LucideIcon, type LucideProps } from 'lucide-react';

const SRC = '/icons/nav-v2/core.png?v=8';

/**
 * Знак «Ядра» (агенты Шара) — объёмный атом, та же картинка, что на кнопке «Агент» в нижней панели.
 * Встаёт везде вместо значка lucide (те же size и className). Плитки с цветной подложкой (Ещё, Настройки, поиск,
 * нижнее меню) для него подложку не рисуют — см. isImageIcon: картинка сама и есть плитка.
 */
const CoreImage = forwardRef<SVGSVGElement, LucideProps>(function CoreIcon({ size = 24, className }, _ref) {
  // Атом круглый и светится по краям — в квадрате значка он кажется мельче линейных иконок. Рисуем крупнее,
  // а лишнее съедаем отрицательным полем: место в строке остаётся прежним, соседи не сдвигаются.
  const px = Number(size) || 24;
  const big = Math.round(px * (px <= 24 ? 1.3 : 1.12));
  const pull = (px - big) / 2;
  return <img className={className ? `nx-core-icon ${className}` : 'nx-core-icon'} src={SRC} alt="" aria-hidden="true" width={big} height={big} style={{ margin: pull }} draggable={false} />;
});

export const CoreIcon = CoreImage as unknown as LucideIcon;

/** Значок — картинка, а не линия: плитке не нужна цветная подложка, картинка встаёт во весь её размер. */
export const isImageIcon = (icon: unknown): boolean => icon === CoreIcon || IMAGE_ICONS.has(icon);

const IMAGE_ICONS = new Set<unknown>();

/** Объёмный значок инструмента из картинки (public/icons/tool-icons) — встаёт вместо lucide с теми же size и className. */
function imageIcon(src: string, name: string): LucideIcon {
  const Icon = forwardRef<SVGSVGElement, LucideProps>(function ToolImage({ size = 24, className }, _ref) {
    const px = Number(size) || 24;
    return <img className={className ? `nx-core-icon ${className}` : 'nx-core-icon'} src={src} alt="" aria-hidden="true" width={px} height={px} draggable={false} />;
  });
  Icon.displayName = name;
  const icon = Icon as unknown as LucideIcon;
  IMAGE_ICONS.add(icon);
  return icon;
}

const V = '?v=1';
export const SearchToolIcon = imageIcon(`/icons/tool-icons/search.png${V}`, 'SearchToolIcon');
export const UtmToolIcon = imageIcon(`/icons/tool-icons/utm-gen.png${V}`, 'UtmToolIcon');
export const LeadsToolIcon = imageIcon(`/icons/tool-icons/zayavki.png${V}`, 'LeadsToolIcon');
export const SocialToolIcon = imageIcon(`/icons/tool-icons/social.png${V}`, 'SocialToolIcon');
export const StudioToolIcon = imageIcon(`/icons/tool-icons/studio.png${V}`, 'StudioToolIcon');
export const GuideToolIcon = imageIcon(`/icons/tool-icons/instructions.png${V}`, 'GuideToolIcon');
export const AdminToolIcon = imageIcon(`/icons/tool-icons/admin.png${V}`, 'AdminToolIcon');

/** Мини-версия знака «Ядра» — линейный атом: пункты меню, мелкие кнопки и подписи, где объёмная картинка не к месту. */
export const CoreMini: LucideIcon = Atom;
