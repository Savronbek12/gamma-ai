// Javoblarni yuklab olinadigan fayllarga aylantirish: Word (.docx) va PowerPoint (.pptx)
import PptxGenJS from "pptxgenjs";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle, AlignmentType,
} from "docx";
import { marked } from "marked";

const NAVY = "141C2B";
const BLUE = "1F3A8A";
const ACCENT = "3B82F6";
const INK = "1E293B";
const MUTED = "64748B";
const FONT = "Calibri";

// Fayl nomi uchun xavfsiz qisqa nom
export function safeFileName(title, ext) {
  const base = String(title || "Gamma AI").replace(/[\\/:*?"<>|\n\r\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Gamma AI";
  return `${base}.${ext}`;
}

// LaTeX belgilarini oddiy matnga yaqinlashtiradi ($x^2$ → x^2)
const plainMath = (s) => String(s).replace(/\$\$([\s\S]+?)\$\$/g, "$1").replace(/\$([^$\n]+)\$/g, "$1");

// ---------------------------------------------------------------------------
// PowerPoint
// ---------------------------------------------------------------------------
export function normalizeDeck(deck) {
  const str = (v, n) => plainMath(String(v ?? "").trim()).slice(0, n);
  const slides = (Array.isArray(deck?.slides) ? deck.slides : [])
    .map((s) => ({
      title: str(s?.title, 120),
      bullets: (Array.isArray(s?.bullets) ? s.bullets : []).map((b) => str(b, 300)).filter(Boolean).slice(0, 8),
      notes: str(s?.notes, 1500),
    }))
    .filter((s) => s.title || s.bullets.length)
    .slice(0, 25);
  return { title: str(deck?.title, 150) || "Taqdimot", subtitle: str(deck?.subtitle, 200), slides };
}

export async function buildPptx(input) {
  const deck = normalizeDeck(input);
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 dyuym
  pptx.title = deck.title;
  pptx.author = "Gamma AI";
  pptx.company = "Gamma-AI.uz";

  // Titul slayd
  const cover = pptx.addSlide();
  cover.background = { color: NAVY };
  cover.addShape(pptx.ShapeType.rect, { x: 0.8, y: 3.05, w: 1.4, h: 0.08, fill: { color: ACCENT }, line: { color: ACCENT } });
  cover.addText(deck.title, {
    x: 0.8, y: 1.2, w: 11.7, h: 1.8, fontFace: FONT, fontSize: 40, bold: true, color: "FFFFFF", valign: "bottom", fit: "shrink",
  });
  if (deck.subtitle) {
    cover.addText(deck.subtitle, { x: 0.8, y: 3.35, w: 11.7, h: 1.2, fontFace: FONT, fontSize: 20, color: "CBD5E1", valign: "top" });
  }
  cover.addText("Gamma AI · Gamma-AI.uz", { x: 0.8, y: 6.6, w: 8, h: 0.4, fontFace: FONT, fontSize: 12, color: "94A3B8" });

  deck.slides.forEach((s, i) => {
    const slide = pptx.addSlide();
    slide.background = { color: "FFFFFF" };
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.18, h: 7.5, fill: { color: BLUE }, line: { color: BLUE } });
    slide.addText(s.title, {
      x: 0.7, y: 0.4, w: 11.9, h: 1.0, fontFace: FONT, fontSize: 30, bold: true, color: INK, valign: "middle", fit: "shrink",
    });
    slide.addShape(pptx.ShapeType.rect, { x: 0.7, y: 1.45, w: 1.0, h: 0.06, fill: { color: ACCENT }, line: { color: ACCENT } });
    if (s.bullets.length) {
      const total = s.bullets.join(" ").length;
      const fontSize = total > 700 ? 15 : total > 450 ? 17 : s.bullets.length > 5 ? 19 : 21;
      slide.addText(
        s.bullets.map((b) => ({ text: b, options: { bullet: { code: "25A0" }, paraSpaceAfter: 10 } })),
        { x: 0.7, y: 1.8, w: 11.9, h: 5.0, fontFace: FONT, fontSize, color: INK, valign: "top", fit: "shrink", lineSpacingMultiple: 1.1 },
      );
    }
    slide.addText(`${i + 2}`, { x: 12.2, y: 6.9, w: 0.8, h: 0.4, fontFace: FONT, fontSize: 11, color: MUTED, align: "right" });
    if (s.notes) slide.addNotes(s.notes);
  });

  return pptx.write({ outputType: "nodebuffer" });
}

// ---------------------------------------------------------------------------
// Word: Markdown → .docx
// ---------------------------------------------------------------------------
function inlineRuns(tokens, style = {}) {
  const runs = [];
  for (const t of tokens || []) {
    if (t.type === "strong") runs.push(...inlineRuns(t.tokens, { ...style, bold: true }));
    else if (t.type === "em") runs.push(...inlineRuns(t.tokens, { ...style, italics: true }));
    else if (t.type === "del") runs.push(...inlineRuns(t.tokens, { ...style, strike: true }));
    else if (t.type === "codespan") runs.push(new TextRun({ ...style, text: decode(t.text), font: "Consolas" }));
    else if (t.type === "link") runs.push(...inlineRuns(t.tokens, { ...style, color: "1D4ED8", underline: {} }));
    else if (t.type === "br") runs.push(new TextRun({ break: 1 }));
    else if (t.tokens) runs.push(...inlineRuns(t.tokens, style));
    else runs.push(new TextRun({ ...style, text: plainMath(decode(t.text ?? t.raw ?? "")) }));
  }
  return runs;
}

const decode = (s) =>
  String(s).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4];
const thin = { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" };

function blocks(tokens, level = 0) {
  const out = [];
  for (const t of tokens) {
    if (t.type === "heading") {
      out.push(new Paragraph({ heading: HEADINGS[Math.min(t.depth, 4) - 1], children: inlineRuns(t.tokens) }));
    } else if (t.type === "paragraph" || t.type === "text") {
      out.push(new Paragraph({ children: inlineRuns(t.tokens || [{ type: "text", text: t.text }]), spacing: { after: 120 } }));
    } else if (t.type === "list") {
      t.items.forEach((item, idx) => {
        const [first, ...rest] = item.tokens;
        const lead = t.ordered ? `${(Number(t.start) || 1) + idx}. ` : "• ";
        const firstRuns = first && (first.type === "text" || first.type === "paragraph") ? inlineRuns(first.tokens || [first]) : [];
        out.push(
          new Paragraph({
            children: [new TextRun(lead), ...firstRuns],
            indent: { left: 360 * (level + 1), hanging: 280 },
            spacing: { after: 60 },
          }),
        );
        const remaining = firstRuns.length ? rest : item.tokens;
        out.push(...blocks(remaining, level + 1));
      });
    } else if (t.type === "code") {
      for (const line of t.text.split("\n")) {
        out.push(new Paragraph({ children: [new TextRun({ text: line || " ", font: "Consolas", size: 20 })], shading: { fill: "F1F5F9" } }));
      }
    } else if (t.type === "blockquote") {
      out.push(...blocks(t.tokens, level).map((p) => p));
    } else if (t.type === "table") {
      const row = (cells, header) =>
        new TableRow({
          tableHeader: header,
          children: cells.map(
            (c) =>
              new TableCell({
                children: [new Paragraph({ children: inlineRuns(c.tokens, header ? { bold: true } : {}) })],
                shading: header ? { fill: "E2E8F0" } : undefined,
              }),
          ),
        });
      out.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: { top: thin, bottom: thin, left: thin, right: thin, insideHorizontal: thin, insideVertical: thin },
          rows: [row(t.header, true), ...t.rows.map((r) => row(r, false))],
        }),
        new Paragraph({ text: "" }),
      );
    } else if (t.type === "hr") {
      out.push(new Paragraph({ border: { bottom: thin }, spacing: { after: 120 } }));
    }
  }
  return out;
}

export async function buildDocx({ title, markdown }) {
  const tokens = marked.lexer(String(markdown || ""));
  const doc = new Document({
    creator: "Gamma AI",
    title: String(title || "Gamma AI"),
    styles: { default: { document: { run: { font: FONT, size: 24 } } } },
    sections: [
      {
        children: [
          ...(title ? [new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.LEFT, children: [new TextRun(String(title))] })] : []),
          ...blocks(tokens),
          new Paragraph({ spacing: { before: 400 }, children: [new TextRun({ text: "Gamma AI · Gamma-AI.uz", color: "94A3B8", size: 18 })] }),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}
