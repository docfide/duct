# Search

Duct supports three search modes that trade off between simplicity and semantic understanding.

## BM25 (Default)

Pure keyword search. No API keys, no external services, fully offline.

BM25 ranks documents by term frequency and inverse document frequency. It works best for:
- Exact term matching ("termination clause", "governing law")
- Short, specific queries
- Legal, technical, and contract documents where precise wording matters

No configuration needed — this is the default when no embedding provider is configured.

## Vector Search

Semantic search using text embeddings. Requires an embedding provider.

```bash
duct search "What are my obligations?" --embed openai
```

| Provider | Default Model | Env Variable | Dimensions | Cost/1M tokens |
|----------|---------------|--------------|------------|----------------|
| OpenAI | `text-embedding-3-small` | `OPENAI_API_KEY` | 1536 | $0.02 |
| Gemini | `text-embedding-004` | `GEMINI_API_KEY` | 768 | $0.006 |
| Cohere | `embed-v4.0` | `COHERE_API_KEY` | 1024 | $0.10 |
| Voyage AI | `voyage-3-large` | `VOYAGE_API_KEY` | 1024 | $0.18 |
| Mistral | `mistral-embed` | `MISTRAL_API_KEY` | 1024 | $0.10 |
| Jina AI | `jina-embeddings-v3` | `JINA_API_KEY` | 1024 | $0.09 |
| Ollama | `nomic-embed-text` | `OLLAMA_HOST` | 768 | Free |
| OpenAI-Compatible | `text-embedding-3-small` | `EMBED_BASE_URL` / `EMBED_API_KEY` | 1536 | Varies |

Chunks are embedded at index time and compared using cosine similarity at search time. Captures semantic meaning even when the query wording doesn't match the document text exactly.

## Hybrid Search

Combines BM25 and vector search using Reciprocal Rank Fusion (RRF), giving you keyword precision + semantic understanding.

```bash
duct search "obligations" --search-mode hybrid --alpha 0.3
```

### Alpha Parameter

Controls the blend between BM25 and vector scores:
- `--alpha 0` → pure BM25
- `--alpha 1` → pure vector
- `--alpha 0.5` → equal weight (default)

```bash
# Bias toward keyword matching
duct search "termination" --search-mode hybrid --alpha 0.2

# Bias toward semantic similarity
duct search "what happens if I breach" --search-mode hybrid --alpha 0.8
```

---

## Scoring

Every search result has a `score` field. The meaning depends on the search mode:

| Mode | Score range | What it measures |
|------|-------------|-----------------|
| BM25 | 0 — unbounded | Term frequency × inverse document frequency, with length normalization. Higher when query terms appear more often in a chunk relative to the corpus. |
| Vector | 0 — 1 | Cosine similarity between the query embedding and the chunk embedding. Higher when the semantic meaning is closer. |
| Hybrid | depends | Reciprocal Rank Fusion (RRF) combines the BM25 and vector rank positions: `score = α × RRF(vector) + (1-α) × RRF(bm25)`. Each RRF is `1 / (rank + 60)`. |

### What affects the score

- **BM25**: Term frequency in the chunk, inverse document frequency across the corpus, chunk length relative to average.
- **Vector**: Semantic overlap between the query and chunk embedding vectors (dot product ÷ magnitudes).
- **Hybrid**: A blend of both, controlled by the `alpha` parameter.

Scores are comparable within a single search, but not across different indexing runs or corpora (BM25 and RRF are corpus-dependent).

---

## Ranking

Results are always returned sorted by score, highest first:

```
[9.42] contract.pdf / Termination
[3.15] nda.pdf / Term
[1.08] policy.md
```

The `Duct.search()` method sorts all results before returning:

```typescript
results.sort((a, b) => b.score - a.score)
return results.slice(0, topK)
```

Ranking is stable — chunks with the same score retain their relative order from the search mode that produced them.

---

## Re-Ranking

A second-pass re-ranker that adjusts scores of the top search results using term proximity and exact-match boosting. This improves precision by preferring results where query terms appear close together or as exact phrases.

```bash
duct search "indemnification" --rerank
duct search "confidentiality" --search-mode hybrid --rerank
```

### How it works

The built-in `SimpleReranker` (`src/search/reranker.ts`) applies post-search score adjustments:

| Signal | Boost | Trigger |
|--------|-------|---------|
| **Exact term match** | `+0.2` per term | Each unique query term found anywhere in the chunk |
| **Exact phrase match** | `+0.4` | The entire query appears verbatim in the chunk |
| **Term proximity** | up to `+0.3` | Two or more query terms found within 500 characters of each other (boost scales inversely with gap) |

The adjusted score is: `original_score × (1 + sum_of_boosts)`. For example, a chunk scoring `5.0` that contains the exact phrase "intellectual property" with both terms close together gets `5.0 × (1 + 0.2 + 0.2 + 0.4 + 0.3) = 10.5`.

### When to use

Re-ranking helps when:
- Queries contain multiple distinct terms that should appear near each other
- Exact phrasing matters ("force majeure" vs. separate appearances of "force" and "majeure")
- You want higher precision without changing the underlying search mode

It adds negligible latency (pure JS, no network calls) and works on top of BM25, vector, or hybrid results.

### Configuration

```typescript
// Enable reranking in the library
const duct = new Duct({ search: { rerank: true } })

// CLI
duct search "confidentiality" --rerank

// API (via config)
curl -X PUT http://localhost:3456/api/config \
  -H "Content-Type: application/json" \
  -d '{"rerank": true}'
```

The re-ranker weights are not currently configurable from the CLI or config — they are hardcoded at `proximityWeight: 0.3` and `exactMatchBoost: 0.2`. If you need custom weights, implement the `Reranker` interface and set it on the `Duct` instance.

## HyDE (Hypothetical Document Embeddings)

Query expansion technique that generates a hypothetical answer before searching, then uses that as the search query. This bridges the gap between short questions and the language used in documents.

```bash
duct search "Can they terminate me?" --hyde
duct ask "What happens if I breach?" --hyde
```

Requires an LLM provider (Ollama, OpenAI, or Gemini). Best for:
- Short, conversational queries
- Questions that don't use the terminology found in the documents
- Improving recall for under-specified queries

## JSON Output

All search commands accept `--json` for machine-readable output:

```bash
duct search "termination" --json | jq '.[].score'
duct ask "What are the clauses?" --json > results.json
```
