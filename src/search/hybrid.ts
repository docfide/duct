import type { SearchResult, Searcher, VectorStore } from '../types.js'

export function reciprocalRankFusion(
  bm25Results: SearchResult[],
  vectorResults: SearchResult[],
  topK: number,
  alpha: number,
): SearchResult[] {
  const seen = new Set<string>()
  const fused = new Map<string, { chunk: SearchResult['chunk']; score: number }>()

  const maxRank = 60

  const addSet = (results: SearchResult[], weight: number) => {
    results.forEach((r, i) => {
      const key = r.chunk.id
      const rank = i + 1
      const rrfScore = weight * (1 / (rank + maxRank))
      if (seen.has(key)) {
        const existing = fused.get(key)!
        existing.score += rrfScore
      } else {
        seen.add(key)
        fused.set(key, { chunk: r.chunk, score: rrfScore })
      }
    })
  }

  addSet(bm25Results, 1 - alpha)
  addSet(vectorResults, alpha)

  const sorted = [...fused.values()].sort((a, b) => b.score - a.score)
  return sorted.slice(0, topK).map(s => ({ chunk: s.chunk, score: s.score }))
}

export class HybridSearcher implements Searcher {
  private bm25: Searcher
  private vectorStore: VectorStore | null
  private alpha: number

  constructor(bm25: Searcher, vectorStore: VectorStore | null, alpha = 0.5) {
    this.bm25 = bm25
    this.vectorStore = vectorStore
    this.alpha = alpha
  }

  setAlpha(alpha: number): void {
    this.alpha = Math.max(0, Math.min(1, alpha))
  }

  async add(chunks: import('../types.js').Chunk[]): Promise<void> {
    await this.bm25.add(chunks)
  }

  async search(query: string, topK = 10): Promise<SearchResult[]> {
    const bm25Results = await this.bm25.search(query, topK * 3)

    if (!this.vectorStore) {
      return bm25Results.slice(0, topK)
    }

    const { OpenAIEmbedder } = await import('../embed/openai.js')
    const { GeminiEmbedder } = await import('../embed/gemini.js')

    let embedder: import('../types.js').EmbeddingProvider | null = null
    if (process.env['OPENAI_API_KEY']) {
      embedder = new OpenAIEmbedder()
    } else if (process.env['GEMINI_API_KEY']) {
      embedder = new GeminiEmbedder()
    }

    if (!embedder) {
      return this.alpha <= 0.5
        ? bm25Results.slice(0, topK)
        : await this.bm25.search(query, topK)
    }

    const [queryEmb] = await embedder.embed([query])
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
