// Ochiq internetdan video qidirish (API kaliti kerak emas):
//   1) Wikimedia Commons — ochiq litsenziyali videolar (webm/ogv)
//   2) Internet Archive (archive.org) — millionlab ochiq/jamoat mulki videolari (mp4)
// Har bir natija: ko'rish uchun manzil (src), yuklab olish manzili (full), muqova rasmi, muallif va litsenziya.

const USER_AGENT = "GammaAI/1.0 (https://gamma-ai.uz)";
const TIMEOUT_MS = 9000;
const MAX_RESULTS = 8;

const stripHtml = (s) => String(s || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
const first = (v) => (Array.isArray(v) ? v[0] : v);

async function getJson(url, signal) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) throw Object.assign(new Error(`${new URL(url).hostname} ${res.status}`), { status: res.status });
  return res.json();
}

async function searchCommonsVideos(query, signal) {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  const params = {
    action: "query", format: "json", formatversion: "2",
    generator: "search", gsrsearch: `filetype:video ${query}`, gsrnamespace: "6", gsrlimit: "12",
    prop: "imageinfo", iiprop: "url|mime|size|extmetadata", iiurlwidth: "480",
    iiextmetadatafilter: "Artist|LicenseShortName|ObjectName",
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const data = await getJson(url, signal);
  return (data.query?.pages || [])
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((p) => {
      const info = p.imageinfo?.[0];
      if (!info?.url || !/^video\//.test(info.mime || "")) return null;
      const meta = info.extmetadata || {};
      return {
        thumb: info.thumburl || null,
        src: info.url.split("?")[0],
        full: info.url.split("?")[0],
        page: info.descriptionurl,
        title: stripHtml(meta.ObjectName?.value) || p.title.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, ""),
        creator: stripHtml(meta.Artist?.value).slice(0, 80) || null,
        license: stripHtml(meta.LicenseShortName?.value) || null,
        source: "Wikimedia Commons",
        duration: Number(info.duration) || null,
        size: Number(info.size) || null,
        ext: (info.url.split("?")[0].split(".").pop() || "webm").toLowerCase(),
      };
    })
    .filter(Boolean);
}

// archive.org: avval qidiruv, keyin har bir yozuvning fayllari ichidan mp4 ni tanlaymiz
async function searchArchiveVideos(query, signal) {
  const url = new URL("https://archive.org/advancedsearch.php");
  url.searchParams.set("q", `(${query}) AND mediatype:(movies) AND licenseurl:* AND -collection:(tvarchive)`);
  for (const f of ["identifier", "title", "creator", "licenseurl"]) url.searchParams.append("fl[]", f);
  url.searchParams.set("rows", "10");
  url.searchParams.set("output", "json");
  const data = await getJson(url, signal);
  const docs = (data.response?.docs || []).slice(0, 8);
  const items = await Promise.all(
    docs.map(async (d) => {
      try {
        const meta = await getJson(`https://archive.org/metadata/${encodeURIComponent(d.identifier)}`, signal);
        const files = (meta.files || []).filter((f) => /\.mp4$/i.test(f.name || "") && !/\.ia\.mp4$/i.test(f.name || ""));
        const mp4 = files.length ? files : (meta.files || []).filter((f) => /\.mp4$/i.test(f.name || ""));
        if (!mp4.length) return null;
        // Juda katta bo'lmagan, lekin eng sifatli faylni tanlaymiz
        mp4.sort((a, b) => Number(a.size || 0) - Number(b.size || 0));
        const pick = mp4.find((f) => Number(f.size || 0) > 300_000 && Number(f.size || 0) < 400_000_000) || mp4[0];
        const fileUrl = `https://archive.org/download/${encodeURIComponent(d.identifier)}/${pick.name.split("/").map(encodeURIComponent).join("/")}`;
        const lic = String(first(d.licenseurl) || "");
        return {
          thumb: `https://archive.org/services/img/${encodeURIComponent(d.identifier)}`,
          src: fileUrl,
          full: fileUrl,
          page: `https://archive.org/details/${encodeURIComponent(d.identifier)}`,
          title: stripHtml(first(d.title)) || d.identifier,
          creator: stripHtml(first(d.creator)).slice(0, 80) || null,
          license: /publicdomain|zero/i.test(lic) ? "Public domain" : /creativecommons/i.test(lic) ? "Creative Commons" : null,
          source: "Internet Archive",
          duration: Number(pick.length) || null,
          size: Number(pick.size) || null,
          ext: "mp4",
        };
      } catch (err) {
        if (signal?.aborted) throw err;
        return null;
      }
    }),
  );
  return items.filter(Boolean);
}

/** @param {{ english?: string|null, local?: string|null }} q */
export async function searchVideos({ english, local }, { signal } = {}) {
  const list = [...new Set([english, local].map((q) => String(q || "").trim()).filter(Boolean))];
  const results = [];
  const seen = new Set();
  let lastErr = null;
  for (const q of list) {
    const [commons, archive] = await Promise.all([
      searchCommonsVideos(q, signal).catch((e) => { lastErr = e; return []; }),
      searchArchiveVideos(q, signal).catch((e) => { lastErr = e; return []; }),
    ]);
    // Ikkala manbadan navbatma-navbat
    for (let i = 0; i < Math.max(commons.length, archive.length); i++) {
      for (const it of [commons[i], archive[i]]) {
        if (!it || results.length >= MAX_RESULTS || seen.has(it.src)) continue;
        seen.add(it.src);
        results.push(it);
      }
    }
    if (results.length >= 4) break;
  }
  if (!results.length && lastErr && signal?.aborted) throw lastErr;
  return results;
}
