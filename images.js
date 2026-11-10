// Rasm yaratish: GEMINI_API_KEY bo'lsa — Google Gemini; bo'lmasa yoki Gemini ishlamasa —
// bepul, kalitsiz Pollinations.ai (IMAGE_FALLBACK=off bilan o'chiriladi).
import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";

// Birinchisi ishlamasa (model o'chirilgan/nomi o'zgargan), keyingisi sinab ko'riladi
const CANDIDATES = [process.env.GEMINI_IMAGE_MODEL, "gemini-3.1-flash-image", "gemini-2.5-flash-image"].filter(Boolean);

let client = null;
let workingModel = null; // muvaffaqiyatli ishlagan model eslab qolinadi

const fallbackOn = () => (process.env.IMAGE_FALLBACK || "on").toLowerCase() !== "off";
export const imagesEnabled = () => Boolean(process.env.GEMINI_API_KEY) || fallbackOn();

// ---------- Zaxira: Pollinations.ai (kalit kerak emas) ----------
let groq = null;
// Pollinations modeli inglizcha tavsifni yaxshiroq tushunadi — Groq bo'lsa, tarjima qilamiz
async function toEnglish(prompt, signal) {
  if (!process.env.GROQ_API_KEY) return prompt;
  try {
    groq ??= new Groq({ apiKey: process.env.GROQ_API_KEY });
    const r = await groq.chat.completions.create(
      {
        model: process.env.IMAGE_PROMPT_MODEL || "llama-3.1-8b-instant",
        temperature: 0.2,
        max_tokens: 300,
        messages: [
          { role: "system", content: "Translate the user's image description into a concise, vivid English image-generation prompt. Output only the prompt, nothing else." },
          { role: "user", content: prompt },
        ],
      },
      { signal },
    );
    const out = r.choices?.[0]?.message?.content?.trim();
    return out ? out.slice(0, 1000) : prompt;
  } catch {
    return prompt;
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });

// Bepul tarif: bitta IP'dan ~45 soniyada 1 rasm. So'rovlarni navbatga qo'yamiz va limitda kutib qayta urinamiz.
let queue = Promise.resolve();
const MAX_WAIT_MS = 60_000;

async function fetchPollinations(url, signal) {
  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(120_000);
    const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const mime = res.headers.get("content-type") || "";
    if (res.ok && mime.startsWith("image/")) {
      return { mime, data: Buffer.from(await res.arrayBuffer()).toString("base64") };
    }
    const body = await res.text().catch(() => "");
    const limited = res.status === 402 || res.status === 429;
    const waitMs = limited
      ? (Number(/retry after (\d+)/i.exec(body)?.[1] ?? res.headers.get("retry-after") ?? 45) + 1) * 1000
      : 3000;
    if (attempt < 2 && (limited || res.status >= 500) && waitMs <= MAX_WAIT_MS) {
      await sleep(waitMs, signal);
      continue;
    }
    throw Object.assign(new Error(`Pollinations ${res.status}: ${body.slice(0, 200)}`), { status: limited ? 429 : 502 });
  }
}

async function generatePollinations(prompt, signal) {
  const english = await toEnglish(prompt, signal);
  const seed = Math.floor(Math.random() * 1e9);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(english)}?width=1024&height=1024&nologo=true&model=flux&seed=${seed}`;
  const job = queue.then(() => fetchPollinations(url, signal));
  queue = job.catch(() => {});
  const { mime, data } = await job;
  return { mime, data, text: "", source: "Pollinations" };
}

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
  if (!process.env.GEMINI_API_KEY) return generatePollinations(prompt, signal);
  try {
    return await generateGemini(prompt, signal);
  } catch (err) {
    // Taqiqlangan tavsifni zaxira orqali chetlab o'tmaymiz
    if (err?.code === "blocked" || signal?.aborted || !fallbackOn()) throw err;
    console.error("Gemini rasm xatosi, zaxiraga o'tilmoqda:", err?.status, err?.message);
    return generatePollinations(prompt, signal);
  }
}

async function generateGemini(prompt, signal) {
  client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const fullPrompt = `Quyidagi tavsif bo'yicha yuqori sifatli rasm yarating. Rasmda yozuv kerak bo'lsa, uni aniq va xatosiz yozing.\n\nTavsif: ${prompt}`;

  const tryModel = async (model) => {
    const out = await generateWith(model, fullPrompt, signal);
    workingModel = model;
    if (!out.image) {
      throw Object.assign(new Error(out.blocked ? "blocked" : "no image"), { code: out.blocked ? "blocked" : "no_image" });
    }
    return { mime: out.image.inlineData.mimeType || "image/png", data: out.image.inlineData.data, text: out.text, source: "Gemini" };
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
