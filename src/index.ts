import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, unlinkSync, watch } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { extract } from './extract/index.js'
import { chunk } from './chunk/index.js'
import { extractUrl, isUrl } from './extract/web.js'
import { extractTablesFromContent } from './extract/table.js'
import { MemoryVectorStore } from './store/memory.js'
import { BM25Searcher } from './search/bm25.js'
import { HybridSearcher, reciprocalRankFusion } from './search/hybrid.js'
import { SimpleReranker, NoopReranker } from './search/reranker.js'
import { createLLMProvider, OpenAILLM, GeminiLLM, OllamaLLM } from './qa/provider.js'
import { createEmbedder } from './embed/factory.js'
import type { EmbedProvider } from './embed/factory.js'
import type {
  DuctConfig, Chunk, EmbeddingProvider, IndexResult, SearchResult, Searcher,
  DocumentInfo, DocumentFormat, RuntimeConfig, Reranker, LLMProvider,
  QAResult, SchemaField, ExtractionResult, DocDiff,
} from './types.js'

const VALID_EXTS = new Set(['.pdf', '.docx', '.md', '.markdown', '.html', '.htm', '.txt', '.csv', '.json', '.log', '.xml', '.xlsx', '.pptx', '.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.gif', '.webp'])

async function findFiles(input: string): Promise<string[]> {
  if (isUrl(input)) return [input]
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
  private reranker: Reranker
  private llmProvider: LLMProvider | null = null
  private documents: Map<string, DocumentInfo> = new Map()
  private chunksCount: number = 0
  private chunkStrategy: 'sliding-window' | 'by-heading'
  private chunkSize: number
  private chunkOverlap: number
  private ocr: boolean
  private searchMode: 'bm25' | 'vector' | 'hybrid'
  private searchAlpha: number
  private rerankEnabled: boolean
  private hydeEnabled: boolean
  private persistPath?: string
  private loaded = false
  private versionHistory: Map<string, { version: number; content: string; timestamp: number }[]> = new Map()
  private watchers: Set<ReturnType<typeof watch>> = new Set()
  private embedProvider: string = ''
  private embedModel: string = ''
  private embedBaseUrl: string = ''

  constructor(config: DuctConfig = {}) {
    this.store = new MemoryVectorStore()
    const rawSearcher = new BM25Searcher()
    this.searcher = new HybridSearcher(rawSearcher, null, config.search?.alpha ?? 0.5)
    this.reranker = new NoopReranker()
    this.chunkStrategy = config.chunk?.strategy ?? 'sliding-window'
    this.chunkSize = config.chunk?.size ?? 1500
    this.chunkOverlap = config.chunk?.overlap ?? 200
    this.ocr = config.ocr ?? false
    this.searchMode = config.search?.mode ?? 'bm25'
    this.searchAlpha = config.search?.alpha ?? 0.5
    this.rerankEnabled = config.search?.rerank ?? false
    this.hydeEnabled = config.search?.hyde ?? false
    this.persistPath = config.persistPath
    if (this.persistPath) mkdirSync(this.persistPath, { recursive: true })
    this.embedProvider = config.embed?.provider || ''
    this.embedModel = config.embed?.model || ''
    this.embedBaseUrl = config.embed?.baseUrl || ''
    this.initEmbedder(config)
    this.initLLM(config)
    this.initReranker()
  }

  private initEmbedder(config: DuctConfig): void {
    this.embedder = createEmbedder({
      provider: config.embed?.provider as EmbedProvider | undefined,
      model: config.embed?.model,
      baseUrl: config.embed?.baseUrl,
      apiKey: config.embed?.apiKey,
    })
    if (this.embedder) {
      this.searcher = new HybridSearcher(new BM25Searcher(), this.store, this.searchAlpha)
    }
  }

  private initLLM(config: DuctConfig): void {
    const llm = config.llm
    if (!llm) {
      if (process.env['OPENAI_API_KEY']) {
        this.llmProvider = new OpenAILLM(process.env['OPENAI_API_KEY'])
      } else if (process.env['GEMINI_API_KEY']) {
        this.llmProvider = new GeminiLLM(process.env['GEMINI_API_KEY'])
      }
      return
    }
    this.llmProvider = createLLMProvider({
      provider: llm.provider || 'ollama',
      model: llm.model,
      baseUrl: llm.baseUrl,
      openaiKey: process.env['OPENAI_API_KEY'],
      geminiKey: process.env['GEMINI_API_KEY'],
    })
  }

  private initReranker(): void {
    this.reranker = this.rerankEnabled ? new SimpleReranker() : new NoopReranker()
  }

  setLLMProvider(provider: LLMProvider | null): void {
    this.llmProvider = provider
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded || !this.persistPath) return
    this.loaded = true
    const dir = this.persistPath
    const metaPath = join(dir, 'meta.json')
    const bm25Path = join(dir, 'bm25.json')
    const vectorsPath = join(dir, 'vectors.json')
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
      if (Array.isArray(meta.documents)) {
        if (typeof meta.documents[0] === 'string') {
          const paths = meta.documents as string[]
          this.documents = new Map()
          for (const p of paths) this.documents.set(p, { path: p, format: 'txt' as DocumentFormat, chunkCount: 0, size: 0, indexedAt: 0 })
        } else {
          const docs = meta.documents as DocumentInfo[]
          this.documents = new Map(docs.map(d => [d.path, d]))
        }
      }
      this.chunksCount = meta.chunks || 0
    }
    if (existsSync(bm25Path)) await this.searcher.load(bm25Path)
    if (this.embedder && existsSync(vectorsPath)) await this.store.load(vectorsPath)
  }

  async index(input: string | string[]): Promise<IndexResult> {
    await this.ensureLoaded()
    const paths = Array.isArray(input) ? input : [input]
    const resolved: string[] = []
    for (const p of paths) {
      try {
        resolved.push(...(await findFiles(p)))
      } catch (err) {
        console.warn(`  Skipping "${p}": ${(err as Error).message}`)
      }
    }
    const start = Date.now()
    let totalDocs = 0
    let totalChunks = 0

    for (const filePath of resolved) {
      try {
        if (this.documents.has(filePath)) {
          if (this.versionHistory.has(filePath)) {
            const versions = this.versionHistory.get(filePath)!
            const lastContent = versions[versions.length - 1]?.content
            const doc = await this.extractPath(filePath)
            if (doc.content !== lastContent) {
              await this.removeDocument(filePath)
            } else {
              continue
            }
          } else {
            continue
          }
        }
        totalDocs++

        const doc = await this.extractPath(filePath)
        const tableAugmented = extractTablesFromContent(doc.content)
        const chunks = chunk(tableAugmented, filePath, doc.format, this.chunkStrategy, this.chunkSize, this.chunkOverlap)

        await this.searcher.add(chunks)
        this.chunksCount += chunks.length
        totalChunks += chunks.length

        this.documents.set(filePath, {
          path: filePath,
          format: doc.format,
          chunkCount: chunks.length,
          size: (doc.metadata.size as number) || 0,
          indexedAt: Date.now(),
        })

        const versions = this.versionHistory.get(filePath) || []
        versions.push({ version: versions.length + 1, content: doc.content, timestamp: Date.now() })
        this.versionHistory.set(filePath, versions)

        if (this.embedder) {
          const batchSize = 20
          for (let i = 0; i < chunks.length; i += batchSize) {
            const batch = chunks.slice(i, i + batchSize)
            const embeddings = await this.embedder.embed(batch.map(c => c.content))
            await this.store.add(batch, embeddings)
          }
        }
      } catch (err) {
        console.warn(`  Error indexing "${filePath}": ${(err as Error).message}`)
      }
    }

    if (this.persistPath) await this._save()
    return { documents: totalDocs, chunks: totalChunks, time: Date.now() - start }
  }

  private async extractPath(filePath: string): Promise<import('./types.js').ExtractedDocument> {
    if (isUrl(filePath)) {
      return await extractUrl(filePath)
    }
    return await extract(filePath, { ocr: this.ocr })
  }

  async search(query: string, topK = 10): Promise<SearchResult[]> {
    await this.ensureLoaded()
    let results: SearchResult[]

    if (this.searchMode === 'vector' && this.embedder) {
      try {
        const [queryEmb] = await this.embedder.embed([query])
        results = await this.store.search(queryEmb, topK)
      } catch {
        results = await this.searcher.search(query, topK)
      }
    } else if (this.searchMode === 'hybrid' && this.embedder) {
      try {
        const [queryEmb] = await this.embedder.embed([query])
        const bm25Results = await this.searcher.search(query, topK * 3)
        const vectorResults = await this.store.search(queryEmb, topK * 3)
        results = reciprocalRankFusion(bm25Results, vectorResults, topK, this.searchAlpha)
      } catch {
        results = await this.searcher.search(query, topK)
      }
    } else {
      results = await this.searcher.search(query, topK * 2)
    }

    try {
      if (this.rerankEnabled) {
        results = await this.reranker.rerank(query, results, topK)
      }
    } catch {
      results = results.slice(0, topK)
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, topK)
  }

  async ask(query: string, topK = 5): Promise<QAResult> {
    await this.ensureLoaded()
    const start = Date.now()

    let hydeQuery = query
    if (this.hydeEnabled && this.llmProvider) {
      try {
        const hyde = await this.llmProvider.generate(
          `Given the question: "${query}"\n\nWrite a short paragraph that would be the ideal answer to this question. Just output the paragraph, no explanation.`,
          'You are a helpful assistant. Write a concise hypothetical answer.',
        )
        if (hyde) hydeQuery = query + '\n' + hyde
      } catch {}
    }

    const searchResults = await this.search(hydeQuery, topK)
    if (searchResults.length === 0) {
      return { answer: 'No relevant documents found.', sources: [], time: Date.now() - start }
    }

    const context = searchResults.map((r, i) =>
      `[${i + 1}] ${r.chunk.documentPath}${r.chunk.heading ? ' > ' + r.chunk.heading : ''}\n${r.chunk.content.slice(0, 2000)}`
    ).join('\n\n---\n\n')

    const systemPrompt = 'You are a document analysis assistant. Answer the user\'s question based ONLY on the provided document excerpts. If the answer cannot be found in the excerpts, say so. Cite sources by their bracketed number [1], [2], etc. Be concise and accurate.'
    const prompt = `Documents:\n\n${context}\n\nQuestion: ${query}\n\nProvide a thorough answer with citations.`

    let answer: string
    if (this.llmProvider) {
      answer = await this.llmProvider.generate(prompt, systemPrompt)
    } else {
      answer = this.fallbackAnswer(searchResults, query)
    }

    const sources = searchResults.map(r => ({
      documentPath: r.chunk.documentPath,
      score: r.score,
      content: r.chunk.content.slice(0, 500),
      heading: r.chunk.heading,
    }))

    return { answer, sources, time: Date.now() - start }
  }

  private fallbackAnswer(results: SearchResult[], query: string): string {
    const top = results[0]
    const heading = top.chunk.heading ? ` (${top.chunk.heading})` : ''
    return `Found ${results.length} relevant result(s) for "${query}".\n\nTop match from: ${top.chunk.documentPath}${heading}\n\n${top.chunk.content.slice(0, 800)}\n\nTo get AI-generated answers, configure an LLM provider (Ollama, OpenAI, or Gemini) in settings.`
  }

  async extractSchema(fields: SchemaField[], paths?: string[]): Promise<ExtractionResult[]> {
    if (!this.llmProvider) throw new Error('LLM provider required for schema extraction. Configure in settings.')
    const docs = paths || [...this.documents.keys()]
    const results: ExtractionResult[] = []

    for (const path of docs) {
      const content = this.documents.get(path)
      if (!content) continue
      const allChunks: string[] = []
      const { chunk } = await import('./chunk/index.js')
      const doc = await this.extractPath(path)
      const chunks = chunk(doc.content, path, doc.format, 'sliding-window', 4000, 0)
      for (const c of chunks) allChunks.push(c.content)

      const extracted: Record<string, unknown> = {}
      for (const batch of chunkArray(allChunks, 3)) {
        const fieldDesc = fields.map(f => `- "${f.name}" (${f.type}): ${f.description}`).join('\n')
        const prompt = `Extract the following fields from these document excerpts.\n\nFields:\n${fieldDesc}\n\nDocument:\n${batch.join('\n...\n')}\n\nReturn ONLY valid JSON with the extracted field values. Use null if a field cannot be found.`
        const systemPrompt = 'You are a data extraction assistant. Output ONLY valid JSON, no explanation.'
        try {
          const resp = await this.llmProvider.generate(prompt, systemPrompt)
          const parsed = JSON.parse(resp.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim())
          Object.assign(extracted, parsed)
        } catch {}
      }
      results.push({ path, fields: extracted })
    }
    return results
  }

  async diff(path: string): Promise<DocDiff | null> {
    const versions = this.versionHistory.get(path)
    if (!versions || versions.length < 2) return null

    const a = versions[versions.length - 2]
    const b = versions[versions.length - 1]
    const tokensA = new Set(a.content.split(/\s+/))
    const tokensB = new Set(b.content.split(/\s+/))

    const additions: string[] = []
    const removals: string[] = []

    const linesA = a.content.split('\n')
    const linesB = b.content.split('\n')
    const setA = new Set(linesA.map(l => l.trim()).filter(Boolean))
    const setB = new Set(linesB.map(l => l.trim()).filter(Boolean))

    for (const line of setB) {
      if (!setA.has(line)) additions.push(line.slice(0, 200))
    }
    for (const line of setA) {
      if (!setB.has(line)) removals.push(line.slice(0, 200))
    }

    return {
      path,
      versionA: a.version,
      versionB: b.version,
      additions: additions.slice(0, 50),
      removals: removals.slice(0, 50),
      changes: [],
    }
  }

  async agenticSearch(query: string): Promise<QAResult> {
    const start = Date.now()
    if (!this.llmProvider) {
      return this.ask(query)
    }

    let subQueries: string[] = [query]
    try {
      const planPrompt = `Given the question: "${query}"

Break this question down into 2-4 sub-questions that need to be answered independently. Each sub-question should be searchable against a document index.

Return ONLY a JSON array of strings, like: ["sub-question 1", "sub-question 2"]`
      const planResp = await this.llmProvider.generate(planPrompt, 'You are a search query planner. Output ONLY valid JSON.')
      subQueries = JSON.parse(planResp.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim())
      if (!Array.isArray(subQueries)) subQueries = [query]
    } catch { subQueries = [query] }

    const allResults: { q: string; results: SearchResult[] }[] = []
    const seen = new Set<string>()
    for (const sq of subQueries) {
      const results = await this.search(sq, 3)
      allResults.push({ q: sq, results })
      for (const r of results) seen.add(r.chunk.id)
    }

    const context = allResults.map(({ q, results }) =>
      `[Sub-query: "${q}"]\n${results.map((r, i) =>
        `[${i + 1}] ${r.chunk.documentPath}${r.chunk.heading ? ' > ' + r.chunk.heading : ''}\n${r.chunk.content.slice(0, 1500)}`
      ).join('\n')}`
    ).join('\n\n---\n\n')

    let answer: string
    try {
      answer = await this.llmProvider.generate(
        `Documents:\n\n${context}\n\nOriginal Question: ${query}\n\nProvide a comprehensive answer synthesizing information from all sub-queries. Cite sources.`,
        'You are a research assistant synthesizing multi-source information.',
      )
    } catch {
      answer = this.fallbackAnswer(allResults.flatMap(r => r.results), query)
    }

    const sources = [...new Map(
      allResults.flatMap(r => r.results).map(r => [r.chunk.id, r])
    ).values()].map(r => ({
      documentPath: r.chunk.documentPath,
      score: r.score,
      content: r.chunk.content.slice(0, 500),
      heading: r.chunk.heading,
    }))

    return { answer, sources, time: Date.now() - start }
  }

  async watch(paths: string[], callback?: () => void): Promise<void> {
    for (const p of paths) {
      const st = statSync(p)
      if (!st.isDirectory()) continue
      const w = watch(p, { recursive: true }, async (eventType, filename) => {
        if (!filename) return
        const ext = extname(filename).toLowerCase()
        if (!VALID_EXTS.has(ext)) return
        const fullPath = join(p, filename.toString())
        try {
          statSync(fullPath)
          await this.index(fullPath)
          callback?.()
        } catch (err) {
          const msg = (err as Error).message
          if (!msg.includes('ENOENT')) console.warn(`  Watch error for "${fullPath}": ${msg}`)
        }
      })
      this.watchers.add(w)
    }
  }

  unwatch(): void {
    for (const w of this.watchers) {
      try { w.close() } catch (err) {
        console.warn(`  Error closing watcher: ${(err as Error).message}`)
      }
    }
    this.watchers.clear()
  }

  async removeDocument(path: string): Promise<void> {
    await this.ensureLoaded()
    const info = this.documents.get(path)
    if (!info) return
    this.documents.delete(path)
    this.chunksCount -= info.chunkCount
    await this.searcher.remove(path)
    if (this.embedder) await this.store.remove(path)
    if (this.persistPath) await this._save()
  }

  async clear(): Promise<void> {
    this.documents.clear()
    this.chunksCount = 0
    await this.store.clear()
    await this.searcher.clear()
    this.versionHistory.clear()
    if (this.persistPath) {
      for (const f of ['meta.json', 'bm25.json', 'vectors.json']) {
        const p = join(this.persistPath, f)
        if (existsSync(p)) unlinkSync(p)
      }
    }
  }

  stats(): { documents: number; chunks: number } {
    return { documents: this.documents.size, chunks: this.chunksCount }
  }

  getDocuments(): DocumentInfo[] {
    return [...this.documents.values()]
  }

  getConfig(): RuntimeConfig {
    return {
      ocr: this.ocr,
      chunkStrategy: this.chunkStrategy,
      chunkSize: this.chunkSize,
      chunkOverlap: this.chunkOverlap,
      searchMode: this.searchMode,
      searchAlpha: this.searchAlpha,
      rerank: this.rerankEnabled,
      hyde: this.hydeEnabled,
      llmProvider: this.llmProvider?.name || 'none',
      llmModel: '',
      llmBaseUrl: '',
      openaiKey: process.env['OPENAI_API_KEY'] || '',
      geminiKey: process.env['GEMINI_API_KEY'] || '',
      embedProvider: this.embedProvider,
      embedModel: this.embedModel,
      embedBaseUrl: this.embedBaseUrl,
      cohereKey: process.env['COHERE_API_KEY'] || '',
      voyageKey: process.env['VOYAGE_API_KEY'] || '',
      mistralKey: process.env['MISTRAL_API_KEY'] || '',
      jinaKey: process.env['JINA_API_KEY'] || '',
    }
  }

  configure(cfg: Partial<RuntimeConfig>): void {
    if (cfg.ocr !== undefined) this.ocr = cfg.ocr
    if (cfg.chunkStrategy !== undefined) this.chunkStrategy = cfg.chunkStrategy
    if (cfg.chunkSize !== undefined) this.chunkSize = cfg.chunkSize
    if (cfg.chunkOverlap !== undefined) this.chunkOverlap = cfg.chunkOverlap
    if (cfg.searchMode !== undefined) this.searchMode = cfg.searchMode
    if (cfg.searchAlpha !== undefined) {
      this.searchAlpha = cfg.searchAlpha
      if (this.searcher instanceof HybridSearcher) {
        this.searcher.setAlpha(cfg.searchAlpha)
      }
    }
    if (cfg.rerank !== undefined) {
      this.rerankEnabled = cfg.rerank
      this.initReranker()
    }
    if (cfg.hyde !== undefined) this.hydeEnabled = cfg.hyde
    if (cfg.llmProvider !== undefined && cfg.llmProvider !== 'none') {
      this.llmProvider = createLLMProvider({
        provider: cfg.llmProvider,
        model: cfg.llmModel || undefined,
        baseUrl: cfg.llmBaseUrl || undefined,
        openaiKey: cfg.openaiKey || process.env['OPENAI_API_KEY'],
        geminiKey: cfg.geminiKey || process.env['GEMINI_API_KEY'],
      })
    }
    if (cfg.openaiKey) process.env['OPENAI_API_KEY'] = cfg.openaiKey
    if (cfg.geminiKey) process.env['GEMINI_API_KEY'] = cfg.geminiKey
    if (cfg.cohereKey) process.env['COHERE_API_KEY'] = cfg.cohereKey
    if (cfg.voyageKey) process.env['VOYAGE_API_KEY'] = cfg.voyageKey
    if (cfg.mistralKey) process.env['MISTRAL_API_KEY'] = cfg.mistralKey
    if (cfg.jinaKey) process.env['JINA_API_KEY'] = cfg.jinaKey

    const embedChanged = cfg.embedProvider !== undefined || cfg.embedModel !== undefined || cfg.embedBaseUrl !== undefined
    const keysChanged = cfg.openaiKey !== undefined || cfg.geminiKey !== undefined ||
      cfg.cohereKey !== undefined || cfg.voyageKey !== undefined ||
      cfg.mistralKey !== undefined || cfg.jinaKey !== undefined

    if (embedChanged || keysChanged) {
      if (cfg.embedProvider !== undefined) this.embedProvider = cfg.embedProvider
      if (cfg.embedModel !== undefined) this.embedModel = cfg.embedModel
      if (cfg.embedBaseUrl !== undefined) this.embedBaseUrl = cfg.embedBaseUrl

      const provider = (this.embedProvider || '') as EmbedProvider
      this.embedder = createEmbedder({
        provider: provider || undefined,
        model: this.embedModel || undefined,
        baseUrl: this.embedBaseUrl || undefined,
      })
      if (this.embedder) {
        this.searcher = new HybridSearcher(new BM25Searcher(), this.store, this.searchAlpha)
      }
    }

    if (this.persistPath) {
      writeFileSync(join(this.persistPath, 'config.json'), JSON.stringify(this.getConfig()))
    }
  }

  private async _save(): Promise<void> {
    const dir = this.persistPath!
    await this.searcher.save(join(dir, 'bm25.json'))
    if (this.embedder) await this.store.save(join(dir, 'vectors.json'))
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({
      documents: [...this.documents.values()],
      chunks: this.chunksCount,
    }))
  }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size))
  return chunks
}

export { HybridSearcher, reciprocalRankFusion, extractUrl, isUrl, extractTablesFromContent }
