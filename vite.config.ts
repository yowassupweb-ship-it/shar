import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Шар — SPA (корень) + свой сервис API (server/, порт 8100).
 *
 * В dev Vite проксирует /api/* (и сокет /api/ws) на SHAR_API_TARGET
 * (по умолчанию http://localhost:8100). Картинки эмодзи лежат в public/emojis.
 * В проде приложение живёт на одном домене с /api — прокси не нужен.
 */
export default defineConfig(({ mode }) => {
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), 'SHAR_') };
  const apiTarget = env.SHAR_API_TARGET || 'http://localhost:8100';

  const http = (target: string): ProxyOptions => ({
    target,
    changeOrigin: true,
    secure: true,
    // Кука сессии, выданная удалённым хостом, должна лечь на localhost.
    cookieDomainRewrite: '',
  });
  const proxy = {
    '/api': {
      ...http(apiTarget),
      ws: true,
      // The browser connects to Vite's origin in development, while the API
      // validates WebSocket Origin against the proxied Host header. Keep both
      // headers on the API target so the same-origin check remains meaningful.
      rewriteWsOrigin: true,
    },
  };

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      port: Number(env.SHAR_PORT) || 3005,
      host: true,
      proxy,
    },
    preview: { proxy },
    build: {
      target: 'es2022',
      sourcemap: true,
      // Код приложения меняется каждый выкат, библиотеки и словари эмодзи —
      // редко: отдельные чанки остаются в кэше браузера между выкатами.
      // emoji-data (~700 КБ, 98 КБ gzip) — словари Apple-эмодзи; лимит чуть выше.
      chunkSizeWarningLimit: 800,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('/src/shared/emoji/')) return 'emoji-data';
            if (/node_modules\/(react|react-dom|react-router|scheduler|zustand)\//.test(id)) return 'vendor-react';
            if (/node_modules\/(react-markdown|remark-|mdast-|micromark|unified|hast-|unist-|vfile|property-information|decode-named|character-|space-separated|comma-separated|html-url|trim-lines|devlop|bail|ccount|escape-string|markdown-table|zwitch|longest-streak|is-plain-obj|trough|estree-util|style-to)/.test(id)) return 'vendor-markdown';
            if (id.includes('node_modules/lucide-react')) return 'vendor-icons';
            return undefined;
          },
        },
      },
    },
  };
});
