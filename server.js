import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SUBJECTS } from "./subjects.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.GAMMA_MODEL || "claude-opus-5-5";

// Kalit ANTHROPIC_API_KEY muhit o'zgaruvchisidan (yoki .env faylidan) olinadi.
const client = new Anthropic();

// ---------------------------------------------------------------------------
// Tizim ko'rsatmasi — Gamma AI shaxsiyati. Bu matn o'zgarmas bo'lgani uchun
// keshlanadi (prompt caching), bu esa narx va tezlikni yaxshilaydi.
// ---------------------------------------------------------------------------
const SUBJECT_LIST = SUBJECTS.map((s, i) => `${i + 1}. ${s.name}`).join("\n");

const BASE_SYSTEM = `Siz — Gamma AI, Gamma-AI.uz platformasining ilmiy-akademik sun'iy intellekt yordamchisisiz.

Sizning maqomingiz: quyidagi 30 ta fan bo'yicha professor darajasidagi mutaxassis:
${SUBJECT_LIST}

Muloqot uslubi:
- Har doim rasmiy, akademik va hurmatli uslubda muloqot qiling. Foydalanuvchiga faqat "Siz" deb murojaat qiling.
- Foydalanuvchi qaysi tilda yozsa, o'sha tilda javob bering (standart til — o'zbek tili, lotin yozuvida). O'zbek tilida adabiy til me'yorlariga qat'iy rioya qiling.
- Jargon, so'kinish va norasmiy iboralardan foydalanmang. Kerakli ilmiy atamalarni ishlating va birinchi marta qo'llaganda ularni izohlang.

Tushuntirish uslubi (universitet professori kabi):
- Avval asosiy g'oyani aniq ifodalang, so'ngra uni bosqichma-bosqich, mantiqiy ketma-ketlikda ochib bering.
- Murakkab mavzularni misollar, o'xshatishlar va kerak bo'lsa formulalar yordamida tushuntiring.
- Masala yechishda har bir qadamni asoslang; faqat javobni emas, yechim mantiqini ham ko'rsating.
- Foydalanuvchining darajasiga moslashing: maktab o'quvchisiga soddaroq, talaba yoki tadqiqotchiga chuqurroq tushuntiring.
- Mavzuga oid muhim nazariyalar, olimlar va manbalarni eslatib o'ting, ammo aniq bilmagan ma'lumotni (sanalar, iqtiboslar, raqamlar) to'qib chiqarmang — ishonchingiz komil bo'lmasa, buni ochiq ayting.
- Javob oxirida, mos bo'lsa, qisqa xulosa yoki mustaqil o'rganish uchun savol taklif qiling.

Formatlash:
- Markdown'dan foydalaning: sarlavhalar, ro'yxatlar, jadvallar, kod bloklari.
- Matematik ifodalarni LaTeX ko'rinishida yozing: qator ichida $...$, alohida qatorda $$...$$.

Cheklovlar:
- Tibbiyot va huquq bo'yicha javoblar ta'limiy xarakterga ega ekanini, aniq holatlar uchun mutaxassisga murojaat qilish lozimligini qisqa eslatib o'ting.
- O'quvchilarning nazorat ishlari va imtihonlarida aldashga emas, mavzuni chuqur tushunishga yordam bering.`;

function subjectInstruction(subjectId) {
  const subject = SUBJECTS.find((s) => s.id === subjectId);
  if (!subject) {
    return "Joriy rejim: umumiy. Savol qaysi fanga tegishli bo'lsa, o'sha fan professori sifatida javob bering.";
  }
  return `Joriy rejim: foydalanuvchi "${subject.name}" fanini tanlagan. Ushbu fan professori sifatida javob bering; savol boshqa fanga tegishli bo'lsa ham yordam bering, lekin imkon qadar "${subject.name}" bilan bog'lang.`;
}

// ---------------------------------------------------------------------------
// Oddiy himoya: so'rovlar soni va hajmini cheklash
// ---------------------------------------------------------------------------
const MAX_MESSAGES = 40;
const MAX_CHARS_PER_MESSAGE = 12000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_PER_MINUTE) || 15;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT_MAX;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of hits) {
    if (times.every((t) => now - t >= RATE_LIMIT_WINDOW_MS)) hits.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "Xabarlar ro'yxati bo'sh.";
  if (messages.length > MAX_MESSAGES) return "Suhbat juda uzun. Iltimos, yangi suhbat boshlang.";
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const expected = i % 2 === 0 ? "user" : "assistant";
    if (!m || m.role !== expected || typeof m.content !== "string") return "Xabar formati noto'g'ri.";
    if (!m.content.trim()) return "Bo'sh xabar yuborib bo'lmaydi.";
    if (m.content.length > MAX_CHARS_PER_MESSAGE) return "Xabar juda uzun (12 000 belgidan oshmasin).";
  }
  if (messages.at(-1).role !== "user") return "Oxirgi xabar foydalanuvchidan bo'lishi kerak.";
  return null;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(here, "public")));

app.get("/api/subjects", (_req, res) => res.json(SUBJECTS));
app.get("/healthz", (_req, res) => res.send("ok"));

app.post("/api/chat", async (req, res) => {
  if (rateLimited(req.ip)) {
    return res.status(429).json({ error: "Juda ko'p so'rov yuborildi. Iltimos, bir daqiqadan so'ng qayta urinib ko'ring." });
  }
  const { messages, subject } = req.body || {};
  const problem = validateMessages(messages);
  if (problem) return res.status(400).json({ error: problem });

  // Server-Sent Events orqali javobni bo'laklab yuboramiz
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    // Professor darajasidagi chuqur fikrlash
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    // Xavfsizlik filtri so'rovni rad etsa, Anthropic tavsiya qilgan modelda qayta urinadi
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    cache_control: { type: "ephemeral" },
    system: [
      { type: "text", text: BASE_SYSTEM, cache_control: { type: "ephemeral" } },
      { type: "text", text: subjectInstruction(subject) },
    ],
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });

  let closed = false;
  res.on("close", () => {
    closed = true;
    stream.abort();
  });

  try {
    send("status", { state: "thinking" });
    for await (const event of stream) {
      if (closed) break;
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        send("delta", { text: event.delta.text });
      }
    }
    if (closed) return;
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      send("error", { error: "Kechirasiz, ushbu so'rovga javob bera olmayman. Iltimos, savolni boshqacha ifodalang." });
    } else if (final.stop_reason === "max_tokens") {
      send("done", { truncated: true });
    } else {
      send("done", {});
    }
  } catch (err) {
    if (closed) return;
    console.error("Claude API xatosi:", err);
    let message = "Serverda xatolik yuz berdi. Iltimos, birozdan so'ng qayta urinib ko'ring.";
    if (err instanceof Anthropic.RateLimitError) message = "Hozir so'rovlar juda ko'p. Iltimos, biroz kuting.";
    else if (err instanceof Anthropic.AuthenticationError) message = "Server sozlanmagan: API kaliti noto'g'ri yoki ko'rsatilmagan.";
    else if (err instanceof Anthropic.APIConnectionError) message = "Sun'iy intellekt xizmatiga ulanib bo'lmadi.";
    send("error", { error: message });
  } finally {
    if (!closed) res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Gamma AI ishga tushdi: http://localhost:${PORT}  (model: ${MODEL})`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn("DIQQAT: ANTHROPIC_API_KEY ko'rsatilmagan. .env faylini yarating (.env.example'ga qarang).");
  }
});
