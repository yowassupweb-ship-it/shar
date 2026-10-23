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
    // changeOrigin меняет только Host, а Origin остаётся локальным (http://127.0.0.1:3005). Сервер сверяет
    // Origin сокета с хостом и закрывает чужой кодом 1008 — dev-окно против прода молча оставалось без
    // событий: ни новых сообщений в открытом чате, ни «прочитано». Как локальный сервер Shar OS
    // (desktop/scripts/web-server.cjs), выдаём себя за сам сервер.
    configure: (proxy) => {
      const origin = new URL(target).origin;
      proxy.on('proxyReqWs', (proxyReq) => { proxyReq.setHeader('origin', origin); });
      proxy.on('proxyReq', (proxyReq) => { if (proxyReq.getHeader('origin')) proxyReq.setHeader('origin', origin); });
    },
  });
  const proxy = { '/api': { ...http(apiTarget), ws: true } };

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
          // Воркер pdf.js лежит в пакете как .mjs, а сервера (nginx, локальный сервер приложения) отдают
          // .mjs как application/octet-stream — браузер отказывается его грузить («fake worker failed»).
          // Кладём его под именем .js; заодно у адреса нет записи в кэше со старым неверным типом.
          assetFileNames: (asset) => (asset.names?.some((name) => name.endsWith('.mjs')) ? 'assets/[name]-[hash].js' : 'assets/[name]-[hash][extname]'),
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
