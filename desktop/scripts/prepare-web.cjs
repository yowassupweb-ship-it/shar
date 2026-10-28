/**
 * Готовит web/ для установщика: сборка Vite (../dist) + маленький локальный сервер.
 *
 * Правило выпуска — одна сборка везде: в установщик кладётся ТОТ ЖЕ ../dist, что уходит на сервер, поэтому
 * по умолчанию сборка не пересобирается, а копируется (иначе у сайта и Shar OS разные index-*.js).
 * `--build` — сначала собрать ../dist (npm run build): для проверочной сборки, не для выпуска.
 *
 * Сервер — web/server.js, без зависимостей (только модули Node): раздаёт сборку и проксирует /api на бэкенд.
 */
const { cpSync, existsSync, mkdirSync, readFileSync, rmSync } = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const desktopDir = path.resolve(__dirname, '..');
const appDir = path.resolve(desktopDir, '..');
const outputDir = path.join(desktopDir, 'web');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (process.argv.includes('--build')) {
  const build = spawnSync(npm, ['run', 'build'], { cwd: appDir, stdio: 'inherit', shell: process.platform === 'win32' });
  if (build.error) throw build.error;
  if (build.status !== 0) process.exit(build.status || 1);
}

const dist = path.join(appDir, 'dist');
const index = path.join(dist, 'index.html');
if (!existsSync(index)) throw new Error(`Сборки нет: ${dist}. Соберите её (npm run build в корне) или запустите с --build.`);

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
// Картинки эмодзи (~26 МБ) в установщик не кладём: их отдаёт прод-сервер, а локальный
// сервер проксирует /emojis туда же (см. server.js).
cpSync(dist, path.join(outputDir, 'dist'), { recursive: true, filter: (src) => !src.includes(`${path.sep}emojis${path.sep}`) });
cpSync(path.join(__dirname, 'web-server.cjs'), path.join(outputDir, 'server.js'));

// Какая сборка внутри — сверить с сайтом: тот же index-*.js, что в dist/index.html на сервере.
const entry = (readFileSync(index, 'utf8').match(/assets\/index-[\w-]+\.js/) || ['?'])[0];
console.log(`Electron web prepared at ${outputDir} (сборка ${entry})`);
