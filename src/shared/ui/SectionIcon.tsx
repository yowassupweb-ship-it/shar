/**
 * Объёмная иконка раздела — та же картинка, что в нижнем меню
 * (public/icons/nav-v2). Действия, которые ведут в раздел или совпадают с
 * ним по смыслу («Написать» — Чаты, «Задача» — Задачи, «Почта» — Почта),
 * показываем этой же иконкой, чтобы она везде значила одно и то же.
 */
export type SectionIconName = 'chats' | 'todo' | 'calendar' | 'contacts' | 'files' | 'mail' | 'menu' | 'new' | 'uved' | 'izb';

export function SectionIcon({ name, size = 20 }: { name: SectionIconName; size?: number }) {
  return (
    <img
      className="nx-sicon"
      src={`/icons/nav-v2/${name}.png?v=6`}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable={false}
    />
  );
}
