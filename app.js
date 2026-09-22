"use strict";

/* =========================================================================
   booktracker3000 — single-user book log backed directly by a GitHub repo.
   No build step, no framework. Data lives in {owner}/{repo}/data/books.json
   and is read/written via the GitHub Contents REST API using a
   fine-grained Personal Access Token stored in localStorage.
   ========================================================================= */

const DATA_PATH = "data/books.json";
const CONFIG_KEY = "bt3k_config";
const DRAFT_PREFIX = "bt3k_draft_";
const API_VERSION = "2022-11-28";
const OPEN_LIBRARY_SEARCH_URL = "https://openlibrary.org/search.json";
const OPEN_LIBRARY_COVER_URL = "https://covers.openlibrary.org/b/id";

/* ---------------------------------------------------------------------
   Config (owner/repo/branch/token) persistence
   --------------------------------------------------------------------- */

function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw);
    if (!cfg.owner || !cfg.repo || !cfg.token) return null;
    if (!cfg.branch) cfg.branch = "main";
    return cfg;
  } catch (e) {
    return null;
  }
}

function saveConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

function clearConfig() {
  localStorage.removeItem(CONFIG_KEY);
}

/* ---------------------------------------------------------------------
   Base64 <-> UTF-8 helpers (GitHub content is base64 of raw UTF-8 bytes)
   --------------------------------------------------------------------- */

function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function b64ToUtf8(b64) {
  const clean = b64.replace(/\n/g, "");
  const binary = atob(clean);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

/* ---------------------------------------------------------------------
   GitHub Contents API wrapper
   --------------------------------------------------------------------- */

class GitHubApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function ghRequest(cfg, path, options = {}) {
  const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      ...(options.headers || {}),
    },
  });
  return res;
}

/**
 * Fetch books.json. Returns { books: [], sha: string|null }.
 * sha is null when the file does not exist yet (will be created on save).
 */
async function fetchBooks(cfg) {
  const res = await ghRequest(cfg, `${DATA_PATH}?ref=${encodeURIComponent(cfg.branch)}`, {
    method: "GET",
  });

  if (res.status === 404) {
    return { books: [], sha: null };
  }
  if (res.status === 401 || res.status === 403) {
    throw new GitHubApiError("Authentication failed. Check your token, repo name, and permissions.", res.status);
  }
  if (!res.ok) {
    throw new GitHubApiError(`GitHub API error (${res.status}) while loading ${DATA_PATH}`, res.status);
  }

  const json = await res.json();
  if (Array.isArray(json)) {
    throw new GitHubApiError(`${DATA_PATH} is a directory, not a file.`, 400);
  }
  let books = [];
  try {
    const text = b64ToUtf8(json.content);
    books = text.trim() ? JSON.parse(text) : [];
  } catch (e) {
    throw new Error(`Could not parse ${DATA_PATH} as JSON: ${e.message}`);
  }
  return { books, sha: json.sha };
}

/**
 * Write the full books array back to books.json.
 * Returns the new sha on success. Throws GitHubApiError with status 409
 * on a sha mismatch (someone/something else changed the file).
 */
async function saveBooks(cfg, books, sha, message) {
  const body = {
    message: message || "Update books.json via booktracker3000",
    content: utf8ToB64(JSON.stringify(books, null, 2)),
    branch: cfg.branch,
  };
  if (sha) body.sha = sha;

  const res = await ghRequest(cfg, DATA_PATH, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 409) {
    throw new GitHubApiError("Conflict: books.json was changed since it was last loaded.", 409);
  }
  if (res.status === 401 || res.status === 403) {
    throw new GitHubApiError("Authentication failed while saving. Check your token permissions.", res.status);
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new GitHubApiError(`GitHub API error (${res.status}) while saving: ${errText}`, res.status);
  }

  const json = await res.json();
  return json.content.sha;
}

/* ---------------------------------------------------------------------
   Book metadata lookup (Open Library — free, keyless, CORS-enabled)
   --------------------------------------------------------------------- */

function coverUrlFor(coverId, size) {
  if (!coverId) return null;
  return `${OPEN_LIBRARY_COVER_URL}/${coverId}-${size || "M"}.jpg`;
}

function resolveCoverUrl(book, size) {
  return book.customCover || coverUrlFor(book.coverId, size);
}

async function searchBookMetadata(query) {
  const url = `${OPEN_LIBRARY_SEARCH_URL}?q=${encodeURIComponent(query)}&fields=title,author_name,first_publish_year,cover_i,isbn,key&limit=8`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open Library search failed (${res.status})`);
  const json = await res.json();
  return json.docs || [];
}

/* ---------------------------------------------------------------------
   Deterministic cosmetic hashing (shelf spine width/color, no cover art)
   --------------------------------------------------------------------- */

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function spineWidthFor(id) {
  return 64 + (hashString(id) % 40); // 64-103px, stands in for spine thickness
}

function authorLastName(author) {
  const trimmed = (author || "").trim();
  if (!trimmed) return "";
  const parts = trimmed.split(/\s+/);
  return parts[parts.length - 1];
}

function spineColorFor(title) {
  const hue = hashString(title || "") % 360;
  return `hsl(${hue}, 32%, 30%)`;
}

/* ---------------------------------------------------------------------
   Minimal Markdown renderer (headers, bold, italic, lists, paragraphs)
   --------------------------------------------------------------------- */

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\*)(.+?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/`([^`]+?)`/g, "<code>$1</code>");
}

function markdownToHtml(md) {
  if (!md) return "";
  const escaped = escapeHtml(md);
  const lines = escaped.split(/\r?\n/);
  let html = "";
  let inList = false;
  let paragraphBuf = [];

  function flushParagraph() {
    if (paragraphBuf.length) {
      html += `<p>${inlineMarkdown(paragraphBuf.join("<br>"))}</p>`;
      paragraphBuf = [];
    }
  }
  function closeList() {
    if (inList) {
      html += "</ul>";
      inList = false;
    }
  }

  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,3})\s+(.*)$/);
    const listMatch = line.match(/^[-*]\s+(.*)$/);

    if (headerMatch) {
      flushParagraph();
      closeList();
      const level = headerMatch[1].length;
      html += `<h${level}>${inlineMarkdown(headerMatch[2])}</h${level}>`;
    } else if (listMatch) {
      flushParagraph();
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += `<li>${inlineMarkdown(listMatch[1])}</li>`;
    } else if (line.trim() === "") {
      flushParagraph();
      closeList();
    } else {
      closeList();
      paragraphBuf.push(line);
    }
  }
  flushParagraph();
  closeList();
  return html;
}

/* ---------------------------------------------------------------------
   App state
   --------------------------------------------------------------------- */

const state = {
  cfg: null,
  books: [],
  sha: null,
  statusFilter: "all",
  search: "",
  sort: "date_desc",
  editingId: null,
  viewMode: "grid",
};

/* ---------------------------------------------------------------------
   Toast / status helper
   --------------------------------------------------------------------- */

let toastTimer = null;
function showToast(message, { error = false, spinner = false, duration = 3000 } = {}) {
  const el = document.getElementById("toast");
  el.innerHTML = (spinner ? '<span class="spinner"></span>' : "") + `<span>${escapeHtml(message)}</span>`;
  el.classList.toggle("error", error);
  el.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  if (duration > 0) {
    toastTimer = setTimeout(() => el.classList.add("hidden"), duration);
  }
}
function hideToast() {
  document.getElementById("toast").classList.add("hidden");
}

/* ---------------------------------------------------------------------
   Rendering
   --------------------------------------------------------------------- */

const STATUS_LABELS = { read: "Read", reading: "Currently Reading", want: "Want to Read", dnf: "Did Not Finish" };
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatGridDate(dateStr) {
  const parts = (dateStr || "").split("-");
  const monthIdx = parseInt(parts[1], 10) - 1;
  if (parts.length < 2 || monthIdx < 0 || monthIdx > 11) return dateStr;
  return `${MONTH_ABBR[monthIdx]} '${parts[0].slice(-2)}`;
}

function starString(rating) {
  const r = Number(rating) || 0;
  let out = "";
  for (let i = 1; i <= 5; i++) {
    out += i <= r ? "&#9733;" : '<span class="off">&#9733;</span>';
  }
  return out;
}

function getFilteredBooks() {
  let list = state.books.slice();

  if (state.statusFilter === "bangers") {
    list = list.filter((b) => Number(b.rating) === 5);
  } else if (state.statusFilter === "all") {
    // "Want to Read" is a wishlist, not part of the library — it only shows
    // up under its own tab.
    list = list.filter((b) => b.status !== "want");
  } else {
    list = list.filter((b) => b.status === state.statusFilter);
  }
  if (state.search.trim()) {
    const q = state.search.trim().toLowerCase();
    list = list.filter(
      (b) => (b.title || "").toLowerCase().includes(q) || (b.author || "").toLowerCase().includes(q)
    );
  }
  return list;
}

function getFilteredSortedBooks() {
  const list = getFilteredBooks();

  const byDate = (a, b) => (a.date || "").localeCompare(b.date || "");
  const byTitle = (a, b) => (a.title || "").localeCompare(b.title || "");
  const byRating = (a, b) => (Number(a.rating) || 0) - (Number(b.rating) || 0);

  switch (state.sort) {
    case "date_asc":
      list.sort(byDate);
      break;
    case "date_desc":
      list.sort((a, b) => byDate(b, a));
      break;
    case "title_asc":
      list.sort(byTitle);
      break;
    case "title_desc":
      list.sort((a, b) => byTitle(b, a));
      break;
    case "rating_asc":
      list.sort(byRating);
      break;
    case "rating_desc":
      list.sort((a, b) => byRating(b, a));
      break;
  }
  return list;
}

function renderGrid() {
  const grid = document.getElementById("book-grid");
  const empty = document.getElementById("empty-list");
  const list = getFilteredSortedBooks();

  grid.innerHTML = "";
  if (list.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  for (const book of list) {
    const card = document.createElement("div");
    card.className = "book-card";
    card.dataset.id = book.id;

    const pillClass = ["read", "reading", "dnf"].includes(book.status) ? book.status : "";
    const metaBits = [];
    if (book.date) metaBits.push(formatGridDate(book.date));

    const cover = resolveCoverUrl(book, "M");
    const coverHtml = cover
      ? `<img class="card-cover" src="${cover}" alt="" loading="lazy" />`
      : `<div class="card-cover card-cover-placeholder" style="background:${spineColorFor(book.title)}"><span>${escapeHtml(
          (book.title || "?").charAt(0).toUpperCase()
        )}</span></div>`;

    card.innerHTML = `
      <div class="card-cover-wrap">
        ${coverHtml}
        <span class="status-pill status-pill-overlay ${pillClass}">${STATUS_LABELS[book.status] || book.status}</span>
      </div>
      <h3>${escapeHtml(book.title || "Untitled")}</h3>
      <p class="author">${escapeHtml(book.author || "Unknown author")}</p>
      <div class="stars">${starString(book.rating)}</div>
      ${metaBits.length ? `<div class="meta-line">${escapeHtml(metaBits.join(" · "))}</div>` : ""}
    `;
    card.addEventListener("click", () => openDetail(book.id));
    grid.appendChild(card);
  }
}

const STATUS_FLAG_COLOR = {
  read: "var(--success)",
  reading: "var(--accent)",
  want: "rgba(255,255,255,0.35)",
  dnf: "var(--danger)",
};

function renderShelf() {
  const container = document.getElementById("shelf-books");
  const list = getFilteredBooks().sort((a, b) => {
    const lastNameCmp = authorLastName(a.author).localeCompare(authorLastName(b.author));
    return lastNameCmp !== 0 ? lastNameCmp : (a.title || "").localeCompare(b.title || "");
  });
  container.innerHTML = "";

  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "shelf-empty";
    empty.textContent = "No books here yet.";
    container.appendChild(empty);
    return;
  }

  for (const book of list) {
    const spine = document.createElement("div");
    spine.className = "spine";
    spine.style.minWidth = spineWidthFor(book.id) + "px";

    const cover = resolveCoverUrl(book, "M");
    if (cover) {
      spine.style.backgroundImage = `linear-gradient(rgba(6, 8, 13, 0.82), rgba(6, 8, 13, 0.82)), url("${cover}")`;
    } else {
      spine.style.backgroundColor = spineColorFor(book.title);
    }

    const flag = document.createElement("div");
    flag.className = "spine-status-flag";
    flag.style.background = STATUS_FLAG_COLOR[book.status] || "transparent";
    spine.appendChild(flag);

    const titleEl = document.createElement("span");
    titleEl.className = "spine-title";
    titleEl.textContent = book.title || "Untitled";
    spine.appendChild(titleEl);

    const authorEl = document.createElement("span");
    authorEl.className = "spine-author";
    const lastName = authorLastName(book.author) || "Unknown";
    authorEl.textContent = lastName + (book.rating ? " " + "★".repeat(book.rating) : "");
    spine.appendChild(authorEl);

    const ratingStr = book.rating ? ` — ${"★".repeat(book.rating)}` : "";
    spine.title = `${book.title || "Untitled"} by ${book.author || "Unknown author"}${ratingStr}`;

    spine.addEventListener("click", () => openDetail(book.id));
    container.appendChild(spine);
  }

  requestAnimationFrame(layoutShelfBoards);
}

function layoutShelfBoards() {
  const container = document.getElementById("shelf-books");
  if (!container) return;
  container.querySelectorAll(".shelf-board").forEach((b) => b.remove());

  const spines = Array.from(container.querySelectorAll(".spine"));
  if (!spines.length) return;

  const rows = [];
  let currentTop = null;
  let currentRow = [];
  for (const s of spines) {
    const top = s.offsetTop;
    if (currentTop === null || Math.abs(top - currentTop) < 2) {
      currentTop = top;
      currentRow.push(s);
    } else {
      rows.push(currentRow);
      currentRow = [s];
      currentTop = top;
    }
  }
  if (currentRow.length) rows.push(currentRow);

  for (const row of rows) {
    const bottom = Math.max(...row.map((s) => s.offsetTop + s.offsetHeight));
    const board = document.createElement("div");
    board.className = "shelf-board";
    board.style.top = bottom + 14 + "px";
    container.appendChild(board);
  }
}

function render() {
  const sortSelect = document.getElementById("sort-select");
  if (state.viewMode === "shelf") {
    document.getElementById("book-grid").classList.add("hidden");
    document.getElementById("empty-list").classList.add("hidden");
    document.getElementById("shelf-view").classList.remove("hidden");
    sortSelect.disabled = true;
    sortSelect.title = "Shelf view is always sorted alphabetically by author";
    renderShelf();
  } else {
    document.getElementById("shelf-view").classList.add("hidden");
    document.getElementById("book-grid").classList.remove("hidden");
    sortSelect.disabled = false;
    sortSelect.title = "";
    renderGrid();
  }
}

/* ---------------------------------------------------------------------
   Screen switching
   --------------------------------------------------------------------- */

function showSetupScreen(errorMsg) {
  document.getElementById("setup-screen").classList.remove("hidden");
  document.getElementById("app-root").classList.add("hidden");
  if (errorMsg) {
    document.getElementById("setup-error").textContent = errorMsg;
  }
  const cfg = state.cfg || {};
  document.getElementById("setup-owner").value = cfg.owner || "";
  document.getElementById("setup-repo").value = cfg.repo || "";
  document.getElementById("setup-branch").value = cfg.branch || "main";
}

function showAppScreen() {
  document.getElementById("setup-screen").classList.add("hidden");
  document.getElementById("app-root").classList.remove("hidden");
}

/* ---------------------------------------------------------------------
   Loading data
   --------------------------------------------------------------------- */

async function loadBooksFromGitHub() {
  showToast("Loading library from GitHub...", { spinner: true, duration: 0 });
  try {
    const { books, sha } = await fetchBooks(state.cfg);
    state.books = books;
    state.sha = sha;
    showAppScreen();
    render();
    hideToast();
  } catch (e) {
    hideToast();
    if (e instanceof GitHubApiError && (e.status === 401 || e.status === 403)) {
      showSetupScreen(e.message);
    } else {
      showToast(e.message || "Failed to load books.json", { error: true, duration: 6000 });
      showAppScreen();
      render();
    }
  }
}

/* ---------------------------------------------------------------------
   Draft autosave (localStorage) for the add/edit form
   --------------------------------------------------------------------- */

function draftKey(id) {
  return DRAFT_PREFIX + id;
}

function readFormValues() {
  return {
    title: document.getElementById("field-title").value,
    author: document.getElementById("field-author").value,
    status: document.getElementById("field-status").value,
    date: document.getElementById("field-date").value,
    rating: currentFormRating,
    notes: document.getElementById("field-notes").value,
    coverId: currentCoverId,
    isbn: currentIsbn,
    firstPublishYear: currentFirstPublishYear,
    olKey: currentOlKey,
    customCover: currentCustomCover,
  };
}

function saveDraft(id) {
  const values = readFormValues();
  localStorage.setItem(draftKey(id), JSON.stringify({ values, savedAt: Date.now() }));
  const note = document.getElementById("draft-note");
  note.textContent = "Draft saved locally " + new Date().toLocaleTimeString();
}

function loadDraft(id) {
  try {
    const raw = localStorage.getItem(draftKey(id));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function clearDraft(id) {
  localStorage.removeItem(draftKey(id));
}

let draftDebounceTimer = null;
function scheduleDraftSave(id) {
  if (draftDebounceTimer) clearTimeout(draftDebounceTimer);
  draftDebounceTimer = setTimeout(() => saveDraft(id), 800);
}

/* ---------------------------------------------------------------------
   Add / Edit form modal
   --------------------------------------------------------------------- */

let currentFormRating = 0;
let currentCoverId = null;
let currentIsbn = null;
let currentFirstPublishYear = null;
let currentOlKey = null;
let currentCustomCover = null;

function setStarPicker(rating) {
  currentFormRating = rating;
  const stars = document.querySelectorAll("#star-picker span");
  stars.forEach((s) => {
    s.classList.toggle("on", Number(s.dataset.val) <= rating);
  });
}

function updateCoverPreview() {
  const row = document.getElementById("cover-preview-row");
  const img = document.getElementById("cover-preview-img");
  const text = document.getElementById("cover-preview-text");
  if (currentCustomCover) {
    img.src = currentCustomCover;
    text.textContent = "Custom pasted cover";
    row.classList.remove("hidden");
  } else if (currentCoverId) {
    img.src = coverUrlFor(currentCoverId, "M");
    const bits = [];
    if (currentFirstPublishYear) bits.push(`First published ${currentFirstPublishYear}`);
    if (currentIsbn) bits.push(`ISBN ${currentIsbn}`);
    text.textContent = bits.join(" · ") || "Cover linked from Open Library";
    row.classList.remove("hidden");
  } else {
    row.classList.add("hidden");
    img.removeAttribute("src");
  }
}

function setMetaState({ coverId = null, isbn = null, firstPublishYear = null, olKey = null } = {}) {
  currentCoverId = coverId;
  currentIsbn = isbn;
  currentFirstPublishYear = firstPublishYear;
  currentOlKey = olKey;
  currentCustomCover = null;
  updateCoverPreview();
}

/**
 * Downscale a pasted image Blob to a data URL, keeping book records (and
 * therefore books.json) small. Longest side capped at maxDim.
 */
function imageBlobToDataUrl(blob, maxDim = 480, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width >= height) {
          height = Math.round(height * (maxDim / width));
          width = maxDim;
        } else {
          width = Math.round(width * (maxDim / height));
          height = maxDim;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that image"));
    };
    img.src = url;
  });
}

async function handleCoverPaste(e) {
  const items = (e.clipboardData || window.clipboardData || {}).items || [];
  const imageItem = Array.from(items).find((item) => item.type && item.type.startsWith("image/"));
  if (!imageItem) {
    showToast("Clipboard didn't contain an image.", { error: true });
    return;
  }
  e.preventDefault();
  try {
    const dataUrl = await imageBlobToDataUrl(imageItem.getAsFile());
    currentCoverId = null;
    currentCustomCover = dataUrl;
    updateCoverPreview();
    if (state.editingId) scheduleDraftSave(state.editingId);
  } catch (err) {
    showToast(err.message, { error: true });
  }
}

function renderMetaResults(docs) {
  const box = document.getElementById("meta-results");
  box.innerHTML = "";
  if (!docs.length) {
    box.innerHTML = '<div class="meta-empty">No matches found.</div>';
    box.classList.remove("hidden");
    return;
  }
  for (const doc of docs) {
    const row = document.createElement("div");
    row.className = "meta-result-item";
    const coverUrl = coverUrlFor(doc.cover_i, "S");
    const author = (doc.author_name && doc.author_name[0]) || "Unknown author";
    row.innerHTML = `
      ${coverUrl ? `<img class="meta-result-cover" src="${coverUrl}" alt="" />` : '<div class="meta-result-cover"></div>'}
      <div class="meta-result-text">
        <div class="mr-title">${escapeHtml(doc.title || "Untitled")}</div>
        <div class="mr-sub">${escapeHtml(author)}${doc.first_publish_year ? " · " + doc.first_publish_year : ""}</div>
      </div>
    `;
    row.addEventListener("click", () => {
      document.getElementById("field-title").value = doc.title || "";
      document.getElementById("field-author").value = author === "Unknown author" ? "" : author;
      setMetaState({
        coverId: doc.cover_i || null,
        isbn: (doc.isbn && doc.isbn[0]) || null,
        firstPublishYear: doc.first_publish_year || null,
        olKey: doc.key || null,
      });
      box.classList.add("hidden");
      box.innerHTML = "";
      if (state.editingId) scheduleDraftSave(state.editingId);
    });
    box.appendChild(row);
  }
  box.classList.remove("hidden");
}

async function handleMetaSearch() {
  const query = document.getElementById("meta-search-input").value.trim();
  if (!query) return;
  const box = document.getElementById("meta-results");
  box.innerHTML = '<div class="meta-empty">Searching...</div>';
  box.classList.remove("hidden");
  try {
    const docs = await searchBookMetadata(query);
    renderMetaResults(docs);
  } catch (e) {
    box.innerHTML = `<div class="meta-empty">${escapeHtml(e.message)}</div>`;
  }
}

function handleCoverRemove() {
  setMetaState();
  if (state.editingId) scheduleDraftSave(state.editingId);
}

function openAddForm() {
  state.editingId = crypto.randomUUID();
  document.getElementById("form-modal-title").textContent = "Add Book";
  document.getElementById("book-id").value = state.editingId;
  document.getElementById("field-title").value = "";
  document.getElementById("field-author").value = "";
  document.getElementById("field-status").value = "read";
  document.getElementById("field-date").value = "";
  document.getElementById("field-notes").value = "";
  setStarPicker(0);
  document.getElementById("meta-search-input").value = "";
  document.getElementById("meta-results").innerHTML = "";
  document.getElementById("meta-results").classList.add("hidden");
  setMetaState();
  document.getElementById("delete-book-btn").classList.add("hidden");
  document.getElementById("draft-note").textContent = "";
  document.getElementById("form-modal-overlay").classList.remove("hidden");
  document.getElementById("field-title").focus();
}

function openEditForm(book) {
  state.editingId = book.id;
  document.getElementById("form-modal-title").textContent = "Edit Book";
  document.getElementById("book-id").value = book.id;
  document.getElementById("field-title").value = book.title || "";
  document.getElementById("field-author").value = book.author || "";
  document.getElementById("field-status").value = book.status || "read";
  document.getElementById("field-date").value = book.date || "";
  document.getElementById("field-notes").value = book.notes || "";
  setStarPicker(Number(book.rating) || 0);
  document.getElementById("meta-search-input").value = "";
  document.getElementById("meta-results").innerHTML = "";
  document.getElementById("meta-results").classList.add("hidden");
  setMetaState({
    coverId: book.coverId || null,
    isbn: book.isbn || null,
    firstPublishYear: book.firstPublishYear || null,
    olKey: book.olKey || null,
  });
  currentCustomCover = book.customCover || null;
  updateCoverPreview();
  document.getElementById("delete-book-btn").classList.remove("hidden");
  document.getElementById("draft-note").textContent = "";

  const draft = loadDraft(book.id);
  if (draft && draft.values) {
    const draftDiffers =
      draft.values.title !== book.title ||
      draft.values.author !== book.author ||
      draft.values.notes !== (book.notes || "") ||
      draft.values.status !== book.status ||
      draft.values.date !== (book.date || "") ||
      Number(draft.values.rating) !== (Number(book.rating) || 0) ||
      (draft.values.coverId || null) !== (book.coverId || null) ||
      (draft.values.customCover || null) !== (book.customCover || null);

    if (draftDiffers) {
      const when = new Date(draft.savedAt).toLocaleString();
      if (confirm(`An unsaved draft from ${when} was found for this book. Restore it?`)) {
        document.getElementById("field-title").value = draft.values.title;
        document.getElementById("field-author").value = draft.values.author;
        document.getElementById("field-status").value = draft.values.status;
        document.getElementById("field-date").value = draft.values.date;
        document.getElementById("field-notes").value = draft.values.notes;
        setStarPicker(Number(draft.values.rating) || 0);
        setMetaState({
          coverId: draft.values.coverId || null,
          isbn: draft.values.isbn || null,
          firstPublishYear: draft.values.firstPublishYear || null,
          olKey: draft.values.olKey || null,
        });
        currentCustomCover = draft.values.customCover || null;
        updateCoverPreview();
        document.getElementById("draft-note").textContent = "Restored unsaved draft.";
      }
    }
  }

  document.getElementById("form-modal-overlay").classList.remove("hidden");
}

function closeForm() {
  document.getElementById("form-modal-overlay").classList.add("hidden");
  state.editingId = null;
}

async function handleFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById("book-id").value;
  const values = readFormValues();

  const existingIndex = state.books.findIndex((b) => b.id === id);
  const now = new Date().toISOString();
  const bookRecord = {
    id,
    title: values.title.trim(),
    author: values.author.trim(),
    status: values.status,
    date: values.date,
    rating: values.rating,
    notes: values.notes,
    coverId: values.coverId,
    isbn: values.isbn,
    firstPublishYear: values.firstPublishYear,
    olKey: values.olKey,
    customCover: values.customCover,
    updatedAt: now,
    createdAt: existingIndex >= 0 ? state.books[existingIndex].createdAt || now : now,
  };

  const nextBooks = state.books.slice();
  if (existingIndex >= 0) {
    nextBooks[existingIndex] = bookRecord;
  } else {
    nextBooks.push(bookRecord);
  }

  const saveBtn = document.getElementById("form-save-btn");
  saveBtn.disabled = true;
  showToast("Saving to GitHub...", { spinner: true, duration: 0 });

  try {
    const newSha = await saveBooks(
      state.cfg,
      nextBooks,
      state.sha,
      `${existingIndex >= 0 ? "Update" : "Add"} "${bookRecord.title}" via booktracker3000`
    );
    state.books = nextBooks;
    state.sha = newSha;
    clearDraft(id);
    hideToast();
    showToast("Saved.");
    closeForm();
    render();
  } catch (err) {
    hideToast();
    if (err instanceof GitHubApiError && err.status === 409) {
      showToast("Conflict detected — reloading latest data from GitHub. Please review and save again.", {
        error: true,
        duration: 6000,
      });
      try {
        const { books, sha } = await fetchBooks(state.cfg);
        state.books = books;
        state.sha = sha;
        render();
      } catch (reErr) {
        showToast("Also failed to reload latest data: " + reErr.message, { error: true, duration: 6000 });
      }
    } else {
      showToast("Save failed: " + err.message, { error: true, duration: 6000 });
    }
  } finally {
    saveBtn.disabled = false;
  }
}

async function handleDeleteBook() {
  const id = document.getElementById("book-id").value;
  const book = state.books.find((b) => b.id === id);
  if (!book) {
    closeForm();
    return;
  }
  if (!confirm(`Delete "${book.title}"? This cannot be undone.`)) return;

  const nextBooks = state.books.filter((b) => b.id !== id);
  showToast("Deleting...", { spinner: true, duration: 0 });
  try {
    const newSha = await saveBooks(state.cfg, nextBooks, state.sha, `Delete "${book.title}" via booktracker3000`);
    state.books = nextBooks;
    state.sha = newSha;
    clearDraft(id);
    hideToast();
    showToast("Deleted.");
    closeForm();
    render();
  } catch (err) {
    hideToast();
    if (err instanceof GitHubApiError && err.status === 409) {
      showToast("Conflict detected — reloading latest data. Please retry the delete.", { error: true, duration: 6000 });
      try {
        const { books, sha } = await fetchBooks(state.cfg);
        state.books = books;
        state.sha = sha;
        render();
      } catch (reErr) {
        showToast("Also failed to reload latest data: " + reErr.message, { error: true, duration: 6000 });
      }
    } else {
      showToast("Delete failed: " + err.message, { error: true, duration: 6000 });
    }
  }
}

/* ---------------------------------------------------------------------
   Detail view modal
   --------------------------------------------------------------------- */

function openDetail(id) {
  const book = state.books.find((b) => b.id === id);
  if (!book) return;

  document.getElementById("detail-status").textContent = STATUS_LABELS[book.status] || book.status;
  document.getElementById("detail-title").textContent = book.title || "Untitled";
  document.getElementById("detail-author").textContent = book.author || "Unknown author";
  document.getElementById("detail-stars").innerHTML = book.rating ? starString(book.rating) : "";

  const metaBits = [];
  if (book.date) metaBits.push(`Logged: ${book.date}`);
  if (book.firstPublishYear) metaBits.push(`First published ${book.firstPublishYear}`);
  if (book.isbn) metaBits.push(`ISBN ${book.isbn}`);
  document.getElementById("detail-meta").textContent = metaBits.join(" · ");

  const coverImg = document.getElementById("detail-cover");
  const coverUrl = resolveCoverUrl(book, "L");
  if (coverUrl) {
    coverImg.src = coverUrl;
    coverImg.classList.remove("hidden");
  } else {
    coverImg.classList.add("hidden");
    coverImg.removeAttribute("src");
  }

  document.getElementById("detail-notes").innerHTML = book.notes
    ? markdownToHtml(book.notes)
    : '<p style="color:var(--text-faint)">No notes yet.</p>';

  document.getElementById("detail-edit-btn").onclick = () => {
    closeDetail();
    openEditForm(book);
  };

  document.getElementById("detail-modal-overlay").classList.remove("hidden");
}

function closeDetail() {
  document.getElementById("detail-modal-overlay").classList.add("hidden");
}

/* ---------------------------------------------------------------------
   Settings panel
   --------------------------------------------------------------------- */

function openSettings() {
  const cfg = state.cfg || {};
  document.getElementById("settings-owner").value = cfg.owner || "";
  document.getElementById("settings-repo").value = cfg.repo || "";
  document.getElementById("settings-branch").value = cfg.branch || "main";
  document.getElementById("settings-token").value = cfg.token || "";
  document.getElementById("settings-status").textContent = "";
  document.getElementById("settings-panel").classList.remove("hidden");
}

function closeSettings() {
  document.getElementById("settings-panel").classList.add("hidden");
}

async function handleSettingsSave() {
  const owner = document.getElementById("settings-owner").value.trim();
  const repo = document.getElementById("settings-repo").value.trim();
  const branch = document.getElementById("settings-branch").value.trim() || "main";
  const token = document.getElementById("settings-token").value.trim();
  const status = document.getElementById("settings-status");

  if (!owner || !repo || !token) {
    status.textContent = "Owner, repo, and token are all required.";
    return;
  }

  const cfg = { owner, repo, branch, token };
  saveConfig(cfg);
  state.cfg = cfg;
  status.textContent = "Saved. Reloading library...";
  await loadBooksFromGitHub();
  closeSettings();
}

function handleSettingsClear() {
  if (!confirm("Remove the stored token and repo settings from this browser? Your data on GitHub is unaffected.")) {
    return;
  }
  clearConfig();
  state.cfg = null;
  state.books = [];
  state.sha = null;
  closeSettings();
  showSetupScreen();
}

/* ---------------------------------------------------------------------
   Setup screen submit
   --------------------------------------------------------------------- */

async function handleSetupSave() {
  const owner = document.getElementById("setup-owner").value.trim();
  const repo = document.getElementById("setup-repo").value.trim();
  const branch = document.getElementById("setup-branch").value.trim() || "main";
  const token = document.getElementById("setup-token").value.trim();
  const errorEl = document.getElementById("setup-error");
  errorEl.textContent = "";

  if (!owner || !repo || !token) {
    errorEl.textContent = "Please fill in owner, repo, and token.";
    return;
  }

  const cfg = { owner, repo, branch, token };
  const btn = document.getElementById("setup-save-btn");
  btn.disabled = true;
  showToast("Connecting to GitHub...", { spinner: true, duration: 0 });

  try {
    const { books, sha } = await fetchBooks(cfg);
    saveConfig(cfg);
    state.cfg = cfg;
    state.books = books;
    state.sha = sha;
    hideToast();
    showAppScreen();
    render();
  } catch (e) {
    hideToast();
    errorEl.textContent = e.message || "Could not connect. Check your settings and try again.";
  } finally {
    btn.disabled = false;
  }
}

/* ---------------------------------------------------------------------
   Event wiring
   --------------------------------------------------------------------- */

function wireEvents() {
  document.getElementById("setup-save-btn").addEventListener("click", handleSetupSave);

  document.getElementById("add-book-btn").addEventListener("click", openAddForm);
  document.getElementById("form-close-btn").addEventListener("click", closeForm);
  document.getElementById("form-cancel-btn").addEventListener("click", closeForm);
  document.getElementById("book-form").addEventListener("submit", handleFormSubmit);
  document.getElementById("delete-book-btn").addEventListener("click", handleDeleteBook);

  ["field-title", "field-author", "field-status", "field-date", "field-notes"].forEach((id) => {
    document.getElementById(id).addEventListener("input", () => {
      if (state.editingId) scheduleDraftSave(state.editingId);
    });
  });

  document.querySelectorAll("#star-picker span").forEach((star) => {
    star.addEventListener("click", () => {
      const val = Number(star.dataset.val);
      setStarPicker(val === currentFormRating ? 0 : val);
      if (state.editingId) scheduleDraftSave(state.editingId);
    });
  });

  document.getElementById("detail-close-btn").addEventListener("click", closeDetail);
  document.getElementById("detail-modal-overlay").addEventListener("click", (e) => {
    if (e.target.id === "detail-modal-overlay") closeDetail();
  });
  document.getElementById("form-modal-overlay").addEventListener("click", (e) => {
    if (e.target.id === "form-modal-overlay") closeForm();
  });

  document.getElementById("settings-btn").addEventListener("click", openSettings);
  document.getElementById("settings-close-btn").addEventListener("click", closeSettings);
  document.getElementById("settings-save-btn").addEventListener("click", handleSettingsSave);
  document.getElementById("settings-clear-btn").addEventListener("click", handleSettingsClear);

  document.getElementById("status-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab-btn");
    if (!btn) return;
    document.querySelectorAll("#status-tabs .tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.statusFilter = btn.dataset.status;
    render();
  });

  document.getElementById("view-toggle").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab-btn");
    if (!btn) return;
    document.querySelectorAll("#view-toggle .tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.viewMode = btn.dataset.view;
    render();
  });

  document.getElementById("meta-search-btn").addEventListener("click", handleMetaSearch);
  document.getElementById("meta-search-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleMetaSearch();
    }
  });
  document.getElementById("cover-remove-btn").addEventListener("click", handleCoverRemove);
  document.getElementById("cover-paste-zone").addEventListener("paste", handleCoverPaste);

  let shelfResizeTimer = null;
  window.addEventListener("resize", () => {
    if (state.viewMode !== "shelf") return;
    if (shelfResizeTimer) clearTimeout(shelfResizeTimer);
    shelfResizeTimer = setTimeout(layoutShelfBoards, 150);
  });

  document.getElementById("search-input").addEventListener("input", (e) => {
    state.search = e.target.value;
    render();
  });

  document.getElementById("sort-select").addEventListener("change", (e) => {
    state.sort = e.target.value;
    render();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeDetail();
      closeForm();
      closeSettings();
    }
  });
}

/* ---------------------------------------------------------------------
   Init
   --------------------------------------------------------------------- */

function init() {
  wireEvents();
  const cfg = loadConfig();
  if (!cfg) {
    showSetupScreen();
    return;
  }
  state.cfg = cfg;
  loadBooksFromGitHub();
}

document.addEventListener("DOMContentLoaded", init);
