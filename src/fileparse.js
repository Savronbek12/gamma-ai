// Foydalanuvchi yuklagan fayldan matn ajratib olish (PDF, Word, PowerPoint, Excel, matn/kod).
// Rasmlar bu yerda emas — ularni providers.js dagi describeImage() o'qiydi.
import JSZip from "jszip";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

export const IMAGE_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

const TEXT_EXT = new Set(
  ("txt md markdown csv tsv json xml html htm css js mjs cjs ts tsx jsx py java c h cpp hpp cs go rs rb php " +
    "swift kt kts sql sh bat ps1 yaml yml ini toml log tex srt vtt rtf").split(" "),
);

export const extOf = (name) => (/\.([a-z0-9]+)$/i.exec(String(name || ""))?.[1] || "").toLowerCase();

const decodeXml = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

// <a:t>…</a:t> kabi teglar ichidagi matnni ketma-ket yig'adi
function xmlTexts(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "g");
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(decodeXml(m[1]));
  return out;
}

const naturalSort = (a, b) => a.localeCompare(b, undefined, { numeric: true });

async function pptxText(buf) {
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort(naturalSort);
  const parts = [];
  for (let i = 0; i < slides.length; i++) {
    const xml = await zip.file(slides[i]).async("string");
    // Har bir paragraf (<a:p>) alohida qator bo'lsin
    const paras = xml.split("</a:p>").map((p) => xmlTexts(p, "a:t").join("")).filter((t) => t.trim());
    parts.push(`--- ${i + 1}-slayd ---\n${paras.join("\n")}`);
  }
  return parts.join("\n\n");
}

async function xlsxText(buf) {
  const zip = await JSZip.loadAsync(buf);
  const sharedXml = await zip.file("xl/sharedStrings.xml")?.async("string");
  const shared = sharedXml ? sharedXml.split("</si>").slice(0, -1).map((si) => xmlTexts(si, "t").join("")) : [];
  const sheets = Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort(naturalSort);
  const parts = [];
  for (let i = 0; i < sheets.length; i++) {
    const xml = await zip.file(sheets[i]).async("string");
    const rows = [];
    for (const rowXml of xml.split("</row>")) {
      const cells = [];
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let m;
      while ((m = cellRe.exec(rowXml))) {
        const attrs = m[1];
        const inner = m[2] || "";
        const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
        let value = "";
        if (/t="s"/.test(attrs) && v !== undefined) value = shared[Number(v)] ?? "";
        else if (/t="inlineStr"/.test(attrs)) value = xmlTexts(inner, "t").join("");
        else if (v !== undefined) value = decodeXml(v);
        cells.push(value.replace(/[\t\n]+/g, " "));
      }
      if (cells.some((c) => c.trim())) rows.push(cells.join("\t"));
    }
    if (rows.length) parts.push(`--- ${i + 1}-varaq ---\n${rows.join("\n")}`);
  }
  return parts.join("\n\n");
}

async function odfText(buf) {
  const zip = await JSZip.loadAsync(buf);
  const xml = (await zip.file("content.xml")?.async("string")) || "";
  return decodeXml(xml.replace(/<\/text:(p|h)>/g, "\n").replace(/<[^>]+>/g, "")).trim();
}

async function pdfText(buf) {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text, totalPages } = await extractText(pdf, { mergePages: false });
  return text.map((t, i) => (totalPages > 1 ? `--- ${i + 1}-sahifa ---\n${t}` : t)).join("\n\n");
}

function looksBinary(buf) {
  const sample = buf.subarray(0, 4000);
  let zeros = 0;
  for (const b of sample) if (b === 0) zeros++;
  return zeros > 0;
}

// Fayldan matn qaytaradi; qo'llab-quvvatlanmasa, kod "UNSUPPORTED" bo'lgan xato tashlaydi
export async function fileToText(buf, name) {
  const ext = extOf(name);
  let text;
  if (ext === "pdf") text = await pdfText(buf);
  else if (ext === "docx") text = (await mammoth.extractRawText({ buffer: buf })).value;
  else if (ext === "pptx") text = await pptxText(buf);
  else if (ext === "xlsx") text = await xlsxText(buf);
  else if (["odt", "odp", "ods"].includes(ext)) text = await odfText(buf);
  else if (TEXT_EXT.has(ext) || (!ext && !looksBinary(buf))) {
    text = buf.toString("utf8");
    if (ext === "html" || ext === "htm") text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, " ");
    if (ext === "rtf") text = text.replace(/\\[a-z]+-?\d* ?|[{}]/gi, "");
  } else {
    const err = new Error(`Qo'llab-quvvatlanmaydigan fayl turi: .${ext || "?"}`);
    err.code = "UNSUPPORTED";
    throw err;
  }
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
