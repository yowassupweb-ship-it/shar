/**
 * Управление компьютером агентом «Ядра» — исполнитель на стороне человека (сервер: server/app/modules/computer).
 *
 * По умолчанию ВЫКЛЮЧЕНО: включает сам человек (Настройки → Устройства), выбор хранится в userData/computer.json.
 * Пока агент действует, поверх всех окон — плашка «Агент управляет компьютером» с кнопкой «Стоп»; Ctrl+Alt+Q —
 * то же самое с клавиатуры. «Стоп» выключает управление совсем (включить снова — только самому, в настройках).
 * Плашка исключена из снимков экрана (setContentProtection), чтобы агент не кликал по ней.
 *
 * Снимок — основной монитор, сжатый до 1366 px по ширине (JPEG): агент даёт координаты в пикселях снимка, здесь они
 * переводятся в физические пиксели экрана. Мышь и клавиатура — SendInput из user32 через koffi (как occlusion.cjs и
 * fileclip.cjs); не Windows или koffi не загрузился — управление недоступно, интерфейс так и скажет.
 */

const { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_WIDTH = 1366;
const STOP_KEY = 'Control+Alt+Q';
const IDLE_HIDE_MS = 15_000;

let win32 = null;
try {
  if (process.platform === 'win32') {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const MOUSEINPUT = koffi.struct('SHAR_MOUSEINPUT', { dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' });
    const KEYBDINPUT = koffi.struct('SHAR_KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' });
    const INPUT_UNION = koffi.union('SHAR_INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT });
    const INPUT = koffi.struct('SHAR_INPUT', { type: 'uint32', u: INPUT_UNION });
    win32 = {
      INPUT,
      size: koffi.sizeof(INPUT),
      SendInput: user32.func('uint32 __stdcall SendInput(uint32 cInputs, SHAR_INPUT *pInputs, int cbSize)'),
      SetCursorPos: user32.func('int __stdcall SetCursorPos(int X, int Y)'),
    };
  }
} catch (err) {
  console.error('[computer] koffi unavailable:', err?.message || err);
  win32 = null;
}

const MOUSE = { MOVE: 0x0001, LEFTDOWN: 0x0002, LEFTUP: 0x0004, RIGHTDOWN: 0x0008, RIGHTUP: 0x0010, MIDDLEDOWN: 0x0020, MIDDLEUP: 0x0040, WHEEL: 0x0800 };
const KEY = { EXTENDED: 0x0001, UP: 0x0002, UNICODE: 0x0004 };
const VK = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, meta: 0x5b, cmd: 0x5b,
  enter: 0x0d, return: 0x0d, esc: 0x1b, escape: 0x1b, tab: 0x09, backspace: 0x08, space: 0x20,
  delete: 0x2e, del: 0x2e, insert: 0x2d, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27, capslock: 0x14, printscreen: 0x2c,
};
const EXTENDED = new Set([0x2e, 0x2d, 0x24, 0x23, 0x21, 0x22, 0x26, 0x28, 0x25, 0x27, 0x5b]);
for (let i = 1; i <= 12; i += 1) VK[`f${i}`] = 0x6f + i;

// ── настройка ───────────────────────────────────────────────────────────────

const file = () => path.join(app.getPath('userData'), 'computer.json');
function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return { enabled: Boolean(s.enabled), deviceId: String(s.deviceId || '') };
  } catch { return { enabled: false, deviceId: '' }; }
}
function writeState(next) {
  try { fs.writeFileSync(file(), JSON.stringify(next)); } catch (err) { console.error('[computer] save failed:', err?.message || err); }
}
let state = null;
function current() {
  if (!state) {
    state = readState();
    if (!state.deviceId) { state.deviceId = crypto.randomBytes(12).toString('hex'); writeState(state); }
  }
  return state;
}

// ── экран и координаты ──────────────────────────────────────────────────────

let lastShot = null; // { imgW, imgH, physX, physY, physW, physH }

function primaryGeometry() {
  const d = screen.getPrimaryDisplay();
  const sf = d.scaleFactor || 1;
  return { physX: Math.round(d.bounds.x * sf), physY: Math.round(d.bounds.y * sf), physW: Math.round(d.size.width * sf), physH: Math.round(d.size.height * sf) };
}

async function shoot() {
  const g = primaryGeometry();
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: g.physW, height: g.physH } });
  const primaryId = String(screen.getPrimaryDisplay().id);
  const src = sources.find((s) => s.display_id === primaryId) || sources[0];
  if (!src || src.thumbnail.isEmpty()) throw new Error('Не удалось снять экран (нет доступа к записи экрана)');
  let img = src.thumbnail;
  const size = img.getSize();
  if (size.width > MAX_WIDTH) img = img.resize({ width: MAX_WIDTH, quality: 'good' });
  const out = img.getSize();
  lastShot = { imgW: out.width, imgH: out.height, ...g };
  return { image: img.toJPEG(72).toString('base64'), width: out.width, height: out.height };
}

/** Точка со снимка → физические пиксели экрана. Снимка ещё не было — считаем по текущему экрану. */
function toScreen(x, y) {
  const s = lastShot || { imgW: Math.min(MAX_WIDTH, primaryGeometry().physW), ...primaryGeometry() };
  if (!s.imgH) s.imgH = Math.round(s.physH * (s.imgW / s.physW));
  const px = s.physX + Math.round((Math.max(0, Math.min(s.imgW, x)) / s.imgW) * s.physW);
  const py = s.physY + Math.round((Math.max(0, Math.min(s.imgH, y)) / s.imgH) * s.physH);
  return [px, py];
}

// ── ввод ────────────────────────────────────────────────────────────────────

function send(inputs) {
  if (!inputs.length) return;
  const sent = win32.SendInput(inputs.length, inputs, win32.size);
  if (sent !== inputs.length) throw new Error('Windows не принял ввод (окно с правами администратора или экран заблокирован)');
}
const mouse = (flags, data = 0) => ({ type: 0, u: { mi: { dx: 0, dy: 0, mouseData: data >>> 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } });
const keyIn = (vk, up, scan = 0, unicode = false) => ({
  type: 1, u: { ki: { wVk: unicode ? 0 : vk, wScan: scan, dwFlags: (up ? KEY.UP : 0) | (unicode ? KEY.UNICODE : 0) | (!unicode && EXTENDED.has(vk) ? KEY.EXTENDED : 0), time: 0, dwExtraInfo: 0 } },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function moveTo(x, y) {
  const [px, py] = toScreen(x, y);
  win32.SetCursorPos(px, py);
}

function vkOf(name) {
  if (VK[name] != null) return VK[name];
  if (/^[a-z]$/.test(name)) return name.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(name)) return name.charCodeAt(0);
  const punct = { '-': 0xbd, minus: 0xbd, '=': 0xbb, plus: 0xbb, ',': 0xbc, comma: 0xbc, '.': 0xbe, period: 0xbe, '/': 0xbf, slash: 0xbf };
  if (punct[name] != null) return punct[name];
  throw new Error(`Неизвестная клавиша «${name}»`);
}

async function perform(action, args) {
  if (!win32) throw new Error('Управление мышью и клавиатурой есть только в Shar OS для Windows');
  switch (action) {
    case 'screenshot': return;
    case 'move': moveTo(args.x, args.y); return;
    case 'click': {
      moveTo(args.x, args.y);
      await sleep(40);
      const [down, up] = args.button === 'right' ? [MOUSE.RIGHTDOWN, MOUSE.RIGHTUP] : args.button === 'middle' ? [MOUSE.MIDDLEDOWN, MOUSE.MIDDLEUP] : [MOUSE.LEFTDOWN, MOUSE.LEFTUP];
      send([mouse(down), mouse(up)]);
      if (args.double) { await sleep(60); send([mouse(down), mouse(up)]); }
      return;
    }
    case 'drag': {
      moveTo(args.x, args.y);
      await sleep(40);
      send([mouse(MOUSE.LEFTDOWN)]);
      // Ведём по шагам: многие программы не замечают перетаскивание одним прыжком.
      for (let i = 1; i <= 12; i += 1) {
        moveTo(args.x + ((args.to_x - args.x) * i) / 12, args.y + ((args.to_y - args.y) * i) / 12);
        await sleep(15);
      }
      send([mouse(MOUSE.LEFTUP)]);
      return;
    }
    case 'scroll': {
      moveTo(args.x, args.y);
      await sleep(30);
      const clicks = Math.max(-50, Math.min(50, Number(args.dy) || 0));
      for (let i = 0; i < Math.abs(clicks); i += 1) { send([mouse(MOUSE.WHEEL, clicks > 0 ? -120 : 120)]); await sleep(12); }
      return;
    }
    case 'type': {
      const text = String(args.text || '').replace(/\r\n/g, '\n');
      for (const ch of text) {
        if (ch === '\n') { send([keyIn(VK.enter, false), keyIn(VK.enter, true)]); continue; }
        const units = [];
        for (let i = 0; i < ch.length; i += 1) units.push(ch.charCodeAt(i));
        send([...units.map((u) => keyIn(0, false, u, true)), ...units.map((u) => keyIn(0, true, u, true))]);
        await sleep(4);
      }
      return;
    }
    case 'key': {
      const names = String(args.keys || '').split('+').map((k) => k.trim()).filter(Boolean);
      const codes = names.map(vkOf);
      send([...codes.map((c) => keyIn(c, false)), ...codes.slice().reverse().map((c) => keyIn(c, true))]);
      return;
    }
    default: throw new Error(`Неизвестное действие «${action}»`);
  }
}

// ── плашка и «Стоп» ─────────────────────────────────────────────────────────

let plaque = null;
let hideTimer = null;
let mainRef = null;

const PLAQUE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;font:13px/1.2 "Segoe UI",system-ui,sans-serif;overflow:hidden;user-select:none}
.p{box-sizing:border-box;height:40px;margin:2px;display:flex;align-items:center;gap:10px;padding:0 8px 0 14px;border-radius:20px;
background:rgba(20,22,28,.94);color:#fff;box-shadow:0 4px 18px rgba(0,0,0,.35);-webkit-app-region:drag}
.dot{width:9px;height:9px;border-radius:50%;background:#ff4d4f;box-shadow:0 0 0 0 rgba(255,77,79,.6);animation:p 1.4s infinite}
@keyframes p{70%{box-shadow:0 0 0 7px rgba(255,77,79,0)}100%{box-shadow:0 0 0 0 rgba(255,77,79,0)}}
.t{flex:1;white-space:nowrap}.k{opacity:.6;font-size:12px}
button{-webkit-app-region:no-drag;border:0;border-radius:14px;padding:6px 12px;background:#ff4d4f;color:#fff;font:600 12.5px "Segoe UI",system-ui;cursor:pointer}
</style></head><body><div class="p"><span class="dot"></span><span class="t">Агент управляет компьютером <span class="k">· Ctrl+Alt+Q</span></span>
<button onclick="document.title='stop'">Стоп</button></div></body></html>`;

function showPlaque() {
  if (!plaque || plaque.isDestroyed()) {
    const area = screen.getPrimaryDisplay().workArea;
    plaque = new BrowserWindow({
      width: 400, height: 44, x: Math.round(area.x + (area.width - 400) / 2), y: area.y + 8,
      frame: false, transparent: true, resizable: false, movable: true, alwaysOnTop: true, skipTaskbar: true, focusable: false,
      show: false, hasShadow: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    plaque.setAlwaysOnTop(true, 'screen-saver');
    plaque.setContentProtection(true); // не попадает в снимки экрана — агент её не «видит» и не кликает
    plaque.on('page-title-updated', (event, title) => { event.preventDefault(); if (title === 'stop') stop('Остановлено кнопкой «Стоп»'); });
    void plaque.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PLAQUE_HTML)}`);
  }
  if (!plaque.isVisible()) plaque.showInactive();
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { if (plaque && !plaque.isDestroyed()) plaque.hide(); }, IDLE_HIDE_MS);
}

function notify() {
  if (mainRef && !mainRef.isDestroyed()) mainRef.webContents.send('computer:changed', { enabled: current().enabled });
}

function setEnabled(on) {
  const s = current();
  s.enabled = Boolean(on);
  writeState(s);
  if (s.enabled) {
    if (!globalShortcut.isRegistered(STOP_KEY)) globalShortcut.register(STOP_KEY, () => stop('Остановлено клавишами Ctrl+Alt+Q'));
  } else {
    if (globalShortcut.isRegistered(STOP_KEY)) globalShortcut.unregister(STOP_KEY);
    clearTimeout(hideTimer);
    if (plaque && !plaque.isDestroyed()) plaque.hide();
  }
  notify();
  return s.enabled;
}

function stop(reason) {
  console.log(`[computer] ${reason}`);
  setEnabled(false);
}

// ── IPC ─────────────────────────────────────────────────────────────────────

let busy = Promise.resolve();

function register(mainWindow) {
  mainRef = mainWindow;
  for (const ch of ['computer:get', 'computer:set', 'computer:run']) ipcMain.removeHandler(ch);
  ipcMain.handle('computer:get', () => {
    const g = primaryGeometry();
    return { enabled: current().enabled, deviceId: current().deviceId, name: os.hostname(), supported: Boolean(win32), stopKey: 'Ctrl+Alt+Q', width: g.physW, height: g.physH };
  });
  ipcMain.handle('computer:set', (_e, on) => setEnabled(on));
  // Команды — по одной: следующая ждёт, пока закончится предыдущая (клик не догонит набор текста).
  ipcMain.handle('computer:run', (_e, action, args) => {
    const job = busy.then(async () => {
      if (!current().enabled) return { ok: false, error: 'Человек выключил управление компьютером' };
      try {
        showPlaque();
        await perform(String(action || ''), args && typeof args === 'object' ? args : {});
        if (action !== 'screenshot') await sleep(350); // экран успевает отрисовать результат действия
        return { ok: true, ...(await shoot()) };
      } catch (err) {
        return { ok: false, error: String(err?.message || err).slice(0, 400) };
      }
    });
    busy = job.catch(() => undefined);
    return job;
  });
  if (current().enabled && !globalShortcut.isRegistered(STOP_KEY)) globalShortcut.register(STOP_KEY, () => stop('Остановлено клавишами Ctrl+Alt+Q'));
}

// _probe — для проверки без окна Шара: размер структуры ввода и снимок экрана (ничего не двигает и не нажимает).
module.exports = { register, _probe: { inputSize: () => win32?.size ?? 0, shoot } };
