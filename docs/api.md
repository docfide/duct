# REST API Reference

All endpoints are prefixed with `/api`. When auth is configured (`--auth-token` or `DUCT_AUTH_TOKEN`), include `Authorization: Bearer <token>` in all requests. Browsers can instead `POST /api/login` with `{"token": "..."}` to receive an HttpOnly cookie.

With `--member-token`, members can't call admin endpoints (`PUT /api/config`, `DELETE /api/documents`, `DELETE /api/clear`, `POST /api/watch`, `POST /api/unwatch`, `DELETE /api/sources`); those return `403`. `GET /api/me` returns the caller's `role`.

Requests must use a `Host` of `localhost`, `127.0.0.1` or `::1` unless the server was started with `--host`/`--allowed-host`. Cross-origin writes (a non-GET request whose `Origin` differs from `Host`) are rejected with `403`.

Rate limit: 120 requests per minute.

---

## `POST /api/index`

Upload files or index a URL.

**Multipart form (files):**
```
POST /api/index
Content-Type: multipart/form-data
files: report.pdf, contract.docx
metadata: {"tenant_id":"acme","category":"legal"}
```

**URL with metadata:**
```json
POST /api/index
Content-Type: application/json
{
  "url": "https://example.com/docs",
  "metadata": { "tenant_id": "acme", "category": "legal" }
}
```

**Response:**
```json
{
  "results": [
    { "file": "report.pdf", "documents": 1, "chunks": 12, "time": 345 }
  ]
}
```

Metadata is propagated to every chunk of the indexed document and can be used as a search filter (see `GET /api/search`). Values must be JSON-serializable.

---

## `GET /api/search`

Each result has `chunk.page` (PDF page or PPTX slide, when known) and `snippet`, an excerpt with matches wrapped in `\u0002` … `\u0003`.


Search indexed documents.

```
GET /api/search?q=termination+clause&topK=10
GET /api/search?q=indemnification&filter={"tenant_id":"acme"}
```

| Param | Type | Description |
|-------|------|-------------|
| `q` | string | Search query (required) |
| `topK` | number | Number of results (default: 10) |
| `filter` | string | URL-encoded JSON object — only return chunks whose metadata matches all key/value pairs exactly |
| `formats` | string | Comma-separated formats, e.g. `pdf,docx` |
| `under` | string | Only documents in this folder |
| `tag` | string | Only documents with this tag; repeat for several (all must match) |
| `after`, `before` | number | Only documents modified at or after / before this time (ms since 1970) |

Numbers match however they were written: `1200`, `1,200`, `1 200` and `1,200.00` find each other.

**Example with filter:**
```
GET /api/search?q=policy&filter=%7B%22tenant_id%22%3A%22acme%22%2C%22category%22%3A%22hr%22%7D
```
This searches for "policy" among documents where `tenant_id === "acme"` and `category === "hr"`.

**Response:**
```json
{
  "results": [
    {
      "score": 8.42,
      "chunk": {
        "id": "abc123",
        "documentPath": "contract.pdf",
        "content": "The term of this Agreement shall commence...",
        "heading": "Term and Termination",
        "index": 3,
        "metadata": { "tenant_id": "acme", "category": "legal" }
      },
      "why": { "words": ["Termination", "terminate"], "fileName": false }
    }
  ]
}
```

`why` says why a result matched: `words` are the matched words as written in the passage (which can be another form of what was typed), `fileName` is true when the file name contains every searched word, and `meaning` when search by meaning found it.

When nothing matches, the response also has `help`, so an empty search is never a dead end:

```json
{
  "results": [],
  "help": {
    "documents": 1420, "needsOcr": 41, "failed": 3, "passwordProtected": 2,
    "indexing": null, "outsideFilters": 12, "didYouMean": "confidentiality clause"
  }
}
```

| Field | Meaning |
|---|---|
| `documents` | Documents searched |
| `needsOcr` | Scans and images with no text yet |
| `failed`, `passwordProtected` | Files that couldn't be read, and how many of those are locked with a password |
| `indexing` | `{ done, total }` while Duct is still reading files, else `null` |
| `outsideFilters` | Results the same search finds without the filters (up to 100) |
| `didYouMean` | The search with misspelt words replaced by the spelling used in the documents |

---

## `POST /api/ask`

Ask a question and get an AI-generated answer.

```json
POST /api/ask
Content-Type: application/json
{
  "question": "What are the termination clauses?",
  "topK": 5,
  "agentic": false
}
```

| Param | Type | Description |
|-------|------|-------------|
| `question` | string | Your question (required) |
| `topK` | number | Number of source documents (default: 5) |
| `agentic` | boolean | Enable multi-hop agentic search |

**Response:**
```json
{
  "answer": "The contract includes a 30-day termination clause...",
  "sources": [
    { "documentPath": "contract.pdf", "score": 9.2, "content": "...", "heading": "Termination" }
  ],
  "time": 1523
}
```

---

## `GET /api/documents`

List all indexed documents, or get a single document's metadata.

```
GET /api/documents              # list all
GET /api/documents?path=/tmp/... # get single document
```

**Response (list):**
```json
{
  "documents": [
    {
      "path": "report.pdf",
      "format": "pdf",
      "chunkCount": 12,
      "storePath": "/tmp/...",
      "indexedAt": 1748530000,
      "metadata": { "tenant_id": "acme", "category": "legal" }
    }
  ]
}
```

**Response (single — returns `document` object instead of `documents` array):**
```json
{
  "document": {
    "path": "report.pdf",
    "format": "pdf",
    "chunkCount": 12,
    "storePath": "/tmp/...",
    "indexedAt": 1748530000,
    "metadata": { "tenant_id": "acme", "category": "legal" }
  }
}
```

Use `storePath` for `DELETE /api/documents` and `GET /api/diff` requests.

---

## `DELETE /api/documents`

Remove a specific document from the index.

```
DELETE /api/documents?path=/tmp/.duct-uploads/1234.pdf
```

Use `storePath` from `GET /api/documents` as the path value.

---

## `GET /api/file/:name?path=…`

Opens an indexed document. PDFs, images and plain-text files are served inline, so `…#page=12` opens a PDF at that page in the browser's viewer; other types download. `:name` is optional and only sets the viewer's title. Paths that aren't in the index return `404`.

---

## `POST /api/ocr`

Runs OCR on one indexed document now, for files indexed with status `no-text` (scans and images).

```json
POST /api/ocr
{ "path": "/Users/me/Duct Library/receipt.png" }
```

Returns the index result plus the updated `document`.

---

## `GET /api/activity`

Indexing progress: `{ "indexing": true, "done": 12, "total": 480, "current": "report.pdf", "embedding": false }`.

---

## `GET /api/sources` / `DELETE /api/sources?path=…`

Lists watched folders (`{ sources: [{ path, kind }], canAdd }`) or stops watching one and removes its documents from the index. Files on disk are not touched.

---

## `GET /api/config`

Get the current runtime configuration.

```
GET /api/config
```

**Response:**
```json
{
  "ocr": false,
  "chunkStrategy": "sliding-window",
  "chunkSize": 1500,
  "chunkOverlap": 200,
  "searchMode": "bm25",
  "searchAlpha": 0.5,
  "rerank": false,
  "hyde": false,
  "llmProvider": "ollama",
  "llmModel": "llama3.2",
  "llmBaseUrl": "http://localhost:11434",
  "embedProvider": "openai",
  "embedModel": "text-embedding-3-small",
  "embedBaseUrl": ""
}
```

---

## `PUT /api/config`

Update runtime configuration. Only provided fields are changed — omitted fields keep their current values.

```json
PUT /api/config
Content-Type: application/json
{
  "searchMode": "hybrid",
  "searchAlpha": 0.3,
  "rerank": true,
  "llmProvider": "openai",
  "llmModel": "gpt-4o",
  "openaiKey": "sk-..."
}
```

Available fields: `ocr`, `chunkStrategy`, `chunkSize`, `chunkOverlap`, `searchMode`, `searchAlpha`, `rerank`, `hyde`, `llmProvider`, `llmModel`, `llmBaseUrl`, `embedProvider`, `embedModel`, `embedBaseUrl`, `openaiKey`, `geminiKey`, `cohereKey`, `voyageKey`, `mistralKey`, `jinaKey`.

API keys are applied to the runtime environment — they are not persisted to disk.

---

## `GET /api/features` / `PUT /api/features`

Which features are switched on. Everything is on by default; `PUT` (admin only) switches some off and saves the change with the index.

```bash
curl -X PUT localhost:3456/api/features -H 'Content-Type: application/json' \
  -d '{"ask": false, "webPages": false, "formats": {"image": false, "archive": false}}'
```

| Name | When off |
|------|----------|
| `ask` | `POST /api/ask` answers 403 |
| `semanticSearch` | no embeddings are made or used; search is keyword-only |
| `schemaExtraction` | `POST /api/extract` answers 403 |
| `fileNameSearch` | file names are no longer matched |
| `webPages` | `POST /api/index` with a `url` answers 403 |
| `uploads` | file uploads to `POST /api/index` answer 403 |
| `watchedFolders` | watching pauses (folders are remembered); `POST /api/watch` answers 403 |
| `ocrOnDemand` | `POST /api/ocr` answers 403 |
| `export` | `GET /api/export` answers 403 |
| `diff` | `GET /api/diff` answers 403 |
| `developerApi` | every [`/v1` route](developer-api.md) answers 403 |
| `formats.<family>` | files of that family (`document`, `spreadsheet`, `presentation`, `ebook`, `email`, `text`, `code`, `image`, `archive`) are skipped when indexing and hidden from search |

A refused request answers `403 {"error": "…", "feature": "ask"}`. `GET /api/info` also carries `features`.

## `GET /api/account`, `POST /api/account/signin`, `POST /api/account/signout`

Sign in with Tensflare. `signin` (admin) opens the sign-in page in the browser of the machine running Duct and returns `202`; poll `GET /api/account` for `{ signedIn, email, plan, entitlements, expiresAt, signingIn, signInError }`.

## `GET /api/telemetry` / `PUT /api/telemetry`

Usage-count status and the exact report that would be sent. `PUT { "enabled": true | false }` (admin).

## `GET /api/stats`

Get document and chunk counts.

```
GET /api/stats
```

**Response:**
```json
{ "documents": 15, "chunks": 142 }
```

---

## `DELETE /api/clear`

Remove all indexed data.

```
DELETE /api/clear
```

**Response:** `{ "ok": true }`

---

## `GET /api/export`

Exports search results with their sources: document, page or slide, section, passage, path and tags.

```
GET /api/export?q=termination&format=docx
GET /api/export?q=invoice+4471&format=csv&tag=fy2025
```

| Param | Description |
|-------|-------------|
| `q` | Search query (required) |
| `format` | `csv` (default; UTF-8 for Excel, and cells that look like formulas are made safe), `docx` (Word), `md` or `json` |
| `topK` | Up to 500 results (default 100) |
| others | The same scope parameters as `/api/search` |

## `POST /api/export`

Exports passages picked by hand (the app's **Collect**), in the order given. Only documents in the index can be named.

```json
{ "format": "docx", "title": "Termination clauses", "items": [{ "path": "/docs/msa.pdf", "page": 4, "text": "Either party may…" }] }
```

## Notebooks

Named collections of quotes picked from documents, each kept with its document, page and your own comment. The app's **Workspace** (`/workspace?left=<path>&right=<path>&notebook=<id>`) shows two documents side by side and adds the selected text to a notebook.

Without sign-in (the desktop app, a token-only server) notebooks belong to everyone using Duct. On a server with sign-in, a notebook belongs to the person who made it (`owner`) and is private until they share it. Each notebook in a response carries the caller's `role`: `owner` (rename, share, delete), `edit` (add, comment, reorder, delete notes) or `view` (read and export). Notebooks the caller can't see answer 404. Notes quoting documents the caller can't open are left out of everything, even in a notebook shared with them. Notebooks made before sharing existed have no owner and stay everyone's to edit; admins manage them.

| Route | |
|-------|---|
| `GET /api/notebooks` | `{ notebooks, sharing, me }`: the notebooks the caller can see, with note counts and `role`, most recently changed first. `sharing` says whether this server can share with people; `me` is the signed-in email |
| `POST /api/notebooks` | `{ "name" }` → `201 { notebook }`, owned by the signed-in person |
| `PUT /api/notebooks/:id/sharing` | Owner only, on a server with sign-in. `{ "sharing": [{ "to": "ada@okafor.ng" \| "okafor.ng" \| "anyone", "can": "view" \| "edit" }] }` replaces the list |
| `POST /api/notebooks/import` | `{ "content": "<text of a shared .html page or a JSON export>" }` → `201 { notebook }`. Notes are matched by document name to documents the caller can open; others keep their name and quote |
| `PATCH /api/notebooks/:id` | `{ "name" }` renames |
| `DELETE /api/notebooks/:id` | Deletes the notebook and its notes |
| `GET /api/notebooks/:id/notes` | `{ notebook, notes }` in order |
| `POST /api/notebooks/:id/notes` | `{ "path", "quote", "page"?, "comment"? }`: adds to the end. `path` must be an indexed document; `quote` is kept as written (up to 20,000 characters) |
| `PUT /api/notebooks/:id/order` | `{ "ids": [...] }` sets the order of the notes |
| `PATCH /api/notes/:id` | `{ "comment" }` |
| `DELETE /api/notes/:id` | |
| `GET /api/notebooks/:id/export?format=docx` | The notebook as `docx` (default), `md`, `csv`, `json`, or `html`: a self-contained page to send to anyone (no scripts, no file paths) that Duct can import. Needs the `export` feature |
| `GET /api/document-text?path=…` | A document as `{ name, format, pageLabel, sections: [{ title, text, page? }] }`: the text the workspace shows for formats the browser can't draw itself |

## `GET /api/tags` / `PUT /api/documents/tags`

`GET` lists every tag with its document count. `PUT { "path", "tags": [...] }` replaces a document's tags (members may tag). Tags are kept when a document is re-indexed. Documents in `/api/documents` carry `tags` and `modifiedAt`.

---

## `GET /api/diff`

Get line-level changes between the last two indexed versions of a document.

```
GET /api/diff?path=/tmp/.duct-uploads/1234.pdf
```

**Response:**
```json
{
  "diff": {
    "path": "contract.pdf",
    "versionA": 1,
    "versionB": 2,
    "additions": ["New clause: ..."],
    "removals": ["Old clause: ..."],
    "changes": []
  }
}
```

---

## `POST /api/extract`

Extract structured data fields from indexed documents using an LLM.

```json
POST /api/extract
Content-Type: application/json
{
  "fields": [
    { "name": "invoice_date", "type": "date", "description": "Invoice issue date" },
    { "name": "total", "type": "number", "description": "Total amount" }
  ],
  "paths": ["/path/to/doc.pdf"]
}
```

| Param | Description |
|-------|-------------|
| `fields` | Array of `{ name, type, description }` (required) |
| `paths` | Optional — restrict extraction to specific document paths |

**Response:**
```json
{
  "results": [
    {
      "path": "invoice.pdf",
      "fields": { "invoice_date": "2024-01-15", "total": 1500.00 }
    }
  ]
}
```

---

## `POST /api/watch`

Start watching directories for file changes.

```json
POST /api/watch
Content-Type: application/json
{
  "directories": ["./docs", "./contracts"]
}
```

New and modified files are automatically indexed. Directories must be inside a root given with `duct serve --watch-root <dir>`; otherwise the request is rejected with `403`.

---

## `POST /api/unwatch`

Stop watching all directories.

```
POST /api/unwatch
```

**Response:** `{ "ok": true }`


## `GET /api/ledger`

The privacy ledger (admin): every connection this Duct process made to another computer, recorded locally.

```
GET /api/ledger?days=7
```

```json
{
  "recording": true,
  "since": "2026-10-08T09:00:00.000Z",
  "days": [{ "day": "2026-10-08", "hosts": [{ "host": "api.openai.com", "category": "ai", "requests": 12, "bytesOut": 48211, "lastAt": 1791450000000 }] }],
  "recent": [{ "at": 1791450000000, "host": "telemetry.tensflare.com", "category": "tensflare", "method": "POST", "path": "/v1/duct/report", "bytesOut": 612 }],
  "labels": { "tensflare": "Tensflare (account, usage counts, feedback, hosted AI)", "ai": "AI provider you chose" }
}
```

Categories: `tensflare`, `ai`, `cloud`, `signin`, `web`. Paths are kept only for Tensflare's own endpoints, since other paths can name files. Requests to this computer itself aren't recorded. `DELETE /api/ledger` clears it.


## `GET /api/discover`

A first look at the library, worked out on this computer from each document's name and opening text (the newest 5,000 documents).

```json
{
  "documents": 193,
  "kinds": [{ "id": "invoice", "label": "invoices", "one": "invoice", "count": 60 }, { "id": "contract", "label": "contracts", "one": "contract", "count": 25 }],
  "suggestions": ["amount due", "Okafor", "payment terms", "Lagos"]
}
```

Kinds: `invoice`, `receipt`, `statement`, `cv`, `contract`, `proposal`, `minutes`, `policy`, `letter`, `report`, and by format `slides`, `sheets`, `email`, `scans`. A document counts once. Every suggestion finds at least one result.


## `POST /api/whatsapp`

Adds a chat exported with WhatsApp's **Export chat** (with media): multipart field `file`, the `.zip` (or the chat `.txt` alone). It's stored in the Library under `WhatsApp/<chat>/`, replacing an earlier import of the same chat.

```json
{ "chat": "Okafor Holdings", "messages": 412, "attachments": 23, "skipped": 9, "dir": "/Users/ada/Duct Library/WhatsApp/Okafor Holdings" }
```

The conversation is one document with a section per day. Each attachment has the metadata `whatsappChat`, `whatsappSender` and `whatsappSentAt` (ISO time), its display name is `<file> · from <sender>`, and its modified time is when it was sent. `skipped` counts files Duct doesn't read (voice notes, stickers). The size limit is 1 GB or `--upload-limit`, whichever is larger.


## `GET /api/deadlines`

The deadlines radar: dates documents say something expires, is due or renews on, read on this computer from the words before each date ("expires on", "due by", "no later than", "renews"); dates after "dated", "signed", "issued" and similar are left out. `?days=365` (how far ahead) and `?pastDays=30`.

```json
{
  "passed": [{ "path": "/docs/INV-2041.pdf", "name": "INV-2041.pdf", "format": "pdf", "page": 1, "date": "2026-10-02", "kind": "due", "text": "Amount due by \u000202/10/2026\u0003." }],
  "soon": [{ "name": "Ikoyi office lease.docx", "date": "2026-10-20", "kind": "expires", "text": "This lease expires on \u000220 October 2026\u0003." }],
  "later": []
}
```

`kind` is `expires`, `due` or `renews`. `soon` is the next 30 days; one entry per document, date and kind. Off when the `deadlines` feature is switched off (403).


## `PUT /api/connectors/:id/visibility`

Who sees a cloud source's results on a shared server (admin).

```json
{ "visibility": "custom", "allow": ["ada@okafor.ng", "okafor.ng"] }
```

`visibility` can be:
- `source`: whoever each file is shared with at the source, plus the person who connected it. Not for S3.
- `everyone`: everyone who can use the server.
- `custom`: the email addresses and domains in `allow`.

It applies at once to what's already indexed. Searches, lists and file routes then leave out documents the signed-in person isn't allowed to see.
