import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { ThemeProvider } from '@/shared/theme/ThemeContext';
import { initTelemetry } from '@/shared/platform/telemetry';
import { applyChatPrefs } from '@/shared/settings/chatPrefs';
import { routes } from '@/app/routes';
import '@/app/styles.css';

initTelemetry();
applyChatPrefs();

const router = createBrowserRouter(routes);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <RouterProvider router={router} />
    </ThemeProvider>
  </StrictMode>,
);
