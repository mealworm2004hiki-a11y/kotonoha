"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

/* ---------- 設定 (localStorage) ---------- */
const settings = {
  get apiKey() { return localStorage.getItem("kotonoha-apikey") || ""; },
  set apiKey(v) { localStorage.setItem("kotonoha-apikey", v); },
  get theme() { return localStorage.getItem("kotonoha-theme") || "auto"; },
  set theme(v) { localStorage.setItem("kotonoha-theme", v); },
};

/* ---------- テーマ ---------- */
const darkMedia = matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const dark = settings.theme === "dark" || (settings.theme === "auto" && darkMedia.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  $("#themeColorMeta").content = dark ? "#1D1B22" : "#F6F0E3";
}
darkMedia.addEventListener("change", applyTheme);

/* ---------- 本の管理 (localStorage) ---------- */
let books = JSON.parse(localStorage.getItem("kotonoha-books") || "[]");
let currentBookId = localStorage.getItem("kotonoha-current-book") || "";

function saveBooks() {
  localStorage.setItem("kotonoha-books", JSON.stringify(books));
  localStorage.setItem("kotonoha-current-book", currentBookId);
}
function currentBook() {
  return books.find((b) => b.id === currentBookId) || null;
}
function addBook(title) {
  const book = { id: crypto.randomUUID(), title, createdAt: Date.now() };
  books.push(book);
  currentBookId = book.id;
  saveBooks();
  return book;
}

/* ---------- 単語 (IndexedDB) ---------- */
let db = null;
let words = [];

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("kotonoha", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("words", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function dbPut(word) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("words", "readwrite");
    tx.objectStore("words").put(word);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
function dbDelete(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("words", "readwrite");
    tx.objectStore("words").delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
function dbAll() {
  return new Promise((resolve, reject) => {
    const req = db.transaction("words").objectStore("words").getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ---------- Claude API ---------- */
const SYSTEM_PROMPT =
  "あなたは国語辞典の編集者です。与えられた日本語の言葉について、次のJSONだけを出力してください。説明や前置きは一切不要です。\n" +
  '{"word":"標準的な表記","reading":"ひらがなの読み","meaning":"簡潔で正確な語釈(50〜120字)","example":"その言葉を使った短い一文"}\n' +
  "表記ゆれや誤字があっても最も可能性の高い言葉を推定してください。";

const PHOTO_PROMPT =
  "この写真は本のページです。写真の中の言葉をひとつ特定し、指定のJSON形式で出力してください。";

async function callClaude(content) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).error?.message || ""; } catch {}
    if (res.status === 401) throw new Error("APIキーが正しくないようです。設定を確認してください。");
    if (res.status === 429) throw new Error("少し混み合っています。時間をおいて試してください。");
    throw new Error(detail || `調べられませんでした (${res.status})`);
  }
  const data = await res.json();
  const text = (data.content || []).map((c) => c.text || "").join("");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("結果をうまく読み取れませんでした。もう一度試してください。");
  const parsed = JSON.parse(match[0]);
  if (!parsed.word || !parsed.meaning) throw new Error("結果をうまく読み取れませんでした。もう一度試してください。");
  return parsed;
}

/* ---------- 調べる ---------- */
let lastSavedId = null;

function setStatus(msg, isError = false) {
  const el = $("#lookupStatus");
  el.hidden = !msg;
  el.className = "status" + (isError ? " error" : "");
  el.innerHTML = msg;
}

async function doLookup(content) {
  if (!settings.apiKey) {
    setStatus('先に設定画面でClaude APIキーを保存してください。<a href="#" id="goSettings">設定を開く</a>', true);
    $("#goSettings")?.addEventListener("click", (e) => { e.preventDefault(); showView("view-settings"); });
    return;
  }
  $("#resultCard").hidden = true;
  $("#lookupEmpty").hidden = true;
  $("#searchBtn").disabled = true;
  setStatus("調べています…");
  try {
    const r = await callClaude(content);
    const book = currentBook();
    const entry = {
      id: crypto.randomUUID(),
      word: r.word,
      reading: r.reading || "",
      meaning: r.meaning,
      example: r.example || "",
      bookId: book ? book.id : "",
      bookTitle: book ? book.title : "",
      createdAt: Date.now(),
      learned: false,
    };
    await dbPut(entry);
    words.push(entry);
    lastSavedId = entry.id;
    showResult(entry);
    setStatus("");
  } catch (err) {
    setStatus(err.message, true);
    $("#lookupEmpty").hidden = false;
  } finally {
    $("#searchBtn").disabled = false;
  }
}

function showResult(entry) {
  $("#resReading").textContent = entry.reading;
  $("#resWord").textContent = entry.word;
  $("#resMeaning").textContent = entry.meaning;
  $("#resExample").textContent = entry.example ? "「" + entry.example + "」" : "";
  $("#resSaved").textContent = entry.bookTitle
    ? `『${entry.bookTitle}』に記録しました`
    : "単語帳に記録しました";
  $("#resultCard").hidden = false;
}

async function undoSave() {
  if (!lastSavedId) return;
  await dbDelete(lastSavedId);
  words = words.filter((w) => w.id !== lastSavedId);
  lastSavedId = null;
  $("#resultCard").hidden = true;
  $("#lookupEmpty").hidden = false;
  toast("記録を取り消しました");
}

/* 写真をリサイズしてbase64に */
function imageToBase64(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const max = 1400;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.85).split(",")[1]);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("写真を読み込めませんでした。")); };
    img.src = url;
  });
}

/* ---------- 本セレクタ ---------- */
function renderBookSelects() {
  const sel = $("#bookSelect");
  sel.innerHTML = "";
  const none = new Option("(本を指定しない)", "");
  sel.add(none);
  for (const b of books) sel.add(new Option(`『${b.title}』`, b.id));
  sel.add(new Option("+ 新しい本を追加…", "__add__"));
  sel.value = currentBook() ? currentBookId : "";

  const filter = $("#filterBook");
  const prev = filter.value;
  filter.innerHTML = "";
  filter.add(new Option("すべての本", ""));
  for (const b of books) filter.add(new Option(`『${b.title}』`, b.id));
  filter.add(new Option("本の指定なし", "__none__"));
  if ([...filter.options].some((o) => o.value === prev)) filter.value = prev;
}

function onBookSelect() {
  const v = $("#bookSelect").value;
  if (v === "__add__") {
    const title = prompt("いま読んでいる本のタイトル");
    if (title && title.trim()) {
      addBook(title.trim());
      toast(`『${title.trim()}』を追加しました`);
    }
    renderBookSelects();
    return;
  }
  currentBookId = v;
  saveBooks();
}

/* ---------- 単語帳 ---------- */
function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
}

function renderList() {
  const bookF = $("#filterBook").value;
  const q = $("#filterText").value.trim();
  let items = [...words].sort((a, b) => b.createdAt - a.createdAt);
  if (bookF === "__none__") items = items.filter((w) => !w.bookId);
  else if (bookF) items = items.filter((w) => w.bookId === bookF);
  if (q) items = items.filter((w) => (w.word + w.reading + w.meaning).includes(q));

  const ul = $("#wordList");
  ul.innerHTML = "";
  $("#listEmpty").hidden = items.length > 0 || q !== "" || bookF !== "";
  for (const w of items) {
    const li = document.createElement("li");
    li.className = "word-item";
    li.dataset.id = w.id;
    li.innerHTML = `
      <div class="word-main">
        <div class="word-head">
          <span class="w"></span><span class="r"></span>
          ${w.learned ? '<span class="learned-mark">覚えた</span>' : ""}
        </div>
        <p class="word-m"></p>
        <div class="word-detail">
          <p class="example"></p>
          <p class="word-meta"></p>
          <button class="linklike del-link">この言葉を削除</button>
        </div>
      </div>
      <button class="word-del">削除</button>`;
    li.querySelector(".w").textContent = w.word;
    li.querySelector(".r").textContent = w.reading;
    li.querySelector(".word-m").textContent = w.meaning;
    li.querySelector(".example").textContent = w.example ? "「" + w.example + "」" : "";
    li.querySelector(".word-meta").textContent =
      (w.bookTitle ? `『${w.bookTitle}』 · ` : "") + fmtDate(w.createdAt);
    ul.appendChild(li);
  }
}

async function deleteWord(id) {
  await dbDelete(id);
  words = words.filter((w) => w.id !== id);
  renderList();
  toast("削除しました");
}

/* スワイプ削除 */
function setupSwipe() {
  const ul = $("#wordList");
  let startX = 0, startY = 0, target = null, swiping = false;

  ul.addEventListener("touchstart", (e) => {
    target = e.target.closest(".word-item");
    if (!target) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    swiping = false;
  }, { passive: true });

  ul.addEventListener("touchmove", (e) => {
    if (!target) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (!swiping && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) swiping = true;
    if (swiping && dx < -40) {
      $$(".word-item.open").forEach((el) => el !== target && el.classList.remove("open"));
      target.classList.add("open");
    } else if (swiping && dx > 20) {
      target.classList.remove("open");
    }
  }, { passive: true });

  ul.addEventListener("click", (e) => {
    const del = e.target.closest(".word-del");
    if (del) {
      deleteWord(del.closest(".word-item").dataset.id);
      return;
    }
    const delLink = e.target.closest(".del-link");
    if (delLink) {
      deleteWord(delLink.closest(".word-item").dataset.id);
      return;
    }
    const item = e.target.closest(".word-item");
    if (!item) return;
    if (item.classList.contains("open")) { item.classList.remove("open"); return; }
    item.classList.toggle("expanded");
  });
}

/* ---------- 復習 ---------- */
let deck = [], deckIdx = 0, gotCount = 0;

function startReview() {
  const pool = $("#onlyUnlearned").checked ? words.filter((w) => !w.learned) : [...words];
  deck = pool.sort(() => Math.random() - 0.5);
  deckIdx = 0;
  gotCount = 0;
  $("#reviewDone").hidden = true;
  if (deck.length === 0) {
    $("#reviewEmpty").hidden = false;
    $("#reviewCard").hidden = true;
    $("#reviewActions").hidden = true;
    $("#reviewProgress").textContent = "";
    return;
  }
  $("#reviewEmpty").hidden = true;
  showFlash();
}

function showFlash() {
  const w = deck[deckIdx];
  $("#reviewCard").hidden = false;
  $("#reviewActions").hidden = false;
  $("#flashWord").textContent = w.word;
  $("#flashReading").textContent = w.reading;
  $("#flashMeaning").textContent = w.meaning;
  $("#flashExample").textContent = w.example ? "「" + w.example + "」" : "";
  $("#flashSrc").textContent = w.bookTitle ? `— 『${w.bookTitle}』で出会った言葉` : "";
  $("#flashBack").hidden = true;
  $("#flashHint").hidden = false;
  $("#reviewProgress").textContent = `${deckIdx + 1} / ${deck.length}`;
}

async function answerFlash(got) {
  const w = deck[deckIdx];
  const stored = words.find((x) => x.id === w.id);
  if (stored && stored.learned !== got) {
    stored.learned = got;
    await dbPut(stored);
  }
  if (got) gotCount++;
  deckIdx++;
  if (deckIdx >= deck.length) {
    $("#reviewCard").hidden = true;
    $("#reviewActions").hidden = true;
    $("#reviewDone").hidden = false;
    $("#reviewDoneStats").textContent = `${deck.length}語中 ${gotCount}語「覚えた」`;
    $("#reviewProgress").textContent = "";
  } else {
    showFlash();
  }
}

/* ---------- バックアップ ---------- */
function exportData() {
  const blob = new Blob(
    [JSON.stringify({ app: "kotonoha", exportedAt: new Date().toISOString(), books, words }, null, 2)],
    { type: "application/json" }
  );
  const a = document.createElement("a");
  const d = new Date();
  a.href = URL.createObjectURL(blob);
  a.download = `kotonoha-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("書き出しました");
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.words)) throw new Error();
    const known = new Set(words.map((w) => w.id));
    let added = 0;
    for (const w of data.words) {
      if (!w.id || known.has(w.id)) continue;
      await dbPut(w);
      words.push(w);
      added++;
    }
    const knownBooks = new Set(books.map((b) => b.id));
    for (const b of data.books || []) {
      if (b.id && !knownBooks.has(b.id)) books.push(b);
    }
    saveBooks();
    renderBookSelects();
    renderStats();
    toast(`${added}語を読み込みました`);
  } catch {
    toast("読み込めないファイルです");
  }
}

function renderStats() {
  const learned = words.filter((w) => w.learned).length;
  $("#statsLine").textContent = `記録した言葉 ${words.length}語 (うち覚えた ${learned}語) · 本 ${books.length}冊`;
}

/* ---------- 画面切替・通知 ---------- */
function showView(id) {
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === id));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === id));
  if (id === "view-list") renderList();
  if (id === "view-review") startReview();
  if (id === "view-settings") renderStats();
}

let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

/* ---------- 起動 ---------- */
async function init() {
  applyTheme();
  db = await openDB();
  words = await dbAll();
  renderBookSelects();

  $$(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));
  $("#settingsBtn").addEventListener("click", () => showView("view-settings"));

  $("#bookSelect").addEventListener("change", onBookSelect);

  $("#lookupForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("#lookupInput").value.trim();
    if (!q) return;
    doLookup([{ type: "text", text: q }]);
  });

  $("#cameraBtn").addEventListener("click", () => $("#cameraInput").click());
  $("#cameraInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      setStatus("写真を読み込んでいます…");
      const b64 = await imageToBase64(file);
      const hint = $("#lookupInput").value.trim();
      doLookup([
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
        { type: "text", text: PHOTO_PROMPT + (hint ? `ヒント:「${hint}」に近い言葉です。` : "最も難しそうな言葉(難読・難解な言葉)を選んでください。") },
      ]);
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  $("#resUndo").addEventListener("click", undoSave);

  $("#filterBook").addEventListener("change", renderList);
  $("#filterText").addEventListener("input", renderList);
  setupSwipe();

  $("#onlyUnlearned").addEventListener("change", startReview);
  $("#reviewCard").addEventListener("click", () => {
    $("#flashBack").hidden = false;
    $("#flashHint").hidden = true;
  });
  $("#btnGot").addEventListener("click", () => answerFlash(true));
  $("#btnStill").addEventListener("click", () => answerFlash(false));
  $("#reviewRestart").addEventListener("click", startReview);

  $("#apiKeyInput").value = settings.apiKey;
  $("#apiKeySave").addEventListener("click", () => {
    settings.apiKey = $("#apiKeyInput").value.trim();
    toast(settings.apiKey ? "APIキーを保存しました" : "APIキーを削除しました");
  });
  $("#themeSelect").value = settings.theme;
  $("#themeSelect").addEventListener("change", () => {
    settings.theme = $("#themeSelect").value;
    applyTheme();
  });
  $("#exportBtn").addEventListener("click", exportData);
  $("#importBtn").addEventListener("click", () => $("#importInput").click());
  $("#importInput").addEventListener("change", (e) => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = "";
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
