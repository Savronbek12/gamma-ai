// Taqdimot slaydlari uchun ochiq litsenziyali rasmlar (Wikipedia / Wikimedia Commons / Openverse).
// Har bir rasm yuklab olinadi, o'lchami aniqlanadi va pptx ichiga joylash uchun base64 qilinadi.
import { searchImages } from "./imagesearch.js";

const USER_AGENT = "GammaAI/1.0 (https://gamma-ai.uz)";
const MAX_BYTES = 2.5 * 1024 * 1024;
const cache = new Map(); // so'rov → rasm (qayta yuklab olishda tezroq)
const CACHE_MAX = 150;

// JPEG/PNG sarlavhasidan rasm o'lchamini o'qiydi
function imageSize(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") {
    return { type: "png", w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15 (DHT=C4, JPG=C8, DAC=CC bundan mustasno)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { type: "jpeg", h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

async function download(url, signal) {
  const timeout = AbortSignal.timeout(10_000);
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) throw new Error(`rasm ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("rasm juda katta");
  return buf;
}

export async function findSlideImage(query, signal) {
  const q = String(query || "").trim();
  if (!q) return null;
  const key = q.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  let result = null;
  try {
    const found = await searchImages({ english: q }, { signal });
    for (const it of found.slice(0, 3)) {
      try {
        const buf = await download(it.thumb, signal);
        const size = imageSize(buf);
        if (!size || size.w < 200 || size.h < 150) continue;
        const credit = [it.source, it.license].filter(Boolean).join(" · ");
        result = {
          data: `image/${size.type};base64,${buf.toString("base64")}`,
          w: size.w,
          h: size.h,
          credit: credit ? `Rasm: ${credit}` : "",
        };
        break;
      } catch (err) {
        if (signal?.aborted) throw err;
      }
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn("Slayd rasmi topilmadi:", q, err?.message);
  }
  cache.set(key, result);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return result;
}

// Taqdimotning barcha rasmlari: bir vaqtda ko'pi bilan 4 ta so'rov
export async function findDeckImages(deck, signal) {
  const queries = [deck.image || deck.title, ...deck.slides.map((s) => s.image)];
  const out = new Array(queries.length).fill(null);
  let next = 0;
  const used = new Set();
  async function worker() {
    while (next < queries.length) {
      const i = next++;
      if (!queries[i]) continue;
      const img = await findSlideImage(queries[i], signal).catch(() => null);
      // Bir xil rasm ikki marta chiqmasin
      if (img && !used.has(img.data.slice(-200))) {
        used.add(img.data.slice(-200));
        out[i] = img;
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { cover: out[0], slides: out.slice(1) };
}
