// Javoblarni yuklab olinadigan fayllarga aylantirish: Word (.docx) va PowerPoint (.pptx)
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle, AlignmentType,
} from "docx";
import { marked } from "marked";

const FONT = "Calibri";

// Fayl nomi uchun xavfsiz qisqa nom
export function safeFileName(title, ext) {
  const base = String(title || "Gamma AI").replace(/[\\/:*?"<>|\n\r\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Gamma AI";
  return `${base}.${ext}`;
}

// LaTeX belgilarini oddiy matnga yaqinlashtiradi ($x^2$ → x^2)
const plainMath = (s) => String(s).replace(/\$\$([\s\S]+?)\$\$/g, "$1").replace(/\$([^$\n]+)\$/g, "$1");

export { normalizeDeck, buildPptx } from "./pptx.js";

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
