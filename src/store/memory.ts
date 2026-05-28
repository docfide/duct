import { readFileSync, writeFileSync } from 'node:fs'
import type { Chunk, SearchResult, VectorStore } from '../types.js'

interface Entry {
  chunk: Chunk
  embedding: number[]
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0; let na = 0; let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

export class MemoryVectorStore implements VectorStore {
  private entries: Entry[] = []

  async add(chunks: Chunk[], embeddings: number[][]): Promise<void> {
    for (let i = 0; i < chunks.length; i++) {
      this.entries.push({ chunk: chunks[i], embedding: embeddings[i] })
    }
  }

  async search(query: number[], topK = 10): Promise<SearchResult[]> {
    const scored = this.entries.map(e => ({ chunk: e.chunk, score: cosineSimilarity(query, e.embedding) }))
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK)
  }

  async remove(documentPath: string): Promise<void> {
    this.entries = this.entries.filter(e => e.chunk.documentPath !== documentPath)
  }

  async clear(): Promise<void> {
    this.entries = []
  }

  async save(path: string): Promise<void> {
    writeFileSync(path, JSON.stringify(this.entries))
  }

  async load(path: string): Promise<void> {
    this.entries = JSON.parse(readFileSync(path, 'utf-8'))
  }
}
