import { Navigate, useLocation, useNavigate } from 'react-router';
import { Compass } from 'lucide-react';
import { fromLegacyUrl, paths } from '@/shared/navigation/routes';
import './notfound.css';

/** Адрес не найден. Раньше любой неизвестный путь молча уводил в чаты — опечатка в ссылке выглядела как «ничего не произошло». */
export default function NotFound() {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  // Адреса старого приложения (/account?tab=…, /test-*-next) ведут в соответствующий раздел v2.
  const legacy = fromLegacyUrl(`${pathname}${search}`) ?? (pathname === '/account' ? paths.chats : null);
  if (legacy && legacy !== `${pathname}${search}`) return <Navigate to={legacy} replace />;
  return (
    <div className="nx-state nx-notfound" role="alert">
      <Compass size={32} aria-hidden="true" />
      <p className="nx-notfound-code">404</p>
      <h2>Такой страницы нет</h2>
      <p>Ссылка устарела или в адресе опечатка. Раздел мог переехать — загляните в «Ещё».</p>
      <div className="nx-dialog-actions" style={{ justifyContent: 'center', marginTop: 0 }}>
        <button type="button" className="nx-ghost" onClick={() => navigate(-1)}>Назад</button>
        <button type="button" className="nx-primary" onClick={() => navigate(paths.chats, { replace: true })}>В чаты</button>
      </div>
    </div>
  );
}
