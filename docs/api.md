# REST API Reference

All endpoints are prefixed with `/api`. When auth is configured (`--auth-token` or `DUCT_AUTH_TOKEN`), include `Authorization: Bearer <token>` in all requests.

Rate limit: 120 requests per minute.

---

## `POST /api/index`

Upload files or index a URL.

**Multipart form (files):**
```
POST /api/index
Content-Type: multipart/form-data
files: report.pdf, contract.docx
```

**URL:**
```json
POST /api/index
Content-Type: application/json
{ "url": "https://example.com/docs" }
```

**Response:**
```json
{
  "results": [
    { "file": "report.pdf", "documents": 1, "chunks": 12, "time": 345 }
  ]
}
```

---

## `GET /api/search`

Search indexed documents.

```
GET /api/search?q=termination+clause&topK=10
```

| Param | Description |
|-------|-------------|
| `q` | Search query (required) |
| `topK` | Number of results (default: 10) |
| `mode` | Search mode override |

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
        "index": 3
      }
    }
  ]
}
```

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

List all indexed documents with their store paths.

```
GET /api/documents
```

**Response:**
```json
{
  "documents": [
    { "path": "report.pdf", "format": "pdf", "chunkCount": 12, "storePath": "/tmp/...", "indexedAt": 1748530000 }
  ]
}
```

---

## `DELETE /api/documents`

Remove a specific document from the index.

```
DELETE /api/documents?path=/tmp/.duct-uploads/1234.pdf
```

Use `storePath` from `GET /api/documents` as the path value.

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
  "llmBaseUrl": "http://localhost:11434"
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

Available fields: `ocr`, `chunkStrategy`, `chunkSize`, `chunkOverlap`, `searchMode`, `searchAlpha`, `rerank`, `hyde`, `llmProvider`, `llmModel`, `llmBaseUrl`, `openaiKey`, `geminiKey`.

API keys are applied to the runtime environment — they are not persisted to disk.

---

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

Export search results in JSON or CSV format.

```
GET /api/export?q=termination&format=csv
GET /api/export?q=indemnification&format=json
```

| Param | Description |
|-------|-------------|
| `q` | Search query (required) |
| `format` | `json` (default) or `csv` |

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

New and modified files are automatically indexed.

---

## `POST /api/unwatch`

Stop watching all directories.

```
POST /api/unwatch
```

**Response:** `{ "ok": true }`
