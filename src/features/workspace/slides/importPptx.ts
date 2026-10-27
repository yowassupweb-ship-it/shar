import { unzipSync, strFromU8 } from "fflate";
import { escapeHtml, sizeFor, THEMES, uid, type Deck, type Size, type Slide, type SlideElement, type TextStyle } from "./deck";

/**
 * PowerPoint (.pptx) → презентация Шара. Файл разбирается в браузере: каждый слайд — свои элементы с местом и размером
 * (у заполнителей — из макета и образца слайдов, как в PowerPoint), текст с жирным, курсивом, кеглем, цветом,
 * выравниванием и списками; фигуры с заливкой; картинки (уходят в хранилище, каждая один раз); фон слайда; таблицы —
 * строками текста; заметки докладчика. Цвета темы (accent1, tx1…) берутся из темы презентации.
 *
 * Чего нет: анимации, диаграммы, SmartArt, картинки EMF/WMF (их не рисует браузер), обрезка картинок.
 */

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const MAX_SLIDES = 150;
const EMU_PER_PT = 12700;
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml" };

type Files = Record<string, Uint8Array>;
type Box = { x: number; y: number; w: number; h: number };
/** Перевод координат: EMU → пиксели слайда, с учётом вложенных групп. */
type Transform = (box: Box) => Box;

const kids = (el: Element | null | undefined, ns: string, name: string) => (el ? Array.from(el.children).filter((c) => c.namespaceURI === ns && c.localName === name) : []);
const kid = (el: Element | null | undefined, ns: string, name: string) => kids(el, ns, name)[0] ?? null;
const path = (el: Element | null | undefined, steps: Array<[string, string]>) => steps.reduce<Element | null>((cur, [ns, name]) => kid(cur, ns, name), el ?? null);
const deep = (el: Element | null | undefined, ns: string, name: string) => (el ? Array.from(el.getElementsByTagNameNS(ns, name)) : []);

function xml(files: Files, name: string): Document | null {
  const data = files[name];
  return data ? new DOMParser().parseFromString(strFromU8(data), "application/xml") : null;
}

/** Связи части пакета: rId → путь внутри архива (относительные пути раскрываются). */
function rels(files: Files, part: string): Record<string, { target: string; type: string }> {
  const dir = part.slice(0, part.lastIndexOf("/"));
  const doc = xml(files, `${dir}/_rels/${part.slice(part.lastIndexOf("/") + 1)}.rels`);
  const out: Record<string, { target: string; type: string }> = {};
  for (const rel of Array.from(doc?.getElementsByTagName("Relationship") ?? [])) {
    const target = rel.getAttribute("Target") || "";
    if (rel.getAttribute("TargetMode") === "External") continue;
    const parts = (target.startsWith("/") ? target.slice(1) : `${dir}/${target}`).split("/");
    const resolved: string[] = [];
    for (const piece of parts) {
      if (piece === "..") resolved.pop();
      else if (piece !== ".") resolved.push(piece);
    }
    out[rel.getAttribute("Id") || ""] = { target: resolved.join("/"), type: rel.getAttribute("Type") || "" };
  }
  return out;
}

const relOfType = (map: ReturnType<typeof rels>, suffix: string) => Object.values(map).find((r) => r.type.endsWith(suffix))?.target;

/** Цвета темы: accent1…6, dk1/lt1 (tx1/bg1), dk2/lt2 (tx2/bg2). */
function themeColors(files: Files, masterPath: string | undefined): Record<string, string> {
  const colors: Record<string, string> = {};
  const themePath = masterPath ? relOfType(rels(files, masterPath), "/theme") : undefined;
  const scheme = deep(xml(files, themePath || "ppt/theme/theme1.xml")?.documentElement, A, "clrScheme")[0];
  for (const entry of Array.from(scheme?.children ?? [])) {
    const value = kid(entry, A, "srgbClr")?.getAttribute("val") || kid(entry, A, "sysClr")?.getAttribute("lastClr");
    if (value) colors[entry.localName] = `#${value}`;
  }
  return { ...colors, tx1: colors.dk1, bg1: colors.lt1, tx2: colors.dk2, bg2: colors.lt2 };
}

function colorOf(fill: Element | null, theme: Record<string, string>): string | undefined {
  if (!fill) return undefined;
  const srgb = kid(fill, A, "srgbClr")?.getAttribute("val");
  if (srgb) return `#${srgb}`;
  const scheme = kid(fill, A, "schemeClr")?.getAttribute("val");
  if (scheme) return theme[scheme];
  const sys = kid(fill, A, "sysClr")?.getAttribute("lastClr");
  return sys ? `#${sys}` : undefined;
}

/** Заполнитель слайда (заголовок, текст…) → его тип и номер: по ним ищется место в макете и образце. */
function placeholderOf(shape: Element): { type: string; idx: string } | null {
  const nv = kid(shape, P, "nvSpPr") || kid(shape, P, "nvPicPr") || kid(shape, P, "nvGraphicFramePr");
  const ph = path(nv, [[P, "nvPr"], [P, "ph"]]);
  return ph ? { type: ph.getAttribute("type") || "body", idx: ph.getAttribute("idx") || "" } : null;
}

/** Место заполнителя в макете или образце (у самого слайда его часто нет — как в PowerPoint, наследуется). */
function inheritedXfrm(templates: Document[], ph: { type: string; idx: string }): Element | null {
  for (const doc of templates) {
    const shapes = deep(doc.documentElement, P, "sp");
    const match = shapes.find((s) => { const p = placeholderOf(s); return p && ph.idx && p.idx === ph.idx; })
      || shapes.find((s) => { const p = placeholderOf(s); return p && p.type === ph.type; })
      || (ph.type === "ctrTitle" ? shapes.find((s) => placeholderOf(s)?.type === "title") : undefined)
      || (ph.type === "subTitle" || ph.type === "obj" ? shapes.find((s) => placeholderOf(s)?.type === "body") : undefined);
    const xfrm = path(match, [[P, "spPr"], [A, "xfrm"]]);
    if (xfrm) return xfrm;
  }
  return null;
}

function boxOf(xfrm: Element | null): Box | null {
  const off = kid(xfrm, A, "off");
  const ext = kid(xfrm, A, "ext");
  if (!off || !ext) return null;
  return { x: Number(off.getAttribute("x")) || 0, y: Number(off.getAttribute("y")) || 0, w: Number(ext.getAttribute("cx")) || 0, h: Number(ext.getAttribute("cy")) || 0 };
}

/** Текст фигуры → HTML блока Шара: абзацы, списки, жирный, курсив, цвет, кегль. Возвращает и общий стиль блока. */
function textOf(body: Element | null, theme: Record<string, string>, pxPerPt: number, bulletsByDefault: boolean): { html: string; style: TextStyle; plain: string } | null {
  if (!body) return null;
  const paragraphs = kids(body, A, "p");
  const style: TextStyle = {};
  const lines: Array<{ html: string; bullet: boolean }> = [];
  let plain = "";
  let firstSize: number | undefined;
  for (const p of paragraphs) {
    const pPr = kid(p, A, "pPr");
    const algn = pPr?.getAttribute("algn");
    if (algn && !style.align) style.align = algn === "ctr" ? "center" : algn === "r" ? "right" : "left";
    // Пункт списка: явный маркер у абзаца или текстовый заполнитель (у него маркеры по умолчанию), если их не сняли.
    const bullet = Boolean(kid(pPr, A, "buChar") || kid(pPr, A, "buAutoNum")) || (bulletsByDefault && !kid(pPr, A, "buNone"));
    let html = "";
    for (const run of Array.from(p.children)) {
      if (run.namespaceURI !== A) continue;
      if (run.localName === "br") { html += "<br>"; plain += "\n"; continue; }
      if (run.localName !== "r" && run.localName !== "fld") continue;
      const text = kid(run, A, "t")?.textContent || "";
      if (!text) continue;
      plain += text;
      const rPr = kid(run, A, "rPr");
      let piece = escapeHtml(text);
      const size = Number(rPr?.getAttribute("sz")) / 100;
      if (size && firstSize === undefined) firstSize = size;
      const color = colorOf(kid(rPr, A, "solidFill"), theme);
      const css = [color ? `color:${color}` : "", size && firstSize && Math.abs(size - firstSize) > 0.5 ? `font-size:${Math.round(size * pxPerPt)}px` : ""].filter(Boolean).join(";");
      if (css) piece = `<span style="${css}">${piece}</span>`;
      if (rPr?.getAttribute("b") === "1") piece = `<b>${piece}</b>`;
      if (rPr?.getAttribute("i") === "1") piece = `<i>${piece}</i>`;
      if (rPr?.getAttribute("u") && rPr.getAttribute("u") !== "none") piece = `<u>${piece}</u>`;
      html += piece;
    }
    plain += "\n";
    lines.push({ html, bullet: bullet && Boolean(html) });
  }
  if (!plain.trim()) return null;
  if (firstSize) style.fontSize = Math.max(8, Math.round(firstSize * pxPerPt));
  const anchor = kid(body, A, "bodyPr")?.getAttribute("anchor");
  style.valign = anchor === "ctr" ? "middle" : anchor === "b" ? "bottom" : "top";
  // Подряд идущие пункты списка — один <ul>, остальное — абзацами.
  let html = "";
  let list = false;
  for (const line of lines) {
    if (line.bullet && !list) { html += "<ul>"; list = true; }
    if (!line.bullet && list) { html += "</ul>"; list = false; }
    html += line.bullet ? `<li>${line.html}</li>` : `<div>${line.html || "<br>"}</div>`;
  }
  if (list) html += "</ul>";
  return { html, style, plain: plain.trim() };
}

const SHAPES: Record<string, "rect" | "round" | "ellipse" | "line"> = { rect: "rect", roundRect: "round", ellipse: "ellipse", line: "line", straightConnector1: "line" };

export async function pptxToDeck(file: File, upload: (blob: Blob, name: string) => Promise<string>, onProgress?: (done: number, total: number) => void): Promise<Deck> {
  let files: Files;
  try {
    files = unzipSync(new Uint8Array(await file.arrayBuffer()));
  } catch {
    throw new Error("Файл повреждён или это не PowerPoint (.pptx)");
  }
  const presentation = xml(files, "ppt/presentation.xml");
  if (!presentation) throw new Error("Это не презентация PowerPoint (.pptx)");
  const sz = deep(presentation.documentElement, P, "sldSz")[0];
  const emuW = Number(sz?.getAttribute("cx")) || 12192000;
  const emuH = Number(sz?.getAttribute("cy")) || 6858000;
  const size: Size = sizeFor(emuW, emuH);
  const scale = size.w / emuW;
  const pxPerPt = EMU_PER_PT * scale;
  const presRels = rels(files, "ppt/presentation.xml");
  const order = deep(presentation.documentElement, P, "sldId").map((s) => presRels[s.getAttributeNS(R, "id") || ""]?.target).filter(Boolean).slice(0, MAX_SLIDES);
  if (!order.length) throw new Error("В презентации нет слайдов");

  const uploaded = new Map<string, Promise<string | null>>();
  const media = (target: string): Promise<string | null> => {
    if (!uploaded.has(target)) {
      const ext = target.split(".").pop()?.toLowerCase() || "";
      const data = files[target];
      uploaded.set(target, data && IMAGE_TYPES[ext]
        ? upload(new Blob([data.slice()], { type: IMAGE_TYPES[ext] }), target.split("/").pop() || `image.${ext}`).catch(() => null)
        : Promise.resolve(null));
    }
    return uploaded.get(target)!;
  };

  // Фон темы — белый, как у образца по умолчанию; свой фон слайда (или его макета) — у самого слайда. Брать фон первого
  // слайда за общий нельзя: титульный тёмный, а у остальных тогда чёрный текст на тёмном.
  const slides: Slide[] = [];
  for (const [index, slidePath] of order.entries()) {
    const doc = xml(files, slidePath);
    if (!doc) continue;
    const slideRels = rels(files, slidePath);
    const layoutPath = relOfType(slideRels, "/slideLayout");
    const masterPath = layoutPath ? relOfType(rels(files, layoutPath), "/slideMaster") : undefined;
    const templates = [layoutPath, masterPath].map((p) => (p ? xml(files, p) : null)).filter((d): d is Document => Boolean(d));
    const theme = themeColors(files, masterPath);
    const elements: SlideElement[] = [];
    const slide: Slide = { id: uid(), notes: "", elements };

    // Фон: свой у слайда, иначе — макета или образца. Картинка-фон — элементом под всем остальным.
    for (const source of [doc, ...templates]) {
      const bgPr = path(source.documentElement, [[P, "cSld"], [P, "bg"], [P, "bgPr"]]);
      if (!bgPr) continue;
      const solid = colorOf(kid(bgPr, A, "solidFill"), theme);
      const blip = path(bgPr, [[A, "blipFill"], [A, "blip"]])?.getAttributeNS(R, "embed");
      const owner = source === doc ? slideRels : rels(files, source === templates[0] ? layoutPath! : masterPath!);
      if (blip && owner[blip]) {
        const src = await media(owner[blip].target);
        if (src) elements.push({ id: uid(), type: "image", src, x: 0, y: 0, w: size.w, h: size.h, fit: "cover" });
      }
      if (solid) slide.background = solid;
      break;
    }

    const toPx: Transform = (box) => ({ x: Math.round(box.x * scale), y: Math.round(box.y * scale), w: Math.max(4, Math.round(box.w * scale)), h: Math.max(4, Math.round(box.h * scale)) });

    const walk = async (tree: Element | null, transform: Transform) => {
      for (const node of Array.from(tree?.children ?? [])) {
        if (node.namespaceURI !== P) continue;
        if (node.localName === "grpSp") {
          // Группа: координаты детей — в её «внутренней» системе (chOff/chExt), растянутой на её место (off/ext).
          const xfrm = path(node, [[P, "grpSpPr"], [A, "xfrm"]]);
          const outer = boxOf(xfrm);
          const chOff = kid(xfrm, A, "chOff");
          const chExt = kid(xfrm, A, "chExt");
          if (outer && chOff && chExt) {
            const cx = Number(chOff.getAttribute("x")) || 0;
            const cy = Number(chOff.getAttribute("y")) || 0;
            const sx = outer.w / (Number(chExt.getAttribute("cx")) || outer.w || 1);
            const sy = outer.h / (Number(chExt.getAttribute("cy")) || outer.h || 1);
            await walk(node, (box) => transform({ x: outer.x + (box.x - cx) * sx, y: outer.y + (box.y - cy) * sy, w: box.w * sx, h: box.h * sy }));
          } else await walk(node, transform);
          continue;
        }
        const ph = placeholderOf(node);
        const ownXfrm = node.localName === "graphicFrame" ? kid(node, P, "xfrm") : path(node, [[P, "spPr"], [A, "xfrm"]]);
        const raw = boxOf(ownXfrm) || (ph ? boxOf(inheritedXfrm(templates, ph)) : null);
        if (!raw) continue;
        const box = transform(raw);
        if (node.localName === "pic") {
          const embed = path(node, [[P, "blipFill"], [A, "blip"]])?.getAttributeNS(R, "embed");
          const src = embed && slideRels[embed] ? await media(slideRels[embed].target) : null;
          if (src) elements.push({ id: uid(), type: "image", src, ...box, fit: "cover" });
          continue;
        }
        if (node.localName === "graphicFrame") {
          // Таблица — строками «ячейка | ячейка»: место и текст сохраняются, вёрстка таблицы — нет.
          const rows = deep(node, A, "tr").map((tr) => deep(tr, A, "tc").map((tc) => deep(tc, A, "t").map((t) => t.textContent || "").join(" ").trim()).join("  |  "));
          if (rows.some((r) => r.trim())) {
            elements.push({ id: uid(), type: "text", ...box, html: rows.map((r) => `<div>${escapeHtml(r)}</div>`).join(""), style: { fontSize: Math.max(10, Math.round(14 * pxPerPt)), valign: "top" } });
          }
          continue;
        }
        if (node.localName !== "sp") continue;
        const spPr = kid(node, P, "spPr");
        const bullets = Boolean(ph && (ph.type === "body" || ph.type === "obj"));
        const text = textOf(kid(node, P, "txBody"), theme, pxPerPt, bullets);
        const fill = colorOf(kid(spPr, A, "solidFill"), theme);
        const ln = kid(spPr, A, "ln");
        const stroke = ln && !kid(ln, A, "noFill") ? colorOf(kid(ln, A, "solidFill"), theme) : undefined;
        const geometry = kid(spPr, A, "prstGeom")?.getAttribute("prst") || "rect";
        const titleLike = ph && (ph.type === "title" || ph.type === "ctrTitle");
        const style: TextStyle = { ...(text?.style || {}), ...(titleLike ? { bold: text?.style.bold ?? true } : {}) };
        if (!style.fontSize && text) style.fontSize = Math.round((titleLike ? 40 : 22) * pxPerPt);
        const role = titleLike ? "title" : ph?.type === "subTitle" ? "subtitle" : ph ? "body" : undefined;
        if (fill || (stroke && !text)) {
          elements.push({
            id: uid(), type: "shape", shape: SHAPES[geometry] ?? "rect", ...box, fill, stroke,
            strokeWidth: stroke ? Math.max(1, Math.round((Number(ln?.getAttribute("w")) || 12700) * scale)) : undefined,
            ...(text ? { html: text.html, style } : {}), ...(role ? { role } : {}),
          });
        } else if (text) {
          elements.push({ id: uid(), type: "text", ...box, html: text.html, style, ...(role ? { role } : {}) });
        }
      }
    };
    await walk(path(doc.documentElement, [[P, "cSld"], [P, "spTree"]]), toPx);

    // Заметки докладчика: текст заполнителя body на странице заметок.
    const notesPath = relOfType(slideRels, "/notesSlide");
    const notes = notesPath ? xml(files, notesPath) : null;
    if (notes) {
      const body = deep(notes.documentElement, P, "sp").find((s) => placeholderOf(s)?.type === "body");
      slide.notes = deep(body, A, "p").map((p) => deep(p, A, "t").map((t) => t.textContent || "").join("")).join("\n").trim().slice(0, 4000);
    }
    slides.push(slide);
    onProgress?.(index + 1, order.length);
  }
  return { version: 1, size, theme: { ...THEMES[0], background: "#ffffff" }, slides };
}
