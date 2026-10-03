import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { showToast } from '@/shared/ui/Toast';
import { useShellOptions } from '@/shared/shell/ShellContext';
import { folderChain, getFile, type CloudFolder } from './api';
import CloudView from './CloudView';
import { ChatFiles, ChatList } from './ChatFilesView';

/**
 * Раздел «Файлы» нового шара: «Мои файлы» (облако с папками) и «Из чатов»
 * (всё, что присылали в переписках). Переключатель — в шапке, без сайдбара.
 *
 * Адрес — источник правды: `?folder=`, `?file=`, `?chat=`. Ссылкой можно поделиться, «назад» в браузере работает.
 */

type View =
  | { kind: 'cloud'; folderId: string | null; fileId?: string | null }
  | { kind: 'chats'; chatId: string | null; chatName?: string };

const subscribeNoop = () => () => {};

function readView(): View {
  const p = new URLSearchParams(window.location.search);
  if (p.has('chat')) return { kind: 'chats', chatId: p.get('chat') || null, chatName: p.get('name') || undefined };
  return { kind: 'cloud', folderId: p.get('folder'), fileId: p.get('file') };
}

function writeView(v: View, push = true) {
  const url = new URL(window.location.href);
  for (const k of ['folder', 'file', 'chat', 'name']) url.searchParams.delete(k);
  if (v.kind === 'cloud' && v.folderId) url.searchParams.set('folder', v.folderId);
  if (v.kind === 'chats') {
    url.searchParams.set('chat', v.chatId || '');
    if (v.chatId && v.chatName) url.searchParams.set('name', v.chatName);
  }
  if (url.href === window.location.href) return;
  if (push) window.history.pushState({ nfPushed: true }, '', url); else window.history.replaceState(window.history.state, '', url);
}

export default function FilesScreen() {
  const mounted = useSyncExternalStore(subscribeNoop, () => true, () => false);
  const [view, setView] = useState<View>(() => (typeof window === 'undefined' ? { kind: 'cloud', folderId: null } : readView()));
  const [trail, setTrail] = useState<CloudFolder[]>([]);
  const [highlight, setHighlight] = useState<string | null>(null);
  const cachedTrail = useRef<CloudFolder[]>([]);
  useEffect(() => { cachedTrail.current = trail; }, [trail]);

  // Папка из адреса → цепочка крошек. Файл из адреса → его папка и подсветка.
  const resolve = useCallback(async (v: View) => {
    if (v.kind !== 'cloud') return;
    if (v.fileId) {
      const f = await getFile(v.fileId);
      if (!f) { showToast('Файл не найден или к нему нет доступа', 'error'); setTrail([]); return; }
      setTrail(f.folderId ? await folderChain(f.folderId) : []);
      setHighlight(f.id);
      return;
    }
    if (!v.folderId) { setTrail([]); return; }
    const known = cachedTrail.current.findIndex((x) => x.id === v.folderId);
    if (known >= 0) { setTrail(cachedTrail.current.slice(0, known + 1)); return; }
    const chain = await folderChain(v.folderId);
    if (!chain.length) showToast('Папка не найдена или к ней нет доступа', 'error');
    setTrail(chain);
  }, []);

  useEffect(() => {
    // Цепочка папок из адреса — после монтирования, отдельной задачей.
    void Promise.resolve(readView()).then(resolve);
    const onPop = () => { const v = readView(); setView(v); void resolve(v); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [resolve]);

  const go = useCallback((v: View) => { writeView(v); setView(v); setHighlight(null); }, []);

  const openFolder = (f: CloudFolder) => {
    setTrail((t) => [...t, f]);
    go({ kind: 'cloud', folderId: f.id });
  };
  const crumb = (i: number) => {
    setTrail((t) => t.slice(0, i + 1));
    go({ kind: 'cloud', folderId: i < 0 ? null : trail[i].id });
  };
  useShellOptions({
    navHidden: false,
    onReselect: () => { setTrail([]); go({ kind: 'cloud', folderId: null }); },
  });

  if (!mounted) return null;

  // Переключатель «Мои файлы / Из чатов» — прямо в шапке раздела: ради двух
  // пунктов сайдбар не нужен, место отдаём файлам.
  const lead = (
    <div className="nx-segment nf-switch" role="group" aria-label="Раздел">
      <button type="button" aria-pressed={view.kind === 'cloud'} onClick={() => crumb(-1)}>Мои файлы</button>
      <button type="button" aria-pressed={view.kind === 'chats'} onClick={() => go({ kind: 'chats', chatId: null })}>Из чатов</button>
    </div>
  );

  return (
    <main className="nfn" aria-label="Файлы">
      {view.kind === 'cloud' && <CloudView lead={lead} trail={trail} onOpenFolder={openFolder} onCrumb={crumb} highlightId={highlight} />}
      {view.kind === 'chats' && !view.chatId && <ChatList lead={lead} onOpen={(c) => go({ kind: 'chats', chatId: c.chatId, chatName: c.chatName })} />}
      {view.kind === 'chats' && view.chatId && (
        <ChatFiles lead={lead} key={view.chatId} chat={{ chatId: view.chatId, chatName: view.chatName || 'Чат' }} onBack={() => go({ kind: 'chats', chatId: null })} />
      )}
    </main>
  );
}
