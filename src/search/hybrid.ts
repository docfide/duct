import type { EmbeddingProvider, SearchResult, Searcher, VectorStore } from '../types.js'

export function reciprocalRankFusion(
  bm25Results: SearchResult[],
  vectorResults: SearchResult[],
  topK: number,
  alpha: number,
): SearchResult[] {
  const seen = new Set<string>()
  const fused = new Map<string, SearchResult>()

  const maxRank = 60

  const addSet = (results: SearchResult[], weight: number) => {
    results.forEach((r, i) => {
      const key = r.chunk.id
      const rank = i + 1
      const rrfScore = weight * (1 / (rank + maxRank))
      if (seen.has(key)) {
        const existing = fused.get(key)!
        existing.score += rrfScore
        // Found both ways: keep the keyword snippet and say it also matched by meaning.
        existing.snippet ??= r.snippet
        existing.why = { words: [...(existing.why?.words ?? []), ...(r.why?.words ?? [])], ...(existing.why?.fileName || r.why?.fileName ? { fileName: true } : {}), ...(existing.why?.meaning || r.why?.meaning ? { meaning: true } : {}) }
      } else {
        seen.add(key)
        fused.set(key, { chunk: r.chunk, score: rrfScore, ...(r.snippet !== undefined ? { snippet: r.snippet } : {}), ...(r.why ? { why: r.why } : {}) })
      }
    })
  }

  addSet(bm25Results, 1 - alpha)
  addSet(vectorResults, alpha)

  const sorted = [...fused.values()].sort((a, b) => b.score - a.score)
  return sorted.slice(0, topK)
}

export class HybridSearcher implements Searcher {
  private bm25: Searcher
  private vectorStore: VectorStore | null
  private alpha: number
  private embedder: EmbeddingProvider | null

  /** Without an embedder (or vector store) this is plain keyword search. */
  constructor(bm25: Searcher, vectorStore: VectorStore | null, alpha = 0.5, embedder: EmbeddingProvider | null = null) {
    this.bm25 = bm25
    this.vectorStore = vectorStore
    this.alpha = alpha
    this.embedder = embedder
  }

  setAlpha(alpha: number): void {
    this.alpha = Math.max(0, Math.min(1, alpha))
  }

  async add(chunks: import('../types.js').Chunk[]): Promise<void> {
    await this.bm25.add(chunks)
  }

  async search(query: string, topK = 10): Promise<SearchResult[]> {
    const bm25Results = await this.bm25.search(query, topK * 3)
    if (!this.vectorStore || !this.embedder) return bm25Results.slice(0, topK)

    const [queryEmb] = await this.embedder.embed([query])
    const vectorResults = await this.vectorStore.search(queryEmb, topK * 3)
    return reciprocalRankFusion(bm25Results, vectorResults, topK, this.alpha)
  }

  async clear(): Promise<void> {
    await this.bm25.clear()
  }

  async remove(documentPath: string): Promise<void> {
    await this.bm25.remove(documentPath)
  }

  async save(path: string): Promise<void> {
    await this.bm25.save(path)
  }

  async load(path: string): Promise<void> {
    await this.bm25.load(path)
  }
}
