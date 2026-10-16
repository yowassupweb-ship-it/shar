// Заметки на рабочем столе — как «Записки» Windows.
//
// Каждая заметка «Офиса» может жить отдельным маленьким окном без рамки поверх рабочего стола: цветная шапка, правка
// на месте, сохранение на сервер (та же заметка, что и в «Офисе»). Заметка выносится пунктом меню «На рабочий стол»
// или перетаскиванием за пределы окна Шара.
//
// Окна грузят тот же интерфейс, что и главное окно, по адресу /sticky/<id>: страница рисует только заметку
// (src/features/workspace/StickyPage.tsx), вход и API общие с приложением (одна сессия Electron). Какие заметки
// открыты и где стоят — в userData/sticky-notes.json; при следующем запуске они возвращаются на свои места.

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, screen } = require('electron');

const NOTE_SIZE = { width: 320, height: 380 };
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function createStickyNotes({ baseUrl, preload, icon }) {
  const windows = new Map(); // noteId → BrowserWindow
  const file = () => path.join(app.getPath('userData'), 'sticky-notes.json');
  let quitting = false;
  let saveTimer = null;
  const state = load();

  app.on('before-quit', () => { quitting = true; });

  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
      return {
        open: Array.isArray(data.open) ? data.open.map(String).filter((id) => ID_PATTERN.test(id)) : [],
        bounds: data.bounds && typeof data.bounds === 'object' ? data.bounds : {},
        onTop: data.onTop && typeof data.onTop === 'object' ? data.onTop : {},
      };
    } catch {
      return { open: [], bounds: {}, onTop: {} };
    }
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { fs.writeFileSync(file(), JSON.stringify(state, null, 2)); } catch { /* не критично */ }
    }, 300);
  }

  /** Окно должно оказаться на видимом экране: монитор могли отключить с тех пор, как заметку туда поставили. */
  function onScreen(bounds) {
    const area = screen.getDisplayMatching(bounds).workArea;
    const width = Math.min(bounds.width, area.width);
    const height = Math.min(bounds.height, area.height);
    return {
      width,
      height,
      x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
      y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
    };
  }

  function urlFor(id) {
    return new URL(`/sticky/${encodeURIComponent(id)}`, baseUrl()).toString();
  }

  /** Новое окно — в точке отпускания, иначе каскадом от последнего открытого, как у системных записок. */
  function nextBounds(point) {
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      return onScreen({ x: Math.round(point.x - 40), y: Math.round(point.y - 18), ...NOTE_SIZE });
    }
    const last = [...windows.values()].filter((win) => !win.isDestroyed()).pop();
    if (last) {
      const b = last.getContentBounds();
      return onScreen({ x: b.x + 28, y: b.y + 28, ...NOTE_SIZE });
    }
    const area = screen.getPrimaryDisplay().workArea;
    return { x: area.x + area.width - NOTE_SIZE.width - 40, y: area.y + 60, ...NOTE_SIZE };
  }

  function open(id, point) {
    const key = String(id);
    const existing = windows.get(key);
    if (existing && !existing.isDestroyed()) {
      if (point) existing.setPosition(Math.round(point.x - 40), Math.round(point.y - 18));
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return { ok: true };
    }
    const saved = state.bounds[key];
    const bounds = saved && !point ? onScreen({ ...NOTE_SIZE, ...saved }) : nextBounds(point);
    const win = new BrowserWindow({
      ...bounds,
      minWidth: 220,
      minHeight: 160,
      frame: false,
      // Размеры — содержимого: у окна без рамки в Windows есть невидимая кромка, и внешние размеры при каждом
      // открытии прибавляли бы по несколько пикселей.
      useContentSize: true,
      show: false,
      backgroundColor: '#2b2b2e',
      icon,
      title: 'Заметка',
      alwaysOnTop: Boolean(state.onTop[key]),
      autoHideMenuBar: true,
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: true },
    });
    win.setMenuBarVisibility(false);
    win.setContentBounds(bounds);
    windows.set(key, win);
    win.once('ready-to-show', () => win.show());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(new URL(baseUrl()).origin)) event.preventDefault(); });
    const remember = () => {
      if (win.isDestroyed() || win.isMinimized()) return;
      state.bounds[key] = win.getContentBounds();
      save();
    };
    win.on('move', remember);
    win.on('resize', remember);
    win.on('closed', () => {
      windows.delete(key);
      // Окно закрыли сами — заметка больше не на столе. При выходе из приложения список открытых не трогаем.
      if (!quitting) { state.open = state.open.filter((item) => item !== key); save(); }
    });
    void win.loadURL(urlFor(key));
    if (!state.open.includes(key)) { state.open.push(key); save(); }
    return { ok: true };
  }

  function close(id) {
    const win = windows.get(String(id));
    if (win && !win.isDestroyed()) win.close();
  }

  function keyOf(sender) {
    for (const [key, win] of windows) if (!win.isDestroyed() && win.webContents === sender) return key;
    return '';
  }

  function restore() {
    for (const id of state.open) open(id);
  }

  function install({ focusMain }) {
    ipcMain.handle('sticky:open', (_event, id, point) => {
      const key = String(id || '');
      if (!ID_PATTERN.test(key)) return { ok: false, error: 'bad_note' };
      return open(key, point && typeof point === 'object' ? { x: Number(point.x), y: Number(point.y) } : null);
    });
    ipcMain.handle('sticky:close', (event, id) => {
      close(id ? String(id) : keyOf(event.sender));
      return { ok: true };
    });
    ipcMain.handle('sticky:set-on-top', (event, value) => {
      const key = keyOf(event.sender);
      const win = windows.get(key);
      if (!win) return false;
      const next = typeof value === 'boolean' ? value : !win.isAlwaysOnTop();
      win.setAlwaysOnTop(next);
      state.onTop[key] = next;
      save();
      return next;
    });
    ipcMain.handle('sticky:state', (event) => {
      const key = keyOf(event.sender);
      return { id: key, onTop: Boolean(windows.get(key)?.isAlwaysOnTop()), open: state.open };
    });
    ipcMain.handle('sticky:minimize', (event) => {
      windows.get(keyOf(event.sender))?.minimize();
      return { ok: true };
    });
    ipcMain.handle('sticky:focus-main', (_event, url) => { focusMain(typeof url === 'string' && url.startsWith('/') ? url : ''); return { ok: true }; });
    // Заметку удалили — её окно на столе больше не нужно.
    ipcMain.handle('sticky:forget', (_event, id) => {
      const key = String(id || '');
      close(key);
      state.open = state.open.filter((item) => item !== key);
      delete state.bounds[key];
      delete state.onTop[key];
      save();
      return { ok: true };
    });
  }

  return { install, open, close, restore };
}

module.exports = { createStickyNotes };
