import type { SearchResult, Reranker } from '../types.js'

export class SimpleReranker implements Reranker {
  private proximityWeight: number
  private exactMatchBoost: number

  constructor(proximityWeight = 0.3, exactMatchBoost = 0.2) {
    this.proximityWeight = proximityWeight
    this.exactMatchBoost = exactMatchBoost
  }

  async rerank(query: string, results: SearchResult[], topK: number): Promise<SearchResult[]> {
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1)
    if (queryTerms.length === 0) return results.slice(0, topK)

    const scored = results.map(r => {
      const content = r.chunk.content.toLowerCase()
      let extra = 0

      const positions: number[] = []
      for (const term of queryTerms) {
        let idx = 0
        while ((idx = content.indexOf(term, idx)) !== -1) {
          positions.push(idx)
          idx += 1
        }
        if (content.includes(term)) {
          extra += this.exactMatchBoost
        }
      }

      if (positions.length >= 2) {
        positions.sort((a, b) => a - b)
        let minGap = Infinity
        for (let i = 1; i < positions.length; i++) {
          const gap = positions[i] - positions[i - 1]
          if (gap < minGap) minGap = gap
        }
        if (minGap < 500) {
          extra += this.proximityWeight * (1 - minGap / 500)
        }
      }

      const exactPhrase = queryTerms.join(' ')
      if (content.includes(exactPhrase)) {
        extra += this.exactMatchBoost * 2
      }

      return { ...r, score: r.score * (1 + extra) }
    })

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK)
  }
}

export class NoopReranker implements Reranker {
  async rerank(_query: string, results: SearchResult[], topK: number): Promise<SearchResult[]> {
    return results.slice(0, topK)
  }
}
