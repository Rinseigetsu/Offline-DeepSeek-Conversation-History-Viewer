# DeepSeek Chat Reader · Portable (no installation, fully offline)

One folder, zero dependencies, completely offline: copy it onto a USB stick or anywhere else and
double-click to run. **No Python / Node / internet / sign-in required.** The whole package is about
1.4 MB across 45 files — meant for quickly browsing conversation content while offline.

---

## 1. What each file and folder is for

### 1.1 Entry points and launchers (4 files, all double-clickable)

| File | Size | Purpose |
| --- | --- | --- |
| `index.html` | 17 KB | The reader itself (a single page). Loads the official stylesheet + my additions + the data + `app.js`. It contains the real sidebar/header structure, the `<input>` used for imports, the toast and the JSON overlay. |
| `OPEN-READER.cmd` | 0.1 KB | Double-click to open `index.html` in your default browser (pure ASCII on purpose, so the cmd code page cannot mistake Chinese comments for commands). |
| `OPEN-READER.bat` | 0.1 KB | The same; use this one if the `.cmd` association is taken over or broken. |
| `SERVE-AND-OPEN.cmd` | 0.5 KB | Optional: starts a local http server (`http://127.0.0.1:8777`) and opens it. Only needed for things that are restricted on `file://` (such as copying to the clipboard). Plain reading does not need it. |

### 1.2 `assets/` — the reader's own code (96 KB)

| File | Size | Purpose |
| --- | --- | --- |
| `app.css` | 26 KB | **Only the parts the official stylesheet does not cover**: search box, import button, branch switcher, web-source cards, footer note, empty state, floating buttons, toast, JSON overlay, print rules, narrow-screen tweaks. Every colour and font references the official `--dsw-*` tokens, so it follows the official theme automatically. |
| `app.js` | 70 KB | All of the logic: data loading (on `file://` it injects classic `<script>` tags to work around the `fetch`/ESM restrictions), conversation tree → page rendering (progressively, in batches), the Markdown / syntax-highlighting / math / citation pipeline, thinking blocks, web sources, branch switching with `‹ ›`, full-text search, light/dark theme, sidebar collapsing, and the **in-browser .zip import** (hand-rolled zip reader + `DecompressionStream` + conversion into the reader's structure + IndexedDB persistence). |

### 1.3 `data/` — conversation data (an **empty archive** in Portable, 104 B)

| File | Size | Purpose |
| --- | --- | --- |
| `manifest.js` | 66 B | The conversation list and metadata (title, timestamps, turn count, model, branches). Initialised in Portable as `{"convs":[]}`. |
| `search.js` | 38 B | The full-text search index. Initialised in Portable as `{"rows":[]}`; loaded only when you search. |

### 1.4 `vendor/` — official and third-party assets (1.2 MB, all local)

| Path | Size | Purpose |
| --- | --- | --- |
| `deepseek/main.css` | 289 KB | **The official stylesheet itself** (design tokens + every component rule for the sidebar, header, messages, code blocks, …). Only the 8 Inter font URLs were repointed at local files. |
| `deepseek/katex.css` | 20 KB | The official KaTeX stylesheet; its 20 math fonts are local as well. |
| `marked.min.js` | 35 KB | Markdown parser (v12). |
| `purify.min.js` | 21 KB | HTML sanitiser (DOMPurify), run before rendering. |
| `highlight.min.js` | 119 KB | Syntax highlighting (v11), together with `hljs-light.min.css` / `hljs-dark.min.css` (4 KB each) which switch with the theme. |
| `katex.min.js` | 269 KB | Math typesetting. |
| `fonts/inter/*.woff2` | 8 files | The same Inter subsets the official site uses (UI/body font). |
| `fonts/KaTeX_*.woff2` | 20 files | KaTeX math glyphs. |

## 2. First run

1. Double-click **`OPEN-READER.cmd`** (or `OPEN-READER.bat` if that does not work), or double-click
   `index.html` directly.
2. On the empty list, click **「选择 .zip 文件导入」** (you can also drag the zip into the window):
   in the DeepSeek web app go to Settings → Data → **Export data** to get
   `deepseek_data-YYYY-MM-DD.zip`, then pick that file.
3. Unpacking and conversion happen locally inside your browser; the result is stored in the
   browser's IndexedDB and **is still there the next time you open it**. Importing the same zip
   again automatically skips the conversations that already exist.

## 3. Usage cheat sheet

- **Reading**: click a conversation on the left (Ctrl/⌘+click = open the same one on the official
  site); the body uses the official site's typography
- **Search**: type in the search box at the top and press Enter to search message text; `Ctrl+K` focuses it
- **Thinking / web sources**: click the heading to expand; the buttons top-right expand everything at once
- **Multiple versions**: at a branch point use `‹ 第 2/5 个版本 ›` to switch
- **Copy**: copy a single answer, or use 「复制全文」 top-right to export the whole conversation as
  Markdown; 「JSON」 shows the raw data; 「官网 ↗」 jumps to the official site
- **Light/dark**: ◐ at the top-right of the sidebar (light by default); **collapsing the sidebar**:
  the button at the top-left of the header (it stays there while collapsed, so you can always reopen it)
- `Ctrl+P` to print / save as PDF (the sidebar is hidden and thinking blocks are expanded automatically)

## 4. Notes (differences from the official site)

- Read-only: there is no message composer (you cannot send anything).
- The interface language is Chinese.
- Original attachment files and inline images are not part of the export: attachments show their file
  name and size, images show a placeholder that links to the original URL.
- The export does not contain thinking durations, so that line shows the character count of the
  thinking text instead.
- The 8 broken LaTeX expressions are shown as red source text so you can spot them.
