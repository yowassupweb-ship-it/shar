import type { AnchorHTMLAttributes, MouseEvent } from 'react';
import { navigate } from '@/shared/navigation/navigate';
import { paths } from '@/shared/navigation/routes';
import { useMail } from './api';

/**
 * Адрес почты в интерфейсе. Если у человека подключён ящик, нажатие открывает новое письмо в «Почте» Шара
 * (адрес уже в поле «Кому»), а не внешний почтовый клиент; без ящика — обычный mailto:.
 * Нажатие с Ctrl/⌘/Shift и средней кнопкой — как у ссылки: браузер сам решает.
 */
export function writeTo(email: string) {
  writeMail({ to: [email] });
}

/** Новое письмо с готовыми темой и текстом (например, ссылкой на материал) — адресата выберет человек. */
export function writeMail(draft: { to?: string[]; subject?: string; body?: string }) {
  useMail.setState({ pendingCompose: { ...draft, to: draft.to ?? [] } });
  navigate(paths.mail);
}

/** Подключён ли у человека ящик: только тогда «Отправить по почте» имеет смысл показывать. */
export const useMailConnected = () => useMail((s) => s.accounts.length > 0);

export function MailLink({ email, children, ...rest }: { email: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  const connected = useMail((s) => s.accounts.length > 0);
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    rest.onClick?.(e);
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    writeTo(email);
  };
  return <a {...rest} href={`mailto:${email}`} onClick={connected ? onClick : rest.onClick}>{children ?? email}</a>;
}
