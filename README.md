# Duct

**Extract, chunk, embed, and search any document format — in one command.**

Duct is an open-source document intelligence pipeline. Point it at a PDF, DOCX, Markdown file (or a whole directory), and it extracts the text, splits it into searchable chunks, and lets you query them instantly. Works with or without AI embeddings.

```bash
npx duct index ./contracts/
npx duct search "termination clauses"
npx duct serve   # starts a web UI at http://localhost:3456
```

## Why Duct?

Every team deals with documents — contracts, reports, specs, proposals. Extracting text and making it searchable should be a trivially simple CLI command, not a multi-dependency RAG project. Duct is that command.

- **No API keys required** — built-in keyword search (BM25) works out of the box
- **AI-powered search** — bring your own OpenAI or Gemini key for semantic vector search
- **Any format** — PDF, DOCX, Markdown, HTML, plain text
- **Web UI included** — `duct serve` starts a full demo server with drag-and-drop upload
- **Pipeline as code** — use the library directly in your Node.js/TypeScript projects

## Install

```bash
npm install -g duct
```

Or use directly with `npx`:

```bash
npx duct index ./docs
```

## Usage

### CLI

**Index documents**

```bash
# Single file
duct index ./report.pdf

# Multiple files
duct index ./contract.docx ./terms.md ./policy.html

# Entire directory (recursive)
duct index ./documents/

# With options
duct index ./docs --strategy by-heading --embed openai
```

**Search**

```bash
duct search "payment terms"
duct search "indemnification clause" --top-k 20
```

**Web UI**

```bash
duct serve
# → http://localhost:3456
```

Start the server, open the browser, drag-and-drop documents, and search.

**Options**

| Flag | Description |
|------|-------------|
| `--strategy` | Chunking strategy: `sliding-window` (default) or `by-heading` |
| `--chunk-size` | Chunk size in characters (default: 1500) |
| `--chunk-overlap` | Chunk overlap in characters (default: 200) |
| `--embed` | Embedding provider: `openai` or `gemini` |
| `--no-embed` | Skip embeddings, use BM25 keyword search |
| `--port` | Server port (default: 3456) |
| `--top-k` | Number of search results (default: 10) |

### Library

```typescript
import { Duct } from 'duct'

const duct = new Duct({
  embed: { provider: 'openai' },          // optional — falls back to BM25
  chunk: { strategy: 'by-heading' },       // optional
})

// Index files or directories
await duct.index('./report.pdf')
await duct.index(['./doc1.docx', './doc2.md'])

// Search
const results = await duct.search('termination clause')
for (const r of results) {
  console.log(r.chunk.content, r.score)
}

// Stats
console.log(duct.stats())
```

### Environment

| Variable | Required For |
|----------|--------------|
| `OPENAI_API_KEY` | OpenAI embeddings (`text-embedding-3-small` / `3-large`) |
| `GEMINI_API_KEY` | Google Gemini embeddings (`text-embedding-004`) |

Without any API key, Duct uses BM25 keyword search — still works, just no semantic understanding.

## API

### `duct serve` endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/index` | Upload files (multipart form, field: `files`) |
| `GET` | `/api/search?q=...` | Search indexed documents |
| `GET` | `/api/stats` | Document and chunk counts |
| `DELETE` | `/api/clear` | Remove all indexed data |

## Architecture

```
file.pdf ──┐
file.docx ─┤  extract() → chunk() → embed() → store() → search()
file.md ───┤           │          │         │
file.html ─┤        text      chunks   vectors   results
file.txt ──┘           │          │         │
                     pdf-parse  sliding    OpenAI
                     mammoth    window    Gemini
                     marked     by-       BM25
                     cheerio    heading   (built-in)
```

## Deploy

Duct ships with a minimal Dockerfile. Deploy the demo server anywhere:

```bash
docker build -t duct .
docker run -d -p 3456:3456 duct
```

Then point `duct.docfide.com` (or your subdomain) at the host.

For production with embeddings, pass API keys as environment variables:

```bash
docker run -d -p 3456:3456 \
  -e OPENAI_API_KEY=sk-... \
  duct
```

### Deploy with one command (Railway / Fly.io / Render)

```bash
# Railway
railway up

# Fly.io
fly launch --image duct

# Any VPS
scp -r . user@host:/app/duct
ssh user@host "cd /app/duct && docker compose up -d"
```

## License

MIT — see [LICENSE](LICENSE).

---

Built by [Tensflare](https://docfide.com). We build contract software; Duct is our gift to developers who work with documents.
