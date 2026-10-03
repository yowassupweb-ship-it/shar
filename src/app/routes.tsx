import { lazy } from 'react';
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
const GuideScreen = lazy(() => import('@/features/guide/GuideScreen'));

export const routes: RouteObject[] = [
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
          { path: paths.guide, element: <GuideScreen /> },
          // Вход показывает корень, пока сессии нет; вошедшего — в чаты.
          { path: paths.login, element: <Navigate to={paths.chats} replace /> },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
];
