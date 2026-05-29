# Library API

```typescript
import { Duct } from '@docfide/duct'
```

## Constructor

```typescript
const duct = new Duct(options?: DuctConfig)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `chunk.strategy` | `'sliding-window' \| 'by-heading'` | `'sliding-window'` | Chunking strategy |
| `chunk.size` | `number` | `1500` | Chunk size in characters |
| `chunk.overlap` | `number` | `200` | Chunk overlap in characters |
| `embed.provider` | `'openai' \| 'gemini' \| 'cohere' \| 'voyage' \| 'mistral' \| 'jina' \| 'ollama' \| 'openai-compatible'` | — | Embedding provider (omit for BM25 only) |
| `embed.model` | `string` | — | Embedding model override |
| `embed.baseUrl` | `string` | — | Embedding base URL (for `ollama` and `openai-compatible`) |
| `embed.apiKey` | `string` | — | Embedding API key override |
| `llm.provider` | `'ollama' \| 'openai' \| 'gemini'` | — | LLM provider for Q&A |
| `llm.model` | `string` | — | LLM model override |
| `llm.baseUrl` | `string` | — | LLM base URL override |
| `search.mode` | `'bm25' \| 'vector' \| 'hybrid'` | `'bm25'` | Default search mode |
| `search.alpha` | `number` | `0.5` | Hybrid blend (0 = BM25, 1 = vector) |
| `search.rerank` | `boolean` | `false` | Enable re-ranking |
| `search.hyde` | `boolean` | `false` | Enable HyDE query expansion |
| `ocr` | `boolean` | `false` | OCR for scanned PDFs |
| `persistPath` | `string` | — | Directory for persistent index |

### Examples

```typescript
// BM25 only (no API keys needed)
const duct = new Duct()

// With OpenAI embeddings
const duct = new Duct({
  embed: { provider: 'openai' },
})

// Full configuration
const duct = new Duct({
  chunk: { strategy: 'by-heading', size: 1000, overlap: 100 },
  embed: { provider: 'gemini', model: 'text-embedding-004' },
  llm: { provider: 'ollama', model: 'llama3.2', baseUrl: 'http://localhost:11434' },
  search: { mode: 'hybrid', alpha: 0.3, rerank: true, hyde: false },
  ocr: true,
  persistPath: '.duct-data',
})
```

---

## Methods

### `duct.index(paths)`

Index files, directories, or URLs.

```typescript
const result = await duct.index('./report.pdf')
// { documents: 1, chunks: 12, time: 345 }

const result = await duct.index(['./doc1.pdf', './doc2.md'])
// { documents: 2, chunks: 24, time: 678 }

const result = await duct.index('./docs/')     // recursive
const result = await duct.index('https://...') // URL
```

---

### `duct.search(query, topK?)`

Search indexed documents. Returns results sorted by relevance score.

```typescript
const results = await duct.search('termination clause', 10)
// [{ chunk: Chunk, score: number }, ...]

// score is unbounded for BM25 (higher = better match)
// score is cosine similarity (0-1) for vector search
// score is RRF rank for hybrid search
```

---

### `duct.ask(question, topK?)`

Answer a question using the configured LLM with retrieved context. Returns an answer with citations.

```typescript
const result = await duct.ask('What are the termination clauses?', 5)
// {
//   answer: "The contract includes a 30-day notice period...",
//   sources: [{ documentPath: '...', score: 9.2, content: '...', heading: '...' }],
//   time: 1523
// }
```

Throws if no LLM provider is configured.

---

### `duct.agenticSearch(question)`

Multi-hop agentic search — decomposes the question into sub-queries, searches each independently, then synthesizes a final answer.

```typescript
const result = await duct.agenticSearch('Compare the indemnification clauses across all contracts')
```

Best for questions that require synthesizing information from multiple documents or sections. Falls back to a single `duct.ask()` call if the LLM does not return valid sub-queries in JSON format.

---

### `duct.watch(directories, onIndex?)`

Watch directories for file changes and auto-index new/modified files.

```typescript
duct.watch(['./docs', './contracts'], () => {
  const s = duct.stats()
  console.log(`Total: ${s.documents} docs, ${s.chunks} chunks`)
})
```

---

### `duct.unwatch()`

Stop watching all directories.

```typescript
duct.unwatch()
```

---

### `duct.extractSchema(fields, paths?)`

Extract structured fields from indexed documents using the LLM.

```typescript
const results = await duct.extractSchema([
  { name: 'invoice_date', type: 'date', description: 'Invoice issue date' },
  { name: 'total', type: 'number', description: 'Total amount' },
  { name: 'paid', type: 'boolean', description: 'Whether the invoice is paid' },
])
// [{ path: 'invoice.pdf', fields: { invoice_date: '2024-01-15', total: 1500, paid: true } }]
```

---

### `duct.diff(path)`

Get line-level changes between the last two indexed versions of a document.

```typescript
const d = await duct.diff('./contract.pdf')
// {
//   path: 'contract.pdf',
//   versionA: 1,
//   versionB: 2,
//   additions: ['New clause...'],
//   removals: ['Old clause...'],
//   changes: [],
// }
```

Returns `null` if the document only has one version.

---

### `duct.configure(config)`

Update runtime configuration. Only provided fields are changed.

```typescript
duct.configure({
  searchMode: 'hybrid',
  searchAlpha: 0.3,
  rerank: true,
  llmProvider: 'openai',
  openaiKey: 'sk-...',
})
```

Available config fields: `ocr`, `chunkStrategy`, `chunkSize`, `chunkOverlap`, `searchMode`, `searchAlpha`, `rerank`, `hyde`, `llmProvider`, `llmModel`, `llmBaseUrl`, `embedProvider`, `embedModel`, `embedBaseUrl`, `openaiKey`, `geminiKey`, `cohereKey`, `voyageKey`, `mistralKey`, `jinaKey`.

---

### `duct.getConfig()`

Get the current runtime configuration.

```typescript
const config = duct.getConfig()
// RuntimeConfig with all current values
```

---

### `duct.getDocuments()`

Get a list of all indexed documents.

```typescript
const docs = duct.getDocuments()
// [{ path: string, format: DocumentFormat, chunkCount: number, size: number, indexedAt: number }]
```

---

### `duct.removeDocument(path)`

Remove a specific document and its chunks from the index.

```typescript
await duct.removeDocument('/path/to/doc.pdf')
```

---

### `duct.stats()`

Get document and chunk counts.

```typescript
const stats = duct.stats()
// { documents: 15, chunks: 142 }
```

---

### `duct.clear()`

Remove all indexed data.

```typescript
await duct.clear()
```
