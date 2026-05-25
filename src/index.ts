import { existsSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { extract } from './extract/index.js'
import { chunk } from './chunk/index.js'
import { OpenAIEmbedder } from './embed/openai.js'
import { GeminiEmbedder } from './embed/gemini.js'
import { MemoryVectorStore } from './store/memory.js'
import { BM25Searcher } from './search/bm25.js'
import type { DuctConfig, Chunk, EmbeddingProvider, IndexResult, SearchResult, Searcher } from './types.js'

const VALID_EXTS = new Set(['.pdf', '.docx', '.md', '.markdown', '.html', '.htm', '.txt'])

async function findFiles(input: string): Promise<string[]> {
  const st = statSync(input)
  if (st.isFile()) {
    const ext = extname(input).toLowerCase()
    if (ext && !VALID_EXTS.has(ext)) return []
    return [input]
  }
  if (st.isDirectory()) {
    const entries = await readdir(input, { recursive: true, withFileTypes: true })
    return entries
      .filter(e => e.isFile() && VALID_EXTS.has(extname(e.name).toLowerCase()))
      .map(e => join(e.parentPath, e.name))
  }
  return []
}

export class Duct {
  private embedder: EmbeddingProvider | null = null
  private store: MemoryVectorStore
  private searcher: Searcher
  private documents: Set<string> = new Set()
  private chunks: number = 0
  private chunkStrategy: 'sliding-window' | 'by-heading'
  private chunkSize: number
  private chunkOverlap: number

  constructor(config: DuctConfig = {}) {
    this.store = new MemoryVectorStore()
    this.searcher = new BM25Searcher()
    this.chunkStrategy = config.chunk?.strategy ?? 'sliding-window'
    this.chunkSize = config.chunk?.size ?? 1500
    this.chunkOverlap = config.chunk?.overlap ?? 200
    this.initEmbedder(config)
  }

  private initEmbedder(config: DuctConfig): void {
    const provider = config.embed?.provider
    if (provider === 'openai') {
      this.embedder = new OpenAIEmbedder(config.embed?.model)
    } else if (provider === 'gemini') {
      this.embedder = new GeminiEmbedder(config.embed?.model)
    } else if (process.env['OPENAI_API_KEY']) {
      this.embedder = new OpenAIEmbedder()
    } else if (process.env['GEMINI_API_KEY']) {
      this.embedder = new GeminiEmbedder()
    }
  }

  async index(input: string | string[]): Promise<IndexResult> {
    const paths = Array.isArray(input) ? input : [input]
    const resolved: string[] = []
    for (const p of paths) {
      resolved.push(...(await findFiles(p)))
    }

    const start = Date.now()
    let totalDocs = 0
    let totalChunks = 0

    for (const filePath of resolved) {
      if (this.documents.has(filePath)) continue
      this.documents.add(filePath)
      totalDocs++

      const doc = await extract(filePath)
      const chunks = chunk(
        doc.content,
        filePath,
        doc.format,
        this.chunkStrategy,
        this.chunkSize,
        this.chunkOverlap,
      )

      await this.searcher.add(chunks)
      this.chunks += chunks.length
      totalChunks += chunks.length

      if (this.embedder) {
        const batchSize = 20
        for (let i = 0; i < chunks.length; i += batchSize) {
          const batch = chunks.slice(i, i + batchSize)
          const embeddings = await this.embedder.embed(batch.map(c => c.content))
          await this.store.add(batch, embeddings)
        }
      }
    }

    return { documents: totalDocs, chunks: totalChunks, time: Date.now() - start }
  }

  async search(query: string, topK = 10): Promise<SearchResult[]> {
    if (this.embedder) {
      const [queryEmbedding] = await this.embedder.embed([query])
      return this.store.search(queryEmbedding, topK)
    }
    return this.searcher.search(query, topK)
  }

  async clear(): Promise<void> {
    this.documents.clear()
    this.chunks = 0
    await this.store.clear()
    await this.searcher.clear()
  }

  stats(): { documents: number; chunks: number } {
    return {
      documents: this.documents.size,
      chunks: this.chunks,
    }
  }
}
