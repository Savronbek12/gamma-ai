// Rasm yaratish — Google Gemini orqali (GEMINI_API_KEY kerak, AI_PROVIDER qanday bo'lishidan qat'i nazar).
import { GoogleGenAI } from "@google/genai";

// Birinchisi ishlamasa (model o'chirilgan/nomi o'zgargan), keyingisi sinab ko'riladi
const CANDIDATES = [process.env.GEMINI_IMAGE_MODEL, "gemini-3.1-flash-image", "gemini-2.5-flash-image"].filter(Boolean);

let client = null;
let workingModel = null; // muvaffaqiyatli ishlagan model eslab qolinadi

export const imagesEnabled = () => Boolean(process.env.GEMINI_API_KEY);

const isModelMissing = (err) => err?.status === 404 || /not found|is not supported|unknown model/i.test(String(err?.message));

// Ro'yxatdagi modellar ishlamasa, API'dan rasm chiqaradigan Gemini modelini topamiz
async function discoverModel() {
  try {
    const pager = await client.models.list();
    for await (const m of pager) {
      const name = String(m.name || "").replace(/^models\//, "");
      if (/gemini.*image/i.test(name) && !/tts|edit/i.test(name) && (m.supportedActions || []).includes("generateContent")) return name;
    }
  } catch {}
  return null;
}

async function generateWith(model, prompt, signal) {
  const res = await client.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { responseModalities: ["TEXT", "IMAGE"], abortSignal: signal },
  });
  const parts = res.candidates?.[0]?.content?.parts || [];
  const image = parts.find((p) => p.inlineData?.data);
  const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("\n").trim();
  const blocked = res.promptFeedback?.blockReason || ["SAFETY", "PROHIBITED_CONTENT", "IMAGE_SAFETY", "BLOCKLIST"].includes(res.candidates?.[0]?.finishReason);
  return { image, text, blocked };
}

/**
 * @returns {Promise<{ mime: string, data: string, text: string }>} data — base64
 */
export async function generateImage(prompt, { signal } = {}) {
  client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const fullPrompt = `Quyidagi tavsif bo'yicha yuqori sifatli rasm yarating. Rasmda yozuv kerak bo'lsa, uni aniq va xatosiz yozing.\n\nTavsif: ${prompt}`;

  const tryModel = async (model) => {
    const out = await generateWith(model, fullPrompt, signal);
    workingModel = model;
    if (!out.image) {
      throw Object.assign(new Error(out.blocked ? "blocked" : "no image"), { code: out.blocked ? "blocked" : "no_image" });
    }
    return { mime: out.image.inlineData.mimeType || "image/png", data: out.image.inlineData.data, text: out.text };
  };

  const models = workingModel ? [workingModel] : CANDIDATES;
  let lastErr = null;
  for (const model of models) {
    try {
      return await tryModel(model);
    } catch (err) {
      if (!isModelMissing(err)) throw err;
      lastErr = err;
    }
  }
  // Hech biri topilmadi — API'dan mos modelni qidiramiz
  workingModel = null;
  const found = await discoverModel();
  if (found && !models.includes(found)) return tryModel(found);
  throw lastErr;
}

export function imageErrorMessage(err) {
  if (err?.code === "blocked") return "Kechirasiz, ushbu tavsif bo'yicha rasm yaratib bo'lmaydi. Iltimos, tavsifni o'zgartiring.";
  if (err?.code === "no_image") return "Rasm yaratilmadi. Iltimos, tavsifni aniqroq yozib qayta urinib ko'ring.";
  const status = err?.status;
  const msg = String(err?.message || "");
  if (status === 429 || /quota|RESOURCE_EXHAUSTED/i.test(msg)) {
    return /limit: 0|free_tier/i.test(msg)
      ? "Rasm yaratish Gemini bepul tarifida mavjud emas — Google AI Studio'da to'lov (billing) yoqilishi kerak."
      : "Rasm yaratish limiti tugadi. Iltimos, birozdan so'ng qayta urinib ko'ring.";
  }
  if (status === 401 || status === 403 || /api key/i.test(msg)) return "Rasm xizmati sozlanmagan: GEMINI_API_KEY noto'g'ri yoki ko'rsatilmagan.";
  if (status === 400 && /location|region|not available/i.test(msg)) return "Rasm yaratish ushbu hududda mavjud emas.";
  return "Rasm yaratishda xatolik yuz berdi. Iltimos, birozdan so'ng qayta urinib ko'ring.";
}
