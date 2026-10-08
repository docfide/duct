# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- `duct serve` listens on `127.0.0.1` by default and refuses other interfaces without `--auth-token`. It accepts only expected `Host` headers, rejects cross-origin writes, and sends a Content-Security-Policy.
- The API no longer indexes local paths sent as URLs, never indexes files without a supported extension, and only deletes files that Duct stored in its Library.
- `POST /api/watch` only accepts folders under `--watch-root`; the desktop app picks folders with the native dialog instead.
- URLs that resolve to private, loopback or link-local addresses are refused by `duct serve`, including after redirects.
- LLM answers are escaped before display, and API keys are never written to disk.
- Browsers log in to a token-protected server once (`POST /api/login`, HttpOnly cookie).

### Added
- Page numbers: PDF and PPTX chunks record their page or slide. Results show "p. 47", with **Open at p. 47** (browser viewer or the desktop PDF window) and **Show in folder** in the desktop app.
- Highlighted snippets around each match.
- Live indexing progress (`duct.activity()`, `GET /api/activity`) in the dashboard and mascot.
- **Run OCR** button for files with no text (`POST /api/ocr`), and a watched-folders list with remove buttons (`GET`/`DELETE /api/sources`).
- A per-viewer switch to hide the mascot.
- Team server: `duct serve --watch <dir>` watches a shared folder from startup, `--rescan <minutes>` catches changes that network drives don't report, and `--member-token` gives colleagues search, open and upload access without admin rights.
- SQLite index (`duct.db`): loads instantly, saves incrementally, and skips unchanged files (timestamp, size, content hash). Older JSON indexes are migrated automatically.
- Remembered watched folders: `restoreSources()`, `listSources()`, `removeSource()`. Changes made while Duct was closed are caught up on, and deleted or moved files leave the index.
- The Library: uploads and "Add Files" are kept in `~/Duct Library` under their real names; identical files are reported as duplicates. Use `addToLibrary` from `@docfide/duct/library` and `--library <dir>`.
- Documents have `displayName`, `source` and `status` (`indexed`, `no-text`, `failed`), shown in the web UI.
- Mascot animations in the web UI and desktop app, plus new app and tray icons (`npm run icons`).
- `embed: false` / `--no-embed` disable embeddings; `EmbeddingProvider.embedQuery` for query-specific embeddings (Cohere).

### Changed
- The CLI keeps one index in `$DUCT_HOME` or `~/.duct`, so `duct index` then `duct search` works across runs.
- Keyword search uses FTS5: stemming ("terminate" finds "termination"), accent-insensitive matching, quoted phrases, and Chinese, Japanese and Korean text. Metadata filters apply before results are limited.
- OCR is optional and offline: images and scanned PDFs are flagged `needsOcr` unless OCR is on, and the English model is bundled. Single-page scans are now detected.
- PDF text keeps its line breaks and whole words. Detected tables are no longer appended as a second copy.
- Changing the embedding model re-embeds in the background instead of mixing vectors from different models. Gemini embeddings are batched.
- Requires Node.js 22.13 or later.

### Fixed
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
