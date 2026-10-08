# CLI Reference

## Where the index lives

Every command uses one index on disk, so `duct index ./docs` followed by `duct search "..."` works across runs. It's stored in `$DUCT_HOME`, or `~/.duct` if that isn't set; pass `--persist <dir>` to use another folder. Unchanged files are skipped when you index again.

`duct serve` keeps uploaded files in `~/Duct Library` (change it with `--library <dir>`).

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

Existing files are indexed first. New, changed, renamed and deleted files are picked up via `fs.watch` (recursive), and watched folders are remembered in the index so `duct serve` and the desktop app resume them. Stop with Ctrl+C.

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

## `duct account`

Sign in with Tensflare. Optional: everything local works without an account; paid features need one.

```bash
duct account signin    # opens the sign-in page in your browser
duct account status    # email, plan, and how long paid features work offline
duct account signout
```

The session is kept in `account.json` in the index folder, readable only by you (the desktop app uses the system keychain).

## `duct telemetry`

Anonymous usage counts: a daily report of versions, features and library size in ranges, never document text, file names, paths or searches. They are off unless you turn them on.

```bash
duct telemetry show    # the exact report that would be sent
duct telemetry on
duct telemetry off     # no requests at all
```

`DO_NOT_TRACK=1` or `DUCT_TELEMETRY=0` turn them off whatever the setting, and they never run in CI. `duct serve` and the desktop app send at most one report a day; the command line never sends.

## `duct keys`

API keys for the [developer API](developer-api.md). A key is shown once; only its hash is stored in the index.

```bash
duct keys create --name "website search" --scopes search --collections help
duct keys list
duct keys revoke <id>
```

Scopes are `search`, `write` and `admin`.

## `duct features`

Shows which features are on, or switches them. Changes are saved with the index.

```bash
duct features                               # list
duct features ask=off formats.image=off     # switch off
duct features ask=on
```

See [`/api/features`](api.md#get-apifeatures--put-apifeatures) for what each switch does.

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
| `--host` | Interface to listen on (default: `127.0.0.1`). Any other value requires `--auth-token` |
| `--watch-root` | Directory the API may watch, including subfolders. Repeatable. Without it, `POST /api/watch` is disabled |
| `--allowed-host` | Extra hostname accepted in the `Host` header, e.g. `duct.example.com`. Repeatable |
| `--library` | Folder where uploaded files are kept (default: `~/Duct Library`) |
| `--watch` | Watch this folder from startup, e.g. a mounted shared drive. Repeatable |
| `--rescan` | Minutes between full rescans of watched folders, for network drives where file events are unreliable (default: 15, `0` = off) |
| `--member-token` | Token for team members (repeatable; env `DUCT_MEMBER_TOKENS`, comma-separated). Requires `--auth-token` |

### Security

By default the server only listens on `127.0.0.1` and only accepts requests addressed to `localhost`, `127.0.0.1` or `::1`. To share it on a network, set a token:

```bash
duct serve --host 0.0.0.0 --auth-token "$(openssl rand -hex 24)" --watch-root /srv/shared-docs
```

Browsers are asked for the token once and then get an HttpOnly login cookie. When `serve` is running, URLs that resolve to private, loopback or link-local addresses are never fetched.

### Team server

Index a shared folder once and let colleagues search it from their browsers:

```bash
duct serve --host 0.0.0.0 \
  --auth-token "$ADMIN_TOKEN" \
  --member-token "$TEAM_TOKEN" \
  --watch /mnt/shared/contracts \
  --library /srv/duct-library
```

- **Admins** (`--auth-token`) can do everything.
- **Members** (`--member-token`) can search, ask, open documents, upload to the library and run OCR. They can't change settings, delete documents, clear the index or change watched folders, and the UI hides those controls.
- Everyone who can log in can search everything that's indexed. Duct doesn't apply the share's own file permissions, so only watch folders that the whole team may read.
- Network drives often don't report file changes, so watched folders are also rescanned every `--rescan` minutes.

### Rate Limiting

API endpoints are limited to 120 requests per minute.
