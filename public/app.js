"use strict";

const $ = (id) => document.getElementById(id);
const chatEl = $("chat");
const welcomeEl = $("welcome");
const inputEl = $("input");
const sendBtn = $("sendBtn");
const subjectsEl = $("subjects");

const STORAGE_KEY = "gamma-ai-state-v1";
const state = { subject: null, messages: [] };
let subjects = [];
let busy = false;
let controller = null;

// ---------- Saqlash (faqat shu brauzerda) ----------
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}
function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (raw && Array.isArray(raw.messages)) {
      state.subject = raw.subject || null;
      // Faqat to'g'ri ketma-ketlikdagi (savol, javob, savol, javob...) xabarlarni qoldiramiz
      const clean = [];
      for (const m of raw.messages) {
        if (!m || typeof m.content !== "string" || !m.content.trim()) continue;
        const expected = clean.length % 2 === 0 ? "user" : "assistant";
        if (m.role === expected) clean.push({ role: m.role, content: m.content });
      }
      // Javobsiz qolgan oxirgi savolni olib tashlaymiz
      if (clean.at(-1)?.role === "user") clean.pop();
      state.messages = clean;
    }
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

// ---------- Xabarlarni chizish ----------
function addMessageEl(role, content) {
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
  else bubble.innerHTML = content ? renderMarkdown(content) : "";
  wrap.appendChild(bubble);
  chatEl.appendChild(wrap);
  return bubble;
}
function renderAll() {
  chatEl.querySelectorAll(".msg").forEach((n) => n.remove());
  welcomeEl.hidden = state.messages.length > 0;
  for (const m of state.messages) addMessageEl(m.role, m.content);
  scrollDown(true);
}
function scrollDown(force) {
  const nearBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 160;
  if (force || nearBottom) chatEl.scrollTop = chatEl.scrollHeight;
}

// ---------- Fanlar ----------
function renderSubjects(filter = "") {
  const q = filter.trim().toLowerCase();
  subjectsEl.innerHTML = "";
  const list = [{ id: null, name: "Umumiy (barcha fanlar)", icon: "γ" }, ...subjects];
  for (const s of list) {
    if (q && !s.name.toLowerCase().includes(q)) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "subject" + (state.subject === s.id ? " active" : "");
    b.innerHTML = `<span class="ic"></span><span></span>`;
    b.children[0].textContent = s.icon;
    b.children[1].textContent = s.name;
    b.addEventListener("click", () => selectSubject(s.id));
    subjectsEl.appendChild(b);
  }
}
function selectSubject(id) {
  state.subject = id;
  save();
  updateCurrent();
  renderSubjects($("subjectSearch").value);
  closeSidebar();
  inputEl.focus();
}
function updateCurrent() {
  const s = subjects.find((x) => x.id === state.subject);
  $("currentSubject").textContent = s ? `${s.icon}  ${s.name}` : "Umumiy";
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
      selectSubject(s.subject);
      send(s.text);
    });
    box.appendChild(b);
  }
}

// ---------- Yuborish ----------
async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  busy = true;
  sendBtn.disabled = true;
  inputEl.value = "";
  autosize();

  state.messages.push({ role: "user", content: text });
  // Shu suhbatni eslab qolamiz: javob kelguncha "Yangi suhbat" bosilsa, javob yangi suhbatga tushmasin
  const convo = state.messages;
  save();
  addMessageEl("user", text);
  const bubble = addMessageEl("assistant", "");
  bubble.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
  scrollDown(true);

  let answer = "";
  let errorText = null;
  let truncated = false;
  controller = new AbortController();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: state.messages, subject: state.subject }),
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
      bubble.innerHTML = renderMarkdown(answer);
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
  if (state.messages !== convo) {
    // Foydalanuvchi yangi suhbat boshladi — eski javobni tashlab yuboramiz
    sendBtn.disabled = !inputEl.value.trim();
    return;
  }

  if (answer) {
    let html = renderMarkdown(answer);
    if (truncated) html += '<p class="note">Javob uzunlik chegarasiga yetdi. Davom ettirish uchun «Davom eting» deb yozing.</p>';
    if (errorText) html += `<p class="error">${escapeHtml(errorText)}</p>`;
    bubble.innerHTML = html;
    state.messages.push({ role: "assistant", content: answer });
  } else {
    bubble.innerHTML = `<p class="error">${escapeHtml(errorText || "Javob olinmadi.")}</p>`;
    // Javobsiz savolni tarixdan olib tashlaymiz, shunda qayta yuborish mumkin
    state.messages.pop();
  }
  save();
  scrollDown();
  sendBtn.disabled = !inputEl.value.trim();
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
$("newChat").addEventListener("click", () => {
  if (controller) controller.abort();
  state.messages = [];
  save();
  renderAll();
  closeSidebar();
  inputEl.focus();
});
$("subjectSearch").addEventListener("input", (e) => renderSubjects(e.target.value));

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
  const current = document.documentElement.dataset.theme ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  applyTheme(next);
  try { localStorage.setItem("gamma-ai-theme", next); } catch {}
});

// ---------- Ishga tushirish ----------
(async function init() {
  load();
  try {
    subjects = await (await fetch("/api/subjects")).json();
  } catch {
    subjects = [];
  }
  $("subjectCount").textContent = String(subjects.length);
  if (!subjects.some((s) => s.id === state.subject)) state.subject = null;
  renderSubjects();
  updateCurrent();
  renderSuggestions();
  renderAll();
  sendBtn.disabled = true;
  inputEl.focus();
})();
