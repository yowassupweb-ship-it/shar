import { useEffect, useRef, useState } from 'react';
import { createUniver, IImageIoService, LocaleType, mergeLocales, type IDocumentData } from '@univerjs/presets';
import { UniverDocsCorePreset } from '@univerjs/preset-docs-core';
import UniverPresetDocsCoreRuRU from '@univerjs/preset-docs-core/locales/ru-RU';
import { UniverFindReplacePlugin } from '@univerjs/find-replace';
import FindReplaceRuRU from '@univerjs/find-replace/locale/ru-RU';
import { UniverDocsFindReplacePlugin } from '@univerjs/docs-find-replace';
import { UniverDocsDrawingPlugin, UniverDocsDrawingUIPlugin, UniverDrawingPlugin, UniverDrawingUIPlugin } from '@univerjs/preset-docs-drawing';
import UniverPresetDocsDrawingRuRU from '@univerjs/preset-docs-drawing/locales/ru-RU';
import { UniverDocsHyperLinkPreset } from '@univerjs/preset-docs-hyper-link';
import UniverPresetDocsHyperLinkRuRU from '@univerjs/preset-docs-hyper-link/locales/ru-RU';
import '@univerjs/preset-docs-hyper-link/lib/index.css';
import '@univerjs/preset-docs-core/lib/index.css';
import '@univerjs/preset-docs-drawing/lib/index.css';
import '@univerjs/find-replace/lib/index.css';
import { UploadingImageIoService, uploadPastedImages } from '../lib/imageIo';
import { SharEmojiPicker } from '@/shared/emoji/SharEmojiPicker';
import { emptySnapshot, ensureDrawingResource, fingerprint, localizeImages, parseSnapshot, type DocSnapshot } from '../lib/docSnapshot';
import { disableBlockHandle, hideMissingFonts, isDarkTheme, overrideComponent, styleDocSurface, univerTheme, useUniverTheme } from '../lib/univerTheme';
import type { EditorProps } from './types';

/**
 * Документ с листами A4: Univer Docs в «традиционной» раскладке (поля, разрывы страниц), как в Word и
 * Google Docs. Правка отдаёт снимок целиком, сервер хранит его как есть. Загружается отдельным куском —
 * Univer тяжёлый, и остальной Шар ради него не ждёт.
 */
export default function DocEditor({ content, onContent, readOnly, loadKey, visible = true }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const theme = useUniverTheme();
  const initial = useRef<DocSnapshot>(parseSnapshot(content) ?? emptySnapshot());
  const lastPrint = useRef(fingerprint(initial.current));
  const onContentRef = useRef(onContent);
  onContentRef.current = onContent;
  const [broken, setBroken] = useState(false);

  // Новая версия с сервера: пересобираем редактор из неё.
  useEffect(() => {
    const next = parseSnapshot(content);
    setBroken(!next && Boolean(content.trim()));
    initial.current = next ?? emptySnapshot();
    lastPrint.current = fingerprint(initial.current);
  }, [loadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = host.current;
    if (!el) return undefined;
    // Свой узел на каждый экземпляр: Univer размонтирует деревья не сразу, и очистка общего контейнера
    // до этого давала «removeChild: узел не является потомком».
    const mount = window.document.createElement('div');
    mount.className = 'nws-univer-mount';
    el.appendChild(mount);
    const { univer, univerAPI } = createUniver({
      locale: LocaleType.RU_RU,
      locales: { [LocaleType.RU_RU]: mergeLocales(UniverPresetDocsCoreRuRU, UniverPresetDocsDrawingRuRU, UniverPresetDocsHyperLinkRuRU, FindReplaceRuRU) },
      darkMode: isDarkTheme(theme),
      theme: univerTheme(theme),
      presets: [
        UniverDocsCorePreset({ container: mount, ribbonType: 'classic', toc: false, header: !readOnly, toolbar: !readOnly, contextMenu: !readOnly }),
        // Картинки: то же, что UniverDocsDrawingPreset, но вставленный файл уходит на сервер, а не в снимок base64.
        { plugins: [[UniverDrawingPlugin, { override: [[IImageIoService, { useClass: UploadingImageIoService }]] }], UniverDrawingUIPlugin, UniverDocsDrawingPlugin, UniverDocsDrawingUIPlugin] },
        // Ссылки: клик — карточка ссылки, Ctrl+клик — открыть в браузере (в приложении — в системном).
        UniverDocsHyperLinkPreset(),
      ],
    });
    // Поиск по документу (Ctrl+F): официальные плагины Univer. Регистрируем до создания документа.
    univer.registerPlugin(UniverFindReplacePlugin);
    univer.registerPlugin(UniverDocsFindReplacePlugin);
    // Ctrl+F: когда фокус внутри документа, поиск открывает сам Univer; из любого другого места страницы
    // (название, шапка, пустое поле вокруг) открываем его здесь, а не отдаём системному поиску.
    const onFindKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.code !== 'KeyF') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('.nws-univer, [data-u-comp="find-replace-dialog"]')) return;
      event.preventDefault();
      void univerAPI.executeCommand('ui.operation.open-find-dialog');
    };
    window.addEventListener('keydown', onFindKey);
    // «Вставка → Эмодзи»: выбор из набора Шара (те же эмодзи, что в чате) вместо встроенного набора Univer.
    // Univer вызывает компонент с onChange(emoji) и сам вставляет выбранное в позицию курсора.
    const restoreEmoji = overrideComponent(
      univer,
      'ui.emoji-picker',
      () => (
        <div className="nem-host">
          <SharEmojiPicker
            autoFocus={false}
            onPick={(emoji) => {
              // Вставляем сами, а не через onChange панели Univer: так видно, получилось ли (нет выделения — не получилось).
              void univerAPI.executeCommand('doc.command.insert-special-character', { value: emoji });
            }}
          />
        </div>
      ),
    );
    const stopPasteUpload = uploadPastedImages(univer);
    univerAPI.toggleDarkMode(isDarkTheme(theme));
    univerAPI.setTheme(univerTheme(theme));
    const doc = univerAPI.createDocument(ensureDrawingResource(structuredClone(initial.current)) as unknown as IDocumentData);
    styleDocSurface(univer, doc.getId(), initial.current.documentStyle?.documentFlavor === 2);
    disableBlockHandle(univer, doc.getId());
    hideMissingFonts(univer);
    if (readOnly) void doc.getPermission().setReadOnly();

    // Правки текста, форматирования и полей страницы идут мутациями; мутация без реальной разницы
    // (фокус, выделение) отсеивается сравнением с сохранённым отпечатком.
    let ready = false;
    const readyTimer = window.setTimeout(() => { ready = true; }, 300);
    let syncTimer = 0;
    const subscription = univerAPI.addEvent(univerAPI.Event.CommandExecuted, (event) => {
      if (!ready || readOnly || !event.id.startsWith('doc.mutation.')) return;
      window.clearTimeout(syncTimer);
      syncTimer = window.setTimeout(() => {
        const snapshot = localizeImages(doc.save() as unknown as DocSnapshot);
        const print = fingerprint(snapshot);
        if (print === lastPrint.current) return;
        lastPrint.current = print;
        onContentRef.current(JSON.stringify(snapshot));
      }, 250);
    });

    return () => {
      window.removeEventListener('keydown', onFindKey);
      restoreEmoji();
      stopPasteUpload();
      window.clearTimeout(readyTimer);
      window.clearTimeout(syncTimer);
      subscription.dispose();
      // Univer снимает свои React-деревья синхронно; внутри фазы рендера нашего компонента React на это жалуется.
      window.setTimeout(() => { univer.dispose(); mount.remove(); }, 0);
    };
  }, [loadKey, readOnly, theme]);

  useEffect(() => { if (visible) window.dispatchEvent(new Event('resize')); }, [visible]);

  if (broken) return <div className="nws-missing" role="alert">Не удалось прочитать содержимое документа: файл повреждён.</div>;
  return <div className="nws-univer nws-univer-doc" ref={host} aria-label="Редактор документа" />;
}
