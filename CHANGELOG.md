# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- No dead ends: a search that finds nothing says what Duct searched, what it couldn't look inside (scans with no text yet, password-protected and unreadable files, files still being read), how many results the filters hid, and "Did you mean" using the spelling in your documents. `GET /api/search` returns this as `help`.
- WhatsApp as a source: + Add › Add a WhatsApp chat takes the .zip from WhatsApp's Export chat (with media). The conversation is indexed day by day ("8 March 2026" in results) and every attachment Duct can read is indexed with who sent it, in which chat and when: results say "WhatsApp · from Chidi Okafor in Okafor Holdings · 8 Mar 2026", the sender's name is searchable with the file ("chidi contract"), and the file's date is when it was sent, so the Modified filters work. Exporting the chat again updates it. iPhone and Android exports, either date order, 12- and 24-hour times. Exported chat files in watched folders are read by day too. `POST /api/whatsapp`.
- The first minute: while Duct reads a new library it shows what it's finding ("Found so far: 60 invoices, 25 contracts, 12 meeting minutes and 6 CVs", worked out on the device from names and opening text). When it's done, instead of dropping you into the app, it asks you to search for a document you couldn't find last week, with searches to try drawn from your own files (kinds of document and names that recur across them), each checked to find something. The suggestions stay on the home screen. `GET /api/discover`, `duct.discover()`.
- The privacy ledger (Settings › Privacy): every connection Duct makes to another computer, recorded on the device by Duct itself: where to, what for (Tensflare, the AI provider you chose, cloud sources, sign-in, web pages you added), how many requests and how much was sent. When nothing left, it says "Nothing." It watches `fetch`, Node's `http`/`https` (used by provider SDKs) and, in the desktop app, the windows' own requests; connections to this computer (a local Ollama) aren't counted. Kept 30 days; `GET`/`DELETE /api/ledger`.
- Offline: Duct says "You're offline. Everything in Duct is still searchable."
- "Why this result?": each result can show the words that matched as written in the passage (including other forms, such as "termination" for "terminate"), a file-name match, or a match by meaning (`why` in the API).

### Fixed
- With search by meaning on, results lost their highlighted excerpt.

## [1.0.0-alpha.1] - 2026-10-08

Duct 1.0 turns the search library into a product family: the desktop app, a team server you can run in your own cloud, the developer API with its clients, and Tensflare accounts for paid plans (hosted AI, sync, connectors, team sign-in). This alpha is for testers; 1.0.0 follows once payments, identity providers, Docker images and Windows and Linux builds are verified.

### Upgrading from 0.2
- Requires Node.js 22.13 or later.
- Indexes from 0.2 are migrated on first start, and their documents are re-read in the background. The CLI keeps one index in `$DUCT_HOME` or `~/.duct`.
- `duct serve` listens on `127.0.0.1` by default. Any other `--host` needs `--auth-token` or sign-in (`--oidc-issuer`).
- `POST /api/watch` only accepts folders under `--watch-root`, and the API only deletes files Duct stored in its Library.
- Docker: the image keeps its data in `/data` (`DUCT_HOME`) and runs as the unprivileged `node` user (uid 1000). Move a volume that was mounted elsewhere to `/data`, and make it writable by uid 1000 (`chown -R 1000:1000`).

### Security
- Spreadsheets are read with SheetJS 0.20.3 (fixes the prototype-pollution and ReDoS advisories in 0.18.5); pdf.js 6 and sharp 0.35.5 also clear their advisories.
- `duct serve` listens on `127.0.0.1` by default and refuses other interfaces without `--auth-token`. It accepts only expected `Host` headers, rejects cross-origin writes, and sends a Content-Security-Policy.
- The API no longer indexes local paths sent as URLs, never indexes files without a supported extension, and only deletes files that Duct stored in its Library.
- `POST /api/watch` only accepts folders under `--watch-root`; the desktop app picks folders with the native dialog instead.
- URLs that resolve to private, loopback or link-local addresses are refused by `duct serve`, including after redirects.
- LLM answers are escaped before display, and API keys are never written to disk.
- Browsers log in to a token-protected server once (`POST /api/login`, HttpOnly cookie).

### Added
- Duct in your own cloud: `deploy/` has Docker Compose with automatic HTTPS (Caddy) and Kubernetes manifests; see docs/deploy.md. Shared servers can sign people in with the organisation's identity provider (OpenID Connect: Google Workspace, Entra ID, Okta…), with admins and members set by email and domain (`--oidc-issuer`, `--admin-email`, `--allow-domain`). An audit log of sign-ins, searches, opens, exports and admin changes (Settings › Audit log, `GET /api/audit`, CSV), kept 365 days; search text only with `--audit-queries`. `--trust-proxy` for running behind a proxy, and `/healthz`.
- S3 connector: Amazon S3 and S3-compatible stores (MinIO, Cloudflare R2, Wasabi, Backblaze B2), from Settings › Library.
- Cloud sources (Team): Google Drive (Docs, Sheets and Slides exported), OneDrive and SharePoint sites, read-only and incrementally, from Settings › Library. Results can open the file in the browser. See docs/connectors.md.
- Hosted AI for Pro and Team: choose "Tensflare" for search by meaning or Ask in Settings › AI, with no API key; credits shown in Settings › Account. Settings sync across devices (search and AI settings and feature switches only, never keys, documents or paths). Settings › Account shows the plan, renewal and payments, and opens the account website signed in for upgrades, plan changes, refunds, team and devices.
- Send feedback and Copy diagnostics (Settings › About and the Help menu). Diagnostics hold version, OS, settings and error codes, never document content. Crash records (error type and Duct's own stack frames only) are kept on the device and sent only if you include them with feedback. Links to the privacy policy, terms and refund policy in the app.
- Sign in with Tensflare (optional, for paid features): OAuth 2.0 with PKCE in the system browser, an Ed25519-signed entitlement that works offline for 30 days, Settings › Account, and `duct account signin|status|signout`. Tokens are kept in the system keychain (desktop) or a private file.
- Anonymous usage counts, off by default for now: a fixed-schema daily report of versions, features and library size in ranges, never content, names, paths or searches. `duct telemetry show|on|off`, a switch with "What Duct sends" in Settings › General, `DO_NOT_TRACK` and `DUCT_TELEMETRY=0`, and opt-in for EU and EEA installs.
- Copy a passage with its source, collect passages across searches, and export them (or a whole search) as a Word document, CSV evidence list or Markdown. Tags on documents (filter by tender, client, matter or outcome), a "Modified" date filter, and "Copy citation" (APA or BibTeX) using the title, author and year Duct now reads from PDFs and Word files. Amounts match however they were written (1200, 1,200, 1 200, 1,200.00). The developer API can sort by a metadata field.
- Developer API (`/v1`) for apps that add document search: API keys with scopes (`duct keys`), collections stored as separate indexes, text and JSON documents under your own ids (single and bulk, skipped when unchanged), file uploads read by the same extractors, search with filters, facets, format scopes, pagination and `<mark>` highlights, and an OpenAPI 3.1 spec at `/v1/openapi.json`. Includes a dependency-free TypeScript client (`@docfide/duct/client`) and a standard-library Python client.
- Feature switches: Settings > Features turns off Ask, search by meaning, file-name matching, field extraction, adding files, watched folders, web pages, OCR on request, export, version comparison, and whole file families. Off is enforced by the library (`FeatureDisabledError`), the server (403) and the UI. Also `duct features`, `GET/PUT /api/features`, and `new Duct({ features })`. The desktop app adds switches for the notch companion, sounds and the quick-search shortcut.
- Redesigned main window: search as you type with a preview pane, file-type and source filters, a Documents view with **Needs attention**, a settings dialog, and Ask as a Labs mode in the search bar. It works down to phone-width windows.
- First-run screen: choose a folder or add files, watch the progress, start searching.
- File names are searchable, not just file contents.
- In the desktop app, API keys entered in Settings are kept in the system keychain (macOS Keychain, Windows DPAPI, the Linux secret store).
- The main page's Content-Security-Policy forbids inline scripts. The UI now lives in `assets/ui/` instead of a template string.
- Many more formats (see docs/formats.md): legacy Word (.doc), OpenDocument (.odt, .ods, .odp), Apple Pages/Numbers/Keynote (including package folders), RTF, EPUB, email (.eml, Outlook .msg, with attachments), old Excel (.xls, .xlsb), ZIP archives, subtitles, YAML/TOML and other text formats, source code, SVG text, and iPhone HEIC photos (OCR). PowerPoint speaker notes are indexed with their slide.
- Results name the location by format: "slide 4", "sheet 2", "ch. 3" or "p. 12".
- Folder scans skip `node_modules`, `.git`, caches, the Trash, hidden folders, Office lock files and `.env` files.
- Text files in UTF-16 or Windows-1252 are decoded correctly instead of showing garbled characters.
- Duct's own PDF viewer (`/viewer`, built on pdf.js): opens at the result's page and highlights the matched words, including stemmed forms ("terminate" highlights "termination"), with previous/next match, page and zoom controls.
- The island: on macOS the mascot lives in the notch, or in a small pill in the menu bar on Macs without one. It shows indexing progress, greets you on launch, peeks out on hover and opens a quick search on click or with ⌘⇧Space (Ctrl+Shift+Space elsewhere). Drop files on it to add them to the Library. Toggle it from View or the tray menu.
- The island's mascot looks at you: on hover and in quick search, a live SVG head follows the cursor with its eyes, tilts toward it and blinks.
- When files can't be read, the island shows the head-tilting "needs a hand" ferret with "3 couldn't be read"; clicking opens Duct on just those files and their errors. `duct.activity().lastRun` reports each run's failures.
- Dropping unsupported files on the island explains what Duct can read. Dropping a folder starts watching it.
- Island sounds: short synthesized chirps (no audio files) for a poke, the dizzy triple-poke, opening quick search, dropped files (added, already indexed, or not supported), a long indexing job finishing (8 s or more), and a hello on the very first launch. The main window stays silent. Turn them off with View › Play Sounds or the tray menu.
- The tray mascot sleeps while folders are watched and wakes up while indexing.
- Page numbers: PDF and PPTX chunks record their page or slide. Results show "p. 47", with **Open at p. 47** (browser viewer or the desktop PDF window) and **Show in folder** in the desktop app.
- Highlighted snippets around each match.
- Live indexing progress (`duct.activity()`, `GET /api/activity`) in the dashboard and mascot.
- **Run OCR** button for files with no text (`POST /api/ocr`), and a watched-folders list with remove buttons (`GET`/`DELETE /api/sources`).
- A per-viewer switch to hide the mascot.
- `npm run bench -- <folder> [queries.json]`: indexing speed, search latency and top-3 accuracy on your own documents.
- Team server: `duct serve --watch <dir>` watches a shared folder from startup, `--rescan <minutes>` catches changes that network drives don't report, and `--member-token` gives colleagues search, open and upload access without admin rights.
- SQLite index (`duct.db`): loads instantly, saves incrementally, and skips unchanged files (timestamp, size, content hash). Older JSON indexes are migrated automatically.
- Remembered watched folders: `restoreSources()`, `listSources()`, `removeSource()`. Changes made while Duct was closed are caught up on, and deleted or moved files leave the index.
- The Library: uploads and "Add Files" are kept in `~/Duct Library` under their real names; identical files are reported as duplicates. Use `addToLibrary` from `@docfide/duct/library` and `--library <dir>`.
- Documents have `displayName`, `source` and `status` (`indexed`, `no-text`, `failed`), shown in the web UI.
- Mascot animations in the web UI and desktop app, plus new app and tray icons (`npm run icons`).
- `embed: false` / `--no-embed` disable embeddings; `EmbeddingProvider.embedQuery` for query-specific embeddings (Cohere).

### Changed
- "Ask your documents" moved into a collapsed **Labs** section; search is the main experience.
- CI runs the tests on Linux, macOS and Windows.
- The CLI keeps one index in `$DUCT_HOME` or `~/.duct`, so `duct index` then `duct search` works across runs.
- Keyword search uses FTS5: stemming ("terminate" finds "termination"), accent-insensitive matching, quoted phrases, and Chinese, Japanese and Korean text. Metadata filters apply before results are limited.
- OCR is optional and offline: images and scanned PDFs are flagged `needsOcr` unless OCR is on, and the English model is bundled. Single-page scans are now detected.
- PDF text keeps its line breaks and whole words. Detected tables are no longer appended as a second copy.
- Changing the embedding model re-embeds in the background instead of mixing vectors from different models. Gemini embeddings are batched.
- Requires Node.js 22.13 or later.

### Fixed
- "Preparing semantic search…" no longer stays on forever. The embedding job's busy flag never cleared when there was nothing to embed, which also stopped later embeddings from running. A failing provider (for example, Gemini selected without `GEMINI_API_KEY`) now shows "semantic search paused" with the reason, and isn't retried until the embedding settings change.
- The README now states the actual license (Apache 2.0).
- pdf.js no longer floods the console with font warnings.
- Slides in `.pptx` files were ordered as text (slide 10 before slide 2), and words split across text runs were merged.
- The server stayed unresponsive while indexing many small files.
- Filenames containing quotes could break out of HTML attributes in the web UI.
- The desktop app no longer deletes its index on quit, and only one copy can run at a time.
- The web UI documents list, search and LLM settings saving, the separate API key field, uploads of more than 120 files, the "Export CSV" label, and the version shown.
- Selecting "None" as LLM provider disables it. `HybridSearcher` uses the embedder it is given instead of OpenAI/Gemini from the environment.
- OCR of scanned PDFs (rendering now uses pdf.js's own canvas).
- Settings changed in the UI are kept after restart. `duct diff` works across runs.

## [0.2.0] - Metadata & Search Docs

### Added
- **Document Metadata**: `duct.index(path, metadata)` attaches arbitrary key-value pairs to documents and their chunks. Metadata persists across save/load cycles.
- **Metadata Filtering**: `duct.search(query, topK, filter)` scopes results by exact metadata match. Exposed via API as `?filter={...}` query param.
- **`duct.getDocument(path)`**: Retrieve a single document's info including metadata.
- **New file formats**: CSV, JSON, LOG, XML, XLSX, PPTX — 21 supported extensions total.
- **Scoring, Ranking & Re-ranking documentation**: Full explanation in `docs/search.md` of BM25 scoring, cosine similarity, RRF fusion, result ordering, and the `SimpleReranker` algorithm with its weights and signals.

### Changed
- `DocumentInfo.metadata` field added to public interface.
- `GET /api/documents?path=` returns a single document.
- `POST /api/index` accepts `metadata` in JSON body and multipart form.
- `docs/library.md` updated with all new method signatures and documented `Reranker`, `LLMProvider`, `EmbeddingProvider`, `VectorStore`, and `Searcher` interfaces.

## [0.1.0] - Initial Release

### Added
- **Core CLI Pipeline**: A unified pipeline to ingest, extract, embed, and search documents.
- **Watch Mode**: `duct.watch()` to continuously monitor directories and auto-ingest file changes.
- **Flow × Lime Dashboard**: A fast, local, offline-first web UI (`duct serve`) for querying documents.
- **Multi-Modal Extractors**: Support for parsing PDF, DOCX, Markdown, and Web URLs.
- **OCR Engine**: Tesseract.js integration for extracting text from images automatically.
- **RAG & Agentic QA**: `duct ask` with integrated Ollama support for offline, local, cited answering.
- **Hybrid Search Engine**: Integrated BM25 + Vector similarity search functionality.
- **Export Capabilities**: API and CLI support for `--json` exports.
