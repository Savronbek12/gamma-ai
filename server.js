import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SUBJECTS } from "./subjects.js";
import { PROVIDER, MODEL, streamAnswer, friendlyError, missingKeyWarning } from "./providers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

// ---------------------------------------------------------------------------
// Tizim ko'rsatmasi — Gamma AI shaxsiyati (har ikkala provayder uchun bir xil)
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
const MAX_MESSAGES = 200;
const MAX_CHARS_PER_MESSAGE = 12000; // faqat foydalanuvchi xabari uchun
// Modelga yuboriladigan suhbat tarixining umumiy hajmi (belgilarda).
// Groq'ning bepul tarifida daqiqasiga token chegarasi past, shuning uchun eski xabarlar qisqartiriladi.
const HISTORY_CHAR_BUDGET = Number(process.env.HISTORY_CHAR_BUDGET) || 16000;
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
    if (m.role === "user" && m.content.length > MAX_CHARS_PER_MESSAGE) return "Xabar juda uzun (12 000 belgidan oshmasin).";
  }
  if (messages.at(-1).role !== "user") return "Oxirgi xabar foydalanuvchidan bo'lishi kerak.";
  return null;
}

// Oxirgi savol doim qoladi; undan oldingi xabarlar byudjetga sig'gunicha qo'shiladi.
// Natija har doim foydalanuvchi xabari bilan boshlanadi.
function trimHistory(messages) {
  const kept = [messages.at(-1)];
  let total = kept[0].content.length;
  for (let i = messages.length - 3; i >= 0; i -= 2) {
    const pairSize = messages[i].content.length + messages[i + 1].content.length;
    if (total + pairSize > HISTORY_CHAR_BUDGET) break;
    kept.unshift(messages[i], messages[i + 1]);
    total += pairSize;
  }
  return kept;
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

  const abort = new AbortController();
  let closed = false;
  res.on("close", () => {
    closed = true;
    abort.abort();
  });

  try {
    send("status", { state: "thinking" });
    const stop = await streamAnswer({
      systemParts: [BASE_SYSTEM, subjectInstruction(subject)],
      messages: trimHistory(messages),
      signal: abort.signal,
      onText: (text) => {
        if (!closed) send("delta", { text });
      },
    });
    if (closed) return;
    if (stop === "refusal") {
      send("error", { error: "Kechirasiz, ushbu so'rovga javob bera olmayman. Iltimos, savolni boshqacha ifodalang." });
    } else {
      send("done", { truncated: stop === "max_tokens" });
    }
  } catch (err) {
    if (closed) return;
    console.error(`${PROVIDER} API xatosi:`, err);
    send("error", { error: friendlyError(err) });
  } finally {
    if (!closed) res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Gamma AI ishga tushdi: http://localhost:${PORT}  (provayder: ${PROVIDER}, model: ${MODEL})`);
  const warning = missingKeyWarning();
  if (warning) console.warn(warning);
});
