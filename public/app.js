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
      const msg = oldest.flatMap((c) => c.messages).find((m) => m.image);
      if (!msg) return;
      delete msg.image;
      msg.imageLost = true;
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
  if (role === "user") bubble.textContent = content;
  else if (msg && msg.images) bubble.innerHTML = galleryHtml(msg);
  else if (msg && (msg.image || msg.imageLost)) bubble.innerHTML = imageMessageHtml(msg);
  else bubble.innerHTML = content ? renderMarkdown(content) + sourcesHtml(sources) : "";
  wrap.appendChild(bubble);
  chatEl.appendChild(wrap);
  return bubble;
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
function pushUserMessage(c, text) {
  c.messages.push({ role: "user", content: text });
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
  sendBtn.disabled = true;
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
  sendBtn.disabled = !inputEl.value.trim();
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

// ---------- Yuborish ----------
async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  if (imagesAvailable && (imageMode || wantsImage(text))) return sendImage(text);
  busy = true;
  sendBtn.disabled = true;
  inputEl.value = "";
  autosize();

  // Shu suhbatni eslab qolamiz: javob kelguncha boshqa suhbatga o'tilsa, javob u yerga tushmasin
  const c = chat;
  pushUserMessage(c, text);
  addMessageEl("user", text);
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
      body: JSON.stringify({ messages: c.messages.map(({ role, content }) => ({ role, content })), subject: c.subject }),
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
  sendBtn.disabled = !inputEl.value.trim();
  if (chat !== c) return dropUnanswered(c); // foydalanuvchi boshqa suhbatga o'tdi

  if (answer) {
    let html = renderMarkdown(answer) + sourcesHtml(sources);
    if (truncated) html += '<p class="note">Javob uzunlik chegarasiga yetdi. Davom ettirish uchun «Davom eting» deb yozing.</p>';
    if (errorText) html += `<p class="error">${escapeHtml(errorText)}</p>`;
    bubble.innerHTML = html;
    c.messages.push(sources.length ? { role: "assistant", content: answer, sources } : { role: "assistant", content: answer });
    c.updatedAt = Date.now();
    save();
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
  sendBtn.disabled = busy || !inputEl.value.trim();
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
  sendBtn.disabled = true;
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
