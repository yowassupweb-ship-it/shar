/**
 * Публичный API «Офиса» для остального приложения: просмотр вложений (панель чата) и открытие в редакторе.
 * Тяжёлые части (pdf.js, редакторы) подгружаются отдельными кусками.
 */
import { lazy } from 'react';

export const DocPanel = lazy(() => import('./viewer/DocPanel'));
export { viewKindOf, canOpenInEditor, type FileRef, type ViewKind } from './viewer/kinds';
export { openInEditor } from './viewer/openInEditor';
