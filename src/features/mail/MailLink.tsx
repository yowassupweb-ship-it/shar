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
  useMail.setState({ pendingCompose: [email] });
  navigate(paths.mail);
}

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
