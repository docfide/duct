import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { detectFormat, extract, UnsupportedFileError } from './extract/index.js'
import { FeatureDisabledError, defaultFeatures, enabledFormats, formatAllowed, mergeFeatures } from './features.js'
import type { Features, FeaturesPatch } from './features.js'
import { PACKAGE_EXTENSIONS, SUPPORTED_EXTENSIONS, isIgnoredDirectory, isSupportedFile } from './formats.js'
import { chunk } from './chunk/index.js'
import { extractUrl, isUrl } from './extract/web.js'
import { extractTablesFromContent } from './extract/table.js'
import { SqliteStore } from './store/sqlite.js'
import type { AuditEntry, StoredApiKey, StoredDocument } from './store/sqlite.js'
import { terminateOcr } from './ocr/index.js'
import { HybridSearcher, reciprocalRankFusion } from './search/hybrid.js'
import { SimpleReranker, NoopReranker } from './search/reranker.js'
import { createLLMProvider, OpenAILLM, GeminiLLM } from './qa/provider.js'
import { createEmbedder } from './embed/factory.js'
import { recurringNames, summarizeKinds, triesFor } from './discover.js'
import type { Discovery } from './discover.js'
import type { EmbedProvider } from './embed/factory.js'
import type { SearchHelp,
  DuctConfig, Chunk, EmbeddingProvider, IndexResult, IndexOptions, IndexActivity, IndexFailure, SearchResult, SearchScope,
  DocumentInfo, DocumentFormat, RuntimeConfig, Reranker, LLMProvider,
  QAResult, SchemaField, ExtractionResult, DocDiff, ExtractedDocument,
} from './types.js'

/** Supported file extensions (see src/formats.ts). */
export const VALID_EXTS = SUPPORTED_EXTENSIONS

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

/**
 * Timestamp, size and content hash of a file, or of a document saved as a folder (older iWork packages):
 * for folders, the newest timestamp, the total size and a hash over every file's name and bytes.
 */
export function fingerprint(path: string): { mtimeMs: number; size: number; hash: () => string } {
  const st = statSync(path)
  if (!st.isDirectory()) return { mtimeMs: st.mtimeMs, size: st.size, hash: () => hashBytes(readFileSync(path)) }
  const files = (readdirSync(path, { recursive: true, withFileTypes: true }) as import('node:fs').Dirent[])
    .filter(e => e.isFile())
    .map(e => join(e.parentPath, e.name))
    .sort()
  let mtimeMs = st.mtimeMs
  let size = 0
  for (const f of files) {
    const s = statSync(f)
    mtimeMs = Math.max(mtimeMs, s.mtimeMs)
    size += s.size
  }
  return {
    mtimeMs,
    size,
    hash: () => {
      const h = createHash('sha256')
      for (const f of files) h.update(f.slice(path.length)).update('\0').update(readFileSync(f))
      return h.digest('hex')
    },
  }
}

async function findFiles(input: string): Promise<string[]> {
  if (isUrl(input)) return [input]
  const st = statSync(input)
  // Older iWork documents are folders ("packages"); they are one document.
  if (st.isDirectory() && PACKAGE_EXTENSIONS.has(extname(input).toLowerCase())) return [resolve(input)]
  // Files without a supported extension (including extensionless ones like id_rsa) are never indexed.
  if (st.isFile()) return isSupportedFile(input) ? [resolve(input)] : []
  if (st.isDirectory()) return walk(resolve(input))
  return []
}

/**
 * Supported files under a folder. Skips dependency, version-control and cache folders, hidden folders and
 * symlinks (so loops can't happen), and treats iWork package folders as single documents.
 */
async function walk(root: string): Promise<string[]> {
  const found: string[] = []
  const pending = [root]
  while (pending.length) {
    const dir = pending.pop()!
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (PACKAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) found.push(full)
        else if (!isIgnoredDirectory(entry.name)) pending.push(full)
      } else if (entry.isFile() && isSupportedFile(entry.name)) {
        found.push(full)
      }
    }
  }
  return found.sort()
}

/** The iWork package a path is inside, if any (changes inside a package re-index the package). */
function packageOf(path: string): string | undefined {
  const match = path.match(/^(.*?\.(?:pages|numbers|key))[\\/]/i)
  return match?.[1]
}

/** Whether a path inside a watched folder sits in a folder that walk() skips. */
function inIgnoredFolder(path: string, root: string): boolean {
  return path.slice(root.length).split(/[\\/]/).slice(0, -1).some(part => part && isIgnoredDirectory(part))
}

/** Text given directly rather than read from a file (see indexText()). */
export interface TextInput {
  text?: string
  /** Text per page; results then carry page numbers. */
  pages?: string[]
  title?: string
  metadata?: Record<string, unknown>
  /** 'md' chunks by heading-aware rules where configured; default 'txt'. */
  format?: 'txt' | 'md'
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
  private features: Features = defaultFeatures()
  private explicitFeatures: FeaturesPatch = {}

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
    this.initFeatures(config)
  }

  /** Saved feature switches, then the constructor's (which win and aren't saved). */
  private initFeatures(config: DuctConfig): void {
    const saved = this.store.getSettings()['features']
    if (saved) {
      try { this.features = mergeFeatures(this.features, saved) } catch (err) { safeWarn(`  Ignoring saved feature settings: ${(err as Error).message}`) }
    }
    if (config.features) {
      this.explicitFeatures = config.features
      this.features = mergeFeatures(this.features, config.features)
    }
  }

  /** Which features are switched on. */
  getFeatures(): Features {
    return { ...this.features, formats: { ...this.features.formats } }
  }

  /**
   * Switches features on or off and saves the change. Switching a file family back on rescans watched
   * folders in the background, so files skipped while it was off are indexed.
   */
  setFeatures(patch: FeaturesPatch): Features {
    const before = this.features
    const next = mergeFeatures(before, patch)
    this.features = mergeFeatures(next, this.explicitFeatures)
    const saved = (this.store.getSettings()['features'] ?? {}) as FeaturesPatch
    this.store.setSettings({ features: mergeFeatures(mergeFeatures(defaultFeatures(), saved), patch) })
    const reenabled = Object.keys(this.features.formats).some(k => this.features.formats[k as keyof Features['formats']] && !before.formats[k as keyof Features['formats']])
    // Watching stops while the switch is off; the folders are remembered and picked up again when it's back on.
    if (!this.features.watchedFolders && before.watchedFolders) this.unwatch()
    else if (this.features.watchedFolders && !before.watchedFolders) this.restoreSources().catch(err => safeWarn(`  Could not restore watched folders: ${(err as Error).message}`))
    else if (reenabled) this.rescanSources().catch(err => safeWarn(`  Rescan failed: ${(err as Error).message}`))
    if (this.features.semanticSearch && !before.semanticSearch) this.embedPending().catch(() => {})
    return this.getFeatures()
  }

  /** Where this index is stored, or undefined for an in-memory index. */
  get dataDir(): string | undefined {
    return this.persistPath
  }

  /** Whether search by meaning is available (an embedding model is set up and the feature is on). */
  semanticAvailable(): boolean {
    return this.activeEmbedder !== null
  }

  /**
   * Indexes text that isn't a file, under `path` as its key (the developer API uses its own ids). Unchanged
   * text is skipped. It is searchable by keyword at once; embeddings, if any, follow in the background.
   */
  async indexText(path: string, input: TextInput): Promise<{ status: 'indexed' | 'no-text' | 'unchanged'; chunks: number }> {
    const format = input.format ?? 'txt'
    const content = input.pages ? input.pages.join('\n\n') : (input.text ?? '')
    const metadata = { ...(input.metadata ?? {}) }
    const hash = hashBytes(JSON.stringify([content, input.pages ? input.pages.length : 0, input.title ?? null, metadata, format]))
    const result = await this.withLock(path, async () => {
      const existing = this.store.getDocument(path)
      if (existing && existing.contentHash === hash && existing.status !== 'failed') return { status: 'unchanged' as const, chunks: existing.chunkCount }
      const doc: ExtractedDocument = { path, format, content, metadata: {}, ...(input.pages ? { pages: input.pages } : {}) }
      const chunks = this.chunkDocument(doc, path)
      const chunkMetadata = { ...metadata, ...(input.title ? { title: input.title } : {}) }
      for (const c of chunks) c.metadata = chunkMetadata
      const status = chunks.length > 0 ? 'indexed' as const : 'no-text' as const
      this.store.replaceDocument({
        path, displayName: input.title || path, source: 'api', format, size: Buffer.byteLength(content), mtimeMs: null,
        contentHash: hash, status, metadata, chunkMetadata,
      }, chunks)
      this.store.addVersion(path, hash, content)
      return { status, chunks: chunks.length }
    })
    if (result.status !== 'unchanged' && this.activeEmbedder) this.embedPending().catch(() => {})
    return result
  }

  /** The stored text of a document (kept for text added with indexText() and for version comparison). */
  documentText(path: string): string | undefined {
    return this.store.latestContent(path)
  }

  /** One page of documents, newest first. */
  pageDocuments(limit: number, offset: number): { documents: DocumentInfo[]; total: number } {
    const page = this.store.pageDocuments(limit, offset)
    return { documents: page.documents.map(d => toInfo(d, this.store.tagsFor(d.path))), total: page.total }
  }

  /** Counts of metadata values among documents matching the keyword query (all documents for an empty query). */
  facets(query: string, fields: string[], limit = 20, filter?: Record<string, unknown>, scope?: SearchScope): Record<string, Record<string, number>> {
    const allowed = enabledFormats(this.features)
    if (allowed) scope = { ...scope, formats: scope?.formats ? scope.formats.filter(f => allowed.includes(f)) : allowed }
    if (scope?.formats && scope.formats.length === 0) return Object.fromEntries(fields.map(f => [f, {}]))
    return this.store.facetCounts(query, fields, limit, filter && Object.keys(filter).length ? filter : undefined, scope)
  }

  /** Records who did what, for the server's audit log (see src/server.ts). */
  recordAudit(e: { actor: string; role?: string; action: string; target?: string; detail?: string }): void {
    this.store.addAudit({ at: Date.now(), ...e })
  }

  auditLog(opts: { before?: number; limit?: number; actor?: string; action?: string } = {}): AuditEntry[] {
    return this.store.listAudit({ ...opts, limit: Math.min(1000, opts.limit ?? 200) })
  }

  /** Deletes audit entries older than `days`. */
  pruneAudit(days: number): number {
    return this.store.pruneAudit(Date.now() - days * 86_400_000)
  }

  /** Creates an API key for the developer API. The key itself is returned once and only its hash is stored. */
  createApiKey(name: string, scopes: string[], collections: string[] | null = null): { id: string; key: string } {
    const id = randomBytes(6).toString('hex')
    const key = `duct_${id}_${randomBytes(24).toString('base64url')}`
    this.store.addApiKey({ id, name, keyHash: hashBytes(key), scopes, collections })
    return { id, key }
  }

  listApiKeys(): StoredApiKey[] {
    return this.store.listApiKeys()
  }

  revokeApiKey(id: string): boolean {
    return this.store.revokeApiKey(id)
  }

  /** The key's record if `key` is a live API key. Updates its last-used time at most once a minute. */
  verifyApiKey(key: string): StoredApiKey | undefined {
    if (!/^duct_[0-9a-f]{12}_[\w-]{32}$/.test(key)) return undefined
    const found = this.store.apiKeyByHash(hashBytes(key))
    if (found && (!found.lastUsedAt || Date.now() - found.lastUsedAt > 60_000)) this.store.touchApiKey(found.id)
    return found
  }

  /** Throws FeatureDisabledError when the feature is off. */
  requireFeature(name: Exclude<keyof Features, 'formats'>): void {
    if (!this.features[name]) throw new FeatureDisabledError(name)
  }

  /** The embedder, unless search by meaning is switched off. */
  private get activeEmbedder(): EmbeddingProvider | null {
    return this.features.semanticSearch ? this.embedder : null
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
      if (isUrl(p) && !this.features.webPages) throw new FeatureDisabledError('webPages')
      try {
        resolved.push(...(await findFiles(p)).filter(f => isUrl(f) || formatAllowed(this.features, f)))
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

    if (this.activeEmbedder && totalChunks > 0) await this.embedPending()
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
        const print = fingerprint(path)
        mtimeMs = print.mtimeMs
        size = print.size
        // Unchanged since last time: same timestamp and size, or the same bytes.
        if (usable && !metaChanged && existing.mtimeMs === mtimeMs && existing.size === size) return { status: 'skipped', chunks: 0 }
        hash = print.hash()
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
      // Not really this kind of file (e.g. a TLS key named "server.key"): skip it without reporting a failure.
      if (err instanceof UnsupportedFileError) return { status: 'skipped', chunks: 0 }
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
    // Emails and archives: each part (body, attachment, file in the ZIP) is chunked under its own heading.
    if (doc.sections) {
      const all: Chunk[] = []
      for (const section of doc.sections) {
        for (const c of chunk(section.text, path, doc.format, this.chunkStrategy, this.chunkSize, this.chunkOverlap)) {
          all.push({ ...c, heading: section.title, index: all.length })
        }
      }
      return all
    }
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
    const embedder = this.activeEmbedder
    if (!embedder) return
    if (this.embedding) return this.embedding
    // A provider that failed (missing key, unreachable server) isn't retried until the settings change.
    if (this.embedError) return
    const model = this.embedKey()
    const run = async () => {
      while (this.activeEmbedder === embedder) {
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

  /**
   * Searches the index. `filter` matches document metadata exactly; `scope` narrows the search to some
   * formats and/or one folder.
   */
  async search(query: string, topK = 10, filter?: Record<string, unknown>, scope?: SearchScope): Promise<SearchResult[]> {
    const fetchK = Math.max(topK * 3, 30)
    const activeFilter = filter && Object.keys(filter).length > 0 ? filter : undefined
    // Switched-off file families are hidden, and so are file-name matches when that feature is off.
    const allowed = enabledFormats(this.features)
    if (allowed || !this.features.fileNameSearch) {
      const formats = allowed ? (scope?.formats ? scope.formats.filter(f => allowed.includes(f)) : allowed) : scope?.formats
      if (formats && formats.length === 0) return []
      scope = { ...scope, ...(formats ? { formats } : {}), ...(this.features.fileNameSearch ? {} : { fileNames: false }) }
    }
    let results: SearchResult[]
    const embedder = this.activeEmbedder

    if ((this.searchMode === 'vector' || this.searchMode === 'hybrid') && embedder) {
      try {
        const queryEmb = embedder.embedQuery ? await embedder.embedQuery(query) : (await embedder.embed([query]))[0]
        const vectorResults = this.store.searchVectors(queryEmb, this.embedKey(), fetchK, activeFilter, scope)
        if (this.searchMode === 'vector' && vectorResults.length > 0) {
          results = vectorResults
        } else {
          const textResults = this.store.searchText(query, fetchK, activeFilter, scope)
          results = vectorResults.length > 0 ? reciprocalRankFusion(textResults, vectorResults, fetchK, this.searchAlpha) : textResults
        }
      } catch {
        results = this.store.searchText(query, fetchK, activeFilter, scope)
      }
    } else {
      results = this.store.searchText(query, fetchK, activeFilter, scope)
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

  /**
   * A first look at the library: how many invoices, contracts, CVs… (from names and opening text, on this
   * computer), and a few searches that find something in it. Looks at the newest 5,000 documents.
   */
  async discover(): Promise<Discovery> {
    const docs = this.store.openings(5000)
    const kinds = summarizeKinds(docs)
    // Alternate a search for the kind of document with a name from the person's own files.
    const tries = triesFor(kinds)
    const names = recurringNames(docs.map(d => d.text))
    const candidates = [...new Set(Array.from({ length: Math.max(tries.length, names.length) }, (_, i) => [tries[i], names[i]]).flat().filter((q): q is string => !!q))]
    const suggestions: string[] = []
    for (const q of candidates) {
      if (suggestions.length >= 4) break
      if ((await this.search(q, 1)).length > 0) suggestions.push(q)
    }
    return { documents: this.store.coverage().documents, kinds: kinds.slice(0, 6), suggestions }
  }

  /**
   * For a search that found nothing: what was searched, what couldn't be (scans without text, locked or
   * unreadable files, files still being read), whether the filters hid results, and a spelling suggestion.
   */
  async searchHelp(query: string, filter?: Record<string, unknown>, scope?: SearchScope): Promise<SearchHelp> {
    const coverage = this.store.coverage()
    const filtered = (filter && Object.keys(filter).length > 0) || (scope && Object.keys(scope).length > 0)
    const outsideFilters = filtered ? (await this.search(query, 100)).length : 0
    const didYouMean = this.store.suggestSpelling(query)
    return {
      ...coverage,
      indexing: this.progress.active > 0 ? { done: this.progress.done, total: this.progress.total } : null,
      outsideFilters,
      ...(didYouMean ? { didYouMean } : {}),
    }
  }

  async ask(query: string, topK = 5): Promise<QAResult> {
    this.requireFeature('ask')
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
    this.requireFeature('schemaExtraction')
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
    this.requireFeature('diff')
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
    this.requireFeature('ask')
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
    this.requireFeature('watchedFolders')
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
    if (!this.features.watchedFolders) return restored
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
    if (!this.features.watchedFolders) return
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
      if (inIgnoredFolder(fullPath, dir)) return
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
      const pkg = packageOf(fullPath)
      if (pkg && existsSync(pkg)) return (await this.index(pkg, undefined, { source: 'watch' })).documents > 0
      if (existsSync(fullPath)) {
        const isDir = statSync(fullPath).isDirectory()
        if (!isDir && !isSupportedFile(fullPath)) return false
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
    return doc ? toInfo(doc, this.store.tagsFor(doc.path)) : undefined
  }

  /** Replaces a document's tags (trimmed, de-duplicated, at most 20 of up to 60 characters). Returns them. */
  setTags(path: string, tags: string[]): string[] {
    const doc = this.findDocument(path)
    if (!doc) throw new Error('Document not found')
    const clean = [...new Set(tags.map(t => String(t).normalize('NFC').replace(/\s+/g, ' ').trim()).filter(t => t.length > 0 && t.length <= 60))].slice(0, 20)
    this.store.setTags(doc.path, clean)
    return clean
  }

  /** Every tag in use, with how many documents carry it. */
  listTags(): { tag: string; count: number }[] {
    return this.store.allTags()
  }

  /** The indexed document with exactly these bytes (sha256 hex), if any. */
  findDocumentByHash(hash: string): DocumentInfo | undefined {
    const doc = this.store.findByHash(hash)
    if (!doc) return undefined
    const { id: _id, mtimeMs: _m, contentHash: _h, ...info } = doc
    return info
  }

  getDocuments(): DocumentInfo[] {
    const tags = this.store.tagMap()
    return this.store.listDocuments().map(d => toInfo(d, tags.get(d.path) ?? []))
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

function toInfo(doc: StoredDocument, tags: string[]): DocumentInfo {
  const { id: _id, mtimeMs, contentHash: _h, ...info } = doc
  return { ...info, ...(mtimeMs != null ? { modifiedAt: Math.round(mtimeMs) } : {}), ...(tags.length ? { tags } : {}) }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size))
  return chunks
}

export { HybridSearcher, reciprocalRankFusion, extractUrl, isUrl, extractTablesFromContent }
export { FeatureDisabledError, FEATURE_NAMES, FEATURE_LABELS, FORMAT_KINDS, defaultFeatures } from './features.js'
export type { Features, FeaturesPatch, FeatureName } from './features.js'
export type { AuditEntry, StoredApiKey } from './store/sqlite.js'
export type { SearchResult, SearchHelp, MatchReason, SearchScope } from './types.js'
export type { Discovery, DocumentKind } from './discover.js'
