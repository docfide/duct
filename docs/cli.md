# CLI Reference

## `duct index`

Index files, directories, or URLs for search.

```bash
duct index ./report.pdf
duct index ./contract.docx ./terms.md ./policy.html
duct index ./documents/          # recursive
duct index https://example.com/docs
```

| Flag | Description |
|------|-------------|
| `--strategy` | Chunking strategy: `sliding-window` (default) or `by-heading` |
| `--chunk-size` | Chunk size in characters (default: 1500) |
| `--chunk-overlap` | Chunk overlap in characters (default: 200) |
| `--embed` | Embedding provider: `openai`, `gemini`, `cohere`, `voyage`, `mistral`, `jina`, `ollama`, or `openai-compatible` |
| `--no-embed` | Skip embeddings, use BM25 keyword search |
| `--ocr` | Attempt OCR for scanned PDFs and image files |
| `--persist` | Directory for persistent index storage |
| `--search-mode` | Search mode: `bm25`, `vector`, or `hybrid` |
| `--alpha` | Hybrid search alpha — 0 = pure BM25, 1 = pure vector (default: 0.5) |

---

## `duct search`

Search indexed documents.

```bash
duct search "payment terms"
duct search "indemnification clause" --top-k 20
duct search "termination" --search-mode hybrid --alpha 0.3 --rerank --json
```

| Flag | Description |
|------|-------------|
| `-k, --top-k` | Number of results (default: 10) |
| `-i, --index` | Index files in this path before searching |
| `--search-mode` | Search mode: `bm25`, `vector`, or `hybrid` |
| `--alpha` | Hybrid search alpha (default: 0.5) |
| `--rerank` | Enable cross-encoder re-ranking |
| `--hyde` | Enable HyDE query expansion |
| `--embed` | Embedding provider (`openai`, `gemini`, `cohere`, `voyage`, `mistral`, `jina`, `ollama`, `openai-compatible`) |
| `--no-embed` | Skip embeddings |
| `--ocr` | Enable OCR during indexing |
| `--persist` | Persistent index directory |
| `--json` | Output as JSON |

---

## `duct ask`

Ask a question and get an AI-generated answer with citations.

```bash
duct ask "What are the termination clauses?"
duct ask "What is the governing law?" --llm openai --model gpt-4o
duct ask "Summarize the indemnification" --hyde
duct ask "List all parties" --no-answer          # context only, no LLM call
duct ask "Compare all contracts" --multi          # agentic multi-hop search
```

| Flag | Description |
|------|-------------|
| `-k, --top-k` | Number of source documents (default: 5) |
| `-i, --index` | Index files before asking |
| `--persist` | Persistent index directory |
| `--llm` | LLM provider: `ollama`, `openai`, or `gemini` |
| `--model` | LLM model name |
| `--base-url` | LLM base URL (for Ollama or OpenAI-compatible endpoints) |
| `--hyde` | Enable HyDE query expansion |
| `--multi` | Enable agentic multi-hop search (decomposes question into sub-queries) |
| `--no-answer` | Skip LLM call, show retrieved context only |
| `--json` | Output as JSON |

### LLM Providers

| Provider | Default Model | Requires |
|----------|---------------|----------|
| `ollama` | `llama3.2` | Local Ollama server running |
| `openai` | `gpt-4o` | `OPENAI_API_KEY` env var |
| `gemini` | `gemini-2.0-flash` | `GEMINI_API_KEY` env var |

---

## `duct watch`

Watch directories and auto-index new/changed files.

```bash
duct watch ./docs ./contracts
duct watch ./inbox --ocr --embed openai --persist .duct-data
```

| Flag | Description |
|------|-------------|
| `--strategy` | Chunking strategy |
| `--ocr` | Enable OCR |
| `--persist` | Persistent index directory |
| `--embed` | Embedding provider (`openai`, `gemini`, `cohere`, `voyage`, `mistral`, `jina`, `ollama`, `openai-compatible`) |

File changes are picked up via `fs.watch` with recursive mode. Stop with Ctrl+C.

---

## `duct extract`

Extract structured data from documents using an LLM.

```bash
duct extract invoice_date:date:Invoice issue date total:number:Total amount --index ./invoices/
duct extract "party_name:string:Name of the contracting party" "effective_date:date:Contract effective date" --llm openai --json
```

Fields follow the format: `name:type:description`

| Type | Description |
|------|-------------|
| `string` | Free text |
| `number` | Numeric value |
| `date` | Date value |
| `boolean` | True/false |

| Flag | Description |
|------|-------------|
| `-i, --index` | Index path containing documents |
| `--persist` | Persistent index directory |
| `--llm` | LLM provider |
| `--model` | LLM model name |
| `--json` | Output as JSON |

---

## `duct diff`

Show line-level changes between document versions. Re-indexing the same file creates a new version.

```bash
duct diff ./contracts/agreement.pdf
duct diff ./docs/spec.md --persist .duct-data
```

| Flag | Description |
|------|-------------|
| `--persist` | Persistent index directory |

Output shows `+` for added lines and `-` for removed lines since the previous index.

---

## `duct serve`

Start the web server with the full UI (Search, Ask, Upload, Settings tabs).

```bash
duct serve
duct serve --port 8080 --persist .duct-data --auth-token my-secret
duct serve --search-mode hybrid --alpha 0.3 --llm ollama
```

| Flag | Description |
|------|-------------|
| `-p, --port` | Port to listen on (default: 3456) |
| `--strategy` | Chunking strategy |
| `--embed` | Embedding provider (`openai`, `gemini`, `cohere`, `voyage`, `mistral`, `jina`, `ollama`, `openai-compatible`) |
| `--no-embed` | Skip embeddings |
| `--ocr` | Enable OCR |
| `--persist` | Persistent index directory |
| `--auth-token` | Bearer token for API auth (env: `DUCT_AUTH_TOKEN`) |
| `--upload-limit` | Max upload file size in MB (default: 50) |
| `--search-mode` | Search mode: `bm25`, `vector`, or `hybrid` |
| `--alpha` | Hybrid search alpha (default: 0.5) |
| `--llm` | Default LLM provider for Ask tab |

### Rate Limiting

API endpoints are limited to 120 requests per minute.
