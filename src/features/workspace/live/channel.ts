import { realtime } from '@/shared/realtime/realtime';

/**
 * Совместная правка в реальном времени (документы и таблицы), как в Google Docs.
 *
 * Каждая правка редактора — мутация Univer `{id, params}` — сразу уходит по сокету. Сервер (server/…/workspace/live.py)
 * выстраивает правки всех в один порядок и раздаёт: у материала номер версии `rev`, правка принимается, только если
 * отправлена от текущей версии. Здесь — клиент классической схемы «одна правка в пути»:
 *
 *  - `inflight` — отправленная пачка, ждёт подтверждения (своё событие `workspace_ops` с нашим cid и номером пачки bid);
 *  - `buffer` — набранное, пока пачка в пути; уйдёт следующей одной пачкой;
 *  - чужая правка переносится через наши неподтверждённые (`transform`), применяется в редакторе, а наши — через неё.
 *    Так у всех сходится одно и то же без вопросов «чью версию оставить»;
 *  - отказ «отстал» (`workspace_ops_behind`) приносит недостающие правки: применяем, переносим свою пачку, шлём снова;
 *  - пропуск в номерах, переподключение сокета, возврат в окно — догоняем запросом GET …/live.
 *
 * Содержимое в базе сохраняет сам клиент, когда у него нет неподтверждённых правок: тогда его редактор ровно в
 * версии `rev`, и сохранение идёт с этим номером (без конфликтов: сервер берёт, если такой версии ещё нет).
 */

export interface LiveOp { id: string; params: Record<string, unknown> }
export interface LiveEntry { rev: number; cid: string; bid: number; userId: string; ops: LiveOp[] }
export interface LiveStart { epoch: string; rev: number; ops: LiveEntry[]; stale?: boolean }

/** Перенос: `local` (ещё не в общем порядке) и `remote` (уже в нём, раньше) сделаны от одного состояния. */
export type Transform = (local: LiveOp[], remote: LiveOp[]) => [LiveOp[], LiveOp[]];

/** Что канал требует от редактора. */
export interface LiveEditor {
  /** Применить чужие правки (уже перенесённые через наши), не трогая своё выделение и историю отмены. */
  apply: (ops: LiveOp[]) => void;
  /** Содержимое в текущем состоянии: снимок берётся синхронно в момент вызова, файл может собираться дольше. */
  serialize: () => Promise<string>;
}

export type LiveStatus = 'synced' | 'sending' | 'saving' | 'offline';

/** Связь с сервером: сокет (кадры и события) и догоняющий запрос. Подменяется в проверках. */
export interface LiveTransport {
  subscribe: (fn: (event: Record<string, unknown>) => void) => () => void;
  send: (frame: { type: string } & Record<string, unknown>) => boolean;
  onStatus: (fn: (status: string) => void) => () => void;
  fetchOps: (itemId: string, epoch: string, since: number) => Promise<{ reset?: boolean; rev?: number; ops?: LiveEntry[] } | null>;
}

const socketTransport: LiveTransport = {
  subscribe: (fn) => realtime.subscribe((event) => fn(event as Record<string, unknown>)),
  send: (frame) => realtime.send(frame),
  onStatus: (fn) => realtime.onStatus(fn),
  fetchOps: async (itemId, epoch, since) => {
    const qs = new URLSearchParams({ epoch, since: String(since) });
    const res = await fetch(`/api/workspace/items/${encodeURIComponent(itemId)}/live?${qs}`, { cache: 'no-store' });
    return res.ok ? res.json() : null;
  },
};

export interface LiveHooks {
  itemId: string;
  canEdit: boolean;
  transform: Transform;
  /** Записать содержимое версии rev. 'already' — эту или более новую версию уже сохранил коллега. */
  save: (content: string, mark: { epoch: string; rev: number }) => Promise<'saved' | 'already'>;
  /** Журнал больше не описывает материал (записали мимо совместной правки, версия из истории): открыть заново. */
  onReset: () => void;
  onStatus?: (status: LiveStatus) => void;
  transport?: LiveTransport;
  /** Как часто записывать в базу, пока правки идут. */
  saveEvery?: number;
  /**
   * Записывать в базу только после паузы в правках (мс), но не реже раза в SAVE_IDLE_CAP_MS. Для таблицы и документа:
   * их снимок собирается в основном потоке (xlsx большой таблицы — полсекунды), и посреди набора это ощущается лагом.
   */
  saveIdle?: number;
}

/** Сколько ждать после своей правки, прежде чем записать в базу (и не реже, пока правки идут подряд). */
const SAVE_AFTER_MS = 2000;
/**
 * «Сохраняю…» показываем, только если сервер не подтвердил правку дольше этого: обычно ответ приходит за доли
 * секунды, и мигать статусом на каждую букву незачем. Подтверждённая правка уже в журнале и у коллег — «Сохранено»;
 * запись снимка в базу идёт в фоне и в статус не попадает.
 */
const SENDING_SHOW_MS = 600;
const SAVE_IDLE_CAP_MS = 30_000;
/** Чужие несохранённые правки сохраняем сами, если за это время их не сохранил автор (закрыл окно, пропала сеть). */
const SAVE_FOR_OTHERS_MS = 8000;
const ACK_TIMEOUT_MS = 8000;
const GAP_WAIT_MS = 1200;
const BEAT_MS = 20_000;

const newCid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).slice(0, 36);

/** Перенос двух списков правок через пару правок: стандартная «решётка» OT. */
export function transformLists(local: LiveOp[], remote: LiveOp[], pair: (l: LiveOp, r: LiveOp) => [LiveOp | null, LiveOp | null]): [LiveOp[], LiveOp[]] {
  let rest = remote;
  const out: LiveOp[] = [];
  for (const l of local) {
    let cur: LiveOp | null = l;
    const next: LiveOp[] = [];
    for (const r of rest) {
      if (!cur) { next.push(r); continue; }
      const [l2, r2] = pair(cur, r);
      cur = l2;
      if (r2) next.push(r2);
    }
    if (cur) out.push(cur);
    rest = next;
  }
  return [out, rest];
}

export class LiveChannel {
  readonly cid = newCid();
  private epoch: string;
  private rev: number;
  /** Номер пачки этого редактора: повтор той же пачки сервер узнаёт и второй раз не применяет. */
  private bid = 0;
  private inflight: { bid: number; ops: LiveOp[]; sentAt: number } | null = null;
  private buffer: LiveOp[] = [];
  /** Правки, пришедшие с опережением (номер больше следующего): ждут недостающие. */
  private early = new Map<number, LiveEntry>();
  private editor: LiveEditor | null = null;
  /** Чужие правки, пришедшие до того, как редактор подключился. */
  private queued: LiveOp[] = [];
  private savedRev: number;
  /** Последняя версия, где есть наша правка: её сохраняем сами и быстро. */
  private authoredRev = 0;
  private saving = false;
  private saveTimer = 0;
  private saveDue = 0;
  /** С какого момента есть своя правка, не записанная в базу (для потолка ожидания паузы). */
  private dirtySince = 0;
  private sendingTimer = 0;
  private gapTimer = 0;
  private ackTimer = 0;
  private beatTimer = 0;
  private catching = false;
  private closed = false;
  private offs: Array<() => void> = [];
  private status: LiveStatus = 'synced';
  private net: LiveTransport;

  constructor(private hooks: LiveHooks, start: LiveStart, savedRev: number) {
    this.epoch = start.epoch;
    this.rev = start.rev;
    this.savedRev = savedRev;
    this.net = hooks.transport ?? socketTransport;
    this.offs.push(this.net.subscribe((event) => this.onEvent(event)));
    this.offs.push(this.net.onStatus((s) => { if (s !== 'open' && this.pendingCount()) this.setStatus('offline'); }));
    if (typeof document !== 'undefined') {
      const onVisible = () => { if (document.visibilityState === 'visible') void this.catchUp(); };
      document.addEventListener('visibilitychange', onVisible);
      this.offs.push(() => document.removeEventListener('visibilitychange', onVisible));
    }
    this.beat();
    // Раз в 20 с: «я в материале» и сверка с журналом — потерянную последнюю правку не по чему заметить иначе.
    this.beatTimer = window.setInterval(() => { this.beat(); void this.catchUp(); }, BEAT_MS);
    // Правки после сохранённой в базе версии: редактор применит их сразу после подключения.
    for (const entry of start.ops) this.receive(entry);
    if (start.stale) void this.catchUp();
  }

  /** Подключить редактор. Возвращает отключение. */
  attach(editor: LiveEditor): () => void {
    this.editor = editor;
    if (this.queued.length) {
      const ops = this.queued;
      this.queued = [];
      editor.apply(ops);
    }
    this.scheduleSave();
    return () => { if (this.editor === editor) this.editor = null; };
  }

  /** Своя правка из редактора. */
  local(ops: LiveOp[]) {
    if (this.closed || !this.hooks.canEdit || !ops.length) return;
    this.buffer.push(...ops);
    if (!this.sendingTimer && this.status !== 'sending') {
      this.sendingTimer = window.setTimeout(() => { this.sendingTimer = 0; if (this.pendingCount()) this.setStatus('sending'); }, SENDING_SHOW_MS);
    }
    this.flush();
  }

  /** Есть ли что-то не дошедшее до сервера или не сохранённое в базе (для «сохранено» и ухода со страницы). */
  pendingCount(): number {
    return (this.inflight?.ops.length ?? 0) + this.buffer.length;
  }

  hasUnsaved(): boolean {
    return this.pendingCount() > 0 || this.authoredRev > this.savedRev;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.offs) off();
    window.clearTimeout(this.saveTimer);
    window.clearTimeout(this.sendingTimer);
    window.clearTimeout(this.gapTimer);
    window.clearTimeout(this.ackTimer);
    window.clearInterval(this.beatTimer);
    this.net.send({ type: 'live', itemId: this.hooks.itemId, state: 'leave' });
    this.editor = null;
  }

  /** Содержимое как есть сейчас — для скачивания, печати, копии (редактор собирает его по запросу). */
  snapshot(): Promise<string> | null {
    return this.editor ? this.editor.serialize() : null;
  }

  /** Сохранить сейчас, если можно (Ctrl+S, уход со страницы). */
  saveNow() {
    window.clearTimeout(this.saveTimer);
    void this.save();
  }

  private beat() {
    this.net.send({ type: 'live', itemId: this.hooks.itemId, state: 'join' });
  }

  private setStatus(next: LiveStatus) {
    if (next === this.status) return;
    this.status = next;
    this.hooks.onStatus?.(next);
  }

  private flush() {
    if (this.closed || this.inflight || !this.buffer.length) return;
    const ops = this.buffer;
    this.buffer = [];
    this.bid += 1;
    this.inflight = { bid: this.bid, ops, sentAt: Date.now() };
    this.send();
  }

  private send() {
    if (!this.inflight) return;
    window.clearTimeout(this.ackTimer);
    this.inflight.sentAt = Date.now();
    const sent = this.net.send({ type: 'ops', itemId: this.hooks.itemId, epoch: this.epoch, base: this.rev, cid: this.cid, bid: this.inflight.bid, ops: this.inflight.ops });
    if (!sent) { this.setStatus('offline'); return; } // сокет поднимется — onStatus('open') догонит и отправит
    // Ответ потерялся (сокет оборвался между отправкой и ответом): догоняем — там видно, принята ли пачка.
    this.ackTimer = window.setTimeout(() => void this.catchUp(), ACK_TIMEOUT_MS);
  }

  private onEvent(e: Record<string, unknown>) {
    if (this.closed || String(e.itemId) !== this.hooks.itemId) return;
    switch (e.type) {
      case 'workspace_ops':
        if (e.epoch !== this.epoch) return;
        this.receive(e as unknown as LiveEntry);
        return;
      case 'workspace_ops_behind': {
        if (e.cid !== this.cid || e.epoch !== this.epoch) return;
        for (const entry of (e.ops as LiveEntry[]) || []) this.receive(entry);
        // Пачка не принята: все правки до текущей версии уже перенесли её — отправляем снова с новым основанием.
        // (Если она всё-таки была принята раньше — подтверждение уже пришло среди этих правок, и пачки в пути нет.)
        if (this.inflight && this.inflight.bid === e.bid) {
          if (this.rev >= Number(e.rev)) this.send(); else void this.catchUp();
        }
        return;
      }
      case 'workspace_ops_denied':
        if (e.cid !== this.cid) return;
        // Права отозвали (или пачка слишком большая): эти правки не войдут в общий текст — открываем заново.
        this.hooks.onReset();
        return;
      case 'workspace_live_saved':
        if (e.epoch === this.epoch) {
          this.savedRev = Math.max(this.savedRev, Number(e.rev) || 0);
          if (!this.pendingCount()) this.setStatus('synced');
        }
        return;
      case 'workspace_live_reset':
        this.hooks.onReset();
        return;
      // Сокет переподключился: кадры принимаются только после приветствия с их списком — тогда и догоняем.
      case 'hello':
        this.beat();
        void this.catchUp();
        return;
      case 'resync':
        void this.catchUp();
        return;
      default:
    }
  }

  /** Правка из общего порядка: своя — подтверждение, чужая — перенос и применение. По порядку номеров. */
  private receive(entry: LiveEntry) {
    const rev = Number(entry.rev);
    if (!Number.isFinite(rev) || rev <= this.rev) return;
    if (rev > this.rev + 1) {
      this.early.set(rev, entry);
      window.clearTimeout(this.gapTimer);
      this.gapTimer = window.setTimeout(() => void this.catchUp(), GAP_WAIT_MS);
      return;
    }
    this.take(entry);
    for (let next = this.early.get(this.rev + 1); next; next = this.early.get(this.rev + 1)) {
      this.early.delete(Number(next.rev));
      this.take(next);
    }
    for (const key of [...this.early.keys()]) if (key <= this.rev) this.early.delete(key);
    if (!this.early.size) window.clearTimeout(this.gapTimer);
  }

  private take(entry: LiveEntry) {
    this.rev = Number(entry.rev);
    if (entry.cid === this.cid && this.inflight && entry.bid === this.inflight.bid) {
      window.clearTimeout(this.ackTimer);
      this.inflight = null;
      this.authoredRev = this.rev;
      this.flush();
      if (!this.pendingCount()) {
        window.clearTimeout(this.sendingTimer);
        this.sendingTimer = 0;
        this.setStatus('synced');
      }
      this.scheduleSave();
      return;
    }
    if (entry.cid === this.cid) return; // своя старая пачка, уже учтённая
    let remote = entry.ops || [];
    if (this.inflight) {
      const [mine, theirs] = this.hooks.transform(this.inflight.ops, remote);
      this.inflight.ops = mine;
      remote = theirs;
    }
    if (this.buffer.length) {
      const [mine, theirs] = this.hooks.transform(this.buffer, remote);
      this.buffer = mine;
      remote = theirs;
    }
    if (remote.length) {
      if (this.editor) {
        try { this.editor.apply(remote); } catch (cause) {
          // Правка не легла (редкая несовместимость): открыть заново надёжнее, чем разойтись с остальными.
          console.warn('[live] remote op failed', cause);
          this.hooks.onReset();
          return;
        }
      } else this.queued.push(...remote);
    }
    this.scheduleSave();
  }

  private async catchUp() {
    if (this.closed || this.catching) return;
    this.catching = true;
    try {
      const data = await this.net.fetchOps(this.hooks.itemId, this.epoch, this.rev);
      if (!data || this.closed) return;
      if (data.reset) { this.hooks.onReset(); return; }
      for (const entry of data.ops || []) this.receive(entry);
      // Пачка в пути, но её нет в журнале: до сервера не дошла (или ещё идёт) — отправляем снова от текущей версии.
      // Повтор безопасен: принятую пачку сервер узнает по номеру и второй раз не применит.
      if (this.inflight) this.send(); else this.flush();
    } catch { /* сеть моргнула — следующее событие или переподключение догонят */ } finally {
      this.catching = false;
    }
  }

  /**
   * Сохранение в базу. Свою правку сохраняем вскоре после подтверждения; чужие несохранённые (автор закрыл окно
   * раньше, чем успел сохранить) — с запасом, если их так никто и не сохранил.
   */
  private scheduleSave(delay?: number) {
    if (this.closed || !this.hooks.canEdit || this.rev <= this.savedRev) return;
    const mine = this.authoredRev > this.savedRev;
    if (delay === undefined && mine && this.hooks.saveIdle) {
      // Ждём паузы: каждая своя правка отодвигает запись, но не дальше потолка от первой незаписанной.
      const now = Date.now();
      if (!this.dirtySince) this.dirtySince = now;
      const due = Math.min(now + this.hooks.saveIdle, this.dirtySince + SAVE_IDLE_CAP_MS);
      window.clearTimeout(this.saveTimer);
      this.saveDue = due;
      this.saveTimer = window.setTimeout(() => { this.saveTimer = 0; void this.save(); }, Math.max(0, due - now));
      return;
    }
    const wait = delay ?? (mine ? this.hooks.saveEvery ?? SAVE_AFTER_MS : SAVE_FOR_OTHERS_MS + Math.random() * 4000);
    const due = Date.now() + wait;
    // Уже назначено не позже — не откладываем: при печати без пауз база всё равно обновляется регулярно.
    if (this.saveTimer && this.saveDue <= due) return;
    window.clearTimeout(this.saveTimer);
    this.saveDue = due;
    this.saveTimer = window.setTimeout(() => { this.saveTimer = 0; void this.save(); }, wait);
  }

  private async save() {
    if (this.closed || this.saving || !this.editor || !this.hooks.canEdit) return;
    if (this.rev <= this.savedRev) return;
    // Неподтверждённые правки есть — редактор не в версии rev; пробуем снова, как только пачка подтвердится.
    if (this.pendingCount()) { this.scheduleSave(300); return; }
    this.saving = true;
    const rev = this.rev;
    const epoch = this.epoch;
    try {
      const content = await this.editor.serialize();
      await this.hooks.save(content, { epoch, rev });
      this.savedRev = Math.max(this.savedRev, rev);
      if (this.savedRev >= this.authoredRev) this.dirtySince = 0;
    } catch {
      // 409 и прочее разбирает сессия (перечитывание); правки целы в журнале — пробуем записать позже.
      this.scheduleSave(4000);
    } finally {
      this.saving = false;
      if (!this.closed && this.rev > this.savedRev) this.scheduleSave();
    }
  }
}
