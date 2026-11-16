// Sun'iy intellekt provayderlari. AI_PROVIDER muhit o'zgaruvchisi bilan tanlanadi:
//   groq   (standart, bepul tarif)  — GROQ_API_KEY kerak
//   gemini (bepul tarif)            — GEMINI_API_KEY kerak
//   claude (pullik)                 — ANTHROPIC_API_KEY kerak
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI, ApiError } from "@google/genai";
import Groq, { toFile } from "groq-sdk";

export const PROVIDER = (process.env.AI_PROVIDER || "groq").toLowerCase();

const DEFAULT_MODELS = { groq: "openai/gpt-oss-120b", gemini: "gemini-3.8-flash", claude: "claude-opus-5-5" };
export const MODEL = process.env.GAMMA_MODEL || DEFAULT_MODELS[PROVIDER];

if (!DEFAULT_MODELS[PROVIDER]) {
  throw new Error(`Noma'lum AI_PROVIDER: "${PROVIDER}". "groq", "gemini" yoki "claude" bo'lishi kerak.`);
}

export function missingKeyWarning() {
  if (PROVIDER === "groq" && !process.env.GROQ_API_KEY) {
    return "DIQQAT: GROQ_API_KEY ko'rsatilmagan. Kalitni https://console.groq.com/keys dan oling.";
  }
  if (PROVIDER === "gemini" && !process.env.GEMINI_API_KEY) {
    return "DIQQAT: GEMINI_API_KEY ko'rsatilmagan. Kalitni https://aistudio.google.com/apikey dan oling.";
  }
  if (PROVIDER === "claude" && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return "DIQQAT: ANTHROPIC_API_KEY ko'rsatilmagan.";
  }
  return null;
}

// So'rov model limitiga sig'madimi (tarixni qisqartirib qayta urinish mumkin)
export function isTooLarge(err) {
  const msg = String(err?.message || "");
  return err?.status === 413 || /reduce your message size|request too large|context length|maximum context/i.test(msg);
}

// Daqiqalik limit (429) bo'lsa, necha millisekund kutish kerakligini qaytaradi; aks holda null.
// Groq "Please try again in 7.66s" deb yozadi va/yoki retry-after sarlavhasini yuboradi.
export function rateLimitWaitMs(err) {
  if (err?.status !== 429) return null;
  const header = typeof err.headers?.get === "function" ? err.headers.get("retry-after") : err.headers?.["retry-after"];
  if (header && !Number.isNaN(Number(header))) return Math.ceil(Number(header) * 1000);
  const m = /try again in (?:(\d+)m)?([\d.]+)(ms|s)/i.exec(String(err.message || ""));
  if (m) {
    const minutes = Number(m[1] || 0);
    const value = Number(m[2]);
    return Math.ceil(minutes * 60_000 + (m[3] === "ms" ? value : value * 1000));
  }
  return 5000;
}

// Xatoni foydalanuvchiga tushunarli o'zbekcha matnga aylantiradi
export function friendlyError(err) {
  const status = err?.status;
  if (status === 429) return "Hozir so'rovlar juda ko'p. Iltimos, bir daqiqadan so'ng qayta urinib ko'ring.";
  if (status === 401 || status === 403) return "Server sozlanmagan: API kaliti noto'g'ri yoki ko'rsatilmagan.";
  if (err instanceof Anthropic.APIConnectionError || err instanceof Groq.APIConnectionError) {
    return "Sun'iy intellekt xizmatiga ulanib bo'lmadi.";
  }
  if (isTooLarge(err)) {
    return "Savolingiz juda uzun. Iltimos, uni qisqartirib qayta yuboring.";
  }
  const isApiError = err instanceof ApiError || err instanceof Anthropic.APIError || err instanceof Groq.APIError;
  if (!isApiError && /api key|apiKey|API_KEY|credentials/i.test(String(err?.message))) {
    return "Server sozlanmagan: API kaliti ko'rsatilmagan.";
  }
  return "Serverda xatolik yuz berdi. Iltimos, birozdan so'ng qayta urinib ko'ring.";
}

// ---------------------------------------------------------------------------
// Yagona interfeys: javob matnini bo'laklab onText() ga beradi va
// tugash sababini qaytaradi: "end" | "max_tokens" | "refusal"
// ---------------------------------------------------------------------------
let groq = null;
let gemini = null;
let claude = null;

export async function streamAnswer(args) {
  if (PROVIDER === "claude") return streamClaude(args);
  if (PROVIDER === "gemini") return streamGemini(args);
  return streamGroq(args);
}

async function streamGroq({ systemParts, messages, signal, onText, maxTokens, reasoningEffort }) {
  // GROQ_API_KEY muhit o'zgaruvchisidan olinadi. Qayta urinishlar kam — aks holda xato juda kech chiqadi.
  // Qayta urinishlarni server.js o'zi boshqaradi (limitda kutish, tarixni qisqartirish)
  groq ??= new Groq({ maxRetries: 0, timeout: 90_000 });
  const stream = await groq.chat.completions.create(
    {
      model: MODEL,
      stream: true,
      // Fikrlash + javob uchun chegara. Groq bepul tarifi bu qiymatni ham daqiqalik token limitiga qo'shib hisoblaydi.
      max_completion_tokens: maxTokens || Number(process.env.MAX_OUTPUT_TOKENS) || 3500,
      // Fikrlash tokenlari ham max_completion_tokens ichida hisoblanadi: "high" da fikrlash butun chegarani
      // egallab, javob bo'sh yoki chala qolardi. "medium" — aniqlik va javob uzunligi o'rtasidagi muvozanat.
      reasoning_effort: reasoningEffort || process.env.REASONING_EFFORT || "medium",
      reasoning_format: "hidden", // fikrlash jarayoni foydalanuvchiga ko'rsatilmaydi
      messages: [
        { role: "system", content: systemParts.join("\n\n") },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    },
    { signal },
  );
  let finish = null;
  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    const text = choice?.delta?.content;
    if (text) onText(text);
    if (choice?.finish_reason) finish = choice.finish_reason;
  }
  return finish === "length" ? "max_tokens" : "end";
}

async function streamGemini({ systemParts, messages, signal, onText }) {
  gemini ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const stream = await gemini.models.generateContentStream({
    model: MODEL,
    contents: messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    config: {
      systemInstruction: systemParts.join("\n\n"),
      maxOutputTokens: 16000,
      abortSignal: signal,
    },
  });

  let finish = null;
  let blocked = false;
  for await (const chunk of stream) {
    if (chunk.promptFeedback?.blockReason) blocked = true;
    const text = chunk.text;
    if (text) onText(text);
    const reason = chunk.candidates?.[0]?.finishReason;
    if (reason) finish = reason;
  }
  if (blocked || ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"].includes(finish)) return "refusal";
  if (finish === "MAX_TOKENS") return "max_tokens";
  return "end";
}

async function streamClaude({ systemParts, messages, signal, onText }) {
  claude ??= new Anthropic();
  const [base, ...rest] = systemParts;
  const stream = claude.beta.messages.stream(
    {
      model: MODEL,
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      // Xavfsizlik filtri rad etsa, Anthropic tavsiya qilgan modelda qayta urinadi
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      cache_control: { type: "ephemeral" },
      system: [
        { type: "text", text: base, cache_control: { type: "ephemeral" } },
        ...rest.map((text) => ({ type: "text", text })),
      ],
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    },
    { signal },
  );
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") onText(event.delta.text);
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") return "refusal";
  if (final.stop_reason === "max_tokens") return "max_tokens";
  return "end";
}

// ---------------------------------------------------------------------------
// Suhbat sarlavhasi: birinchi savol asosida 2–6 so'zli qisqa nom
// ---------------------------------------------------------------------------
const TITLE_SYSTEM =
  "Foydalanuvchining birinchi xabari asosida suhbat uchun 2–6 so'zdan iborat qisqa sarlavha yozing. " +
  "Sarlavha suhbat mavzusini aniq ifodalasin va xabar tilida (odatda o'zbek tili, lotin yozuvi) bo'lsin. " +
  "Faqat sarlavhaning o'zini qaytaring: qo'shtirnoqsiz, nuqtasiz, izohsiz.";

function cleanTitle(raw) {
  const line = String(raw || "").split("\n").map((s) => s.trim()).find(Boolean) || "";
  const t = line.replace(/^(sarlavha|title)\s*:\s*/i, "").replace(/^["'«»“”*#\s]+|["'«»“”*.!?:\s]+$/g, "").trim();
  return t ? t.slice(0, 70) : null;
}

// Qisqa, bir martalik javob (sarlavha, qidiruv so'rovi) — arzon va tez model bilan
async function shortAnswer(system, text, signal) {
  const input = String(text).slice(0, 1500);
  if (PROVIDER === "groq") {
    groq ??= new Groq({ maxRetries: 0, timeout: 90_000 });
    // Birinchi model ishlamasa (o'chirilgan/nomi o'zgargan), keyingisi sinaladi; oxirgisi — asosiy suhbat modeli
    const models = [...new Set([process.env.TITLE_MODEL, "openai/gpt-oss-20b", MODEL].filter(Boolean))];
    let lastErr = null;
    for (const model of models) {
      const reasoning = /gpt-oss/i.test(model);
      try {
        const r = await groq.chat.completions.create(
          {
            model,
            temperature: 0.2,
            // gpt-oss avval qisqa o'ylaydi — fikrlash uchun ham joy qoldiramiz
            max_completion_tokens: reasoning ? 400 : 60,
            ...(reasoning ? { reasoning_effort: "low", reasoning_format: "hidden" } : {}),
            messages: [{ role: "system", content: system }, { role: "user", content: input }],
          },
          { signal },
        );
        const out = r.choices?.[0]?.message?.content;
        if (out && out.trim()) return out;
      } catch (err) {
        if (signal?.aborted || err?.status === 429) throw err;
        console.warn(`Qisqa javob modeli ${model} xatosi:`, err?.status, err?.message);
        lastErr = err;
      }
    }
    if (lastErr) throw lastErr;
    return null;
  }
  if (PROVIDER === "gemini") {
    gemini ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const r = await gemini.models.generateContent({
      model: process.env.TITLE_MODEL || MODEL,
      contents: [{ role: "user", parts: [{ text: input }] }],
      config: { systemInstruction: system, abortSignal: signal },
    });
    return r.text;
  }
  claude ??= new Anthropic();
  const r = await claude.messages.create(
    {
      model: process.env.TITLE_MODEL || "claude-haiku-5-5",
      max_tokens: 80,
      system,
      messages: [{ role: "user", content: input }],
    },
    { signal },
  );
  return r.content.find((b) => b.type === "text")?.text;
}

export async function generateTitle(text, signal) {
  return cleanTitle(await shortAnswer(TITLE_SYSTEM, text, signal));
}

// ---------------------------------------------------------------------------
// Rasm qidiruvi: foydalanuvchi so'rovidan inglizcha qisqa qidiruv so'rovi
// ---------------------------------------------------------------------------
const IMAGE_QUERY_SYSTEM =
  "The user asks (in any language, usually Uzbek) to find a picture. Write a short English image-search query " +
  "(1-4 words) naming exactly what should be in the picture. Write proper names (people, places, things) " +
  "the way the English Wikipedia article title spells them (e.g. Amir Temur → Timur, Registon → Registan, " +
  "Toshkent teleminorasi → Tashkent Tower). Do not add generic words like photo, picture, image, building. " +
  "Output only the query, without quotes or explanations.";

export async function imageSearchQuery(text, signal) {
  const raw = await shortAnswer(IMAGE_QUERY_SYSTEM, text, signal);
  const line = String(raw || "").split(/\r?\n/).map((x) => x.trim()).find(Boolean) || "";
  const q = line.replace(/^(query|search)\s*:\s*/i, "").replace(/^["'«»“”*\s]+|["'«»“”*.!?\s]+$/g, "").trim();
  return q ? q.slice(0, 100) : null;
}

// ---------------------------------------------------------------------------
// Rasmni o'qish (vision): rasmdagi barcha matn va tasvirni so'z bilan ifodalaydi.
// Natija oddiy matn sifatida suhbatga qo'shiladi, shuning uchun asosiy model rasm ko'rmasa ham ishlaydi.
// ---------------------------------------------------------------------------
const VISION_SYSTEM =
  "You read images for a teaching assistant that cannot see them. First transcribe ALL visible text exactly as written, " +
  "in its original language and script (keep line breaks; write math formulas in LaTeX). Then describe in detail " +
  "everything else that matters for understanding: diagrams, charts (axes, values, trends), tables (as Markdown), " +
  "drawings, photos, handwriting. If it is a task or exam question, reproduce it completely. Do not solve anything, " +
  "do not add opinions. Write the description part in Uzbek (Latin script).";
const VIDEO_FRAMES_NOTE =
  " This image is a grid of frames taken from ONE video in time order (left to right, top to bottom; each frame is " +
  "labeled with its timestamp). Describe what is shown and what happens in the video over time, frame by frame where useful.";

// ---------------------------------------------------------------------------
// Audio/video nutqini matnga aylantirish (Groq Whisper). Boshqa provayderlarda — null.
// ---------------------------------------------------------------------------
export const canTranscribe = () => PROVIDER === "groq" || !!process.env.GROQ_API_KEY;

export async function transcribeAudio(buf, name, signal) {
  if (!canTranscribe()) return null;
  groq ??= new Groq({ maxRetries: 0, timeout: 90_000 });
  const r = await groq.audio.transcriptions.create(
    {
      file: await toFile(buf, name),
      model: process.env.TRANSCRIBE_MODEL || "whisper-large-v3-turbo",
      response_format: "json",
      temperature: 0,
    },
    { signal },
  );
  return String(r?.text || "").trim();
}

export async function describeImage(buf, mime, signal, { videoFrames = false } = {}) {
  const system = VISION_SYSTEM + (videoFrames ? VIDEO_FRAMES_NOTE : "");
  const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
  if (PROVIDER === "gemini") {
    gemini ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const r = await gemini.models.generateContent({
      model: process.env.VISION_MODEL || MODEL,
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: mime, data: buf.toString("base64") } }, { text: "Rasmni o'qing." }] }],
      config: { systemInstruction: system, abortSignal: signal },
    });
    return r.text;
  }
  if (PROVIDER === "claude") {
    claude ??= new Anthropic();
    const r = await claude.messages.create(
      {
        model: process.env.VISION_MODEL || MODEL,
        max_tokens: 4000,
        system,
        messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: mime, data: buf.toString("base64") } }, { type: "text", text: "Rasmni o'qing." }] }],
      },
      { signal },
    );
    return r.content.find((b) => b.type === "text")?.text;
  }
  groq ??= new Groq({ maxRetries: 0, timeout: 90_000 });
  const models = [
    ...new Set([process.env.VISION_MODEL, "meta-llama/llama-4-scout-17b-16e-instruct", "meta-llama/llama-4-maverick-17b-128e-instruct"].filter(Boolean)),
  ];
  let lastErr = null;
  for (const model of models) {
    try {
      const r = await groq.chat.completions.create(
        {
          model,
          temperature: 0.1,
          max_completion_tokens: 2500,
          messages: [
            { role: "system", content: system },
            { role: "user", content: [{ type: "text", text: "Rasmni o'qing." }, { type: "image_url", image_url: { url: dataUrl } }] },
          ],
        },
        { signal },
      );
      const out = r.choices?.[0]?.message?.content;
      if (out && out.trim()) return out;
    } catch (err) {
      if (signal?.aborted || err?.status === 429) throw err;
      console.warn(`Vision modeli ${model} xatosi:`, err?.status, err?.message);
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

// ---------------------------------------------------------------------------
// Tuzilgan (JSON) javob — masalan, taqdimot slaydlari uchun
// ---------------------------------------------------------------------------
function parseJsonLoose(raw) {
  const s = String(raw || "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    return JSON.parse(s);
  } catch {
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a !== -1 && b > a) return JSON.parse(s.slice(a, b + 1));
    throw new Error("Model JSON qaytarmadi");
  }
}

export async function completeJSON(system, user, { maxTokens = 4000, signal } = {}) {
  if (PROVIDER === "gemini") {
    gemini ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const r = await gemini.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: user }] }],
      config: { systemInstruction: system, responseMimeType: "application/json", abortSignal: signal },
    });
    return parseJsonLoose(r.text);
  }
  if (PROVIDER === "claude") {
    claude ??= new Anthropic();
    const r = await claude.messages.create(
      { model: MODEL, max_tokens: 16000, system, messages: [{ role: "user", content: user }] },
      { signal },
    );
    return parseJsonLoose(r.content.find((b) => b.type === "text")?.text);
  }
  groq ??= new Groq({ maxRetries: 0, timeout: 90_000 });
  const request = {
    model: MODEL,
    max_completion_tokens: maxTokens,
    reasoning_effort: "low",
    reasoning_format: "hidden",
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  };
  let r;
  try {
    r = await groq.chat.completions.create(request, { signal });
  } catch (err) {
    // Ba'zan JSON rejimi "json_validate_failed" beradi — oddiy rejimda qayta urinamiz
    if (err?.status !== 400 || signal?.aborted) throw err;
    console.warn("JSON rejimi xatosi, oddiy rejimda qayta urinilmoqda:", err?.message);
    delete request.response_format;
    r = await groq.chat.completions.create(request, { signal });
  }
  return parseJsonLoose(r.choices?.[0]?.message?.content);
}
