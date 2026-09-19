# booktracker3000

A lightweight, single-user Goodreads replacement. It's a static HTML/JS site
served from GitHub Pages, with no backend server — your book data is stored
as JSON directly in a private GitHub repository and read/written from the
browser using the GitHub REST API.

## How it works

- **Frontend**: `index.html` + `app.js` + `styles.css`, no build step, no framework.
- **Database**: `data/books.json` in whichever repo you point it at (can be
  this same repo, or a separate private repo used only for data).
- **Auth**: a fine-grained GitHub Personal Access Token, entered once and
  stored in `localStorage` in your browser. Every read/write goes straight
  from your browser to `api.github.com` — there is no intermediate server.

## This deployment

This project actually uses **two repos**, because GitHub Pages on a free
plan only serves from public repos, and we didn't want book reviews
sitting in a public file:

- **[`tacomadragonclass1/booktracker3000`](https://github.com/tacomadragonclass1/booktracker3000)**
  — this repo. Public, holds only the static app code (no data, no
  secrets). Serves the site via GitHub Pages.
- **[`tacomadragonclass1/booktracker3000-data`](https://github.com/tacomadragonclass1/booktracker3000-data)**
  — private. Holds `data/books.json` (currently seeded with `[]`). The
  app's Settings panel points at this repo, and all reads/writes of your
  actual book data go here via the GitHub API — never through Pages, so
  it's never served as a static file.

If you're setting this up somewhere else, or from scratch, follow the
general steps below.

### 1. Decide where your data lives

You can store `data/books.json` in the same repo as the app, or point the
app at a separate **private** repo dedicated to your book data
(recommended — see above for why). If you use a separate data repo, just
create an empty private repo on GitHub; the app will create
`data/books.json` in it automatically on your first save.

### 2. Deploy the app to GitHub Pages

1. Push the app files (`index.html`, `app.js`, `styles.css`) to a
   **public** repo (Pages on a private repo requires GitHub Pro/Team/
   Enterprise).
2. In the repo settings, enable **GitHub Pages** for the branch/folder
   containing `index.html`.
3. Visit the published URL.

### 3. Create a Fine-Grained Personal Access Token

1. Go to `https://github.com/settings/personal-access-tokens/new`.
2. Give it a name like `booktracker3000`.
3. Under **Repository access**, choose **Only select repositories** and
   pick your data repo.
4. Under **Permissions → Repository permissions**, set **Contents** to
   **Read and write**. Nothing else is needed.
5. Generate the token and copy it (you won't be able to see it again).

### 4. Connect the app

On first visit, the app will show a setup screen asking for:

- **Repo owner** — your GitHub username or org (e.g. `tacomadragonclass1`).
- **Repository name** — the repo holding `data/books.json` (e.g.
  `booktracker3000-data`, *not* `booktracker3000` itself).
- **Branch** — usually `main`.
- **Personal Access Token** — the token you just created.

Click **Connect & Load Library**. The app will try to read
`data/books.json`; if it doesn't exist yet, it will be created the first
time you save a book.

## Updating or removing your token

Click the gear icon in the top-right corner at any time to open
**Settings**, where you can update the owner/repo/branch/token or delete
the stored token entirely (this only clears it from your browser —
nothing on GitHub is touched).

## Metadata search & Shelf view

- **Metadata search**: in the Add/Edit form, the "Find book metadata" box
  queries the [Open Library Search API](https://openlibrary.org/dev/docs/api/search)
  (free, no key or account required, CORS-enabled) and lets you click a
  result to auto-fill title/author plus a cover image, first-publish year,
  and ISBN. This is entirely optional — you can still type title/author by
  hand and skip it. Selected metadata is stored on the book record
  (`coverId`, `isbn`, `firstPublishYear`, `olKey`) and shown in the detail
  view; older book records without these fields work fine, they just show
  no cover.
- **Paste your own cover art**: can't find it on Open Library, or want a
  screenshot of your own copy? Click the "Or paste your own cover art" box
  in the form and paste an image (Ctrl/Cmd+V) straight from your clipboard.
  It's downscaled and compressed client-side (long side capped at 480px,
  JPEG ~80% quality) and stored directly on the book record as a
  `customCover` data URL — no extra GitHub repo or upload step needed. A
  pasted cover takes priority over an Open Library one everywhere it's
  shown; "Remove cover" clears whichever is active. Because it's stored
  inline in `books.json`, pasting covers on many books will grow that file
  faster than relying on Open Library links — see the size note below.
- **Shelf view**: a second view mode (toggle next to the status tabs) that
  renders your filtered/sorted books as spines standing on a wooden shelf
  background — books with a cover show it as the spine art, others get a
  deterministic color derived from the title. Purely visual; it uses the
  same underlying book data as Grid view and doesn't change what's stored.

## Notes & limitations

- This is intentionally single-user: anyone with the token can read/write
  your data, so keep the token private and scoped only to the data repo.
- The GitHub Contents API used here has a practical size limit of about 1MB
  per file. That comfortably fits hundreds of books with long-form notes,
  but if your library grows very large, consider splitting `books.json`
  into per-book files under `/data` (the schema is intentionally simple —
  one JSON object per book — to make that migration easy later).
- Drafts of the book form (title/author/notes/etc.) autosave to
  `localStorage` every ~800ms while typing, so a closed tab or crash won't
  lose an in-progress review. Drafts are cleared automatically once a save
  to GitHub succeeds.
- If GitHub reports a conflict while saving (the file changed since it was
  loaded — e.g. you edited it on two devices), the app reloads the latest
  version and asks you to redo and re-save your change.
