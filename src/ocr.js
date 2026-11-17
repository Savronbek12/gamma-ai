// Rasmdagi matnni o'qish (OCR) — AI vision modeli bo'lmaganda zaxira yo'l.
// Tesseract serverda ishlaydi: o'zbek (lotin), ingliz va rus tillari. Til ma'lumotlari birinchi
// ishlatilganda yuklanadi; ishchi (worker) 10 daqiqa ishlatilmasa, xotirani bo'shatish uchun yopiladi.
import { createWorker } from "tesseract.js";

const LANGS = process.env.OCR_LANGS || "uzb+eng+rus";
const IDLE_MS = 10 * 60_000;
let workerPromise = null;
let idleTimer = null;
let queue = Promise.resolve();

function getWorker() {
  workerPromise ??= createWorker(LANGS, 1, { cachePath: process.env.OCR_CACHE || undefined }).catch((err) => {
    workerPromise = null;
    throw err;
  });
  return workerPromise;
}

function scheduleIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const p = workerPromise;
    workerPromise = null;
    try { (await p)?.terminate(); } catch {}
  }, IDLE_MS);
  idleTimer.unref?.();
}

// Bir vaqtda bitta rasm (xotira kam bo'lgan bepul serverda xavfsizroq)
export function ocrImage(buf) {
  const job = queue.then(async () => {
    const worker = await getWorker();
    const { data } = await worker.recognize(buf);
    scheduleIdle();
    // Matnsiz fotoda Tesseract tasodifiy belgilar chiqaradi — ishonchi past natijani tashlaymiz
    if ((Number(data?.confidence) || 0) < 55) return "";
    return String(data?.text || "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  });
  queue = job.catch(() => {});
  return job;
}
