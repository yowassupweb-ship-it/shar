import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import {
  ArrowRight, Bell, CheckCircle2, ChevronLeft, Chrome, Copy, Download, Laptop, MessageCircle, MonitorDown, Phone, RefreshCw,
  ShieldCheck, Smartphone, Wifi, type LucideIcon,
} from 'lucide-react';
import { paths, PUBLIC_ORIGIN } from '@/shared/navigation/routes';
import { showToast } from '@/shared/ui/Toast';
import {
  BROWSER_STEPS, DESKTOP_STEPS, FEATURES, HELP, NOTIFICATION_CHECKS, PHONE_STEPS, PRIORITY, PROD_URL, SECTIONS, UPDATES, WORK_RULES,
} from './content';
import './guide.css';

function Steps({ items }: { items: string[] }) {
  return <ol className="ngd-steps">{items.map((t) => <li key={t}>{t}</li>)}</ol>;
}

function Checks({ items }: { items: string[] }) {
  return (
    <ul className="ngd-checks">
      {items.map((t) => <li key={t}><CheckCircle2 size={16} aria-hidden="true" /><span>{t}</span></li>)}
    </ul>
  );
}

function Card({ icon: Icon, title, tone, children }: { icon: LucideIcon; title: string; tone?: string; children: ReactNode }) {
  return (
    <div className="ngd-card">
      <div className="ngd-card-head">
        <span className="ngd-card-icon" aria-hidden="true"><Icon size={18} /></span>
        <span><h3>{title}</h3>{tone && <small>{tone}</small>}</span>
      </div>
      {children}
    </div>
  );
}

function Section({ id, eyebrow, title, lead, children }: { id: string; eyebrow: string; title: string; lead?: string; children: ReactNode }) {
  return (
    <section id={`guide-${id}`} className="ngd-section" aria-labelledby={`guide-${id}-title`}>
      <p className="ngd-eyebrow">{eyebrow}</p>
      <h2 id={`guide-${id}-title`}>{title}</h2>
      {lead && <p className="ngd-lead">{lead}</p>}
      {children}
    </section>
  );
}

function Figure({ src, alt, width, height, caption }: { src: string; alt: string; width: number; height: number; caption: string }) {
  return (
    <figure className="ngd-figure">
      <img src={src} alt={alt} width={width} height={height} loading="lazy" />
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

/** Инструкция «Как пользоваться Шаром»: оглавление слева, разделы справа. */
export default function GuideScreen() {
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string>(SECTIONS[0].id);

  // Подсветка текущего раздела в оглавлении.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return undefined;
    const io = new IntersectionObserver((entries) => {
      const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) setActive(top.target.id.replace('guide-', ''));
    }, { root, rootMargin: '0px 0px -65% 0px' });
    root.querySelectorAll('.ngd-section').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  const go = (id: string) => document.getElementById(`guide-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(PROD_URL); showToast('Ссылка на Шар скопирована', 'success'); }
    catch { showToast(PROD_URL, 'info'); }
  };

  // Установщик лежит рядом с обновлениями (nginx отдаёт /updates). Адрес полный:
  // в приложении для компьютера относительный вёл бы на локальный 127.0.0.1.
  const download = `${PUBLIC_ORIGIN}/updates/Shar%20setup.exe`;

  // Назад — туда, откуда пришли (в приложении для компьютера иначе вернуться нечем);
  // если страницу открыли по прямой ссылке, истории нет — тогда в «Ещё».
  const goBack = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx;
    if (typeof idx === 'number' && idx > 0) navigate(-1);
    else navigate(paths.more, { replace: true });
  };

  return (
    <div ref={scrollRef} className="nx-page nx-scroll-y">
      <div className="nx-page-inner ngd" data-wide="">
        <header className="nx-page-head ngd-head">
          <button type="button" className="nx-icon-btn nx-page-back" aria-label="Назад" title="Назад" onClick={goBack}>
            <ChevronLeft size={20} />
          </button>
          <h1>Инструкция</h1>
        </header>

        <div className="ngd-layout">
          <aside className="ngd-aside">
            <button type="button" className="ngd-brand" onClick={() => void copyLink()} title="Скопировать ссылку на Шар">
              <img src="/logo-shar-120.png" alt="" width={36} height={36} />
              <span><b>Шар</b><small><Copy size={11} aria-hidden="true" /> скопировать ссылку</small></span>
            </button>
            <nav className="ngd-toc" aria-label="Разделы инструкции">
              {SECTIONS.map((s) => (
                <button key={s.id} type="button" aria-current={active === s.id ? 'true' : undefined} onClick={() => go(s.id)}>{s.label}</button>
              ))}
            </nav>
            <p className="ngd-aside-note">Рабочая переписка с отделом продаж ведётся в Шаре. Просьба написать в другой мессенджер не считается рабочим маршрутом.</p>
          </aside>

          <div className="ngd-body">
            <section id="guide-start" className="ngd-section ngd-hero" aria-labelledby="guide-start-title">
              <div>
                <span className="nx-tag" data-tone="accent"><ShieldCheck size={12} aria-hidden="true" /> Основной канал рабочей переписки</span>
                <h2 id="guide-start-title" className="ngd-hero-title">Как поставить Шар и не потеряться в первый день</h2>
                <div className="ngd-cta">
                  <a className="nx-primary ngd-big" href={download}><Download size={16} aria-hidden="true" /> Скачать для Windows</a>
                  <button type="button" className="nx-ghost ngd-big" onClick={() => void copyLink()}>Ссылка для браузера <Copy size={14} aria-hidden="true" /></button>
                </div>
              </div>
              <ol className="ngd-priority" aria-label="Приоритет способов входа">
                {PRIORITY.map((p) => <li key={p.title}><b>{p.title}</b><span>{p.text}</span></li>)}
              </ol>
            </section>

            <Section id="desktop" eyebrow="Основной способ" title="Рабочий компьютер: ставим приложение"
              lead="Приложение держит Шар под рукой: отдельное окно, уведомления, меньше зависимости от вкладок браузера.">
              <Card icon={MonitorDown} title="Приложение для Windows" tone="для офиса и рабочего компьютера">
                <Steps items={DESKTOP_STEPS} />
                <div className="ngd-cta">
                  <a className="nx-primary" href={download}><Download size={15} aria-hidden="true" /> Скачать установщик</a>
                  <span className="nx-note">Если Windows спросит разрешение, подтвердите установку.</span>
                </div>
              </Card>
            </Section>

            <Section id="browser" eyebrow="Резерв" title="Браузер: когда приложение недоступно"
              lead="Браузер нужен как запасной вход: для удалённой работы, чужого компьютера или быстрой проверки.">
              <div className="ngd-grid">
                <Card icon={Chrome} title="Chrome или Яндекс Браузер" tone="рекомендованные браузеры">
                  <Steps items={BROWSER_STEPS} />
                  <button type="button" className="nx-ghost ngd-inline-cta" onClick={() => void copyLink()}>Скопировать адрес Шара <ArrowRight size={14} aria-hidden="true" /></button>
                </Card>
                <Card icon={Laptop} title="Что такое PWA" tone="сайт, который открывается как приложение">
                  <p className="ngd-text">PWA не скачивается из магазина. Вы открываете Шар в браузере, добавляете его на экран, и он запускается отдельной иконкой. На компьютере это резервный вариант, на телефоне — основной удобный.</p>
                  <Checks items={['PWA всё равно работает через интернет и требует входа в аккаунт.']} />
                </Card>
              </div>
            </Section>

            <Section id="phone" eyebrow="Телефон" title="На телефоне: браузер или PWA"
              lead="Установка на телефон добровольная. Но в рабочее время сообщения от отдела продаж приходят в Шар, поэтому доступ с телефона лучше настроить заранее.">
              <div className="ngd-grid">
                {PHONE_STEPS.map((g) => <Card key={g.title} icon={Smartphone} title={g.title} tone="короткая установка"><Steps items={g.items} /></Card>)}
              </div>
            </Section>

            <Section id="features" eyebrow="Возможности" title="Что есть в Шаре"
              lead="Шар — это не только переписка. Внутри собраны основные рабочие разделы, чтобы задачи, файлы и обсуждения не расходились по разным местам.">
              <div className="ngd-grid ngd-grid-3">
                {FEATURES.map((g) => <Card key={g.title} icon={CheckCircle2} title={g.title}><Checks items={g.items} /></Card>)}
              </div>
            </Section>

            <Section id="notifications" eyebrow="Уведомления" title="Чтобы сообщения не терялись"
              lead="Если уведомления выключены в браузере, системе или в самом чате, сообщение может прийти, но вы заметите его слишком поздно.">
              <div className="ngd-grid ngd-grid-aside">
                <Card icon={Bell} title="Разрешите уведомления при первом запросе">
                  <p className="ngd-text">Если Шар или браузер спрашивает про уведомления, выбирайте «Разрешить». Без этого новые сообщения видны только внутри открытого окна, без системного сигнала.</p>
                  <Checks items={NOTIFICATION_CHECKS} />
                  <Figure src="/how-to/chat-notification-bell.png" alt="Колокольчик уведомлений в чате" width={587} height={113}
                    caption="Внутри чата следите за колокольчиком: если уведомления для чата выключены, важное легко пропустить." />
                </Card>
                <Figure src="/how-to/notifications.png" alt="Запрос разрешения уведомлений" width={465} height={705}
                  caption="Когда появляется системный запрос, разрешите уведомления. Это нужно один раз, но именно этот шаг чаще всего забывают." />
              </div>
            </Section>

            <Section id="updates" eyebrow="Обновления" title="Что недавно менялось">
              <div className="nx-group">
                {UPDATES.map((u) => (
                  <article key={u.hash} className="nx-row ngd-update">
                    <span className="nx-row-text">
                      <span className="nx-row-hint">{u.date} · <code>{u.hash}</code></span>
                      <span className="nx-row-label">{u.title}</span>
                      <span className="nx-row-hint">{u.text}</span>
                    </span>
                  </article>
                ))}
              </div>
            </Section>

            <Section id="work" eyebrow="Рабочий режим" title="Как пользоваться без хаоса"
              lead="Шар заменяет рабочую переписку в Teams. Чем меньше параллельных каналов, тем меньше потерянных поручений.">
              <div className="ngd-grid">
                {WORK_RULES.map((r, i) => <Card key={r.title} icon={i === 0 ? MessageCircle : Phone} title={r.title}><p className="ngd-text">{r.text}</p></Card>)}
              </div>
            </Section>

            <Section id="help" eyebrow="Поддержка" title="Если что-то не работает"
              lead="Сначала проверьте простое. Если не помогло, напишите Антону и укажите, где именно застряли: установка, вход, уведомления или сообщения.">
              <div className="ngd-help">
                {HELP.map((h) => (
                  <article key={h.title} className="ngd-help-item" data-image={h.image ? 'true' : undefined}>
                    <div className="ngd-help-text">
                      {h.title.startsWith('Обновите') ? <RefreshCw size={18} aria-hidden="true" /> : <Wifi size={18} aria-hidden="true" />}
                      <div><h3>{h.title}</h3><p>{h.text}</p></div>
                    </div>
                    {h.image && <Figure {...h.image} />}
                  </article>
                ))}
              </div>
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}
