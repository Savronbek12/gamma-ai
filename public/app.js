"use strict";

const $ = (id) => document.getElementById(id);
const chatEl = $("chat");
const welcomeEl = $("welcome");
const inputEl = $("input");
const sendBtn = $("sendBtn");
const chatListEl = $("chatList");

// ---------- Suhbatlar (faqat shu brauzerda saqlanadi) ----------
// Har bir suhbat: { id, title, titlePending, subject, messages, updatedAt }
const STORAGE_KEY = "gamma-ai-chats-v2";
const OLD_STORAGE_KEY = "gamma-ai-state-v1";
const store = { chats: [], currentId: null };
let chat = newDraft(); // joriy suhbat (hali saqlanmagan bo'lishi mumkin)
let busy = false;
let controller = null;

function newDraft(subject = null) {
  return { id: null, title: null, titlePending: false, subject, messages: [], updatedAt: 0 };
}
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const isSaved = (c) => store.chats.includes(c);

function save() {
  store.currentId = isSaved(chat) ? chat.id : null;
  // Rasmlar joy egallaydi: xotira to'lsa, eng eski suhbatlardagi rasmlardan boshlab o'chiramiz (matni qoladi)
  for (;;) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
      return;
    } catch {
      const oldest = [...store.chats].sort((a, b) => a.updatedAt - b.updatedAt);
      const all = oldest.flatMap((c) => c.messages);
      const msg = all.find((m) => m.image);
      if (msg) {
        delete msg.image;
        msg.imageLost = true;
        continue;
      }
      // Keyin — eski suhbatlardagi biriktirilgan fayllar matni (fayl nomi qoladi)
      const withFile = all.find((m) => m.file && m.file.text && m !== chat.messages.at(-1));
      if (!withFile) return;
      withFile.file.text = "";
      withFile.file.lost = true;
    }
  }
}

// Faqat to'g'ri ketma-ketlikdagi (savol, javob, savol, javob...) xabarlarni qoldiramiz
function cleanMessages(list) {
  const clean = [];
  for (const m of Array.isArray(list) ? list : []) {
    if (!m || typeof m.content !== "string" || !m.content.trim()) continue;
    const expected = clean.length % 2 === 0 ? "user" : "assistant";
    if (m.role !== expected) continue;
    const item = { role: m.role, content: m.content };
    if (m.role === "user" && m.file && typeof m.file.name === "string" && typeof m.file.text === "string") {
      item.file = {
        name: m.file.name.slice(0, 200), kind: m.file.kind === "image" ? "image" : "document",
        text: m.file.text.slice(0, 60000), chars: Number(m.file.chars) || m.file.text.length,
        truncated: !!m.file.truncated, ...(m.file.lost ? { lost: true } : {}),
      };
    }
    if (m.role === "assistant" && m.deck && Array.isArray(m.deck.slides)) item.deck = m.deck;
    if (m.role === "assistant" && Array.isArray(m.sources)) item.sources = m.sources;
    if (m.role === "assistant" && typeof m.image === "string" && m.image.startsWith("data:image/")) item.image = m.image;
    if (m.role === "assistant" && m.imageLost) item.imageLost = true;
    if (m.role === "assistant" && typeof m.imageSource === "string") item.imageSource = m.imageSource;
    if (m.role === "assistant" && Array.isArray(m.images)) {
      const images = cleanImages(m.images);
      if (images.length) item.images = images;
    }
    clean.push(item);
  }
  // Javobsiz qolgan oxirgi savolni olib tashlaymiz
  if (clean.at(-1)?.role === "user") clean.pop();
  return clean;
}

const provisionalTitle = (text) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 48 ? t.slice(0, 46).trimEnd() + "…" : t;
};

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (raw && Array.isArray(raw.chats)) {
      for (const c of raw.chats) {
        const messages = cleanMessages(c?.messages);
        if (!messages.length) continue;
        store.chats.push({
          id: typeof c.id === "string" ? c.id : newId(),
          title: typeof c.title === "string" && c.title ? c.title : provisionalTitle(messages[0].content),
          titlePending: !!c.titlePending,
          subject: typeof c.subject === "string" ? c.subject : null,
          messages,
          updatedAt: Number(c.updatedAt) || 0,
        });
      }
      store.currentId = raw.currentId || null;
    } else {
      // Eski versiyadagi yagona suhbatni ro'yxatga ko'chiramiz
      const old = JSON.parse(localStorage.getItem(OLD_STORAGE_KEY) || "null");
      const messages = cleanMessages(old?.messages);
      if (messages.length) {
        store.chats.push({
          id: newId(), title: provisionalTitle(messages[0].content), titlePending: true,
          subject: old.subject || null, messages, updatedAt: Date.now(),
        });
        store.currentId = store.chats[0].id;
      }
    }
  } catch {}
  chat = store.chats.find((c) => c.id === store.currentId) || newDraft();
  save();
  try { localStorage.removeItem(OLD_STORAGE_KEY); } catch {}
}

// Birinchi savol asosida mavzuga mos sarlavha so'raymiz
async function requestTitle(c) {
  const first = c.messages.find((m) => m.role === "user");
  if (!first) return;
  try {
    const res = await fetch("/api/title", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: first.content }),
    });
    const data = await res.json().catch(() => ({}));
    if (!isSaved(c)) return;
    if (res.ok && typeof data.title === "string" && data.title.trim()) {
      c.title = data.title.trim().slice(0, 70);
      c.titlePending = false;
    } else if (res.status !== 429 && res.status < 500) {
      c.titlePending = false; // qayta so'rab foyda yo'q — vaqtinchalik sarlavha qoladi
    }
    save();
    renderChats();
    updateCurrent();
  } catch {}
}

// ---------- Markdown + LaTeX ----------
// Belgilash uchun Unicode "shaxsiy foydalanish" belgilari (matnda uchramaydi, markdown ularni o'zgartirmaydi)
const PH_OPEN = "";
const PH_CLOSE = "";

function renderMarkdown(text) {
  // 1) Kod bloklarini vaqtincha ajratamiz, ichidagi $ belgisi formula deb hisoblanmasin
  const code = [];
  const stashCode = (s) => {
    code.push(s);
    return `${PH_OPEN}CODE${code.length - 1}${PH_CLOSE}`;
  };
  let src = text
    .replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2[^\n]*(?=\n|$)|$)/g, (m) => stashCode(m))
    .replace(/`[^`\n]+`/g, (m) => stashCode(m));

  // 2) Formulalarni markdown'dan himoyalash uchun ajratamiz
  const math = [];
  const stash = (tex, display) => {
    math.push({ tex, display });
    return `${PH_OPEN}MATH${math.length - 1}${PH_CLOSE}`;
  };
  src = src
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => stash(t, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => stash(t, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => stash(t, false))
    .replace(/(^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\d)/g, (_, pre, t) => pre + stash(t, false));

  // 3) Kodni qaytaramiz va markdown'ni HTML'ga aylantiramiz
  src = src.replace(new RegExp(`${PH_OPEN}CODE(\\d+)${PH_CLOSE}`, "g"), (_, i) => code[Number(i)]);
  let html = DOMPurify.sanitize(marked.parse(src, { gfm: true, breaks: false }));
  html = html.replace(new RegExp(`${PH_OPEN}MATH(\\d+)${PH_CLOSE}`, "g"), (_, i) => {
    const { tex, display } = math[Number(i)];
    try {
      return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: "html" });
    } catch {
      return escapeHtml(tex);
    }
  });
  return html;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Wikipedia manbalari ----------
const isWikiUrl = (u) => {
  try { const x = new URL(String(u)); return x.protocol === "https:" && x.hostname.endsWith(".wikipedia.org"); } catch { return false; }
};
function sourcesHtml(sources) {
  const list = (Array.isArray(sources) ? sources : []).filter(
    (s) => s && typeof s.title === "string" && isWikiUrl(s.url),
  );
  if (!list.length) return "";
  const items = list
    .map((s, i) => `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">[${i + 1}] ${escapeHtml(s.title)}</a></li>`)
    .join("");
  return `<div class="sources"><span>Wikipedia manbalari</span><ol>${items}</ol></div>`;
}

// ---------- Internetdan topilgan rasmlar ----------
const isHttpsUrl = (u) => {
  try { return new URL(String(u)).protocol === "https:"; } catch { return false; }
};
const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
function cleanImages(list) {
  return (Array.isArray(list) ? list : [])
    .filter((x) => x && isHttpsUrl(x.thumb) && isHttpsUrl(x.page))
    .slice(0, 8)
    .map((x) => ({
      thumb: x.thumb, page: x.page,
      title: str(x.title, 140) || "Rasm", creator: str(x.creator, 80),
      license: str(x.license, 40), source: str(x.source, 40),
    }));
}
function galleryHtml(m) {
  const items = m.images
    .map((x) => {
      const meta = [x.creator, x.license].filter(Boolean).map(escapeHtml).join(" · ");
      return `<figure class="found-image">
        <a href="${escapeHtml(x.page)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(x.title)}">
          <img src="${escapeHtml(x.thumb)}" alt="${escapeHtml(x.title)}" loading="lazy" referrerpolicy="no-referrer"
               onerror="this.closest('figure').remove()">
        </a>
        <figcaption><strong>${escapeHtml(x.title)}</strong>${meta ? `<span>${meta}</span>` : ""}<span class="src">${escapeHtml(x.source || "")}</span></figcaption>
      </figure>`;
    })
    .join("");
  return `<p class="gallery-head">Ochiq internetdan topilgan rasmlar — ustiga bosib, asl manbani oching:</p><div class="gallery">${items}</div>`;
}

// ---------- Avval yaratilgan rasmlar (eski suhbatlar uchun) ----------
function imageHtml(src, prompt, source) {
  const caption = `<figcaption><span>${source ? escapeHtml(source) + " yaratgan rasm" : "Yaratilgan rasm"}</span><a href="${escapeHtml(src)}" download="gamma-ai-rasm.jpg">Yuklab olish</a></figcaption>`;
  return `<figure class="gen-image"><img src="${escapeHtml(src)}" alt="${escapeHtml(prompt || "Yaratilgan rasm")}" loading="lazy">${caption}</figure>`;
}
function imageMessageHtml(m) {
  if (m.image) return imageHtml(m.image, m.content, m.imageSource);
  return renderMarkdown(m.content) + (m.imageLost ? '<p class="note">Rasm brauzer xotirasi to\'lgani sababli saqlanmadi.</p>' : "");
}

// ---------- Xabarlarni chizish ----------
function addMessageEl(role, content, sources, msg) {
  welcomeEl.hidden = true;
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  if (role === "assistant") {
    const av = document.createElement("div");
    av.className = "avatar";
    av.textContent = "γ";
    wrap.appendChild(av);
  }
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (role === "user") {
    if (msg && msg.file) bubble.appendChild(fileChipEl(msg.file));
    bubble.appendChild(document.createTextNode(content));
  } else if (msg && msg.images) bubble.innerHTML = galleryHtml(msg);
  else if (msg && (msg.image || msg.imageLost)) bubble.innerHTML = imageMessageHtml(msg);
  else if (msg && msg.deck) bubble.innerHTML = deckHtml(msg.deck);
  else bubble.innerHTML = content ? renderMarkdown(content) + sourcesHtml(sources) : "";
  if (role === "assistant" && msg && !msg.images && !msg.image && !msg.imageLost) bubble.appendChild(actionsEl(msg));
  wrap.appendChild(bubble);
  chatEl.appendChild(wrap);
  return bubble;
}

// ---------- Biriktirilgan fayl belgisi ----------
const formatChars = (n) => (n >= 1000 ? `${Math.round(n / 1000)} ming belgi` : `${n} belgi`);
function fileChipEl(file, { status, onRemove } = {}) {
  const chip = document.createElement("div");
  chip.className = "file-chip" + (status === "error" ? " error" : "");
  const icon = document.createElement(status === "uploading" ? "span" : "span");
  if (status === "uploading") icon.className = "spin";
  else icon.textContent = file.kind === "image" ? "🖼" : "📄";
  const name = document.createElement("span");
  name.className = "fname";
  name.textContent = file.name;
  name.title = file.name;
  const meta = document.createElement("span");
  meta.className = "fmeta";
  meta.textContent =
    status === "uploading" ? (file.kind === "image" ? "rasm o'qilmoqda…" : "o'qilmoqda…")
    : status === "error" ? file.error
    : file.lost ? "matni saqlanmagan"
    : file.kind === "image" ? "rasm o'qildi"
    : formatChars(file.chars || file.text.length) + (file.truncated ? " (qisqartirildi)" : "");
  chip.append(icon, name, meta);
  if (onRemove) {
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "✕";
    x.setAttribute("aria-label", "Faylni olib tashlash");
    x.addEventListener("click", onRemove);
    chip.appendChild(x);
  }
  return chip;
}

// ---------- Taqdimot ----------
function deckHtml(deck) {
  const slides = deck.slides
    .map((s) => `<li><strong>${escapeHtml(s.title || "")}</strong>${s.bullets?.length ? `<ul>${s.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>` : ""}</li>`)
    .join("");
  return `<p><strong>Taqdimot tayyor: «${escapeHtml(deck.title)}»</strong> — ${deck.slides.length + 1} ta slayd (titul bilan). Quyida reja; PowerPoint faylini yuklab oling.</p>
    <div class="deck-outline"><ol>${slides}</ol></div>`;
}
const deckOutlineText = (deck) =>
  `Taqdimot: «${deck.title}»${deck.subtitle ? ` — ${deck.subtitle}` : ""}\n\n` +
  deck.slides.map((s, i) => `${i + 1}. ${s.title}\n${(s.bullets || []).map((b) => `   - ${b}`).join("\n")}`).join("\n");
const deckMarkdown = (deck) =>
  `${deck.subtitle ? `*${deck.subtitle}*\n\n` : ""}` +
  deck.slides.map((s) => `## ${s.title}\n\n${(s.bullets || []).map((b) => `- ${b}`).join("\n")}`).join("\n\n");

// ---------- Fayl yuklab olish (server vaqtinchalik havola beradi — Android ilovada ham ishlaydi) ----------
async function downloadExport(endpoint, body) {
  const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) throw new Error(data.error || "Faylni tayyorlab bo'lmadi.");
  const a = document.createElement("a");
  a.href = data.url;
  a.download = data.filename || "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
const exportDeck = (deck) => downloadExport("/api/export/pptx", { deck });
const exportWord = (title, markdown) => downloadExport("/api/export/docx", { title, markdown });

function actionsEl(msg) {
  const box = document.createElement("div");
  box.className = "msg-actions";
  const err = document.createElement("span");
  err.className = "act-error";
  const button = (label, cls, run) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener("click", async () => {
      err.textContent = "";
      b.disabled = true;
      try { await run(); } catch (e) { err.textContent = e.message || "Xatolik yuz berdi."; }
      b.disabled = false;
    });
    box.appendChild(b);
  };
  if (msg.deck) {
    button("⬇ PowerPoint (.pptx)", "primary", () => exportDeck(msg.deck));
    button("⬇ Word (.docx)", "", () => exportWord(msg.deck.title, deckMarkdown(msg.deck)));
  } else {
    button("⬇ Word", "", () => exportWord(chat.title || "Gamma AI javobi", msg.content));
    button("📊 Taqdimot", "", async () => {
      if (busy) throw new Error("Avvalgi so'rov tugashini kuting.");
      const idx = chat.messages.indexOf(msg);
      const question = idx > 0 ? chat.messages[idx - 1].content : chat.title || "";
      sendPresentation("Yuqoridagi javob asosida taqdimot tayyorlab bering.", { source: msg.content, topic: question });
    });
  }
  box.appendChild(err);
  return box;
}
function renderAll() {
  chatEl.querySelectorAll(".msg").forEach((n) => n.remove());
  welcomeEl.hidden = chat.messages.length > 0;
  for (const m of chat.messages) addMessageEl(m.role, m.content, m.sources, m);
  scrollDown(true);
}
function scrollDown(force) {
  const nearBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 160;
  if (force || nearBottom) chatEl.scrollTop = chatEl.scrollHeight;
}

// ---------- Yon panel: suhbatlar ro'yxati ----------
function renderChats() {
  const q = $("chatSearch").value.trim().toLowerCase();
  const list = [...store.chats].sort((a, b) => b.updatedAt - a.updatedAt);
  $("chatCount").textContent = String(list.length);
  chatListEl.innerHTML = "";
  const shown = q
    ? list.filter((c) => c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q)))
    : list;
  if (!shown.length) {
    const p = document.createElement("p");
    p.className = "chat-empty";
    p.textContent = q ? "Hech narsa topilmadi." : "Hali suhbatlar yo'q. Savol yozing — suhbat shu yerda mavzusi bilan saqlanadi.";
    chatListEl.appendChild(p);
    return;
  }
  for (const c of shown) {
    const row = document.createElement("div");
    row.className = "chat-item" + (c === chat ? " active" : "");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "chat-open";
    open.textContent = c.title;
    open.title = c.title;
    open.addEventListener("click", () => openChat(c));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "chat-del";
    del.setAttribute("aria-label", `«${c.title}» suhbatini o'chirish`);
    del.textContent = "✕";
    del.addEventListener("click", () => {
      // Tasodifan o'chirilmasin: birinchi bosishda so'raymiz, ikkinchisida o'chiramiz
      if (del.dataset.armed) return deleteChat(c);
      del.dataset.armed = "1";
      del.textContent = "O'chirish?";
      row.classList.add("armed");
      setTimeout(() => {
        delete del.dataset.armed;
        del.textContent = "✕";
        row.classList.remove("armed");
      }, 3000);
    });
    row.append(open, del);
    chatListEl.appendChild(row);
  }
}

function switchTo(next) {
  if (controller) controller.abort();
  chat = next;
  save();
  renderChats();
  updateCurrent();
  renderAll();
  closeSidebar();
  inputEl.focus();
}
const openChat = (c) => { if (c !== chat) switchTo(c); else closeSidebar(); };

function deleteChat(c) {
  store.chats = store.chats.filter((x) => x !== c);
  if (c === chat) switchTo(newDraft());
  else { save(); renderChats(); }
}

function updateCurrent() {
  $("currentTitle").textContent = chat.title || "Yangi suhbat";
}

// Yangi savol joriy suhbatga qo'shiladi; suhbat birinchi savolda ro'yxatga yoziladi
function pushUserMessage(c, text, file) {
  c.messages.push(file ? { role: "user", content: text, file } : { role: "user", content: text });
  c.updatedAt = Date.now();
  let isNew = false;
  if (!isSaved(c)) {
    c.id = newId();
    c.title = provisionalTitle(text);
    c.titlePending = true;
    store.chats.push(c);
    isNew = true;
  }
  save();
  renderChats();
  updateCurrent();
  if (isNew) requestTitle(c);
}

// Javob kelmagan (yoki boshqa suhbatga o'tilgani uchun bekor qilingan) savolni olib tashlaymiz
function dropUnanswered(c) {
  if (c.messages.at(-1)?.role === "user") c.messages.pop();
  if (!c.messages.length) store.chats = store.chats.filter((x) => x !== c);
  save();
  renderChats();
}

const SUGGESTIONS = [
  { subject: "matematika", label: "Matematika", text: "Hosila tushunchasini geometrik ma'nosi bilan tushuntirib bering." },
  { subject: "fizika", label: "Fizika", text: "Nisbiylik nazariyasining asosiy postulatlari nimalardan iborat?" },
  { subject: "ozbekiston-tarixi", label: "O'zbekiston tarixi", text: "Amir Temur davlatining boshqaruv tizimi haqida ma'lumot bering." },
  { subject: "iqtisodiyot", label: "Iqtisodiyot", text: "Inflyatsiya qanday yuzaga keladi va unga qarshi qanday choralar ko'riladi?" },
];
function renderSuggestions() {
  const box = $("suggestions");
  box.innerHTML = "";
  for (const s of SUGGESTIONS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "suggestion";
    b.innerHTML = "<small></small><span></span>";
    b.children[0].textContent = s.label;
    b.children[1].textContent = s.text;
    b.addEventListener("click", () => {
      if (busy) return;
      if (!chat.messages.length) chat.subject = s.subject;
      send(s.text);
    });
    box.appendChild(b);
  }
}

// ---------- Rasm qidirish rejimi (ochiq internetdan) ----------
const imageBtn = $("imageBtn");
let imagesAvailable = false;
let imageMode = false;

// "Amir Temurning rasmini topib bering", "mushuk rasmini chiz", "найди фото…", "show me a picture of…" kabi so'rovlar
const IMAGE_INTENT = [
  /\b(rasm|surat|tasvir|foto|fotosurat|illyustratsiya)(i|ni|ini|si|sini|lar|lari|larini|larni)?\s+(\p{L}+\s+)?(top|ko['ʻ’`]?rsat|chiz|yarat|izla|qidir|yubor|chiqar|ber)/iu,
  /(нарисуй|(найди|покажи|сгенерируй|создай|сделай)\S*\s+(\S+\s+)?(картинк|фото|изображени|рисун))/i,
  /\b(draw|paint|(find|show|get|generate|create|make)\s+(me\s+)?(an?\s+|some\s+)?(image|picture|photo|illustration|drawing)s?)\b/i,
];
const wantsImage = (text) => IMAGE_INTENT.some((re) => re.test(text));

function setImageMode(on) {
  imageMode = on && imagesAvailable;
  imageBtn.setAttribute("aria-pressed", String(imageMode));
  inputEl.placeholder = imageMode ? "Qanday rasm kerak? (masalan: Registon maydoni, Samarqand)" : "Savolingizni yozing…";
}
imageBtn.addEventListener("click", () => {
  setImageMode(!imageMode);
  inputEl.focus();
});

async function sendImage(text) {
  busy = true;
  updateSendBtn();
  inputEl.value = "";
  autosize();

  const c = chat;
  pushUserMessage(c, text);
  addMessageEl("user", text);
  const bubble = addMessageEl("assistant", "");
  bubble.innerHTML = '<div class="typing"><span></span><span></span><span></span></div><p class="note">Ochiq manbalardan rasm qidirilmoqda…</p>';
  scrollDown(true);
  controller = new AbortController();

  let images = null;
  let query = "";
  let errorText = null;
  try {
    const res = await fetch("/api/image-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: text }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    images = cleanImages(data.images);
    if (!res.ok || !images.length) throw new Error(data.error || "Rasm topilmadi.");
    query = typeof data.query === "string" ? data.query : "";
  } catch (err) {
    images = null;
    if (err.name !== "AbortError") errorText = err.message || "Tarmoq xatosi.";
  }

  busy = false;
  controller = null;
  updateSendBtn();
  if (chat !== c) return dropUnanswered(c); // foydalanuvchi boshqa suhbatga o'tdi

  if (images) {
    const msg = {
      role: "assistant",
      content: `Foydalanuvchi so'roviga ko'ra ochiq internetdan ${images.length} ta rasm topildi: «${text}»${query ? ` (qidiruv: ${query})` : ""}.`,
      images,
    };
    bubble.innerHTML = galleryHtml(msg);
    c.messages.push(msg);
    c.updatedAt = Date.now();
    save();
  } else {
    bubble.innerHTML = `<p class="error">${escapeHtml(errorText || "Rasm topilmadi.")}</p>`;
    dropUnanswered(c);
    if (!isSaved(c)) chat = newDraft(c.subject);
  }
  scrollDown(true);
}

// ---------- Fayl biriktirish ----------
const attachBar = $("attachBar");
const fileInput = $("fileInput");
const MAX_FILE_MB = 20;
let attachment = null; // { status: "uploading" | "ready" | "error", name, kind, text, chars, truncated, error }
let attachController = null;

function renderAttach() {
  attachBar.innerHTML = "";
  attachBar.hidden = !attachment;
  if (attachment) {
    attachBar.appendChild(fileChipEl(attachment, { status: attachment.status, onRemove: clearAttachment }));
  }
  updateSendBtn();
}
function clearAttachment() {
  attachController?.abort();
  attachController = null;
  attachment = null;
  fileInput.value = "";
  renderAttach();
}
function updateSendBtn() {
  sendBtn.disabled = busy || attachment?.status === "uploading" || !(inputEl.value.trim() || attachment?.status === "ready");
}

// Katta rasmlarni brauzerda kichraytiramiz (tezroq yuklanadi, vision modeli chegarasiga sig'adi)
async function shrinkImage(file) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) || typeof createImageBitmap !== "function") return { blob: file, name: file.name };
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size < 1.5 * 1024 * 1024) return { blob: file, name: file.name };
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85));
  return blob ? { blob, name: file.name.replace(/\.[^.]+$/, "") + ".jpg" } : { blob: file, name: file.name };
}

async function attachFile(file) {
  if (!file || busy) return;
  attachController?.abort();
  const isImage = /^image\//.test(file.type) || /\.(png|jpe?g|webp|gif)$/i.test(file.name);
  const name = file.name || (isImage ? "rasm.png" : "fayl");
  if (file.size > MAX_FILE_MB * 1024 * 1024) {
    attachment = { status: "error", name, kind: isImage ? "image" : "document", error: `juda katta (${MAX_FILE_MB} MB dan oshmasin)` };
    return renderAttach();
  }
  const ctrl = (attachController = new AbortController());
  attachment = { status: "uploading", name, kind: isImage ? "image" : "document" };
  renderAttach();
  try {
    const { blob, name: uploadName } = isImage ? await shrinkImage(file).catch(() => ({ blob: file, name })) : { blob: file, name };
    const res = await fetch("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(uploadName || name) },
      body: blob,
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || typeof data.text !== "string") throw new Error(data.error || "Faylni o'qib bo'lmadi.");
    if (ctrl !== attachController) return;
    attachment = {
      status: "ready", name, kind: data.kind === "image" ? "image" : "document",
      text: data.text, chars: Number(data.chars) || data.text.length, truncated: !!data.truncated,
    };
  } catch (err) {
    if (err.name === "AbortError" || ctrl !== attachController) return;
    attachment = { status: "error", name, kind: attachment?.kind || "document", error: err.message || "Tarmoq xatosi." };
  }
  attachController = null;
  renderAttach();
  inputEl.focus();
}

$("attachBtn").addEventListener("click", () => { if (!busy) fileInput.click(); });
fileInput.addEventListener("change", () => attachFile(fileInput.files[0]));
inputEl.addEventListener("paste", (e) => {
  const file = [...(e.clipboardData?.files || [])][0];
  if (file) {
    e.preventDefault();
    attachFile(file);
  }
});
// Faylni sahifaga sudrab tashlash
const appEl = document.querySelector(".app");
let dragDepth = 0;
appEl.addEventListener("dragenter", (e) => {
  if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
  dragDepth++;
  appEl.classList.add("dragging");
});
appEl.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) { dragDepth = 0; appEl.classList.remove("dragging"); }
});
appEl.addEventListener("dragover", (e) => { if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault(); });
appEl.addEventListener("drop", (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  dragDepth = 0;
  appEl.classList.remove("dragging");
  attachFile(e.dataTransfer.files[0]);
});

// Biriktirilgan faylni yuborishga oladi (tayyor bo'lsa) va panelni tozalaydi
function takeAttachment() {
  if (attachment?.status !== "ready") return null;
  const { name, kind, text, chars, truncated } = attachment;
  attachment = null;
  fileInput.value = "";
  renderAttach();
  return { name, kind, text, chars, truncated };
}

// Serverga faqat oxirgi biriktirilgan faylning matnini yuboramiz (model faqat shuni o'qiydi), qolganlarining nomi yetarli
function chatPayload(messages) {
  let lastFile = -1;
  messages.forEach((m, i) => { if (m.file) lastFile = i; });
  return messages.map((m, i) => ({
    role: m.role,
    content: m.content,
    ...(m.file ? { file: { name: m.file.name, text: i === lastFile ? m.file.text : "" } } : {}),
  }));
}

// ---------- So'rov turlari: taqdimot va Word fayl ----------
const PRESENTATION_WORD = /(taqdimot|prezentats|presentation|power\s?point|pptx|slayd|slides?\b|презентац|слайд)/i;
const CREATE_WORD = /(\bber|qil|tayyorla|yasa|tuz|yarat|kerak|chiqar|make|create|generate|prepare|build|сдела|подготов|созда|состав|нужн)/i;
const EXPLAIN_WORD = /(tushuntir|izohla|tahlil|o['ʻ’`]?qib|o['ʻ’`]?qi\b|xulosa|mazmun|nima\s+haqida|explain|summar|analy|объясн|анализ|перескаж)/i;
// "Fotosintez mavzusida taqdimot qilib bering" — ha; "bu taqdimotni tushuntirib bering" — yo'q (oddiy javob)
const wantsPresentation = (text) => PRESENTATION_WORD.test(text) && CREATE_WORD.test(text) && !EXPLAIN_WORD.test(text);
const WORD_INTENT = /(\bword\b|docx|\.doc\b|referat|hujjat\s+(qilib|tayyorla|yoz)|fayl\s*(qilib|ko['ʻ’`]?rinishida|ga)|файл|реферат|документ)/i;

// Taqdimot: server slaydlar rejasini tuzadi, keyin .pptx avtomatik yuklab olinadi
async function sendPresentation(text, { file = null, source = null, topic = null } = {}) {
  if (busy) return;
  busy = true;
  updateSendBtn();
  inputEl.value = "";
  autosize();

  const c = chat;
  pushUserMessage(c, text, file);
  addMessageEl("user", text, null, file ? { file } : null);
  const bubble = addMessageEl("assistant", "");
  bubble.innerHTML = '<div class="typing"><span></span><span></span><span></span></div><p class="note">Taqdimot tayyorlanmoqda — slaydlar tuzilmoqda (odatda 20–60 soniya)…</p>';
  scrollDown(true);
  controller = new AbortController();

  let deck = null;
  let errorText = null;
  try {
    const res = await fetch("/api/presentation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: topic ? `${text}\nMavzu: ${topic}`.slice(0, 7900) : text,
        subject: c.subject,
        ...(file ? { file: { name: file.name, text: file.text } } : {}),
        ...(source ? { source } : {}),
      }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.deck?.slides?.length) throw new Error(data.error || "Taqdimotni tuzib bo'lmadi.");
    deck = data.deck;
  } catch (err) {
    if (err.name !== "AbortError") errorText = err.message || "Tarmoq xatosi.";
  }

  busy = false;
  controller = null;
  updateSendBtn();
  if (chat !== c) return dropUnanswered(c);

  if (deck) {
    const msg = { role: "assistant", content: deckOutlineText(deck), deck };
    c.messages.push(msg);
    c.updatedAt = Date.now();
    save();
    const wrap = bubble.parentElement;
    wrap.remove();
    addMessageEl("assistant", msg.content, null, msg);
    exportDeck(deck).catch(() => {}); // tugma ham bor — avtomatik yuklash o'xshamasa, foydalanuvchi bosadi
  } else {
    bubble.innerHTML = `<p class="error">${escapeHtml(errorText || "Taqdimotni tuzib bo'lmadi.")}</p>`;
    dropUnanswered(c);
    if (!isSaved(c)) chat = newDraft(c.subject);
  }
  scrollDown(true);
}

// ---------- Yuborish ----------
async function send(text) {
  text = text.trim();
  if (busy || attachment?.status === "uploading") return;
  const file = attachment?.status === "ready" ? attachment : null;
  if (!text && !file) return;
  if (!text) text = file.kind === "image" ? "Ushbu rasmni tushuntirib bering." : "Ushbu faylni o'qib, mazmunini tushuntirib bering.";
  if (wantsPresentation(text)) return sendPresentation(text, { file: takeAttachment() });
  if (!file && imagesAvailable && (imageMode || wantsImage(text))) return sendImage(text);
  takeAttachment();
  const wantsWord = WORD_INTENT.test(text);
  busy = true;
  updateSendBtn();
  inputEl.value = "";
  autosize();

  // Shu suhbatni eslab qolamiz: javob kelguncha boshqa suhbatga o'tilsa, javob u yerga tushmasin
  const c = chat;
  const fileData = file ? { name: file.name, kind: file.kind, text: file.text, chars: file.chars, truncated: file.truncated } : null;
  pushUserMessage(c, text, fileData);
  addMessageEl("user", text, null, fileData ? { file: fileData } : null);
  const bubble = addMessageEl("assistant", "");
  bubble.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
  scrollDown(true);

  let answer = "";
  let errorText = null;
  let truncated = false;
  let sources = [];
  controller = new AbortController();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: chatPayload(c.messages), subject: c.subject }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "So'rov bajarilmadi.");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let pending = false;
    const paint = () => {
      pending = false;
      bubble.innerHTML = renderMarkdown(answer) + sourcesHtml(sources);
      scrollDown();
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = /^event: (.*)$/m.exec(chunk)?.[1];
        const dataLine = /^data: (.*)$/m.exec(chunk)?.[1];
        if (!ev || !dataLine) continue;
        const data = JSON.parse(dataLine);
        if (ev === "delta") {
          answer += data.text;
          if (!pending) { pending = true; requestAnimationFrame(paint); }
        } else if (ev === "sources") {
          sources = Array.isArray(data.sources) ? data.sources : [];
        } else if (ev === "status" && data.state === "waiting" && !answer) {
          bubble.innerHTML =
            '<div class="typing"><span></span><span></span><span></span></div>' +
            `<p class="note">Hozir so'rovlar ko'p — navbatingiz kutilmoqda (taxminan ${Number(data.seconds) || 5} soniya)…</p>`;
        } else if (ev === "error") {
          errorText = data.error;
        } else if (ev === "done") {
          truncated = !!data.truncated;
        }
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") errorText = err.message || "Tarmoq xatosi.";
  }

  busy = false;
  controller = null;
  updateSendBtn();
  if (chat !== c) return dropUnanswered(c); // foydalanuvchi boshqa suhbatga o'tdi

  if (answer) {
    let html = renderMarkdown(answer) + sourcesHtml(sources);
    if (truncated) html += '<p class="note">Javob uzunlik chegarasiga yetdi. Davom ettirish uchun «Davom eting» deb yozing.</p>';
    if (errorText) html += `<p class="error">${escapeHtml(errorText)}</p>`;
    bubble.innerHTML = html;
    const msg = sources.length ? { role: "assistant", content: answer, sources } : { role: "assistant", content: answer };
    bubble.appendChild(actionsEl(msg));
    c.messages.push(msg);
    c.updatedAt = Date.now();
    save();
    // "Word fayl qilib bering", "referat yozing" kabi so'rovlarda .docx avtomatik yuklanadi
    if (wantsWord && !errorText) exportWord(c.title || provisionalTitle(text), answer).catch(() => {});
  } else {
    bubble.innerHTML = `<p class="error">${escapeHtml(errorText || "Javob olinmadi.")}</p>`;
    // Javobsiz savolni tarixdan olib tashlaymiz, shunda qayta yuborish mumkin
    dropUnanswered(c);
    if (!isSaved(c)) chat = newDraft(c.subject);
  }
  scrollDown();
}

// ---------- UI hodisalari ----------
function autosize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";
}
inputEl.addEventListener("input", () => {
  autosize();
  updateSendBtn();
});
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send(inputEl.value);
  }
});
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  send(inputEl.value);
});
$("newChat").addEventListener("click", () => switchTo(newDraft()));
$("chatSearch").addEventListener("input", renderChats);

function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("backdrop").classList.remove("show");
}
$("menuBtn").addEventListener("click", () => {
  $("sidebar").classList.add("open");
  $("backdrop").classList.add("show");
});
$("backdrop").addEventListener("click", closeSidebar);

// Mavzu (yorug'/qorong'i)
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
try { applyTheme(localStorage.getItem("gamma-ai-theme")); } catch {}
$("themeBtn").addEventListener("click", () => {
  const current = document.documentElement.dataset.theme || "dark";
  const next = current === "dark" ? "light" : "dark";
  applyTheme(next);
  try { localStorage.setItem("gamma-ai-theme", next); } catch {}
});

// ---------- Ishga tushirish ----------
(async function init() {
  load();
  renderChats();
  updateCurrent();
  renderSuggestions();
  renderAll();
  updateSendBtn();
  inputEl.focus();
  // Avval sarlavhasi olinmay qolgan suhbatlar uchun qayta so'raymiz
  store.chats.filter((c) => c.titlePending).slice(0, 3).forEach(requestTitle);
  try {
    imagesAvailable = !!(await (await fetch("/api/features")).json()).images;
  } catch {
    imagesAvailable = false;
  }
  imageBtn.hidden = !imagesAvailable;
  if (!imagesAvailable) setImageMode(false);
})();
