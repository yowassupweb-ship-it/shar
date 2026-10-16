import { useParams } from 'react-router';
import { Eye, Pencil } from 'lucide-react';
import { useEffect, useState } from 'react';
import { workspaceApi } from './api';
import { ItemView } from './ItemView';
import './workspace.css';

/**
 * Материал по ссылке (/n/…, /d/…, /t/…, /p/…): открывается без входа в Шар. Что можно — решает ссылка:
 * «просмотр» — читалка без ленты и меню, «правка» — тот же редактор. К остальному Шару доступа нет.
 */
export default function SharedPage() {
  const { token = '' } = useParams();
  const [mode, setMode] = useState<'view' | 'edit' | null>(null);

  // Режим нужен для плашки сверху; сам материал загружает ItemView.
  useEffect(() => {
    let alive = true;
    workspaceApi.shared(token).then((r) => { if (alive) setMode(r.mode); }).catch(() => { if (alive) setMode(null); });
    return () => { alive = false; };
  }, [token]);

  return (
    <div className="nx nws-shared">
      <div className="nws-shared-bar">
        <img src="/logo-shar-120.png" alt="" width={22} height={22} />
        <b>Шар</b>
        {mode && (
          <span className="nws-shared-mode">
            {mode === 'edit' ? <><Pencil size={13} aria-hidden="true" /> Можно редактировать</> : <><Eye size={13} aria-hidden="true" /> Только просмотр</>}
          </span>
        )}
      </div>
      <div className="nws-shared-body">
        <ItemView key={token} source={{ token }} />
      </div>
    </div>
  );
}
