// Ochiq internetdan rasm qidirish (API kaliti kerak emas):
//   1) Wikimedia Commons — Wikipedia'ning ochiq litsenziyali rasmlar ombori
//   2) Openverse — Flickr va boshqa ochiq (Creative Commons) manbalar
// Har bir rasm muallifi, litsenziyasi va asl sahifasiga havola bilan qaytariladi.

const USER_AGENT = "GammaAI/1.0 (https://gamma-ai.uz)"; // Wikimedia talabi: tanib bo'ladigan User-Agent
const TIMEOUT_MS = 8000;
const MAX_RESULTS = 6;

const stripHtml = (s) => String(s || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

async function getJson(url, signal) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) throw Object.assign(new Error(`${new URL(url).hostname} ${res.status}`), { status: res.status });
  return res.json();
}

async function searchCommons(query, signal) {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  const params = {
    action: "query",
    format: "json",
    formatversion: "2",
    generator: "search",
    gsrsearch: `filetype:bitmap ${query}`,
    gsrnamespace: "6",
    gsrlimit: "10",
    prop: "imageinfo",
    iiprop: "url|extmetadata|mime",
    iiurlwidth: "640",
    iiextmetadatafilter: "Artist|LicenseShortName|ObjectName",
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const data = await getJson(url, signal);
  return (data.query?.pages || [])
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((p) => {
      const info = p.imageinfo?.[0];
      if (!info?.thumburl || !/^image\/(jpeg|png|webp|gif)$/.test(info.mime || "")) return null;
      const meta = info.extmetadata || {};
      return {
        thumb: info.thumburl,
        page: info.descriptionurl,
        title: stripHtml(meta.ObjectName?.value) || p.title.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, ""),
        creator: stripHtml(meta.Artist?.value).slice(0, 80) || null,
        license: stripHtml(meta.LicenseShortName?.value) || null,
        source: "Wikimedia Commons",
      };
    })
    .filter(Boolean);
}

async function searchOpenverse(query, signal) {
  const url = new URL("https://api.openverse.org/v1/images/");
  url.searchParams.set("q", query);
  url.searchParams.set("page_size", "10");
  url.searchParams.set("mature", "false");
  const data = await getJson(url, signal);
  return (data.results || [])
    .filter((r) => r.thumbnail && r.foreign_landing_url)
    .map((r) => ({
      thumb: r.thumbnail,
      page: r.foreign_landing_url,
      title: stripHtml(r.title) || query,
      creator: stripHtml(r.creator).slice(0, 80) || null,
      license: r.license ? `CC ${String(r.license).toUpperCase()} ${r.license_version || ""}`.trim() : null,
      source: r.source ? r.source.charAt(0).toUpperCase() + r.source.slice(1) : "Openverse",
    }));
}

const isHttps = (u) => {
  try { return new URL(u).protocol === "https:"; } catch { return false; }
};

/**
 * @param {string} query inglizcha qidiruv so'rovi (bir nechta variant bo'lishi mumkin)
 * @returns {Promise<{thumb:string,page:string,title:string,creator:string|null,license:string|null,source:string}[]>}
 */
export async function searchImages(queries, { signal } = {}) {
  const list = [...new Set(queries.map((q) => String(q || "").trim()).filter(Boolean))].slice(0, 2);
  const results = [];
  const seen = new Set();
  const add = (items) => {
    for (const it of items) {
      if (results.length >= MAX_RESULTS) return;
      if (!isHttps(it.thumb) || !isHttps(it.page) || seen.has(it.page)) continue;
      seen.add(it.page);
      results.push(it);
    }
  };
  let lastErr = null;
  for (const q of list) {
    const [commons, openverse] = await Promise.all([
      searchCommons(q, signal).catch((e) => { lastErr = e; return []; }),
      searchOpenverse(q, signal).catch((e) => { lastErr = e; return []; }),
    ]);
    // Commons odatda aniqroq — birinchi navbatda undan olamiz
    add(commons.slice(0, 4));
    add(openverse);
    add(commons);
    if (results.length >= 3) break;
  }
  if (!results.length && lastErr && signal?.aborted) throw lastErr;
  return results;
}
