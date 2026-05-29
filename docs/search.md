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

| Provider | Default Model | Env Variable |
|----------|---------------|--------------|
| OpenAI | `text-embedding-3-small` | `OPENAI_API_KEY` |
| Gemini | `text-embedding-004` | `GEMINI_API_KEY` |

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

## Re-Ranking

A second-pass re-ranker that scores the top search results using term proximity and exact-match boosting. This improves precision by preferring results where query terms appear close together.

```bash
duct search "indemnification" --rerank
duct search "confidentiality" --search-mode hybrid --rerank
```

The built-in re-ranker (`SimpleReranker`) works without any ML dependencies:
- Exact phrase matches get a boost
- Results where query terms appear closer together rank higher
- Works on top of BM25, vector, or hybrid results

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
