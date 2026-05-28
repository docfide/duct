import { readFileSync, writeFileSync } from 'node:fs'
import type { Chunk, SearchResult, Searcher } from '../types.js'

interface IndexedChunk {
  chunk: Chunk
  terms: [string, number][]
  length: number
}

export class BM25Searcher implements Searcher {
  private chunks: IndexedChunk[] = []
  private df: Map<string, number> = new Map()
  private totalDocs = 0
  private totalLength = 0
  private k1 = 1.5
  private b = 0.75

  async add(newChunks: Chunk[]): Promise<void> {
    for (const chunk of newChunks) {
      const terms = tokenize(chunk.content)
      const freq = new Map<string, number>()
      for (const term of terms) {
        freq.set(term, (freq.get(term) || 0) + 1)
      }
      for (const term of freq.keys()) {
        this.df.set(term, (this.df.get(term) || 0) + 1)
      }
      this.chunks.push({ chunk, terms: [...freq.entries()], length: terms.length })
      this.totalLength += terms.length
    }
    this.totalDocs += newChunks.length
  }

  async search(query: string, topK = 10): Promise<SearchResult[]> {
    const queryTerms = [...new Set(tokenize(query))]
    const avgdl = this.totalDocs > 0 ? this.totalLength / this.totalDocs : 1
    const scores: { chunk: Chunk; score: number }[] = []

    for (const entry of this.chunks) {
      let score = 0
      const termMap = new Map(entry.terms)
      for (const term of queryTerms) {
        const tf = termMap.get(term) || 0
        if (tf === 0) continue
        const df = this.df.get(term) || 0
        const idf = Math.log((this.totalDocs - df + 0.5) / (df + 0.5) + 1)
        const numerator = tf * (this.k1 + 1)
        const denominator = tf + this.k1 * (1 - this.b + this.b * (entry.length / avgdl))
        score += idf * (numerator / denominator)
      }
      if (score > 0) {
        scores.push({ chunk: entry.chunk, score })
      }
    }

    scores.sort((a, b) => b.score - a.score)
    return scores.slice(0, topK).map(s => ({ chunk: s.chunk, score: s.score }))
  }

  async remove(documentPath: string): Promise<void> {
    this.chunks = this.chunks.filter(entry => {
      if (entry.chunk.documentPath === documentPath) {
        this.totalLength -= entry.length
        return false
      }
      return true
    })
    this.totalDocs = this.chunks.length
    this.df = new Map()
    for (const entry of this.chunks) {
      const seen = new Set(entry.terms.map(t => t[0]))
      for (const term of seen) {
        this.df.set(term, (this.df.get(term) || 0) + 1)
      }
    }
  }

  async clear(): Promise<void> {
    this.chunks = []
    this.df = new Map()
    this.totalDocs = 0
    this.totalLength = 0
  }

  async save(path: string): Promise<void> {
    const data = { chunks: this.chunks, df: [...this.df.entries()], totalDocs: this.totalDocs, totalLength: this.totalLength }
    writeFileSync(path, JSON.stringify(data))
  }

  async load(path: string): Promise<void> {
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    this.chunks = data.chunks
    this.df = new Map(data.df)
    this.totalDocs = data.totalDocs
    this.totalLength = data.totalLength
  }
}

function tokenize(text: string): string[] {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return []
  return cleaned.split(' ').filter(t => t.length > 1 && t.length < 50)
}
