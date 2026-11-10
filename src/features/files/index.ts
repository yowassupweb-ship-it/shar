// Публичный API раздела «Файлы» для других фич: значок формата, определение вида файла и меню вложения
// (просмотр, копия в редакторе, «Сохранить в Файлы», «Сохранить на устройство») — для почты и чатов.
// Сам раздел грузится отдельно (FilesScreen).
export { useAttachmentMenu, type AttachmentFile } from './AttachmentMenu';
export { FileGlyph } from './FileGlyph';
export { kindOf } from './api';
