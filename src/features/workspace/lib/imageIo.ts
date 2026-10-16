import { ImageSourceType, ImageUploadStatusType, type IImageIoServiceParam, type Nullable, type Univer } from '@univerjs/core';
import { IDocClipboardService } from '@univerjs/docs-ui';
import { ImageIoService } from '@univerjs/drawing';
import { uploadFileWithProgress } from '@/shared/api/uploadFile';
import { attachmentUrl } from '@/shared/ui/format';
import { showToast } from '@/shared/ui/Toast';

/**
 * Картинки в документе: Univer по умолчанию кладёт вставленный файл прямо в снимок строкой base64 — документ
 * разбухает до мегабайт, а автосохранение отправляет его целиком после каждой паузы в наборе. Здесь файл уходит
 * на сервер (как вложение чата), а в документе остаётся короткая ссылка.
 */
async function uploadImage(file: File): Promise<string | null> {
  try {
    const uploaded = await uploadFileWithProgress(file, () => undefined);
    return attachmentUrl(uploaded.url);
  } catch {
    showToast('Картинка не загрузилась — проверьте соединение и вставьте ещё раз', 'error');
    return null;
  }
}

/** «Вставка → Изображение»: проверки типа и размера — от стандартного сервиса, хранение — у нас. */
export class UploadingImageIoService extends ImageIoService {
  override async saveImage(imageFile: File): Promise<Nullable<IImageIoServiceParam>> {
    const local = await super.saveImage(imageFile);
    if (!local) return local;
    const url = await uploadImage(imageFile);
    return url ? { ...local, imageSourceType: ImageSourceType.URL, source: url, status: ImageUploadStatusType.SUCCUSS } : null;
  }
}

/** Ctrl+V картинки (скриншот, файл из проводника) идёт мимо сервиса выше, через буфер обмена документа. */
export function uploadPastedImages(univer: Univer): () => void {
  const injector = (univer as unknown as { __getInjector: () => { get: <T>(token: unknown) => T } }).__getInjector();
  const clipboard = injector.get<{ addClipboardHook: (hook: object) => { dispose: () => void } }>(IDocClipboardService);
  const hook = clipboard.addClipboardHook({
    onBeforePasteImage: async (file: File) => {
      const url = await uploadImage(file);
      return url ? { source: url, imageSourceType: ImageSourceType.URL } : null;
    },
  });
  return () => hook.dispose();
}
