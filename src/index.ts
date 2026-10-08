import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { detectFormat, extract } from './extract/index.js'
import { chunk } from './chunk/index.js'
import { extractUrl, isUrl } from './extract/web.js'
import { extractTablesFromContent } from './extract/table.js'
import { SqliteStore } from './store/sqlite.js'
import { terminateOcr } from './ocr/index.js'
import { HybridSearcher, reciprocalRankFusion } from './search/hybrid.js'
import { SimpleReranker, NoopReranker } from './search/reranker.js'
import { createLLMProvider, OpenAILLM, GeminiLLM } from './qa/provider.js'
import { createEmbedder } from './embed/factory.js'
import type { EmbedProvider } from './embed/factory.js'
import type {
  DuctConfig, Chunk, EmbeddingProvider, IndexResult, IndexOptions, IndexActivity, IndexFailure, SearchResult,
  DocumentInfo, DocumentFormat, RuntimeConfig, Reranker, LLMProvider,
  QAResult, SchemaField, ExtractionResult, DocDiff, ExtractedDocument,
} from './types.js'

export const VALID_EXTS = new Set(['.pdf', '.docx', '.md', '.markdown', '.html', '.htm', '.txt', '.csv', '.json', '.log', '.xml', '.xlsx', '.pptx', '.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.gif', '.webp'])

const WATCH_DEBOUNCE_MS = 300
const EMBED_BATCH = 20
const API_KEY_FIELDS = ['openaiKey', 'geminiKey', 'cohereKey', 'voyageKey', 'mistralKey', 'jinaKey'] as const

function safeWarn(msg: string): void {
  try {
    console.warn(msg)
  } catch {
    // EPIPE when stdout/stderr is closed (e.g., Electron quitting)
  }
}

export function hashBytes(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

async function findFiles(input: string): Promise<string[]> {
  if (isUrl(input)) return [input]
  const st = statSync(input)
  if (st.isFile()) {
    // Files without a supported extension (including extensionless ones like id_rsa) are never indexed.
    if (!VALID_EXTS.has(extname(input).toLowerCase())) return []
    return [resolve(input)]
  }
  if (st.isDirectory()) {
    const entries = await readdir(input, { recursive: true, withFileTypes: true })
    return entries
      .filter(e => e.isFile() && VALID_EXTS.has(extname(e.name).toLowerCase()))
      .map(e => resolve(e.parentPath, e.name))
  }
  return []
}

type IndexOutcome = { status: 'indexed' | 'no-text' | 'skipped' | 'failed'; chunks: number; error?: string }

const MAX_REPORTED_FAILURES = 50

export class Duct {
  private embedder: EmbeddingProvider | null = null
  private store: SqliteStore
  private reranker: Reranker
  private llmProvider: LLMProvider | null = null
  private chunkStrategy: 'sliding-window' | 'by-heading'
  private chunkSize: number
  private chunkOverlap: number
  private ocr: boolean
  private searchMode: 'bm25' | 'vector' | 'hybrid'
  private searchAlpha: number
  private rerankEnabled: boolean
  private hydeEnabled: boolean
  private persistPath?: string
  private watchers = new Map<string, FSWatcher>()
  private pendingChanges = new Map<string, NodeJS.Timeout>()
  private locks = new Map<string, Promise<void>>()
  private embedding: Promise<void> | null = null
  private embedError: string | null = null
  private progress = { active: 0, done: 0, total: 0, current: '', failures: [] as IndexFailure[], failed: 0 }
  private lastRun: IndexActivity['lastRun']
  private runCounter = 0
  private embedProvider: string = ''
  private embedModel: string = ''
  private embedBaseUrl: string = ''
  private llmModel: string = ''
  private llmBaseUrl: string = ''
  private blockPrivateUrls: boolean

  constructor(config: DuctConfig = {}) {
    this.blockPrivateUrls = config.blockPrivateUrls ?? false
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
    this.store = new SqliteStore(this.persistPath ? join(this.persistPath, 'duct.db') : ':memory:')
    const embed = config.embed || undefined
    this.embedProvider = embed?.provider || ''
    this.embedModel = embed?.model || ''
    this.embedBaseUrl = embed?.baseUrl || ''
    this.initEmbedder(config)
    this.initLLM(config)
    if (this.persistPath) this.migrateLegacyIndex(this.persistPath)
    this.applySavedSettings(config)
    this.initReranker()
  }

  private initEmbedder(config: DuctConfig): void {
    if (config.embed === false) {
      this.embedder = null
      return
    }
    this.embedder = createEmbedder({
      provider: config.embed?.provider as EmbedProvider | undefined,
      model: config.embed?.model,
      baseUrl: config.embed?.baseUrl,
      apiKey: config.embed?.apiKey,
    })
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
    this.llmModel = llm.model || ''
    this.llmBaseUrl = llm.baseUrl || ''
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

  /** Settings changed through configure() are saved; values passed to the constructor take precedence. */
  private applySavedSettings(config: DuctConfig): void {
    const saved = this.store.getSettings() as Partial<RuntimeConfig>
    const pick: Partial<RuntimeConfig> = {}
    const take = <K extends keyof RuntimeConfig>(key: K, explicit: boolean) => {
      if (!explicit && saved[key] !== undefined) pick[key] = saved[key] as RuntimeConfig[K]
    }
    take('ocr', config.ocr !== undefined)
    take('chunkStrategy', config.chunk?.strategy !== undefined)
    take('chunkSize', config.chunk?.size !== undefined)
    take('chunkOverlap', config.chunk?.overlap !== undefined)
    take('searchMode', config.search?.mode !== undefined)
    take('searchAlpha', config.search?.alpha !== undefined)
    take('rerank', config.search?.rerank !== undefined)
    take('hyde', config.search?.hyde !== undefined)
    for (const key of ['llmProvider', 'llmModel', 'llmBaseUrl'] as const) take(key, config.llm !== undefined)
    for (const key of ['embedProvider', 'embedModel', 'embedBaseUrl'] as const) take(key, config.embed !== undefined)
    if (Object.keys(pick).length > 0) this.applyConfig(pick, false)
  }

  /** Imports an index written by Duct 0.2 (meta.json / bm25.json / vectors.json) into SQLite, once. */
  private migrateLegacyIndex(dir: string): void {
    const metaPath = join(dir, 'meta.json')
    const bm25Path = join(dir, 'bm25.json')
    const vectorsPath = join(dir, 'vectors.json')
    const configPath = join(dir, 'config.json')
    if (![metaPath, bm25Path, vectorsPath, configPath].some(p => existsSync(p))) return
    try {
      if (this.store.stats().documents === 0 && existsSync(bm25Path)) {
        const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf-8')) : {}
        const infos = new Map<string, DocumentInfo>()
        for (const d of Array.isArray(meta.documents) ? meta.documents : []) {
          if (typeof d === 'object' && d?.path) infos.set(d.path, d)
        }
        const bm25 = JSON.parse(readFileSync(bm25Path, 'utf-8')) as { chunks?: { chunk: Chunk }[] }
        const byDoc = new Map<string, Chunk[]>()
        const seen = new Set<string>()
        for (const { chunk: c } of bm25.chunks ?? []) {
          const key = `${c.documentPath}\u0000${c.index}\u0000${c.content}`
          if (seen.has(key)) continue
          seen.add(key)
          byDoc.set(c.documentPath, [...(byDoc.get(c.documentPath) ?? []), c])
        }
        const rowIds = new Map<string, number>()
        for (const [path, chunks] of byDoc) {
          const info = infos.get(path)
          const ids = this.store.replaceDocument({
            path,
            displayName: basename(path),
            source: isUrl(path) ? 'url' : 'path',
            format: info?.format ?? chunks[0].documentFormat,
            size: info?.size ?? 0,
            mtimeMs: null,
            contentHash: '',
            status: 'indexed',
            metadata: info?.metadata ?? {},
            chunkMetadata: chunks[0].metadata ?? {},
          }, chunks)
          chunks.forEach((c, i) => rowIds.set(c.id, ids[i]))
        }
        if (existsSync(vectorsPath)) {
          const entries = JSON.parse(readFileSync(vectorsPath, 'utf-8')) as { chunk: Chunk; embedding: number[] }[]
          this.store.addVectors(entries
            .filter(e => rowIds.has(e.chunk.id))
            .map(e => ({ chunkRowId: rowIds.get(e.chunk.id)!, model: 'legacy', vector: e.embedding })))
          if (this.embedder) this.store.adoptVectors('legacy', this.embedKey(), this.embedder.dimensions)
        }
      }
      if (existsSync(configPath) && Object.keys(this.store.getSettings()).length === 0) {
        const old = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
        for (const k of API_KEY_FIELDS) delete old[k]
        this.store.setSettings(old)
      }
      for (const p of [metaPath, bm25Path, vectorsPath, configPath]) {
        if (existsSync(p)) renameSync(p, p + '.migrated')
      }
    } catch (err) {
      safeWarn(`  Could not migrate the old index in ${dir}: ${(err as Error).message}`)
    }
  }

  setLLMProvider(provider: LLMProvider | null): void {
    this.llmProvider = provider
  }

  /** Identifies the current embedding model, so vectors from another model are never mixed in. */
  private embedKey(): string {
    if (!this.embedder) return ''
    return `${this.embedder.constructor.name}:${this.embedModel || 'default'}:${this.embedder.dimensions}`
  }

  /** Runs `fn` after any earlier work on the same key has finished. */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const run = previous.then(fn)
    const settled = run.then(() => {}, () => {})
    this.locks.set(key, settled)
    settled.then(() => { if (this.locks.get(key) === settled) this.locks.delete(key) })
    return run
  }

  async index(input: string | string[], metadata?: Record<string, unknown>, options?: IndexOptions): Promise<IndexResult> {
    const paths = Array.isArray(input) ? input : [input]
    const resolved: string[] = []
    for (const p of paths) {
      try {
        resolved.push(...(await findFiles(p)))
      } catch (err) {
        safeWarn(`  Skipping "${p}": ${(err as Error).message}`)
      }
    }
    const start = Date.now()
    let totalDocs = 0
    let totalChunks = 0
    let failed = 0

    this.progress.active++
    this.progress.total += resolved.length
    try {
      for (const filePath of resolved) {
        this.progress.current = isUrl(filePath) ? filePath : basename(filePath)
        const outcome = await this.withLock(filePath, () => this.indexOne(filePath, metadata, options))
        this.progress.done++
        // Let the server answer other requests (searches, progress polls) between files.
        await new Promise(resolve => setImmediate(resolve))
        if (outcome.status === 'indexed' || outcome.status === 'no-text') {
          totalDocs++
          totalChunks += outcome.chunks
        } else if (outcome.status === 'failed') {
          failed++
          this.progress.failed++
          if (this.progress.failures.length < MAX_REPORTED_FAILURES) {
            this.progress.failures.push({ path: filePath, name: isUrl(filePath) ? filePath : basename(filePath), error: outcome.error ?? 'Could not be read' })
          }
        }
      }
    } finally {
      // Overlapping index() calls share one run; it ends when the last of them finishes.
      if (--this.progress.active === 0) {
        if (this.progress.total > 0) {
          this.lastRun = { id: ++this.runCounter, done: this.progress.done, failed: this.progress.failed, failures: this.progress.failures, finishedAt: Date.now() }
        }
        this.progress = { active: 0, done: 0, total: 0, current: '', failures: [], failed: 0 }
      }
    }

    if (this.embedder && totalChunks > 0) await this.embedPending()
    return { documents: totalDocs, chunks: totalChunks, time: Date.now() - start, ...(failed > 0 ? { failed } : {}) }
  }

  /** What indexing is doing right now, for progress displays. */
  activity(): IndexActivity {
    const { active, done, total, current } = this.progress
    return {
      indexing: active > 0, done, total, current,
      embedding: this.embedding !== null,
      ...(this.embedError ? { embeddingError: this.embedError } : {}),
      ...(this.lastRun ? { lastRun: this.lastRun } : {}),
    }
  }

  private async indexOne(path: string, metadata: Record<string, unknown> | undefined, options: IndexOptions | undefined): Promise<IndexOutcome> {
    const url = isUrl(path)
    const existing = this.store.getDocument(path)
    const usable = existing && existing.status !== 'failed' && !options?.force
    const metaChanged = metadata !== undefined && JSON.stringify(metadata) !== JSON.stringify(existing?.metadata ?? {})
    const docMeta = metadata ?? existing?.metadata ?? {}
    let mtimeMs: number | null = null
    let size = 0
    let hash = ''
    try {
      if (!url) {
        const st = statSync(path)
        mtimeMs = st.mtimeMs
        size = st.size
        // Unchanged since last time: same timestamp and size, or the same bytes.
        if (usable && !metaChanged && existing.mtimeMs === mtimeMs && existing.size === size) return { status: 'skipped', chunks: 0 }
        hash = hashBytes(readFileSync(path))
        if (usable && !metaChanged && existing.contentHash === hash) {
          this.store.touchDocument(path, mtimeMs, size)
          return { status: 'skipped', chunks: 0 }
        }
      }

      const doc = await this.extractPath(path, options?.ocr)
      if (url) {
        hash = hashBytes(doc.content)
        size = doc.content.length
        if (usable && !metaChanged && existing.contentHash === hash) return { status: 'skipped', chunks: 0 }
      }

      const chunks = this.chunkDocument(doc, path)
      const chunkMetadata = { ...docMeta, ...doc.metadata }
      for (const c of chunks) c.metadata = chunkMetadata
      const status = chunks.length > 0 ? 'indexed' : 'no-text'

      this.store.replaceDocument({
        path,
        displayName: options?.displayName ?? existing?.displayName ?? (url ? path : basename(path)),
        source: options?.source ?? existing?.source ?? (url ? 'url' : 'path'),
        format: doc.format,
        size,
        mtimeMs,
        contentHash: hash,
        status,
        metadata: docMeta,
        chunkMetadata,
      }, chunks)
      this.store.addVersion(path, hash, doc.content)
      return { status, chunks: chunks.length }
    } catch (err) {
      const message = (err as Error).message
      safeWarn(`  Error indexing "${path}": ${message}`)
      // Keep a previously good copy searchable; only record the failure for documents not indexed yet.
      if (!usable) {
        this.store.replaceDocument({
          path,
          displayName: options?.displayName ?? (url ? path : basename(path)),
          source: options?.source ?? (url ? 'url' : 'path'),
          format: url ? 'url' : detectFormat(path),
          size,
          mtimeMs,
          contentHash: hash,
          status: 'failed',
          error: message,
          metadata: docMeta,
          chunkMetadata: docMeta,
        }, [])
      }
      return { status: 'failed', chunks: 0, error: message }
    }
  }

  /**
   * Splits a document into chunks. Paged documents (PDF, PPTX) are chunked page by page so every chunk
   * stays on one page and records it. Tables are already part of the text and aren't indexed twice.
   */
  private chunkDocument(doc: ExtractedDocument, path: string): Chunk[] {
    if (!doc.pages) return chunk(doc.content, path, doc.format, this.chunkStrategy, this.chunkSize, this.chunkOverlap)
    const all: Chunk[] = []
    doc.pages.forEach((text, i) => {
      for (const c of chunk(text, path, doc.format, this.chunkStrategy, this.chunkSize, this.chunkOverlap)) {
        all.push({ ...c, page: i + 1, index: all.length })
      }
    })
    return all
  }

  /** Embeds every chunk that has no vector for the current model. Safe to call repeatedly. */
  async embedPending(): Promise<void> {
    if (!this.embedder) return
    if (this.embedding) return this.embedding
    // A provider that failed (missing key, unreachable server) isn't retried until the settings change.
    if (this.embedError) return
    const embedder = this.embedder
    const model = this.embedKey()
    const run = async () => {
      while (this.embedder === embedder) {
        const batch = this.store.chunksNeedingVectors(model, EMBED_BATCH)
        if (batch.length === 0) break
        const vectors = await embedder.embed(batch.map(b => b.content))
        if (vectors.length !== batch.length) throw new Error(`embedding provider returned ${vectors.length} vectors for ${batch.length} texts`)
        this.store.addVectors(batch.map((b, i) => ({ chunkRowId: b.rowId, model, vector: vectors[i] })))
      }
    }
    // Clear the flag in a callback: run() can finish synchronously (nothing to embed), and clearing it inside
    // run() would happen before the assignment below, leaving "embedding" set forever.
    this.embedding = run()
      .catch(err => {
        if (this.embedder === embedder) this.embedError = (err as Error).message
        safeWarn(`  Embedding paused (keyword search still works): ${(err as Error).message}`)
      })
      .finally(() => { this.embedding = null })
    return this.embedding
  }

  private async extractPath(filePath: string, ocr?: boolean): Promise<ExtractedDocument> {
    if (isUrl(filePath)) {
      return await extractUrl(filePath, { blockPrivate: this.blockPrivateUrls })
    }
    return await extract(filePath, { ocr: ocr ?? this.ocr })
  }

  private findDocument(path: string) {
    return this.store.getDocument(path) ?? (isUrl(path) ? undefined : this.store.getDocument(resolve(path)))
  }

  async search(query: string, topK = 10, filter?: Record<string, unknown>): Promise<SearchResult[]> {
    const fetchK = Math.max(topK * 3, 30)
    const activeFilter = filter && Object.keys(filter).length > 0 ? filter : undefined
    let results: SearchResult[]

    if ((this.searchMode === 'vector' || this.searchMode === 'hybrid') && this.embedder) {
      try {
        const queryEmb = this.embedder.embedQuery ? await this.embedder.embedQuery(query) : (await this.embedder.embed([query]))[0]
        const vectorResults = this.store.searchVectors(queryEmb, this.embedKey(), fetchK, activeFilter)
        if (this.searchMode === 'vector' && vectorResults.length > 0) {
          results = vectorResults
        } else {
          const textResults = this.store.searchText(query, fetchK, activeFilter)
          results = vectorResults.length > 0 ? reciprocalRankFusion(textResults, vectorResults, fetchK, this.searchAlpha) : textResults
        }
      } catch {
        results = this.store.searchText(query, fetchK, activeFilter)
      }
    } else {
      results = this.store.searchText(query, fetchK, activeFilter)
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
    const docs = paths || this.store.listDocuments().filter(d => d.status === 'indexed').map(d => d.path)
    const results: ExtractionResult[] = []

    for (const requested of docs) {
      const known = this.findDocument(requested)
      if (!known) continue
      const path = known.path
      const allChunks: string[] = []
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
    const known = this.findDocument(path)
    const versions = this.store.lastVersions(known?.path ?? path)
    if (versions.length < 2) return null

    const [a, b] = versions
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


  /**
   * Indexes the folders (existing files first), then keeps them in sync: new and changed files are
   * indexed, deleted or moved files are removed. Folders are remembered; see restoreSources().
   */
  async watch(paths: string[], callback?: () => void): Promise<void> {
    for (const p of paths) {
      const dir = resolve(p)
      if (!statSync(dir).isDirectory()) continue
      this.store.addSource(dir, 'watch')
      this.startWatcher(dir, callback)
      await this.reconcile(dir)
    }
  }

  /** Re-watches every remembered folder, catching up on changes made while Duct wasn't running. */
  async restoreSources(callback?: () => void): Promise<string[]> {
    const restored: string[] = []
    for (const source of this.store.listSources()) {
      if (source.kind !== 'watch') continue
      if (!existsSync(source.path)) {
        safeWarn(`  Watched folder is unavailable, keeping its documents: ${source.path}`)
        continue
      }
      this.startWatcher(source.path, callback)
      await this.reconcile(source.path)
      restored.push(source.path)
    }
    await this.refreshStale()
    return restored
  }

  /** Re-extracts documents imported from an older index format (e.g. to add page numbers). */
  async refreshStale(): Promise<number> {
    let refreshed = 0
    for (const doc of this.store.staleDocuments()) {
      if (doc.source === 'url' || !existsSync(doc.path)) continue
      refreshed += (await this.index(doc.path)).documents
    }
    return refreshed
  }

  /**
   * Re-checks every watched folder for changes without relying on file events, which network drives
   * (SMB/NFS) often don't deliver. Cheap when nothing changed: unchanged files are skipped by timestamp.
   */
  async rescanSources(): Promise<void> {
    for (const source of this.store.listSources()) {
      if (source.kind === 'watch' && existsSync(source.path)) await this.reconcile(source.path)
    }
  }

  listSources(): { path: string; kind: string }[] {
    return this.store.listSources()
  }

  /** Stops watching a folder and forgets it; by default its documents leave the index too. */
  async removeSource(path: string, options: { removeDocuments?: boolean } = {}): Promise<void> {
    const dir = resolve(path)
    this.watchers.get(dir)?.close()
    this.watchers.delete(dir)
    this.store.removeSource(dir)
    if (options.removeDocuments ?? true) {
      for (const doc of this.store.documentsUnder(dir)) await this.removeDocument(doc.path)
    }
  }

  private async reconcile(dir: string): Promise<void> {
    await this.index(dir, undefined, { source: 'watch' })
    for (const doc of this.store.documentsUnder(dir)) {
      if (!existsSync(doc.path)) await this.removeDocument(doc.path)
    }
  }

  private startWatcher(dir: string, callback?: () => void): void {
    if (this.watchers.has(dir)) return
    const watcher = watch(dir, { recursive: true }, (_event, filename) => {
      if (!filename) return
      const fullPath = join(dir, filename.toString())
      // Editors and copies fire several events per save; handle each path once it settles.
      clearTimeout(this.pendingChanges.get(fullPath))
      this.pendingChanges.set(fullPath, setTimeout(() => {
        this.pendingChanges.delete(fullPath)
        this.handleChange(fullPath).then(changed => { if (changed) callback?.() })
      }, WATCH_DEBOUNCE_MS))
    })
    watcher.on('error', err => safeWarn(`  Watch error for "${dir}": ${err.message}`))
    this.watchers.set(dir, watcher)
  }

  private async handleChange(fullPath: string): Promise<boolean> {
    try {
      if (existsSync(fullPath)) {
        const isDir = statSync(fullPath).isDirectory()
        if (!isDir && !VALID_EXTS.has(extname(fullPath).toLowerCase())) return false
        const result = await this.index(fullPath, undefined, { source: 'watch' })
        return result.documents > 0
      }
      // Deleted, or renamed/moved away: drop the file, or everything under it if it was a folder.
      const gone = [this.store.getDocument(fullPath), ...this.store.documentsUnder(fullPath)]
        .filter((d): d is NonNullable<typeof d> => !!d)
      for (const path of new Set(gone.map(d => d.path))) await this.removeDocument(path)
      return gone.length > 0
    } catch (err) {
      safeWarn(`  Watch error for "${fullPath}": ${(err as Error).message}`)
      return false
    }
  }

  /** Stops all watchers. Watched folders stay remembered for restoreSources(). */
  unwatch(): void {
    for (const timer of this.pendingChanges.values()) clearTimeout(timer)
    this.pendingChanges.clear()
    for (const w of this.watchers.values()) {
      try { w.close() } catch (err) {
        safeWarn(`  Error closing watcher: ${(err as Error).message}`)
      }
    }
    this.watchers.clear()
  }

  async removeDocument(path: string): Promise<void> {
    const doc = this.findDocument(path)
    if (doc) this.store.removeDocument(doc.path)
  }

  async clear(): Promise<void> {
    this.store.clear()
  }

  stats(): { documents: number; chunks: number } {
    return this.store.stats()
  }

  getDocument(path: string): DocumentInfo | undefined {
    const doc = this.findDocument(path)
    if (!doc) return undefined
    const { id: _id, mtimeMs: _m, contentHash: _h, ...info } = doc
    return info
  }

  /** The indexed document with exactly these bytes (sha256 hex), if any. */
  findDocumentByHash(hash: string): DocumentInfo | undefined {
    const doc = this.store.findByHash(hash)
    if (!doc) return undefined
    const { id: _id, mtimeMs: _m, contentHash: _h, ...info } = doc
    return info
  }

  getDocuments(): DocumentInfo[] {
    return this.store.listDocuments().map(({ id: _id, mtimeMs: _m, contentHash: _h, ...info }) => info)
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
      llmModel: this.llmModel,
      llmBaseUrl: this.llmBaseUrl,
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
    this.applyConfig(cfg, true)
  }

  private applyConfig(cfg: Partial<RuntimeConfig>, persist: boolean): void {
    if (cfg.ocr !== undefined) this.ocr = cfg.ocr
    if (cfg.chunkStrategy !== undefined) this.chunkStrategy = cfg.chunkStrategy
    if (cfg.chunkSize !== undefined) this.chunkSize = cfg.chunkSize
    if (cfg.chunkOverlap !== undefined) this.chunkOverlap = cfg.chunkOverlap
    if (cfg.searchMode !== undefined) this.searchMode = cfg.searchMode
    if (cfg.searchAlpha !== undefined) this.searchAlpha = Math.max(0, Math.min(1, cfg.searchAlpha))
    if (cfg.rerank !== undefined) {
      this.rerankEnabled = cfg.rerank
      this.initReranker()
    }
    if (cfg.hyde !== undefined) this.hydeEnabled = cfg.hyde
    if (cfg.openaiKey) process.env['OPENAI_API_KEY'] = cfg.openaiKey
    if (cfg.geminiKey) process.env['GEMINI_API_KEY'] = cfg.geminiKey
    if (cfg.cohereKey) process.env['COHERE_API_KEY'] = cfg.cohereKey
    if (cfg.voyageKey) process.env['VOYAGE_API_KEY'] = cfg.voyageKey
    if (cfg.mistralKey) process.env['MISTRAL_API_KEY'] = cfg.mistralKey
    if (cfg.jinaKey) process.env['JINA_API_KEY'] = cfg.jinaKey
    if (cfg.llmModel !== undefined) this.llmModel = cfg.llmModel
    if (cfg.llmBaseUrl !== undefined) this.llmBaseUrl = cfg.llmBaseUrl
    if (cfg.llmProvider === 'none') {
      this.llmProvider = null
    } else if (cfg.llmProvider !== undefined) {
      this.llmProvider = createLLMProvider({
        provider: cfg.llmProvider,
        model: this.llmModel || undefined,
        baseUrl: this.llmBaseUrl || undefined,
        openaiKey: process.env['OPENAI_API_KEY'],
        geminiKey: process.env['GEMINI_API_KEY'],
      })
    }

    const embedChanged = cfg.embedProvider !== undefined || cfg.embedModel !== undefined || cfg.embedBaseUrl !== undefined
    const keysChanged = API_KEY_FIELDS.some(k => cfg[k] !== undefined)
    if (embedChanged || keysChanged) {
      this.embedError = null
      const before = this.embedKey()
      if (cfg.embedProvider !== undefined) this.embedProvider = cfg.embedProvider
      if (cfg.embedModel !== undefined) this.embedModel = cfg.embedModel
      if (cfg.embedBaseUrl !== undefined) this.embedBaseUrl = cfg.embedBaseUrl
      this.embedder = createEmbedder({
        provider: (this.embedProvider || undefined) as EmbedProvider | undefined,
        model: this.embedModel || undefined,
        baseUrl: this.embedBaseUrl || undefined,
      })
      // A different model can't be compared with old vectors: embed everything again in the background.
      if (this.embedder && this.embedKey() !== before) {
        const pending = this.embedding ?? Promise.resolve()
        pending.then(() => this.embedPending())
      }
    }

    if (persist) {
      // Only what was explicitly configured is saved, and API keys never are.
      const saved: Record<string, unknown> = { ...cfg }
      for (const k of API_KEY_FIELDS) delete saved[k]
      this.store.setSettings(saved)
    }
  }

  /** Closes watchers and the database. The instance can't be used afterwards. */
  close(): void {
    this.unwatch()
    this.store.close()
    terminateOcr().catch(() => {})
  }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size))
  return chunks
}

export { HybridSearcher, reciprocalRankFusion, extractUrl, isUrl, extractTablesFromContent }
