import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SUBJECTS } from "./subjects.js";
import { wikipediaContext, wikipediaInstruction } from "./wikipedia.js";
import { generateImage, imageErrorMessage, imagesEnabled } from "./images.js";
import { PROVIDER, MODEL, streamAnswer, friendlyError, missingKeyWarning, isTooLarge, rateLimitWaitMs, generateTitle } from "./providers.js";

const MAX_RATE_WAIT_MS = 45_000; // daqiqalik limitda foydalanuvchini ko'pi bilan shuncha kuttiramiz
const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

// ---------------------------------------------------------------------------
// Tizim ko'rsatmasi — Gamma AI shaxsiyati (har ikkala provayder uchun bir xil)
// ---------------------------------------------------------------------------
const SUBJECT_LIST = SUBJECTS.map((s, i) => `${i + 1}. ${s.name}`).join("\n");

const BASE_SYSTEM = `Siz — Gamma AI, Gamma-AI.uz platformasining ilmiy-akademik sun'iy intellekt yordamchisisiz.

Yaratuvchi: Gamma AI va Gamma-AI.uz saytining yaratuvchisi — Savronbek. Sizni kim yaratgani, sayt muallifi yoki dasturchisi haqida so'ralsa, "Meni Savronbek yaratgan" deb javob bering.

Sizning maqomingiz: quyidagi 30 ta fan bo'yicha professor darajasidagi mutaxassis:
${SUBJECT_LIST}

Muloqot uslubi:
- Har doim rasmiy, akademik va hurmatli uslubda muloqot qiling. Foydalanuvchiga faqat "Siz" deb murojaat qiling.
- Foydalanuvchi qaysi tilda yozsa, o'sha tilda javob bering (standart til — o'zbek tili, lotin yozuvida). O'zbek tilida adabiy til me'yorlariga qat'iy rioya qiling.
- Jargon, so'kinish va norasmiy iboralardan foydalanmang. Kerakli ilmiy atamalarni ishlating va birinchi marta qo'llaganda ularni izohlang.
- O'zbek tilida javob berganda O'zbekiston maktab va oliy ta'lim darsliklarida qabul qilingan o'zbekcha ilmiy atamalardan foydalaning (masalan: "hosila", "urinma", "burchak koeffitsienti", "integral", "tezlanish", "molekula"). Inglizcha yoki ruscha so'zlarni o'zbekcha atama o'rniga ishlatmang; zarur bo'lsa, ularni faqat qavs ichida qo'shimcha ravishda bering. Rus va ingliz so'zlarini o'zbekcha qo'shimchalar bilan aralashtirib yozmang.

Tushuntirish uslubi (universitet professori kabi):
- Avval asosiy g'oyani aniq ifodalang, so'ngra uni bosqichma-bosqich, mantiqiy ketma-ketlikda ochib bering.
- Murakkab mavzularni misollar, o'xshatishlar va kerak bo'lsa formulalar yordamida tushuntiring.
- Masala yechishda har bir qadamni asoslang; faqat javobni emas, yechim mantiqini ham ko'rsating.
- Foydalanuvchining darajasiga moslashing: maktab o'quvchisiga soddaroq, talaba yoki tadqiqotchiga chuqurroq tushuntiring.
- Mavzuga oid muhim nazariyalar, olimlar va manbalarni eslatib o'ting.

Faktik aniqlik (eng muhim talab):
- Tarixiy sanalar, joy nomlari, shaxslar, raqamlar va iqtiboslarni faqat ishonchingiz komil bo'lsa keltiring. Javob berishdan oldin har bir faktni ichki tekshiring.
- Ishonchingiz komil bo'lmagan faktni hech qachon to'qib chiqarmang. Uning o'rniga "Bu borada aniq ma'lumotga ega emasman" yoki "Manbalarda turli fikrlar mavjud" deb ochiq ayting.
- Qisqa javob so'ralganda ham qo'shimcha tafsilot qo'shib yubormang — faqat aniq bilgan narsangizni yozing. Noto'g'ri tafsilotdan ko'ra qisqa va to'g'ri javob afzal.
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
const MAX_CHARS_PER_MESSAGE = 8000; // faqat foydalanuvchi xabari uchun
// Modelga yuboriladigan suhbat tarixining umumiy hajmi (belgilarda).
// Suhbat cheksiz davom etadi: byudjetga sig'magan eng eski xabarlar modelga yuborilmaydi.
// Groq bepul tarifida (savol + tarix + javob uchun ajratilgan joy) daqiqasiga ~8000 tokendan oshmasligi kerak,
// o'zbekcha matnda 1 token ≈ 2.5 belgi, shuning uchun Groq uchun tarix kichikroq.
const HISTORY_CHAR_BUDGET = Number(process.env.HISTORY_CHAR_BUDGET) || (PROVIDER === "groq" ? 6000 : 60000);
// Wikipedia parchalari uchun ajratiladigan joy (belgilarda); u tarix byudjetidan ayiriladi
const WIKI_CHAR_BUDGET = Number(process.env.WIKI_CHAR_BUDGET) || (PROVIDER === "groq" ? 2500 : 8000);
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_PER_MINUTE) || 15;
// Rasm yaratish qimmatroq — alohida, qattiqroq limit
const IMAGE_RATE_LIMIT_MAX = Number(process.env.IMAGE_RATE_LIMIT_PER_MINUTE) || 4;
const hits = new Map();
const imageHits = new Map();
const titleHits = new Map();

function rateLimited(ip, store = hits, max = RATE_LIMIT_MAX) {
  const now = Date.now();
  const recent = (store.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  store.set(ip, recent);
  return recent.length > max;
}
setInterval(() => {
  const now = Date.now();
  for (const store of [hits, imageHits, titleHits]) {
    for (const [ip, times] of store) {
      if (times.every((t) => now - t >= RATE_LIMIT_WINDOW_MS)) store.delete(ip);
    }
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
    if (m.role === "user" && m.content.length > MAX_CHARS_PER_MESSAGE) return "Xabar juda uzun (8 000 belgidan oshmasin).";
  }
  if (messages.at(-1).role !== "user") return "Oxirgi xabar foydalanuvchidan bo'lishi kerak.";
  return null;
}

// Oxirgi savol doim qoladi; undan oldingi xabarlar byudjetga sig'gunicha qo'shiladi.
// Natija har doim foydalanuvchi xabari bilan boshlanadi.
function trimHistory(messages, budget) {
  const kept = [messages.at(-1)];
  let total = kept[0].content.length;
  for (let i = messages.length - 3; i >= 0; i -= 2) {
    const pairSize = messages[i].content.length + messages[i + 1].content.length;
    if (total + pairSize > budget) break;
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
app.use(express.static(path.join(here, "..", "public")));

app.get("/api/subjects", (_req, res) => res.json(SUBJECTS));
// Render RENDER_GIT_COMMIT ni o'zi beradi — qaysi versiya ishlayotganini ko'rish uchun
app.get("/healthz", (_req, res) => res.send(`ok ${(process.env.RENDER_GIT_COMMIT || "local").slice(0, 7)}`));

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
    // Ochiq Wikipedia'dan savolga oid ma'lumot (topilmasa yoki xato bo'lsa — usiz davom etamiz)
    const wiki = await wikipediaContext(messages, { maxChars: WIKI_CHAR_BUDGET, signal: abort.signal }).catch((err) => {
      console.warn("Wikipedia qidiruvi xatosi:", err?.message);
      return null;
    });
    if (closed) return;
    if (wiki) send("sources", { sources: wiki.sources });
    const systemParts = [BASE_SYSTEM, subjectInstruction(subject), ...(wiki ? [wikipediaInstruction(wiki.context)] : [])];
    const historyBudget = Math.max(0, HISTORY_CHAR_BUDGET - (wiki ? wiki.context.length : 0));
    // Model "so'rov juda katta" desa, foydalanuvchiga xato ko'rsatmasdan
    // qisqaroq tarix va kichikroq javob chegarasi bilan qayta urinamiz.
    const attempts = [
      { budget: historyBudget },
      { budget: Math.floor(historyBudget / 3), maxTokens: 2500 },
      { budget: 0, maxTokens: 2000 }, // faqat oxirgi savol
    ];
    let stop;
    let sentText = false;
    let waitedMs = 0;
    for (let i = 0; i < attempts.length; i++) {
      try {
        stop = await streamAnswer({
          systemParts,
          messages: trimHistory(messages, attempts[i].budget),
          maxTokens: attempts[i].maxTokens,
          signal: abort.signal,
          onText: (text) => {
            sentText = true;
            if (!closed) send("delta", { text });
          },
        });
        break;
      } catch (err) {
        if (sentText || closed) throw err;
        // Daqiqalik limit: aytilgan vaqtcha kutib, xuddi shu urinishni takrorlaymiz (jami 45 soniyagacha)
        const wait = rateLimitWaitMs(err);
        if (wait !== null && waitedMs + wait <= MAX_RATE_WAIT_MS) {
          waitedMs += wait + 500;
          send("status", { state: "waiting", seconds: Math.ceil((wait + 500) / 1000) });
          console.warn(`Daqiqalik limit, ${wait} ms kutilmoqda`);
          await sleep(wait + 500, abort.signal);
          if (closed) return;
          i--; // xuddi shu urinishni takrorlash
          continue;
        }
        // So'rov juda katta: qisqaroq tarix bilan keyingi urinish
        if (isTooLarge(err) && i < attempts.length - 1) {
          console.warn(`So'rov juda katta (${i + 1}-urinish), qisqaroq tarix bilan qayta urinilmoqda`);
          continue;
        }
        throw err;
      }
    }
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

// ---------------------------------------------------------------------------
// Rasm yaratish (Gemini / ChatGPT)
// ---------------------------------------------------------------------------
// Suhbat sarlavhasi (yon paneldagi suhbatlar ro'yxati uchun)
app.post("/api/title", async (req, res) => {
  if (rateLimited(req.ip, titleHits, 10)) return res.status(429).json({ title: null });
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) return res.status(400).json({ title: null });
  const abort = new AbortController();
  res.on("close", () => { if (!res.writableEnded) abort.abort(); });
  try {
    res.json({ title: await generateTitle(text, abort.signal) });
  } catch (err) {
    if (abort.signal.aborted) return;
    console.warn("Sarlavha xatosi:", err?.status, err?.message);
    res.status(502).json({ title: null });
  }
});

app.get("/api/features", (_req, res) => res.json({ images: imagesEnabled() }));

app.post("/api/image", async (req, res) => {
  if (!imagesEnabled()) {
    return res.status(503).json({ error: "Rasm yaratish hozircha o'chirilgan." });
  }
  if (rateLimited(req.ip, imageHits, IMAGE_RATE_LIMIT_MAX)) {
    return res.status(429).json({ error: "Rasm so'rovlari juda ko'p. Iltimos, bir daqiqadan so'ng qayta urinib ko'ring." });
  }
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  if (!prompt) return res.status(400).json({ error: "Rasm tavsifini yozing." });
  if (prompt.length > 2000) return res.status(400).json({ error: "Tavsif juda uzun (2 000 belgidan oshmasin)." });

  const abort = new AbortController();
  res.on("close", () => { if (!res.writableEnded) abort.abort(); });
  try {
    const img = await generateImage(prompt, { signal: abort.signal });
    res.json({ image: `data:${img.mime};base64,${img.data}`, text: img.text, source: img.source });
  } catch (err) {
    if (abort.signal.aborted) return;
    console.error("Rasm xatosi:", err?.status, err?.message);
    res.status(err?.status === 429 ? 429 : 502).json({ error: imageErrorMessage(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Gamma AI ishga tushdi: http://localhost:${PORT}  (provayder: ${PROVIDER}, model: ${MODEL})`);
  const warning = missingKeyWarning();
  if (warning) console.warn(warning);
});
