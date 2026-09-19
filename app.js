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

const STATUS_LABELS = { read: "Read", reading: "Currently Reading", want: "Want to Read" };

function starString(rating) {
  const r = Number(rating) || 0;
  let out = "";
  for (let i = 1; i <= 5; i++) {
    out += i <= r ? "&#9733;" : '<span class="off">&#9733;</span>';
  }
  return out;
}

function getFilteredSortedBooks() {
  let list = state.books.slice();

  if (state.statusFilter !== "all") {
    list = list.filter((b) => b.status === state.statusFilter);
  }
  if (state.search.trim()) {
    const q = state.search.trim().toLowerCase();
    list = list.filter(
      (b) => (b.title || "").toLowerCase().includes(q) || (b.author || "").toLowerCase().includes(q)
    );
  }

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

    const pillClass = book.status === "read" ? "read" : book.status === "reading" ? "reading" : "";
    const metaBits = [];
    if (book.date) metaBits.push(book.date);

    card.innerHTML = `
      <span class="status-pill ${pillClass}">${STATUS_LABELS[book.status] || book.status}</span>
      <h3>${escapeHtml(book.title || "Untitled")}</h3>
      <p class="author">${escapeHtml(book.author || "Unknown author")}</p>
      <div class="stars">${starString(book.rating)}</div>
      ${metaBits.length ? `<div class="meta-line">${escapeHtml(metaBits.join(" · "))}</div>` : ""}
    `;
    card.addEventListener("click", () => openDetail(book.id));
    grid.appendChild(card);
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
    renderGrid();
    hideToast();
  } catch (e) {
    hideToast();
    if (e instanceof GitHubApiError && (e.status === 401 || e.status === 403)) {
      showSetupScreen(e.message);
    } else {
      showToast(e.message || "Failed to load books.json", { error: true, duration: 6000 });
      showAppScreen();
      renderGrid();
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

function setStarPicker(rating) {
  currentFormRating = rating;
  const stars = document.querySelectorAll("#star-picker span");
  stars.forEach((s) => {
    s.classList.toggle("on", Number(s.dataset.val) <= rating);
  });
}

function openAddForm() {
  state.editingId = crypto.randomUUID();
  document.getElementById("form-modal-title").textContent = "Add Book";
  document.getElementById("book-id").value = state.editingId;
  document.getElementById("field-title").value = "";
  document.getElementById("field-author").value = "";
  document.getElementById("field-status").value = "want";
  document.getElementById("field-date").value = "";
  document.getElementById("field-notes").value = "";
  setStarPicker(0);
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
  document.getElementById("field-status").value = book.status || "want";
  document.getElementById("field-date").value = book.date || "";
  document.getElementById("field-notes").value = book.notes || "";
  setStarPicker(Number(book.rating) || 0);
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
      Number(draft.values.rating) !== (Number(book.rating) || 0);

    if (draftDiffers) {
      const when = new Date(draft.savedAt).toLocaleString();
      if (confirm(`An unsaved draft from ${when} was found for this book. Restore it?`)) {
        document.getElementById("field-title").value = draft.values.title;
        document.getElementById("field-author").value = draft.values.author;
        document.getElementById("field-status").value = draft.values.status;
        document.getElementById("field-date").value = draft.values.date;
        document.getElementById("field-notes").value = draft.values.notes;
        setStarPicker(Number(draft.values.rating) || 0);
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
    renderGrid();
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
        renderGrid();
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
    renderGrid();
  } catch (err) {
    hideToast();
    if (err instanceof GitHubApiError && err.status === 409) {
      showToast("Conflict detected — reloading latest data. Please retry the delete.", { error: true, duration: 6000 });
      try {
        const { books, sha } = await fetchBooks(state.cfg);
        state.books = books;
        state.sha = sha;
        renderGrid();
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
  document.getElementById("detail-meta").textContent = book.date ? `Logged: ${book.date}` : "";
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
    renderGrid();
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
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.statusFilter = btn.dataset.status;
    renderGrid();
  });

  document.getElementById("search-input").addEventListener("input", (e) => {
    state.search = e.target.value;
    renderGrid();
  });

  document.getElementById("sort-select").addEventListener("change", (e) => {
    state.sort = e.target.value;
    renderGrid();
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
