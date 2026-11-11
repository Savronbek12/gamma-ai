// Rasm yaratish: Google Gemini (GEMINI_API_KEY) yoki OpenAI / ChatGPT (OPENAI_API_KEY).
// Ikkala kalit ham bo'lsa, IMAGE_PROVIDER (gemini | openai) birinchi sinaladiganini tanlaydi,
// birinchisi ishlamasa ikkinchisi sinab ko'riladi. Kalit bo'lmasa, rasm yaratish o'chiq.
import { GoogleGenAI } from "@google/genai";

const hasGemini = () => Boolean(process.env.GEMINI_API_KEY);
const hasOpenAI = () => Boolean(process.env.OPENAI_API_KEY);
export const imagesEnabled = () => hasGemini() || hasOpenAI();

function providerOrder() {
  const order = (process.env.IMAGE_PROVIDER || "gemini").toLowerCase() === "openai" ? ["openai", "gemini"] : ["gemini", "openai"];
  return order.filter((p) => (p === "gemini" ? hasGemini() : hasOpenAI()));
}

const fullPrompt = (prompt) =>
  `Quyidagi tavsif bo'yicha yuqori sifatli rasm yarating. Rasmda yozuv kerak bo'lsa, uni aniq va xatosiz yozing.\n\nTavsif: ${prompt}`;

const blockedError = () => Object.assign(new Error("blocked"), { code: "blocked" });

/**
 * @returns {Promise<{ mime: string, data: string, text: string, source: string }>} data — base64
 */
export async function generateImage(prompt, { signal } = {}) {
  const providers = providerOrder();
  if (!providers.length) throw Object.assign(new Error("no image provider"), { code: "disabled" });
  let lastErr = null;
  for (const p of providers) {
    try {
      return p === "gemini" ? await generateGemini(prompt, signal) : await generateOpenAI(prompt, signal);
    } catch (err) {
      // Taqiqlangan tavsifni boshqa xizmat orqali chetlab o'tmaymiz
      if (err?.code === "blocked" || signal?.aborted) throw err;
      console.error(`${p} rasm xatosi:`, err?.status, err?.message);
      lastErr = Object.assign(err, { provider: p });
    }
  }
  throw lastErr;
}

// ---------- OpenAI (ChatGPT rasm modeli) ----------
const OPENAI_CANDIDATES = [process.env.OPENAI_IMAGE_MODEL, "gpt-image-1.5", "gpt-image-1"].filter(Boolean);
let openaiModel = null; // muvaffaqiyatli ishlagan model eslab qolinadi

async function openaiRequest(model, prompt, signal) {
  const timeout = AbortSignal.timeout(150_000);
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model,
      prompt: fullPrompt(prompt),
      n: 1,
      size: "1024x1024",
      quality: process.env.OPENAI_IMAGE_QUALITY || "medium",
      output_format: "jpeg",
    }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = body?.error || {};
    if (e.code === "moderation_blocked" || /safety system|moderation/i.test(e.message || "")) throw blockedError();
    throw Object.assign(new Error(e.message || `OpenAI ${res.status}`), { status: res.status, code: e.code, type: e.type });
  }
  const data = body?.data?.[0]?.b64_json;
  if (!data) throw Object.assign(new Error("no image"), { code: "no_image" });
  return { mime: "image/jpeg", data, text: "", source: "ChatGPT" };
}

const openaiModelMissing = (err) =>
  err?.code === "model_not_found" || err?.status === 404 || /model .*(does not exist|not found)|invalid model/i.test(String(err?.message));

async function generateOpenAI(prompt, signal) {
  const models = openaiModel ? [openaiModel] : OPENAI_CANDIDATES;
  let lastErr = null;
  for (const model of models) {
    try {
      const out = await openaiRequest(model, prompt, signal);
      openaiModel = model;
      return out;
    } catch (err) {
      if (!openaiModelMissing(err)) throw err;
      lastErr = err;
    }
  }
  openaiModel = null;
  throw lastErr;
}

// ---------- Google Gemini ----------
const GEMINI_CANDIDATES = [process.env.GEMINI_IMAGE_MODEL, "gemini-3.1-flash-image", "gemini-2.5-flash-image"].filter(Boolean);
let client = null;
let geminiModel = null;

const geminiModelMissing = (err) => err?.status === 404 || /not found|is not supported|unknown model/i.test(String(err?.message));

// Ro'yxatdagi modellar ishlamasa, API'dan rasm chiqaradigan Gemini modelini topamiz
async function discoverGeminiModel() {
  try {
    const pager = await client.models.list();
    for await (const m of pager) {
      const name = String(m.name || "").replace(/^models\//, "");
      if (/gemini.*image/i.test(name) && !/tts|edit/i.test(name) && (m.supportedActions || []).includes("generateContent")) return name;
    }
  } catch {}
  return null;
}

async function geminiRequest(model, prompt, signal) {
  const res = await client.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: fullPrompt(prompt) }] }],
    config: { responseModalities: ["TEXT", "IMAGE"], abortSignal: signal },
  });
  const parts = res.candidates?.[0]?.content?.parts || [];
  const image = parts.find((p) => p.inlineData?.data);
  const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("\n").trim();
  const blocked = res.promptFeedback?.blockReason || ["SAFETY", "PROHIBITED_CONTENT", "IMAGE_SAFETY", "BLOCKLIST"].includes(res.candidates?.[0]?.finishReason);
  geminiModel = model;
  if (!image) throw blocked ? blockedError() : Object.assign(new Error("no image"), { code: "no_image" });
  return { mime: image.inlineData.mimeType || "image/png", data: image.inlineData.data, text, source: "Gemini" };
}

async function generateGemini(prompt, signal) {
  client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const models = geminiModel ? [geminiModel] : GEMINI_CANDIDATES;
  let lastErr = null;
  for (const model of models) {
    try {
      return await geminiRequest(model, prompt, signal);
    } catch (err) {
      if (!geminiModelMissing(err)) throw err;
      lastErr = err;
    }
  }
  geminiModel = null;
  const found = await discoverGeminiModel();
  if (found && !models.includes(found)) return geminiRequest(found, prompt, signal);
  throw lastErr;
}

// ---------- Xatolarni tushunarli matnga aylantirish ----------
export function imageErrorMessage(err) {
  if (err?.code === "blocked") return "Kechirasiz, ushbu tavsif bo'yicha rasm yaratib bo'lmaydi. Iltimos, tavsifni o'zgartiring.";
  if (err?.code === "no_image") return "Rasm yaratilmadi. Iltimos, tavsifni aniqroq yozib qayta urinib ko'ring.";
  if (err?.code === "disabled") return "Rasm yaratish hozircha o'chirilgan.";
  const status = err?.status;
  const msg = String(err?.message || "");
  const openai = err?.provider === "openai";

  if (openai) {
    if (err?.code === "insufficient_quota" || err?.code === "billing_hard_limit_reached" || /billing|quota/i.test(msg)) {
      return "ChatGPT (OpenAI) hisobida mablag' yo'q — platform.openai.com'da balansni to'ldirish kerak.";
    }
    if (status === 429) return "Rasm yaratish limiti tugadi. Iltimos, birozdan so'ng qayta urinib ko'ring.";
    if (status === 401) return "Rasm xizmati sozlanmagan: OPENAI_API_KEY noto'g'ri.";
    if (status === 403 && /verif/i.test(msg)) {
      return "OpenAI rasm modeli uchun tashkilotni tasdiqlash (Organization verification) kerak — platform.openai.com sozlamalarida.";
    }
    if (status === 403) return "OpenAI kaliti rasm modeliga ruxsatga ega emas.";
  } else {
    if (status === 429 || /quota|RESOURCE_EXHAUSTED/i.test(msg)) {
      return /limit: 0|free_tier/i.test(msg)
        ? "Rasm yaratish Gemini bepul tarifida mavjud emas — Google AI Studio'da to'lov (billing) yoqilishi kerak."
        : "Rasm yaratish limiti tugadi. Iltimos, birozdan so'ng qayta urinib ko'ring.";
    }
    if (status === 401 || status === 403 || /api key/i.test(msg)) return "Rasm xizmati sozlanmagan: GEMINI_API_KEY noto'g'ri.";
    if (status === 400 && /location|region|not available/i.test(msg)) return "Rasm yaratish ushbu hududda mavjud emas.";
  }
  return "Rasm yaratishda xatolik yuz berdi. Iltimos, birozdan so'ng qayta urinib ko'ring.";
}
