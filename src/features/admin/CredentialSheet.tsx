import { Copy, Printer } from 'lucide-react';
import { Sheet } from '@/shared/ui/overlay';
import { showToast } from '@/shared/ui/Toast';
import type { AdminUser } from './api';

const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Временный пароль: показывается один раз, дальше сервер хранит только хеш. */
export default function CredentialSheet({ user, password, onClose }: { user: AdminUser; password: string; onClose: () => void }) {
  const text = `Шар\nЛогин: ${user.username}\nВременный пароль: ${password}`;

  const copy = async () => {
    try { await navigator.clipboard.writeText(text); showToast('Скопировано', 'success'); }
    catch { showToast('Не удалось скопировать — выделите пароль вручную', 'error'); }
  };

  const print = () => {
    const win = window.open('', '_blank');
    if (!win) { showToast('Браузер не дал открыть окно печати', 'error'); return; }
    win.document.write(`<!doctype html><meta charset="utf-8"><title>Доступ в Шар</title>
      <body style="font-family:Arial,sans-serif;margin:32px"><h1 style="font-size:18px">Доступ в Шар</h1>
      <p>${esc(user.name || user.username || '')}</p><p>Логин: <b>${esc(user.username || '')}</b></p>
      <p>Временный пароль: <b style="font-family:monospace">${esc(password)}</b></p>
      <p style="color:#666;font-size:12px">Смените пароль после первого входа.</p></body>`);
    win.document.close();
    win.focus();
    window.setTimeout(() => { win.print(); win.close(); }, 300);
  };

  return (
    <Sheet title="Новый пароль" onClose={onClose} footer={<button type="button" className="nx-primary" onClick={onClose}>Готово</button>}>
      <p className="nx-note">Пароль виден только сейчас. Передайте его пользователю — позже посмотреть его будет нельзя, только сбросить заново.</p>
      <div className="nx-group">
        <div className="nx-row"><span className="nx-row-text"><span className="nx-row-label">Логин</span></span><code>{user.username}</code></div>
        <div className="nx-row"><span className="nx-row-text"><span className="nx-row-label">Пароль</span></span><code className="nad-password">{password}</code></div>
      </div>
      <div className="nx-actions">
        <button type="button" className="nx-ghost" onClick={() => void copy()}><Copy size={14} aria-hidden="true" /> Копировать</button>
        <button type="button" className="nx-ghost" onClick={print}><Printer size={14} aria-hidden="true" /> Печать</button>
      </div>
    </Sheet>
  );
}
