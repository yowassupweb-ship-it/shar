import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { ThemeProvider } from '@/shared/theme/ThemeContext';
import { initTelemetry } from '@/shared/platform/telemetry';
import { applyChatPrefs } from '@/shared/settings/chatPrefs';
import { routes } from '@/app/routes';
import { startWhereAmI } from '@/features/core/whereAmI';
import '@/app/styles.css';
// Последним: правила живой сборки прода, которых не было в исходниках (см. комментарий в файле).
import '@/app/restored-live.css';

initTelemetry();
applyChatPrefs();
startWhereAmI(); // каждое окно сообщает «Ядру», что у человека на экране

const router = createBrowserRouter(routes);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <RouterProvider router={router} />
    </ThemeProvider>
  </StrictMode>,
);
