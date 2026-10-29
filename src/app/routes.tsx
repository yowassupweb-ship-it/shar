import { lazy, Suspense } from 'react';
import { Navigate, type RouteObject } from 'react-router';
import { paths } from '@/shared/navigation/routes';
import ChatsScreen from '@/features/chat/ChatsScreen';
import AppRoot from './AppRoot';
import NotFound from './NotFound';
import RouteError from './RouteError';

/**
 * Маршруты Шара v2. Чаты — стартовый раздел, их код в основном бандле;
 * остальные разделы грузятся при первом переходе.
 * Новый раздел: маршрут здесь + пункт в shell/sections.ts.
 */

const TasksScreen = lazy(() => import('@/features/tasks/TasksScreen'));
const CalendarScreen = lazy(() => import('@/features/calendar/CalendarScreen'));
const ContactsScreen = lazy(() => import('@/features/contacts/ContactsScreen'));
const FilesScreen = lazy(() => import('@/features/files/FilesScreen'));
const MailScreen = lazy(() => import('@/features/mail/MailScreen'));
const MoreScreen = lazy(() => import('@/features/more/MoreScreen'));
const SettingsScreen = lazy(() => import('@/features/settings/SettingsScreen'));
const AdminScreen = lazy(() => import('@/features/admin/AdminScreen'));
const UtmScreen = lazy(() => import('@/features/utm/UtmScreen'));
const LeadsScreen = lazy(() => import('@/features/leads/LeadsScreen'));
const SocialScreen = lazy(() => import('@/features/social/SocialScreen'));
const CoreScreen = lazy(() => import('@/features/core/CoreScreen'));
const GuideScreen = lazy(() => import('@/features/guide/GuideScreen'));
const OfficeScreen = lazy(() => import('@/features/workspace/OfficeScreen'));
const SharedPage = lazy(() => import('@/features/workspace/SharedPage'));
const StickyPage = lazy(() => import('@/features/workspace/StickyPage'));

export const routes: RouteObject[] = [
  // Материалы по ссылке открываются без входа — вне каркаса с проверкой сессии.
  ...['n', 'd', 't', 'p'].map((prefix): RouteObject => ({
    path: `/${prefix}/:token`,
    element: <Suspense fallback={null}><SharedPage /></Suspense>,
    errorElement: <RouteError />,
  })),
  // Заметка в отдельном окне на рабочем столе: без каркаса приложения, только сама заметка.
  { path: '/sticky/:id', element: <Suspense fallback={null}><StickyPage /></Suspense>, errorElement: <RouteError /> },
  {
    element: <AppRoot />,
    errorElement: <RouteError />,
    children: [
      {
        // Сбой раздела не роняет каркас: меню и соединение остаются.
        errorElement: <RouteError />,
        children: [
          { index: true, element: <Navigate to={paths.chats} replace /> },
          { path: paths.chats, element: <ChatsScreen /> },
          { path: paths.tasks, element: <TasksScreen /> },
          { path: paths.calendar, element: <CalendarScreen /> },
          { path: paths.contacts, element: <ContactsScreen /> },
          { path: paths.files, element: <FilesScreen /> },
          { path: paths.mail, element: <MailScreen /> },
          { path: paths.more, element: <MoreScreen /> },
          { path: paths.settings, element: <SettingsScreen /> },
          { path: paths.admin, element: <AdminScreen /> },
          { path: paths.utm, element: <UtmScreen /> },
          { path: paths.leads, element: <LeadsScreen /> },
          { path: paths.social, element: <SocialScreen /> },
          { path: paths.core, element: <CoreScreen /> },
          { path: paths.guide, element: <GuideScreen /> },
          { path: paths.office, element: <OfficeScreen /> },
          // Вход показывает корень, пока сессии нет; вошедшего — в чаты.
          { path: paths.login, element: <Navigate to={paths.chats} replace /> },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
];
