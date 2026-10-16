// Локальный сервер встроенного клиента: раздаёт dist/ со SPA-fallback и проксирует
// /api (HTTP + WebSocket) на удалённый бэкенд. Только модули Node.
// Окружение: PORT, HOSTNAME, BACKEND_URL.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');

const PORT = Number(process.env.PORT || 47821);
const HOST = process.env.HOSTNAME || '127.0.0.1';
const BACKEND = new URL(process.env.BACKEND_URL || 'https://vokrug-sveta.shar-os.ru');
const ROOT = path.join(__dirname, 'dist');
// Картинки эмодзи в установщик не входят — их отдаёт боевой сервер (кэш на год, качаются один раз).
// Отдельный адрес: у бета-канала и тестовых стендов бэкенд свой, а эмодзи всё равно на проде.
const EMOJI_ORIGIN = process.env.EMOJI_URL || 'https://vokrug-sveta.shar-os.ru';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json',
  '.webmanifest': 'application/manifest+json', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

const client = BACKEND.protocol === 'https:' ? https : http;

// Файлы (/api/uploads/…) бэкенд отдаёт редиректом на объектное хранилище, а у его бакета CORS открыт только
// для боевого сайта: fetch() с http://127.0.0.1:PORT (просмотр HTML/таблиц/PDF) падал бы «Failed to fetch».
// Поэтому редирект на другой хост проходим здесь, на сервере, и отдаём файл со своего origin.
function followRedirect(location, res, hops) {
  let target;
  try { target = new URL(location); } catch { return false; }
  if (!/^https?:$/.test(target.protocol) || hops > 3) return false;
  const lib = target.protocol === 'https:' ? https : http;
  const out = lib.get(target, { headers: { 'accept-encoding': 'identity' } }, (up) => {
    if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location) {
      up.resume();
      if (!followRedirect(new URL(up.headers.location, target).href, res, hops + 1)) { res.writeHead(502); res.end('Bad gateway'); }
      return;
    }
    const headers = {};
    for (const k of ['content-type', 'content-length', 'content-disposition', 'last-modified', 'etag', 'cache-control']) if (up.headers[k]) headers[k] = up.headers[k];
    res.writeHead(up.statusCode || 502, headers);
    up.pipe(res);
  });
  out.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Bad gateway'); });
  return true;
}

function proxy(req, res) {
  const headers = { ...req.headers, host: BACKEND.host };
  delete headers.origin;
  const upstream = client.request({
    protocol: BACKEND.protocol, hostname: BACKEND.hostname, port: BACKEND.port || undefined,
    method: req.method, path: req.url, headers,
  }, (up) => {
    const location = up.headers.location;
    if (req.method === 'GET' && location && up.statusCode >= 300 && up.statusCode < 400 && req.url.startsWith('/api/uploads/')) {
      const abs = new URL(location, BACKEND).href;
      if (new URL(abs).host !== BACKEND.host) { up.resume(); if (followRedirect(abs, res, 0)) return; }
    }
    // Куку сессии бэкенд ставит с Secure; на http://127.0.0.1 браузер её бы отверг.
    const out = { ...up.headers };
    if (out['set-cookie']) out['set-cookie'] = [].concat(out['set-cookie']).map((c) => c.replace(/;\s*secure/ig, '').replace(/;\s*domain=[^;]+/ig, ''));
    res.writeHead(up.statusCode || 502, out);
    up.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Bad gateway'); });
  req.pipe(upstream);
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, 'index.html'); // SPA
  const ext = path.extname(file).toLowerCase();
  const immutable = /[\\/]assets[\\/]/.test(file);
  res.writeHead(200, {
    'content-type': TYPES[ext] || 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return proxy(req, res);
  if (req.url.startsWith('/emojis/') && req.method === 'GET') {
    // Без этого запрос попадал в SPA-fallback и получал index.html — эмодзи были «битыми картинками».
    if (!followRedirect(new URL(req.url, EMOJI_ORIGIN).href, res, 0)) { res.writeHead(502); res.end('Bad gateway'); }
    return undefined;
  }
  return serveStatic(req, res);
});

// WebSocket: пробрасываем рукопожатие и дальше гоним байты в обе стороны.
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/api/')) return socket.destroy();
  const port = Number(BACKEND.port || (BACKEND.protocol === 'https:' ? 443 : 80));
  const upstream = BACKEND.protocol === 'https:' ? tls.connect({ host: BACKEND.hostname, port, servername: BACKEND.hostname }) : net.connect(port, BACKEND.hostname);
  upstream.on('connect', start); upstream.on('secureConnect', start);
  let started = false;
  function start() {
    if (started) return; started = true;
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries({ ...req.headers, host: BACKEND.host, origin: BACKEND.origin })) lines.push(`${k}: ${v}`);
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream); upstream.pipe(socket);
  }
  const close = () => { socket.destroy(); upstream.destroy(); };
  upstream.on('error', close); socket.on('error', close); socket.on('close', close); upstream.on('close', close);
});

server.listen(PORT, HOST, () => console.log(`Shar web on http://${HOST}:${PORT} → ${BACKEND.origin}`));
