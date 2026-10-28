import { lazy, Suspense, useEffect, useRef, useState, type ComponentType } from 'react';
import {
  AlertCircle, ArrowLeft, Check, Copy, Download, FilePlus, Globe2, History, Link2, Lock, MoreHorizontal, Pin, PinOff, MonitorUp, Printer, Send, Share2, Trash2, Upload, Users,
} from 'lucide-react';
import { recordVisit } from '@/features/spotlight/history';
import { absolute, links } from '@/shared/navigation/routes';
import { askConfirm, Menu, MenuItem, type MenuAnchor } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import { workspaceApi } from './api';
import { KINDS } from './kinds';
import { NoteEditor } from './editors/NoteEditor';
import type { EditorProps } from './editors/types';
import { downloadBase64, downloadBlob, downloadText, markdownHtml, printHtml, safeFileName, workbookHtml, XLSX_MIME } from './lib/exportDoc';
import { markdownToSnapshot, parseSnapshot, snapshotToMarkdown } from './lib/docSnapshot';
import { tabsAsSections } from './lib/noteTabs';
import { IMPORT_RULES, importFile } from './lib/importFile';
import { canSticky, forgetSticky, openSticky, stickyLabel } from './lib/sticky';
import { PresenceStack } from './PresenceStack';
import { SendToChatSheet } from './SendToChatSheet';
import { usePresence } from './usePresence';
import { useCursors } from './useCursors';
import { VersionsSheet } from './VersionsSheet';
import { ShareDialog } from './ShareDialog';
import { useItemSession, type Source } from './useItemSession';
import type { AccessLevel, AccessMode, Kind, NoteColor } from './types';
import { Spinner } from '@/shared/ui/Spinner';

// Univer и редактор слайдов тяжёлые: грузятся отдельными кусками, когда нужны.
const DocEditor = lazy(() => import('./editors/DocEditor'));
const SheetEditor = lazy(() => import('./editors/SheetEditor'));
const DeckEditor = lazy(() => import('./editors/DeckEditor'));

const EDITORS: Record<Kind, ComponentType<EditorProps>> = {
  note: NoteEditor,
  document: DocEditor,
  table: SheetEditor,
  presentation: DeckEditor,
};

export const NOTE_COLORS: Array<{ value: NoteColor; label: string }> = [
  { value: 'default', label: 'Без метки' }, { value: 'red', label: 'Красная' }, { value: 'orange', label: 'Оранжевая' },
  { value: 'yellow', label: 'Жёлтая' }, { value: 'green', label: 'Зелёная' }, { value: 'cyan', label: 'Бирюзовая' },
  { value: 'blue', label: 'Синяя' }, { value: 'purple', label: 'Фиолетовая' }, { value: 'gray', label: 'Серая' },
];

const ACCESS_ICON = { private: Lock, all: Globe2 } as const;

/**
 * Один материал целиком: шапка (название, состояние сохранения, доступ, «Поделиться», меню) и редактор своего вида.
 * Работает и после входа (по id), и по ссылке (по токену) — тогда без меню владельца.
 */
export function ItemView({ source, onBack, onChanged, onDeleted, onOpen, windowControls }: {
  source: Source;
  /** Кнопки окна (поверх всех окон, свернуть, закрыть) — для отдельного окна материала: ставятся в конец шапки. */
  windowControls?: React.ReactNode;
  onBack?: () => void;
  /** Название, закрепление или доступ изменились — список обновит строку. */
  onChanged?: () => void;
  onDeleted?: () => void;
  /** Создана копия — открыть её. */
  onOpen?: (id: string, kind: Kind) => void;
}) {
  const session = useItemSession(source);
  const { item, status, state, error, conflict, loadKey } = session;
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [downloadMenu, setDownloadMenu] = useState<MenuAnchor | null>(null);
  const [uploadMenu, setUploadMenu] = useState<MenuAnchor | null>(null);
  const [importing, setImporting] = useState(false);
  const [share, setShare] = useState(false);
  const [sendToChat, setSendToChat] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  const importMode = useRef<'replace' | 'append'>('replace');
  const shared = 'token' in source;
  // Присутствие: кто ещё в материале и кто печатает (по ссылке без входа — не показываем).
  const viewers = usePresence('token' in source ? null : String(source.id), state === 'pending' || state === 'saving');
  // Курсоры коллег, как в Google Docs.
  const { cursors, send: sendCursor } = useCursors('token' in source ? null : String(source.id), viewers);

  // История посещений для поиска: открытый материал попадает в «Недавние».
  const visitTitle = useRef('');
  visitTitle.current = item?.title || '';
  const visitId = !shared && status === 'ready' && item ? item.id : null;
  const visitKind = item?.kind;
  useEffect(() => {
    if (!visitId || !visitKind) return;
    recordVisit({ id: visitId, kind: 'office', sub: visitKind, title: visitTitle.current || KINDS[visitKind].untitled, subtitle: KINDS[visitKind].plural, path: links.office(visitKind, visitId) });
  }, [visitId, visitKind]);

  // Ctrl+P печатает открытый материал, а не всё окно приложения. В фазе захвата — раньше, чем редактор
  // (Univer) успеет забрать сочетание себе. Сама печать — ниже, после загрузки материала (printRef).
  const printRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.code !== 'KeyP' || !printRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      printRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (status === 'loading') return <div className="nws-loading"><Spinner size={24} label="Открываю" /></div>;
  if (status === 'missing') return <div className="nws-missing" role="alert">{shared ? 'Ссылка не открывается: её отозвали или материал удалён.' : 'Материал не найден или нет доступа.'}</div>;
  if (status === 'error' || !item) return <div className="nws-missing" role="alert">{error || 'Не удалось открыть.'} <button type="button" className="nx-ghost" onClick={() => void session.reload()}>Повторить</button></div>;

  const info = KINDS[item.kind];
  const Editor = EDITORS[item.kind];
  const readOnly = !item.canEdit;
  const accessLevel: AccessLevel = item.accessLevel ?? 'private';
  const AccessIcon = ACCESS_ICON[accessLevel];

  async function patch(fields: Record<string, unknown>) {
    try { await session.patchFields(fields); onChanged?.(); } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось изменить', 'error'); }
  }

  async function remove() {
    const ok = await askConfirm({ title: `Удалить «${item!.title || info.untitled}»?`, text: 'Это нельзя отменить. Те, кому вы дали доступ, его потеряют.', confirm: 'Удалить', tone: 'danger' });
    if (!ok || 'token' in source) return;
    try { await workspaceApi.remove(source.id); forgetSticky(source.id); onDeleted?.(); } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось удалить', 'error'); }
  }

  async function duplicate() {
    try {
      await session.refreshContent();
      const created = await workspaceApi.create({ kind: item!.kind, title: `${item!.title || info.untitled} (копия)`, content: session.getContent(), meta: item!.meta });
      showToast('Копия создана', 'success');
      onOpen?.(created.id, created.kind);
      onChanged?.();
    } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось создать копию', 'error'); }
  }

  const name = safeFileName(item.title || info.untitled);
  const markdown = (withImages = false) => {
    const content = session.getContent();
    if (item.kind === 'note') return tabsAsSections(content); // вкладки — разделами с заголовком
    const snapshot = parseSnapshot(content);
    return snapshot ? snapshotToMarkdown(snapshot, { images: withImages }) : '';
  };

  /** Печать (и «Сохранить как PDF» в окне печати): документ и заметка — с картинками, таблица — все листы. */
  const canPrint = item.kind === 'document' || item.kind === 'note' || item.kind === 'table';
  async function print() {
    const title = item!.title || info.untitled;
    await session.refreshContent();
    if (item!.kind === 'table') {
      try { printHtml(await workbookHtml(title, session.getContent())); } catch { showToast('Не удалось подготовить таблицу к печати', 'error'); }
      return;
    }
    printHtml(markdownHtml(title, markdown(true)));
  }
  printRef.current = canPrint ? () => void print() : null;

  async function downloadDocx() {
    try {
      await session.refreshContent();
      const { markdownToDocx } = await import('./lib/exportDocx');
      downloadBlob(`${name}.docx`, await markdownToDocx(item!.title || info.untitled, markdown()));
    } catch { showToast('Не удалось собрать файл Word', 'error'); }
  }

  /** Таблица → CSV (первый лист, разделитель «;» и BOM — так его без плясок открывает русский Excel). */
  async function downloadCsv() {
    try {
      await session.refreshContent();
      const { bookFromBase64 } = await import('./lib/workbook');
      const sheet = (await bookFromBase64(session.getContent())).worksheets[0];
      const quote = (value: unknown) => {
        const text = value && typeof value === 'object' && 'result' in value ? String((value as { result: unknown }).result ?? '')
          : value && typeof value === 'object' && 'richText' in value ? (value as { richText: Array<{ text: string }> }).richText.map((p) => p.text).join('')
          : value instanceof Date ? value.toISOString() : String(value ?? '');
        return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      };
      const lines: string[] = [];
      sheet?.eachRow({ includeEmpty: true }, (row) => {
        const cells: string[] = [];
        for (let c = 1; c <= sheet.columnCount; c += 1) cells.push(quote(row.getCell(c).value));
        lines.push(cells.join(';'));
      });
      downloadText(`${name}.csv`, 'text/csv', `\uFEFF${lines.join('\r\n')}`);
    } catch { showToast('Не удалось собрать CSV', 'error'); }
  }

  /** Текст без разметки Markdown — для «.txt»: заголовки, выделение и ссылки остаются словами. */
  const plainText = () => markdown()
    .replace(/^#{1,6}\s+/gm, '').replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, '$1').replace(/(\*\*|__|~~|`)/g, '').replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$)/g, '$1$2');

  function pickImport(mode: 'replace' | 'append') {
    importMode.current = mode;
    importInput.current?.click();
  }

  /** Файл с компьютера → в открытый материал: заменить содержимое или дописать в конец (для таблицы — только заменить). */
  async function importInto(file: File | undefined) {
    if (importInput.current) importInput.current.value = '';
    if (!file || !item) return;
    try {
      if (item.kind === 'presentation') { await importSlides(file); return; }
      const imported = await importFile(file, undefined, item.kind);
      await session.refreshContent();
      // У заметки — исходная строка: markdown() превращает её вкладки в разделы, а дописать нужно в последнюю вкладку.
      const current = item.kind === 'table' || item.kind === 'note' ? session.getContent() : markdown();
      const empty = item.kind !== 'table' && !current.trim();
      if (importMode.current === 'append' && item.kind !== 'table' && !empty) {
        const added = item.kind === 'note' ? imported.content : snapshotToMarkdown(parseSnapshot(imported.content) ?? { } as never);
        const joined = `${current.trimEnd()}

${added}`;
        session.replaceContent(item.kind === 'note' ? joined : JSON.stringify(markdownToSnapshot(item.title || '', joined)));
      } else {
        if (!empty && !(await askConfirm({ title: 'Заменить содержимое?', text: `Текущее содержимое будет заменено файлом «${file.name}».`, confirm: 'Заменить', tone: 'danger' }))) return;
        session.replaceContent(imported.content, item.title.trim() ? undefined : imported.title);
      }
      showToast('Файл импортирован', 'success');
    } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось импортировать', 'error'); }
  }

  /** PowerPoint или PDF → в открытую презентацию: заменить её или добавить слайды в конец. Слайды другого размера
   *  вписываются в размер этой презентации, свой фон сохраняют. */
  async function importSlides(file: File) {
    if (importMode.current === 'replace'
      && !(await askConfirm({ title: 'Заменить презентацию?', text: `Все слайды будут заменены слайдами из «${file.name}».`, confirm: 'Заменить', tone: 'danger' }))) return;
    setImporting(true);
    try {
      const imported = await importFile(file, undefined, 'presentation');
      if (importMode.current === 'replace') {
        session.replaceContent(imported.content, item!.title.trim() ? undefined : imported.title);
      } else {
        const { deckSize, parseDeck, serializeDeck } = await import('./slides/deck');
        const current = parseDeck(session.getContent());
        const incoming = parseDeck(imported.content);
        const to = deckSize(current);
        const from = deckSize(incoming);
        const k = Math.min(to.w / from.w, to.h / from.h);
        const dx = Math.round((to.w - from.w * k) / 2);
        const dy = Math.round((to.h - from.h * k) / 2);
        current.slides.push(...incoming.slides.map((slide) => ({
          ...slide,
          background: slide.background || incoming.theme.background,
          elements: slide.elements.map((el) => ({
            ...el, x: Math.round(el.x * k) + dx, y: Math.round(el.y * k) + dy, w: Math.round(el.w * k), h: Math.round(el.h * k),
            ...(el.type !== 'image' && el.style?.fontSize ? { style: { ...el.style, fontSize: Math.max(8, Math.round(el.style.fontSize * k)) } } : {}),
          })),
        })) as typeof current.slides);
        session.replaceContent(serializeDeck(current));
      }
      showToast(importMode.current === 'replace' ? 'Презентация загружена' : 'Слайды добавлены в конец', 'success');
    } catch (cause) { showToast(cause instanceof Error ? cause.message : 'Не удалось загрузить', 'error'); } finally { setImporting(false); }
  }

  async function copyLink() {
    try { await navigator.clipboard.writeText(absolute(links.office(item!.kind, item!.id))); showToast('Ссылка скопирована', 'success'); } catch { showToast('Не удалось скопировать', 'error'); }
  }

  const status_ = (() => {
    if (readOnly) return <span className="nws-save">Только просмотр</span>;
    if (state === 'error') return <span className="nws-save is-error" role="alert"><AlertCircle size={13} aria-hidden="true" /> {error || 'Не сохранилось'}</span>;
    if (state === 'saving') return <span className="nws-save is-busy">Сохраняю…</span>;
    if (state === 'pending') return <span className="nws-save is-busy">Есть несохранённые правки</span>;
    return <span className="nws-save" title="Сохранено"><Check size={13} aria-hidden="true" /> <span className="nws-label">Сохранено</span></span>;
  })();

  return (
    <div className="nws-item" data-kind={item.kind}>
      <header className="nws-head">
        {onBack && <button type="button" className="nx-icon-btn nws-back" onClick={onBack} aria-label="К списку"><ArrowLeft size={18} /></button>}
        <span className="nws-kind-icon" style={{ '--a': info.tint[0], '--b': info.tint[1] } as React.CSSProperties} aria-hidden="true"><info.icon size={16} /></span>
        <input
          className="nws-title"
          value={item.title}
          readOnly={readOnly}
          placeholder={info.untitled}
          maxLength={200}
          onChange={(e) => session.setTitle(e.target.value)}
          onBlur={() => onChanged?.()}
          aria-label="Название"
        />
        <PresenceStack viewers={viewers} ownTips />
        {status_}
        {!shared && item.isOwner && (
          <button type="button" className="nws-access" onClick={() => setShare(true)} title={accessLevel === 'all' ? 'Видят все в Шаре' : 'Видите только вы и те, кому выдан доступ'}>
            <AccessIcon size={13} aria-hidden="true" /> <span className="nws-label">{accessLevel === 'all' ? 'Все в Шаре' : 'Только я'}</span>
          </button>
        )}
        {!shared && !item.isOwner && item.ownerName && <span className="nws-owner" title="Владелец"><Users size={13} aria-hidden="true" /> {item.ownerName}</span>}
        {!shared && (
          <button type="button" className="nx-icon-btn" aria-label="История версий" title="История версий" onClick={() => setVersionsOpen(true)}>
            <History size={17} />
          </button>
        )}
        {canPrint && (
          <button type="button" className="nx-icon-btn" aria-label="Печать" title="Печать (Ctrl+P)" onClick={() => void print()}>
            <Printer size={17} />
          </button>
        )}
        {item.kind !== 'presentation' && (
          <button type="button" className="nx-icon-btn" aria-label="Скачать" title="Скачать" aria-haspopup="menu" aria-expanded={Boolean(downloadMenu)} onClick={(e) => setDownloadMenu({ element: e.currentTarget, align: 'end' })}>
            <Download size={17} />
          </button>
        )}
        {/* Скачать презентацию — в панели слайдов; здесь — загрузить её из PowerPoint или PDF. */}
        {item.kind === 'presentation' && !shared && !readOnly && (
          <button type="button" className="nx-ghost nws-upload-btn" aria-haspopup="menu" aria-expanded={Boolean(uploadMenu)} disabled={importing}
            title="Загрузить из PowerPoint (.pptx) или PDF" onClick={(e) => setUploadMenu({ element: e.currentTarget, align: 'end' })}>
            {importing ? <Spinner size={14} label="Загружаю" /> : <Upload size={15} aria-hidden="true" />} <span className="nws-label">{importing ? 'Загружаю…' : 'Загрузить'}</span>
          </button>
        )}
        {!shared && (
          <button type="button" className="nx-primary nws-share-btn" onClick={() => setShare(true)} title="Поделиться"><Share2 size={14} aria-hidden="true" /> <span>Поделиться</span></button>
        )}
        {!shared && (
          <button type="button" className="nx-icon-btn" aria-label="Ещё" aria-haspopup="menu" aria-expanded={Boolean(menu)} onClick={(e) => setMenu({ element: e.currentTarget, align: 'end' })}>
            <MoreHorizontal size={18} />
          </button>
        )}
        {windowControls}
      </header>

      {conflict && (
        <div className="nws-banner" role="alert">
          Пока вы правили, материал изменил кто-то другой.
          <button type="button" className="nx-ghost" onClick={() => void session.resolveConflict(false)}>Взять чужую версию</button>
          <button type="button" className="nx-primary" onClick={() => void session.resolveConflict(true)}>Оставить мою</button>
        </div>
      )}

      <div className="nws-editor">
        <Suspense fallback={<div className="nws-loading"><Spinner size={24} label="Загружаю редактор" /></div>}>
          <Editor content={item.content} onContent={session.setContent} readOnly={readOnly} loadKey={loadKey} title={item.title} visible cursors={cursors} onCursor={sendCursor} live={session.live} />
        </Suspense>
      </div>

      {!shared && (
        <input ref={importInput} type="file" accept={IMPORT_RULES[item.kind].accept} hidden onChange={(e) => void importInto(e.target.files?.[0])} />
      )}

      {uploadMenu && (
        <Menu anchor={uploadMenu} label="Загрузить презентацию" onClose={() => setUploadMenu(null)}>
          <MenuItem icon={<FilePlus size={15} />} onSelect={() => { setUploadMenu(null); pickImport('append'); }}>Добавить слайды из файла…</MenuItem>
          <MenuItem icon={<Upload size={15} />} onSelect={() => { setUploadMenu(null); pickImport('replace'); }}>Заменить презентацию файлом…</MenuItem>
        </Menu>
      )}

      {downloadMenu && (
        <Menu anchor={downloadMenu} label="Скачать" onClose={() => setDownloadMenu(null)}>
          {(item.kind === 'document' || item.kind === 'note') && (
            <>
              <MenuItem icon={<Download size={15} />} onSelect={() => { setDownloadMenu(null); void downloadDocx(); }}>Word (.docx)</MenuItem>
              <MenuItem icon={<Printer size={15} />} onSelect={() => { setDownloadMenu(null); void print(); }}>PDF (через печать)</MenuItem>
              <MenuItem icon={<Download size={15} />} onSelect={() => { setDownloadMenu(null); downloadText(`${name}.md`, 'text/markdown', markdown()); }}>Markdown (.md)</MenuItem>
              <MenuItem icon={<Download size={15} />} onSelect={() => { setDownloadMenu(null); downloadText(`${name}.txt`, 'text/plain', plainText()); }}>Текст (.txt)</MenuItem>
              <MenuItem icon={<Download size={15} />} onSelect={() => { setDownloadMenu(null); downloadText(`${name}.html`, 'text/html', markdownHtml(item.title || info.untitled, markdown(true))); }}>Веб-страница (.html)</MenuItem>
            </>
          )}
          {item.kind === 'table' && (
            <>
              <MenuItem icon={<Download size={15} />} onSelect={() => { setDownloadMenu(null); void session.refreshContent().then(() => downloadBase64(`${name}.xlsx`, XLSX_MIME, session.getContent())); }}>Excel (.xlsx)</MenuItem>
              <MenuItem icon={<Download size={15} />} onSelect={() => { setDownloadMenu(null); void downloadCsv(); }}>CSV (.csv)</MenuItem>
            </>
          )}
        </Menu>
      )}

      {menu && !shared && (
        <Menu anchor={menu} label="Действия с материалом" onClose={() => setMenu(null)}>
          {item.isOwner && (
            <MenuItem icon={item.pinned ? <PinOff size={15} /> : <Pin size={15} />} onSelect={() => { setMenu(null); void patch({ pinned: !item.pinned }); }}>
              {item.pinned ? 'Открепить' : 'Закрепить сверху'}
            </MenuItem>
          )}
          <MenuItem icon={<Send size={15} />} onSelect={() => { setMenu(null); setSendToChat(true); }}>Отправить в чат</MenuItem>
          {canSticky(item.kind) && <MenuItem icon={<MonitorUp size={15} />} onSelect={() => { setMenu(null); void openSticky(item.id, null, { kind: item.kind }); }}>{stickyLabel(item.kind)}</MenuItem>}
          <MenuItem icon={<Link2 size={15} />} onSelect={() => { setMenu(null); void copyLink(); }}>Скопировать ссылку на материал</MenuItem>
          <MenuItem icon={<Copy size={15} />} onSelect={() => { setMenu(null); void duplicate(); }}>Сделать копию</MenuItem>
          {!readOnly && (
            <>
              <MenuItem icon={<Upload size={15} />} onSelect={() => { setMenu(null); pickImport('replace'); }}>Импорт из файла (заменить)…</MenuItem>
              {item.kind !== 'table' && <MenuItem icon={<FilePlus size={15} />} onSelect={() => { setMenu(null); pickImport('append'); }}>{item.kind === 'presentation' ? 'Добавить слайды из файла…' : 'Добавить из файла в конец…'}</MenuItem>}
            </>
          )}
          {item.kind === 'note' && !readOnly && (
            <div className="nws-colors" role="group" aria-label="Цвет метки">
              {NOTE_COLORS.map((c) => (
                <button key={c.value} type="button" className="nws-swatch" data-color={c.value} aria-pressed={(item.meta.color || 'default') === c.value} title={c.label} aria-label={c.label}
                  onClick={() => { setMenu(null); void patch({ meta: { color: c.value } }); }} />
              ))}
            </div>
          )}
          {item.isOwner && <MenuItem icon={<Trash2 size={15} />} tone="danger" onSelect={() => { setMenu(null); void remove(); }}>Удалить</MenuItem>}
        </Menu>
      )}

      {versionsOpen && !shared && (
        <VersionsSheet itemId={item.id} kind={item.kind} currentContent={session.getContent} onClose={() => setVersionsOpen(false)} onRestored={() => { void session.reload(); onChanged?.(); }} />
      )}

      {sendToChat && !shared && (
        <SendToChatSheet
          item={{ id: item.id, kind: item.kind, title: item.title, isOwner: item.isOwner, accessLevel, accessMode: (item.accessMode ?? 'edit') as AccessMode }}
          onClose={() => setSendToChat(false)}
        />
      )}

      {share && !shared && (
        <ShareDialog
          item={{ id: item.id, kind: item.kind, title: item.title, accessLevel, accessMode: (item.accessMode ?? 'edit') as AccessMode, isOwner: item.isOwner, canEdit: item.canEdit }}
          onClose={() => setShare(false)}
          onChanged={() => {
            // Подтягиваем только поля доступа: перезагрузка пересобрала бы редактор под руками.
            void session.patchFields({}).catch(() => undefined);
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}

/** Начальное содержимое нового материала. Таблица собирается асинхронно (exceljs грузится по требованию). */
export async function initialContent(kind: Kind): Promise<string> {
  if (kind === 'document') return JSON.stringify(markdownToSnapshot('', ''));
  if (kind === 'table') return (await import('./lib/workbook')).emptyTableContent();
  if (kind === 'presentation') {
    const { newDeck, serializeDeck } = await import('./slides/deck');
    return serializeDeck(newDeck());
  }
  return '';
}
