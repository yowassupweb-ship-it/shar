/**
 * Готовит web/ для установщика: сборка Vite (../dist) + маленький локальный сервер.
 *
 * Раньше сюда копировался standalone-сервер Next; теперь клиент — статическая
 * сборка, и серверу нужно только раздать её и проксировать /api (HTTP и сокет)
 * на бэкенд. Сервер — web/server.js, без зависимостей (только модули Node).
 */
const { cpSync, existsSync, mkdirSync, rmSync } = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const desktopDir = path.resolve(__dirname, '..');
const appDir = path.resolve(desktopDir, '..');
const outputDir = path.join(desktopDir, 'web');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const build = spawnSync(npm, ['run', 'build'], { cwd: appDir, stdio: 'inherit', shell: process.platform === 'win32' });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status || 1);

const dist = path.join(appDir, 'dist');
if (!existsSync(path.join(dist, 'index.html'))) throw new Error(`Vite build not found at ${dist}`);

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
// Картинки эмодзи (~26 МБ) в установщик не кладём: их отдаёт прод-сервер, а локальный
// сервер проксирует /emojis туда же (см. server.js).
cpSync(dist, path.join(outputDir, 'dist'), { recursive: true, filter: (src) => !src.includes(`${path.sep}emojis${path.sep}`) });
cpSync(path.join(__dirname, 'web-server.cjs'), path.join(outputDir, 'server.js'));

console.log(`Electron web prepared at ${outputDir}`);
