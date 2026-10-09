# Developer API

Add document search to your app. Duct reads PDFs, Office files, email, scans and your own text, and searches them by keyword or meaning. You get page numbers, highlighted snippets, metadata filters and facet counts. It runs on your own servers from one Docker image or `npx`.

The developer API lives at `/v1` and is separate from the `/api` endpoints the Duct app uses. The OpenAPI 3.1 description is at `GET /v1/openapi.json`.

## Quickstart

```bash
# 1. A key for your app (shown once; only its hash is stored)
duct keys create --name "my app" --scopes admin

# 2. Run the server (add --host 0.0.0.0 --auth-token … to serve other machines)
duct serve

export DUCT=http://localhost:3456 KEY=duct_…

# 3. A collection: a separate index, e.g. one per app or per customer
curl -X POST $DUCT/v1/collections -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"name":"help"}'

# 4. Documents under your own ids
curl -X PUT $DUCT/v1/collections/help/documents/refunds -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"title":"Refunds","text":"Refunds are processed within five working days.","metadata":{"lang":"en","product":"store"}}'

# …or files, read like the app reads them (page numbers included)
curl -X POST $DUCT/v1/collections/help/files -H "Authorization: Bearer $KEY" -F file=@terms.pdf -F id=terms -F 'metadata={"lang":"en"}'

# 5. Search
curl "$DUCT/v1/collections/help/search?q=refund&facets=lang" -H "Authorization: Bearer $KEY"
```

```json
{
  "hits": [{
    "id": "refunds", "title": "Refunds", "score": 1.6, "format": "txt",
    "snippet": "Refunds are processed within five working days.",
    "highlight": "<mark>Refunds</mark> are processed within five working days.",
    "metadata": { "lang": "en", "product": "store" }
  }],
  "offset": 0, "limit": 10, "has_more": false,
  "facets": { "lang": { "en": 1 } },
  "took_ms": 1
}
```

## Keys and scopes

| Scope | Allows |
|-------|--------|
| `search` | listing collections and documents, reading documents, searching |
| `write` | everything in `search`, plus adding, replacing and deleting documents and files |
| `admin` | everything, plus creating and deleting collections and managing keys |

A key can be limited to some collections (`--collections a,b`). A limited admin key can only create keys for its own collections. Keys are sent as `Authorization: Bearer duct_…`. The server's `--auth-token` also works, with every scope. Browser cookies are never accepted on `/v1`. Each key is rate limited to 600 requests a minute.

```bash
duct keys create --name "website search" --scopes search --collections help
duct keys list
duct keys revoke <id>
```

Keys can also be managed over the API: `GET/POST /v1/keys`, `DELETE /v1/keys/:id`.

Keep `search` keys on your backend unless the collection is public. `/v1` sends no CORS headers, so browsers can't call it from other sites.

## Collections

Each collection is its own index, stored at `<index>/collections/<name>/`. One collection's documents never appear in another's results, or in the Duct app. Names use lower-case letters, digits, `-` and `_`.

New collections copy the main index's chunking, search mode and embedding settings. You can override `search_mode` (`bm25`, `vector`, `hybrid`) and `ocr` when creating one:

```json
POST /v1/collections
{ "name": "contracts", "settings": { "search_mode": "hybrid", "ocr": true } }
```

`GET /v1/collections/:name` returns counts and indexing activity. `DELETE` removes the collection, its index and its uploaded files.

## Documents

| Request | Does |
|---------|------|
| `PUT /v1/collections/:c/documents/:id` | Add or replace one text document |
| `POST /v1/collections/:c/documents` | Add or replace up to 1000: `{ "documents": [{ "id", … }] }`. Every document is checked first, so a bad one leaves nothing half-indexed |
| `POST /v1/collections/:c/files` | Upload a file (multipart `file`, optional `id`, `title`, `metadata` as JSON). Without an `id` one is made up and returned |
| `GET /v1/collections/:c/documents?limit=&offset=` | List documents, newest first, with `total` |
| `GET /v1/collections/:c/documents/:id[?include=text]` | One document, optionally with its text |
| `DELETE /v1/collections/:c/documents/:id` | Delete it (and its uploaded file) |

A text document is `{ "text": "…" }` or `{ "pages": ["page 1", "page 2"] }` (hits then carry page numbers), plus an optional `title`, `metadata` and `format` (`txt` or `md`). Metadata values must be strings, numbers, booleans or null, so every field can be filtered and counted.

Ids are yours: letters, digits and `. _ : @ -`, up to 200 characters. Sending the same id replaces the document; sending the same content again is skipped (`"status": "unchanged"`). Text is searchable by keyword as soon as the request returns. With an embedding model, search by meaning follows in the background.

Files are limited by `--upload-limit` (50 MB by default). A file that can't be read answers `422` with the document's `error`.

## Search

`GET /v1/collections/:c/search?q=…` or `POST` with a JSON body:

| Field | Default | |
|-------|---------|--|
| `q` | | Words to find. Matches word forms ("terminate" finds "termination") and "quoted phrases". An empty `q` returns facets only |
| `limit`, `offset` | 10, 0 | Up to 100 per page and 1000 results in all. `has_more` says whether there's another page |
| `filter` | | Exact matches on metadata, all of which must match: `{ "client": "acme", "year": 2026 }`. In a GET, a JSON string |
| `facets` | | Metadata fields to count values of among matching documents (top 20 each, at most 10 fields) |
| `formats` | | Only these formats, e.g. `["pdf", "docx"]` |
| `sort` | | `field:asc` or `field:desc` to order matches by a metadata field instead of relevance; documents without the field come last |
| `group` | `document` | `document`: one hit per document, its best passage. `passage`: every matching passage |

Each hit has `id`, `title`, `score`, `format`, `page` and `page_label` (`p. 4`, `slide 2`, `sheet 1`) where the format has pages, `heading` for email attachments and archive entries, `snippet` (plain text), `highlight` (HTML-escaped, matches in `<mark>`), and `metadata`.

How results are found follows the collection's `search_mode`. Keyword search (BM25 on SQLite FTS5) needs nothing else. `hybrid` and `vector` need an embedding provider configured on the server (OpenAI, Gemini, Cohere, Voyage, Mistral, Jina or a local Ollama), and fall back to keywords until vectors exist.

## Clients

**TypeScript** (no dependencies; Node 18+, Deno, Bun, edge runtimes):

```typescript
import { DuctClient } from '@docfide/duct/client'

const duct = new DuctClient({ url: 'https://search.example.com', key: process.env.DUCT_API_KEY! })
await duct.createCollection('help')
await duct.upsertMany('help', [{ id: 'refunds', title: 'Refunds', text: '…', metadata: { lang: 'en' } }])
await duct.uploadFile('help', new Blob([pdfBytes]), { filename: 'terms.pdf', id: 'terms' })
const { hits, facets } = await duct.search('help', { q: 'refund', filter: { lang: 'en' }, facets: ['lang'] })
```

**Python** (standard library only, 3.8+): copy [`clients/python/duct_client.py`](../clients/python/duct_client.py).

```python
from duct_client import DuctClient
duct = DuctClient("https://search.example.com", key=os.environ["DUCT_API_KEY"])
duct.upsert("help", "refunds", title="Refunds", text="...", metadata={"lang": "en"})
duct.upload_file("help", "terms.pdf", id="terms")
hits = duct.search("help", "refund", filter={"lang": "en"})["hits"]
```

Errors are JSON, `{ "error": "message", "code": "document_not_found" }`, raised as `DuctApiError` by both clients.

## Deploying

```bash
docker run -d -p 3456:3456 -v duct-data:/data \
  -e DUCT_AUTH_TOKEN="$(openssl rand -hex 24)" \
  duct serve --host 0.0.0.0 --persist /data/index
docker exec <container> node dist/cli.js keys create --name "my app" --scopes write --persist /data/index
```

Put TLS in front of it (a load balancer or reverse proxy). The developer API can be switched off with `duct features developerApi=off`, which also hides it from the app's Settings.
