import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Univer (engine-render) раскладывает текст документа посимвольно и для каждого не-ASCII символа (вся кириллица)
 * ищет первую графему остатка строки через Intl.Segmenter — по вызову, а то и по два, на каждую букву при каждой
 * раскладке. Вызов дорогой: в русском документе это была главная статья расходов раскладки. Быстрый путь даёт тот
 * же ответ без Segmenter для обычных знаков (сверено с Segmenter на 300 000 случайных строк, включая эмодзи и
 * комбинируемые знаки); для остального Segmenter смотрит окно в 64 знака, а не весь хвост абзаца. Правка нужна и
 * воркеру раскладки (worker.plugins). Сборка падает, если Univer изменил этот код: правку тогда нужно пересмотреть
 * (может, её уже сделали в самом Univer).
 */
function univerGraphemeWindow(): Plugin {
  const target = /\/@univerjs\/engine-render\/lib\/es\/index\.js$/;
  const segmenterDecl = 'const segmenter = new Intl.Segmenter(void 0, { granularity: "grapheme" });';
  const original = 'return ((_it$next$value = segmenter.segment(text)[Symbol.iterator]().next().value) === null || _it$next$value === void 0 ? void 0 : _it$next$value.segment) ?? null;';
  const patched = [
    // Быстрый путь — ровно тот же ответ, что дал бы Segmenter: обычный знак (ASCII без \r, латиница,
    // кириллица, греческий, иврит без огласовок, типографика, ₽, №), за которым не идёт ничего, что
    // склеивается с ним в одну графему (комбинируемый знак, ZWJ/ZWNJ, селектор варианта, суррогатная пара).
    'const c0 = text.charCodeAt(0), c1 = text.charCodeAt(1);',
    'if (((c0 >= 0x20 && c0 < 0x7F) || (c0 >= 0xA0 && c0 <= 0x05FF && !(c0 >= 0x0300 && c0 <= 0x036F) && !(c0 >= 0x0483 && c0 <= 0x0489) && !(c0 >= 0x0591 && c0 <= 0x05C7))',
    '  || (c0 >= 0x2010 && c0 <= 0x205E) || (c0 >= 0x20A0 && c0 <= 0x20C0) || (c0 >= 0x2100 && c0 <= 0x214F))',
    '  && !(c1 >= 0xD800 && c1 <= 0xDFFF) && !(c1 >= 0xFE00 && c1 <= 0xFE0F) && c1 !== 0x200C && c1 !== 0x200D && !__sharMark.test(text[1])) return text[0];',
    'const head = text.length > 64 ? text.slice(0, 64) : text;',
    'const first = ((_it$next$value = segmenter.segment(head)[Symbol.iterator]().next().value) === null || _it$next$value === void 0 ? void 0 : _it$next$value.segment) ?? null;',
    'if (first !== null && head.length < text.length && first.length === head.length) return segmenter.segment(text)[Symbol.iterator]().next().value?.segment ?? null;',
    'return first;',
  ].join(' ');
  return {
    name: 'shar-univer-grapheme-window',
    transform(code, id) {
      if (!target.test(id.split('?')[0].replace(/\\/g, '/'))) return null;
      if (!code.includes(original) || !code.includes(segmenterDecl)) this.error('Univer engine-render: getFirstGrapheme изменился — пересмотрите правку univerGraphemeWindow в vite.config.ts');
      return { code: code.replace(segmenterDecl, `${segmenterDecl} const __sharMark = /\\p{M}/u;`).replace(original, patched), map: null };
    },
  };
}

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
    plugins: [react(), tailwindcss(), univerGraphemeWindow()],
    // Раскладка документа идёт в воркере (DocEditor, docsLayout.worker.ts): модульный формат, та же правка Univer.
    worker: { format: 'es', plugins: () => [univerGraphemeWindow()] },
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
