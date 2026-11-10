/**
 * Файлы в системный буфер обмена Windows (формат CF_HDROP — тот, что кладёт Проводник при «Копировать»).
 *
 * У Electron для этого нет API: clipboard.write умеет текст, HTML и картинки. Поэтому — публичные вызовы Windows
 * через koffi (как в occlusion.cjs): OpenClipboard, GlobalAlloc, SetClipboardData. После этого файлы вставляются
 * и в Проводник, и в поле чата (Chromium читает CF_HDROP как files у события paste).
 * Не Windows или koffi не загрузился — copyFiles вернёт false, и интерфейс обойдётся тем, что умеет без этого.
 */

const CF_HDROP = 15;
const GMEM_MOVEABLE = 0x0002;
const GMEM_ZEROINIT = 0x0040;

let api = null;
let loadFailed = false;

function load() {
  if (api || loadFailed) return api;
  if (process.platform !== 'win32') { loadFailed = true; return null; }
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    api = {
      // Владелец — настоящее окно: при OpenClipboard(NULL) EmptyClipboard проходит, а SetClipboardData после него молча отказывает.
      OpenClipboard: user32.func('int __stdcall OpenClipboard(uintptr_t owner)'),
      GetDesktopWindow: user32.func('uintptr_t __stdcall GetDesktopWindow()'),
      EmptyClipboard: user32.func('int __stdcall EmptyClipboard()'),
      SetClipboardData: user32.func('void * __stdcall SetClipboardData(uint32_t format, void *mem)'),
      CloseClipboard: user32.func('int __stdcall CloseClipboard()'),
      GlobalAlloc: kernel32.func('void * __stdcall GlobalAlloc(uint32_t flags, size_t bytes)'),
      GlobalFree: kernel32.func('void * __stdcall GlobalFree(void *mem)'),
      GlobalLock: kernel32.func('void * __stdcall GlobalLock(void *mem)'),
      GlobalUnlock: kernel32.func('int __stdcall GlobalUnlock(void *mem)'),
      RtlMoveMemory: kernel32.func('void __stdcall RtlMoveMemory(void *dst, const uint8_t *src, size_t bytes)'),
    };
  } catch (err) {
    loadFailed = true;
    console.error('[fileclip] koffi unavailable:', err?.message || err);
    return null;
  }
  return api;
}

/** DROPFILES: заголовок в 20 байт + пути в UTF-16, каждый с нулём, и ещё один нуль в конце списка. */
function dropFiles(paths) {
  const names = Buffer.from(`${paths.join('\0')}\0\0`, 'utf16le');
  const head = Buffer.alloc(20);
  head.writeUInt32LE(20, 0); // pFiles — где начинаются пути
  head.writeUInt32LE(1, 16); // fWide — пути в UTF-16
  return Buffer.concat([head, names]);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Положить файлы (абсолютные пути) в буфер обмена. owner — HWND окна приложения. true — получилось. */
async function copyFiles(paths, owner) {
  const native = load();
  const list = (paths || []).filter((p) => typeof p === 'string' && p);
  if (!native || !list.length) return false;
  const data = dropFiles(list);
  // Буфер обмена может на миг держать другая программа — пробуем несколько раз.
  let opened = false;
  for (let i = 0; i < 10 && !opened; i += 1) {
    opened = native.OpenClipboard(owner || native.GetDesktopWindow()) !== 0;
    if (!opened) await sleep(25);
  }
  if (!opened) return false;
  let mem = null;
  try {
    native.EmptyClipboard();
    mem = native.GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, data.length);
    if (!mem) return false;
    const target = native.GlobalLock(mem);
    if (!target) return false;
    native.RtlMoveMemory(target, data, data.length);
    native.GlobalUnlock(mem);
    // После успешного SetClipboardData память принадлежит системе — освобождать её самим нельзя.
    const placed = native.SetClipboardData(CF_HDROP, mem);
    if (placed) mem = null;
    return Boolean(placed);
  } catch (err) {
    console.error('[fileclip] copy failed:', err?.message || err);
    return false;
  } finally {
    if (mem) { try { native.GlobalFree(mem); } catch { /* уже освобождена */ } }
    native.CloseClipboard();
  }
}

module.exports = { copyFiles };
