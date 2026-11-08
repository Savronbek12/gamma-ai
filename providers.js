// Sun'iy intellekt provayderlari. AI_PROVIDER muhit o'zgaruvchisi bilan tanlanadi:
//   groq   (standart, bepul tarif)  — GROQ_API_KEY kerak
//   gemini (bepul tarif)            — GEMINI_API_KEY kerak
//   claude (pullik)                 — ANTHROPIC_API_KEY kerak
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI, ApiError } from "@google/genai";
import Groq from "groq-sdk";

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

async function streamGroq({ systemParts, messages, signal, onText, maxTokens }) {
  // GROQ_API_KEY muhit o'zgaruvchisidan olinadi. Qayta urinishlar kam — aks holda xato juda kech chiqadi.
  groq ??= new Groq({ maxRetries: 1, timeout: 90_000 });
  const stream = await groq.chat.completions.create(
    {
      model: MODEL,
      stream: true,
      // Fikrlash + javob uchun chegara. Groq bepul tarifi bu qiymatni ham daqiqalik token limitiga qo'shib hisoblaydi.
      max_completion_tokens: maxTokens || Number(process.env.MAX_OUTPUT_TOKENS) || 3500,
      // "high" — javobdan oldin chuqurroq o'ylaydi (faktik xatolar kamroq, biroz sekinroq)
      reasoning_effort: process.env.REASONING_EFFORT || "high",
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
