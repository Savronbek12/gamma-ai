// PowerPoint taqdimot: yorqin dizayn, turli slayd ko'rinishlari, rasmlar va bezak shakllari.
// Slaydlar rejasi (deck) modeldan JSON ko'rinishida keladi, rasmlar slideimages.js orqali topiladi.
import PptxGenJS from "pptxgenjs";

const FONT = "Segoe UI";
const FONT_HEAD = "Segoe UI Semibold";
const W = 13.333;
const H = 7.5;

// Har bir taqdimot uchun rang to'plami (mavzu nomiga qarab tanlanadi)
const THEMES = [
  { dark: "0F172A", dark2: "1E1B4B", light: "F8FAFC", ink: "0F172A", muted: "475569", accents: ["6366F1", "06B6D4", "F59E0B", "10B981", "EC4899", "8B5CF6"] },
  { dark: "082F49", dark2: "0C4A6E", light: "F0F9FF", ink: "0C1A2B", muted: "475569", accents: ["0EA5E9", "F97316", "22C55E", "A855F7", "EAB308", "EF4444"] },
  { dark: "1C1917", dark2: "3B0764", light: "FAFAF9", ink: "1C1917", muted: "57534E", accents: ["F43F5E", "8B5CF6", "14B8A6", "F59E0B", "3B82F6", "84CC16"] },
  { dark: "052E16", dark2: "14532D", light: "F7FEE7", ink: "14261A", muted: "4B5563", accents: ["16A34A", "0EA5E9", "F59E0B", "DB2777", "7C3AED", "EA580C"] },
];

const plainMath = (s) => String(s).replace(/\$\$([\s\S]+?)\$\$/g, "$1").replace(/\$([^$\n]+)\$/g, "$1").replace(/\\\(|\\\)/g, "");
const str = (v, n) => plainMath(String(v ?? "").replace(/\s+/g, " ").trim()).slice(0, n);
const arr = (v, n) => (Array.isArray(v) ? v : []).slice(0, n);
const LAYOUTS = new Set(["bullets", "two_column", "comparison", "stats", "timeline", "quote"]);

export function normalizeDeck(deck) {
  const slides = arr(deck?.slides, 22)
    .map((s) => {
      const out = {
        layout: LAYOUTS.has(s?.layout) ? s.layout : "bullets",
        title: str(s?.title, 110),
        lead: str(s?.lead, 260),
        bullets: arr(s?.bullets, 6).map((b) => str(b, 320)).filter(Boolean),
        columns: arr(s?.columns, 2)
          .map((c) => ({ heading: str(c?.heading, 60), points: arr(c?.points, 5).map((p) => str(p, 200)).filter(Boolean) }))
          .filter((c) => c.heading || c.points.length),
        stats: arr(s?.stats, 4).map((x) => ({ value: str(x?.value, 18), label: str(x?.label, 120) })).filter((x) => x.value),
        steps: arr(s?.steps, 6).map((x) => ({ label: str(x?.label, 28), text: str(x?.text, 170) })).filter((x) => x.label || x.text),
        quote: str(s?.quote, 320),
        author: str(s?.author, 80),
        image: str(s?.image, 80),
        notes: str(s?.notes, 1500),
      };
      // Ko'rinish uchun ma'lumot yetmasa — oddiy bandlarga qaytamiz
      if ((out.layout === "two_column" || out.layout === "comparison") && out.columns.length < 2) out.layout = "bullets";
      if (out.layout === "stats" && out.stats.length < 2) out.layout = "bullets";
      if (out.layout === "timeline" && out.steps.length < 3) out.layout = "bullets";
      if (out.layout === "quote" && !out.quote) out.layout = "bullets";
      if (out.layout === "bullets" && !out.bullets.length) {
        out.bullets = [...out.columns.flatMap((c) => c.points), ...out.steps.map((x) => `${x.label}: ${x.text}`)].slice(0, 6);
      }
      return out;
    })
    .filter((s) => s.title || s.bullets.length);
  return {
    title: str(deck?.title, 140) || "Taqdimot",
    subtitle: str(deck?.subtitle, 220),
    image: str(deck?.image, 80),
    slides,
  };
}

// Matn qutiga sig'adigan eng katta shrift o'lchamini taxminiy hisoblaydi
function fitFont(texts, w, h, max, min = 11, gap = 0.12) {
  const list = (Array.isArray(texts) ? texts : [texts]).filter(Boolean);
  for (let fs = max; fs > min; fs--) {
    const charW = (fs * 0.5) / 72; // o'rtacha harf kengligi (dyuym)
    const perLine = Math.max(8, Math.floor(w / charW));
    const lines = list.reduce((n, t) => n + Math.ceil(t.length / perLine), 0);
    const need = (lines * fs * 1.22) / 72 + gap * Math.max(0, list.length - 1);
    if (need <= h) return fs;
  }
  return min;
}

const hashIndex = (s, n) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % n;

/**
 * @param {object} input — deck JSON
 * @param {{ cover?: ImageInfo|null, slides?: (ImageInfo|null)[] }} images — {data, w, h, credit}
 */
export async function buildPptx(input, images = {}) {
  const deck = normalizeDeck(input);
  const T = THEMES[hashIndex(deck.title, THEMES.length)];
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = deck.title;
  pptx.author = "Gamma AI";
  pptx.company = "Gamma-AI.uz";
  const S = pptx.ShapeType;
  const total = deck.slides.length + 3; // titul + reja + slaydlar + yakun

  const circle = (slide, x, y, d, color, transparency = 0) =>
    slide.addShape(S.ellipse, { x, y, w: d, h: d, fill: { color, transparency }, line: { type: "none" } });
  const box = (slide, x, y, w, h, color, opts = {}) =>
    slide.addShape(opts.round ? S.roundRect : S.rect, {
      x, y, w, h, fill: { color, transparency: opts.transparency || 0 },
      line: opts.line ? { color: opts.line, width: 1 } : { type: "none" },
      ...(opts.round ? { rectRadius: opts.round } : {}),
      ...(opts.shadow ? { shadow: { type: "outer", color: "000000", opacity: 0.12, blur: 8, offset: 3, angle: 90 } } : {}),
    });

  // Rasm: berilgan qutini to'ldiradi (ortiqcha qismi kesiladi), ostida kichik muallif yozuvi
  function addImage(slide, img, x, y, w, h, { frame, creditColor } = {}) {
    if (!img) return false;
    if (frame) box(slide, x + 0.14, y + 0.14, w, h, frame, { round: 0.12 });
    const ratio = img.w / img.h;
    slide.addImage({ data: img.data, x, y, w: ratio, h: 1, sizing: { type: "cover", w, h } });
    if (img.credit) {
      slide.addText(img.credit, {
        x, y: y + h + (frame ? 0.18 : 0.04), w, h: 0.25, fontFace: FONT, fontSize: 8, color: creditColor || T.muted, align: "right", italic: true,
      });
    }
    return true;
  }

  function footer(slide, n, accent) {
    slide.addShape(S.line, { x: 0.6, y: 7.0, w: W - 1.2, h: 0, line: { color: "CBD5E1", width: 0.75 } });
    slide.addText(deck.title, { x: 0.6, y: 7.05, w: 9, h: 0.3, fontFace: FONT, fontSize: 9, color: T.muted });
    slide.addText([{ text: String(n), options: { bold: true, color: accent } }, { text: ` / ${total}`, options: { color: T.muted } }], {
      x: W - 2.1, y: 7.05, w: 1.5, h: 0.3, fontFace: FONT, fontSize: 9, align: "right",
    });
  }

  function header(slide, s, idx, accent) {
    slide.background = { color: T.light };
    // Bezak: o'ng yuqori burchakdagi shaffof doiralar
    circle(slide, W - 2.3, -1.3, 3.4, accent, 82);
    circle(slide, W - 1.0, 0.9, 1.2, T.accents[(idx + 2) % T.accents.length], 70);
    box(slide, 0, 0, 0.12, H, accent);
    // Raqamli belgi
    box(slide, 0.6, 0.5, 0.78, 0.62, accent, { round: 0.12 });
    slide.addText(String(idx + 1).padStart(2, "0"), {
      x: 0.6, y: 0.5, w: 0.78, h: 0.62, fontFace: FONT_HEAD, fontSize: 18, bold: true, color: "FFFFFF", align: "center", valign: "middle",
    });
    slide.addText(s.title, {
      x: 1.6, y: 0.38, w: W - 4.2, h: 0.86, fontFace: FONT_HEAD, fontSize: fitFont(s.title, W - 4.2, 0.86, 30, 20), bold: true,
      color: T.ink, valign: "middle",
    });
    if (s.lead) {
      slide.addText(s.lead, {
        x: 1.6, y: 1.22, w: W - 3.4, h: 0.62, fontFace: FONT, fontSize: fitFont(s.lead, W - 3.4, 0.62, 16, 11), italic: true,
        color: T.muted, valign: "top",
      });
    }
    return s.lead ? 2.05 : 1.6; // kontent boshlanadigan y
  }

  // Raqamli doirachalar bilan bandlar ro'yxati
  function bulletList(slide, items, x, y, w, h, accentFor) {
    const n = items.length;
    const gap = 0.16;
    const fs = fitFont(items, w - 0.75, h - gap * n, 21, 11, gap);
    const heights = items.map((t) => {
      const perLine = Math.max(8, Math.floor((w - 0.75) / ((fs * 0.5) / 72)));
      return Math.max(0.5, (Math.ceil(t.length / perLine) * fs * 1.22) / 72 + 0.12);
    });
    const used = heights.reduce((a, b) => a + b, 0) + gap * (n - 1);
    let cy = y + Math.max(0, (h - used) / 2) * 0.35;
    items.forEach((t, i) => {
      const color = accentFor(i);
      circle(slide, x, cy + 0.04, 0.42, color);
      slide.addText(String(i + 1), {
        x, y: cy + 0.04, w: 0.42, h: 0.42, fontFace: FONT_HEAD, fontSize: 12, bold: true, color: "FFFFFF", align: "center", valign: "middle",
      });
      slide.addText(t, { x: x + 0.62, y: cy, w: w - 0.62, h: heights[i], fontFace: FONT, fontSize: fs, color: T.ink, valign: "top" });
      cy += heights[i] + gap;
    });
  }

  // ---- Titul slayd ----
  const cover = pptx.addSlide();
  cover.background = { color: T.dark };
  const coverImg = images.cover || null;
  const textW = coverImg ? 6.9 : 11.2;
  if (coverImg) {
    addImage(cover, { ...coverImg, credit: "" }, 7.55, 0, W - 7.55, H);
    if (coverImg.credit) {
      box(cover, 7.55, H - 0.32, W - 7.55, 0.32, "000000", { transparency: 45 });
      cover.addText(coverImg.credit, { x: 7.7, y: H - 0.32, w: W - 7.85, h: 0.32, fontFace: FONT, fontSize: 8, color: "E2E8F0", align: "right", italic: true, valign: "middle" });
    }
    box(cover, 7.55, 0, 0.18, H, T.accents[0]);
  }
  circle(cover, -1.6, -1.9, 4.6, T.accents[0], 55);
  circle(cover, coverImg ? 5.6 : 9.8, 4.9, 3.6, T.accents[1], 65);
  circle(cover, coverImg ? 6.4 : 11.6, 0.7, 1.0, T.accents[2], 35);
  box(cover, 0.85, 4.12, 1.6, 0.09, T.accents[2]);
  cover.addText(deck.title, {
    x: 0.85, y: 1.35, w: textW, h: 2.65, fontFace: FONT_HEAD, fontSize: fitFont(deck.title, textW, 2.65, 44, 26), bold: true,
    color: "FFFFFF", valign: "bottom",
  });
  if (deck.subtitle) {
    cover.addText(deck.subtitle, {
      x: 0.85, y: 4.4, w: textW, h: 1.3, fontFace: FONT, fontSize: fitFont(deck.subtitle, textW, 1.3, 20, 13), color: "CBD5E1", valign: "top",
    });
  }
  cover.addText("Gamma AI  ·  Gamma-AI.uz", { x: 0.85, y: 6.55, w: 6, h: 0.4, fontFace: FONT, fontSize: 12, color: "94A3B8" });

  // ---- Reja (mundarija) ----
  const agenda = pptx.addSlide();
  agenda.background = { color: T.light };
  box(agenda, 0, 0, 4.3, H, T.dark);
  circle(agenda, 1.5, 5.0, 2.6, T.accents[0], 55);
  circle(agenda, -0.9, -0.9, 2.4, T.accents[1], 60);
  agenda.addText("Reja", { x: 0.6, y: 2.6, w: 3.4, h: 1.0, fontFace: FONT_HEAD, fontSize: 40, bold: true, color: "FFFFFF" });
  agenda.addText(`${deck.slides.length} ta bo'lim`, { x: 0.6, y: 3.55, w: 3.4, h: 0.5, fontFace: FONT, fontSize: 16, color: "CBD5E1" });
  {
    const items = deck.slides.map((s) => s.title);
    const cols = items.length > 7 ? 2 : 1;
    const perCol = Math.ceil(items.length / cols);
    const colW = (W - 5.0 - 0.4 * (cols - 1)) / cols;
    const rowH = Math.min(0.72, 6.0 / perCol);
    items.forEach((t, i) => {
      const c = Math.floor(i / perCol);
      const r = i % perCol;
      const x = 4.85 + c * (colW + 0.4);
      const y = 0.75 + r * rowH;
      const color = T.accents[i % T.accents.length];
      box(agenda, x, y + 0.06, 0.55, rowH - 0.18, color, { round: 0.08 });
      agenda.addText(String(i + 1).padStart(2, "0"), {
        x, y: y + 0.06, w: 0.55, h: rowH - 0.18, fontFace: FONT_HEAD, fontSize: 13, bold: true, color: "FFFFFF", align: "center", valign: "middle",
      });
      agenda.addText(t, {
        x: x + 0.7, y, w: colW - 0.7, h: rowH - 0.06, fontFace: FONT, fontSize: fitFont(t, colW - 0.7, rowH - 0.06, 20, 10), color: T.ink, valign: "middle",
      });
    });
  }
  agenda.addText([{ text: "2", options: { bold: true, color: T.accents[0] } }, { text: ` / ${total}`, options: { color: T.muted } }], {
    x: W - 2.1, y: 7.05, w: 1.5, h: 0.3, fontFace: FONT, fontSize: 9, align: "right",
  });

  // ---- Asosiy slaydlar ----
  deck.slides.forEach((s, idx) => {
    const slide = pptx.addSlide();
    const accent = T.accents[idx % T.accents.length];
    const accentFor = (i) => T.accents[(idx + i) % T.accents.length];
    const img = images.slides?.[idx] || null;
    const top = header(slide, s, idx, accent);
    const bottom = 6.75;
    const areaH = bottom - top;

    if (s.layout === "bullets") {
      if (img) {
        const imgW = 4.7;
        bulletList(slide, s.bullets, 0.75, top, W - imgW - 1.75, areaH, accentFor);
        addImage(slide, img, W - imgW - 0.75, top + 0.05, imgW, Math.min(areaH - 0.45, 4.3), { frame: accent });
      } else if (s.bullets.length >= 3) {
        // Rasm bo'lmasa — kartochkalar to'ri
        const n = s.bullets.length;
        const cols = n === 4 ? 2 : Math.min(3, n);
        const rows = Math.ceil(n / cols);
        const gap = 0.3;
        const cw = (W - 1.5 - gap * (cols - 1)) / cols;
        const ch = (areaH - gap * (rows - 1)) / rows;
        const fs = fitFont(s.bullets.reduce((a, b) => (a.length > b.length ? a : b)), cw - 0.6, ch - 0.75, 21, 11);
        s.bullets.forEach((t, i) => {
          const x = 0.75 + (i % cols) * (cw + gap);
          const y = top + Math.floor(i / cols) * (ch + gap);
          const color = accentFor(i);
          box(slide, x, y, cw, ch, "FFFFFF", { round: 0.1, shadow: true, line: "E2E8F0" });
          box(slide, x, y, cw, 0.1, color);
          circle(slide, x + 0.3, y + 0.32, 0.46, color);
          slide.addText(String(i + 1), {
            x: x + 0.3, y: y + 0.32, w: 0.46, h: 0.46, fontFace: FONT_HEAD, fontSize: 13, bold: true, color: "FFFFFF", align: "center", valign: "middle",
          });
          slide.addText(t, { x: x + 0.3, y: y + 0.9, w: cw - 0.6, h: ch - 1.05, fontFace: FONT, fontSize: fs, color: T.ink, valign: "top" });
        });
      } else {
        bulletList(slide, s.bullets, 0.75, top, W - 1.5, areaH, accentFor);
      }
    } else if (s.layout === "two_column" || s.layout === "comparison") {
      const gap = s.layout === "comparison" ? 0.9 : 0.4;
      const cw = (W - 1.5 - gap) / 2;
      s.columns.forEach((c, i) => {
        const x = 0.75 + i * (cw + gap);
        const color = accentFor(i * 2);
        box(slide, x, top, cw, areaH, "FFFFFF", { round: 0.1, shadow: true, line: "E2E8F0" });
        box(slide, x, top, cw, 0.72, color, { round: 0.1 });
        box(slide, x, top + 0.4, cw, 0.32, color);
        slide.addText(c.heading, {
          x: x + 0.3, y: top, w: cw - 0.6, h: 0.72, fontFace: FONT_HEAD, fontSize: fitFont(c.heading, cw - 0.6, 0.72, 20, 13), bold: true,
          color: "FFFFFF", valign: "middle",
        });
        const fs = fitFont(c.points, cw - 0.9, areaH - 1.1, 22, 11, 0.12);
        slide.addText(
          c.points.map((p) => ({ text: p, options: { bullet: { code: "25CF", indent: 18 }, paraSpaceAfter: 8, breakLine: true } })),
          { x: x + 0.3, y: top + 0.9, w: cw - 0.6, h: areaH - 1.05, fontFace: FONT, fontSize: fs, color: T.ink, valign: "top" },
        );
      });
      if (s.layout === "comparison") {
        circle(slide, W / 2 - 0.42, top + areaH / 2 - 0.42, 0.84, T.dark);
        slide.addText("VS", {
          x: W / 2 - 0.42, y: top + areaH / 2 - 0.42, w: 0.84, h: 0.84, fontFace: FONT_HEAD, fontSize: 16, bold: true, color: "FFFFFF", align: "center", valign: "middle",
        });
      }
    } else if (s.layout === "stats") {
      const n = s.stats.length;
      const withImg = !!img && n <= 3;
      const areaW = withImg ? W - 1.5 - 4.4 : W - 1.5;
      const gap = 0.3;
      const cw = (areaW - gap * (n - 1)) / n;
      const ch = Math.min(areaH, 3.4);
      s.stats.forEach((st, i) => {
        const x = 0.75 + i * (cw + gap);
        const color = accentFor(i);
        box(slide, x, top, cw, ch, color, { round: 0.12, shadow: true });
        circle(slide, x + cw - 1.0, top - 0.35, 1.4, "FFFFFF", 82);
        slide.addText(st.value, {
          x: x + 0.2, y: top + 0.35, w: cw - 0.4, h: 1.3, fontFace: FONT_HEAD, fontSize: fitFont(st.value, cw - 0.4, 1.3, 44, 22), bold: true,
          color: "FFFFFF", align: "center", valign: "middle",
        });
        box(slide, x + cw / 2 - 0.5, top + 1.75, 1.0, 0.05, "FFFFFF", { transparency: 30 });
        slide.addText(st.label, {
          x: x + 0.25, y: top + 1.9, w: cw - 0.5, h: ch - 2.05, fontFace: FONT, fontSize: fitFont(st.label, cw - 0.5, ch - 2.05, 16, 10),
          color: "FFFFFF", align: "center", valign: "top",
        });
      });
      if (withImg) addImage(slide, img, W - 0.75 - 4.1, top, 4.1, Math.min(areaH - 0.4, 4.2), { frame: accent });
      if (s.bullets.length && top + ch + 0.3 < bottom - 0.5) {
        const y = top + ch + 0.3;
        slide.addText(
          s.bullets.slice(0, 3).map((b) => ({ text: b, options: { bullet: { code: "25B6", indent: 18 }, paraSpaceAfter: 6, breakLine: true } })),
          { x: 0.75, y, w: areaW, h: bottom - y, fontFace: FONT, fontSize: fitFont(s.bullets.slice(0, 3), areaW - 0.3, bottom - y, 18, 10), color: T.ink, valign: "top" },
        );
      }
    } else if (s.layout === "timeline") {
      const n = s.steps.length;
      const lineY = top + 1.25;
      const x0 = 0.95;
      const x1 = W - 0.95;
      slide.addShape(S.line, { x: x0, y: lineY, w: x1 - x0, h: 0, line: { color: "CBD5E1", width: 3 } });
      const step = (x1 - x0) / n;
      s.steps.forEach((st, i) => {
        const cx = x0 + step * (i + 0.5);
        const color = accentFor(i);
        circle(slide, cx - 0.3, lineY - 0.3, 0.6, color);
        circle(slide, cx - 0.12, lineY - 0.12, 0.24, "FFFFFF");
        slide.addText(st.label, {
          x: cx - step / 2 + 0.05, y: top, w: step - 0.1, h: 0.75, fontFace: FONT_HEAD, fontSize: fitFont(st.label, step - 0.1, 0.75, 20, 11),
          bold: true, color, align: "center", valign: "bottom",
        });
        const cardY = lineY + 0.55;
        const cardH = Math.min(bottom - cardY, 3.4);
        box(slide, cx - step / 2 + 0.08, cardY, step - 0.16, cardH, "FFFFFF", { round: 0.08, shadow: true, line: "E2E8F0" });
        box(slide, cx - step / 2 + 0.08, cardY, step - 0.16, 0.08, color);
        slide.addText(st.text, {
          x: cx - step / 2 + 0.2, y: cardY + 0.2, w: step - 0.4, h: cardH - 0.3, fontFace: FONT,
          fontSize: fitFont(st.text, step - 0.4, cardH - 0.3, 18, 9), color: T.ink, valign: "top", align: "center",
        });
      });
    } else if (s.layout === "quote") {
      const qx = img ? 5.6 : 1.4;
      const qw = W - qx - 1.0;
      if (img) addImage(slide, img, 0.75, top, 4.3, areaH - 0.4, { frame: accent });
      box(slide, qx - 0.3, top, qw + 0.6, areaH - 0.2, "FFFFFF", { round: 0.12, shadow: true, line: "E2E8F0" });
      slide.addText("“", { x: qx - 0.1, y: top - 0.25, w: 1.4, h: 1.6, fontFace: "Georgia", fontSize: 110, bold: true, color: accent });
      slide.addText(s.quote, {
        x: qx + 0.2, y: top + 1.0, w: qw - 0.4, h: areaH - 2.2, fontFace: "Georgia", fontSize: fitFont(s.quote, qw - 0.4, areaH - 2.2, 28, 15),
        italic: true, color: T.ink, valign: "middle",
      });
      if (s.author) {
        box(slide, qx + 0.2, top + areaH - 1.05, 0.8, 0.06, accent);
        slide.addText(`— ${s.author}`, {
          x: qx + 1.15, y: top + areaH - 1.3, w: qw - 1.3, h: 0.55, fontFace: FONT_HEAD, fontSize: 16, bold: true, color: T.muted, valign: "middle",
        });
      }
    }

    footer(slide, idx + 3, accent);
    if (s.notes) slide.addNotes(s.notes);
  });

  // ---- Yakuniy slayd ----
  const end = pptx.addSlide();
  end.background = { color: T.dark };
  circle(end, -1.5, 3.8, 5.0, T.accents[0], 55);
  circle(end, W - 3.4, -1.8, 4.6, T.accents[1], 60);
  circle(end, W - 2.2, 5.6, 1.3, T.accents[2], 30);
  end.addText("E'tiboringiz uchun rahmat!", {
    x: 1.0, y: 2.4, w: W - 2.0, h: 1.4, fontFace: FONT_HEAD, fontSize: 44, bold: true, color: "FFFFFF", align: "center", valign: "middle",
  });
  box(end, W / 2 - 0.8, 3.95, 1.6, 0.09, T.accents[2]);
  end.addText("Savollaringiz bo'lsa, marhamat", { x: 1.0, y: 4.2, w: W - 2.0, h: 0.6, fontFace: FONT, fontSize: 20, color: "CBD5E1", align: "center" });
  end.addText(deck.title, { x: 1.0, y: 6.4, w: W - 2.0, h: 0.4, fontFace: FONT, fontSize: 12, color: "94A3B8", align: "center" });

  return pptx.write({ outputType: "nodebuffer" });
}
