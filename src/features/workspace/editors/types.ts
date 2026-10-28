import type { CursorPos, RemoteCursor } from '../useCursors';
import type { LiveChannel } from '../live/channel';
import type { CommentAnchor } from '../types';

/** Связь панели комментариев с редактором: что сейчас выделено (для нового комментария) и переход к месту ветки. */
export interface CommentsBridge {
  anchor: () => CommentAnchor | null;
  jump: (anchor: CommentAnchor) => void;
  /** Команда редактора по имени (отменить, жирный…). false — такой команды в этой сборке нет. */
  exec: (commandId: string) => boolean;
  has: (commandId: string) => boolean;
}
/**
 * Контракт редактора вида. Редактор сам разбирает и собирает формат содержимого;
 * сессия (useItemSession) видит только строку и отвечает за сохранение.
 */
export interface EditorProps {
  /** Содержимое, с которого начинается правка. Подмена без смены loadKey редактор не перечитывает. */
  content: string;
  /** Правка: новое содержимое целиком. Вызывается и на каждое изменение, и после серии — сессия сама склеивает. */
  onContent: (next: string) => void;
  readOnly: boolean;
  /** Меняется, когда материал надо открыть заново (перечитали с сервера, решили конфликт). */
  loadKey: number;
  /** Редактор на экране (для пересчёта размеров холста). */
  visible?: boolean;
  /** Публичная ссылка: без меню владельца. */
  title?: string;
  /** Курсоры других людей в материале. */
  cursors?: RemoteCursor[];
  /** Своё положение курсора — для остальных (null — ушёл из текста). */
  onCursor?: (pos: CursorPos | null) => void;
  /**
   * Совместная правка в реальном времени (документы и таблицы): редактор отдаёт в канал свои правки и применяет
   * чужие на месте. Сохраняет в базу сам канал; onContent тогда нужен только для экспорта и копирования.
   */
  live?: LiveChannel | null;
  /** Документ и таблица кладут сюда свои функции для панели комментариев. */
  commentsBridge?: React.MutableRefObject<CommentsBridge | null>;
  /** Таблица: ячейки с открытыми комментариями — на них рисуется отметка-уголок. */
  commentCells?: Array<{ sheet: string; cell: string }>;
  /** «Комментарий» в контекстном меню редактора: открыть панель с новым комментарием к выделенному. */
  onAddComment?: () => void;
  /** Документ: цитаты открытых комментариев — этот текст подсвечивается. */
  commentQuotes?: string[];
  /** Документ: курсор встал в прокомментированный текст — показать ветку. */
  onCommentQuote?: (quote: string) => void;
  /** Таблица: выбрали ячейку с открытым комментарием — показать его ветку. */
  onCommentCell?: (cell: { sheet: string; cell: string }) => void;
}
