import express from 'express'
import multer from 'multer'
import rateLimit from 'express-rate-limit'
import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Duct, StoredApiKey, TextInput } from '../index.js'
import type { DocumentFormat, DocumentInfo, SearchResult } from '../types.js'
import { FeatureDisabledError } from '../features.js'
import { FORMATS, SUPPORTED_SUMMARY, isSupportedFile, pageLabel } from '../formats.js'
import { safeFileName } from '../library.js'
import { VERSION } from '../version.js'
import { Collections, COLLECTION_NAME } from './collections.js'
import { openApiSpec } from './openapi.js'

export const API_SCOPES = ['search', 'write', 'admin'] as const
export type ApiScope = typeof API_SCOPES[number]

/** Document ids are the developer's own: letters, digits and . _ : @ -, up to 200 characters. */
export const DOCUMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/
const MAX_BULK = 1000
const MAX_TEXT = 5_000_000
const MAX_RESULTS = 1000
const TEXT_PREFIX = 'text:'

export interface ApiOptions {
  /** The server's admin token; it works as a key with every scope. */
  adminToken?: string
  uploadLimitMb?: number
}

interface Caller {
  scopes: ApiScope[]
  collections: string[] | null
  keyId: string | null
}

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

/** Search snippets mark matches with \u0002…\u0003; the API returns plain text plus an HTML-safe version with <mark>. */
function snippetParts(raw: string | undefined, fallback: string): { snippet: string; highlight: string } {
  const text = raw ?? fallback.slice(0, 240)
  const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
  return {
    snippet: text.replace(/[\u0002\u0003]/g, ''),
    highlight: escape(text).replace(/\u0002/g, '<mark>').replace(/\u0003/g, '</mark>'),
  }
}

function idOf(path: string): string {
  return path.startsWith(TEXT_PREFIX) ? path.slice(TEXT_PREFIX.length) : basename(dirname(path))
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value !== '' ? Number(value) : NaN
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Metadata values must be strings, numbers, booleans or null, so every field can be filtered and counted. */
function checkMetadata(value: unknown, where: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (!plainObject(value)) throw new ApiError(400, 'invalid_metadata', `${where}: metadata must be an object`)
  for (const [k, v] of Object.entries(value)) {
    if (!k || k.length > 100 || /["\\]/.test(k)) throw new ApiError(400, 'invalid_metadata', `${where}: invalid metadata field name "${k}"`)
    if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) throw new ApiError(400, 'invalid_metadata', `${where}: metadata "${k}" must be a string, number, boolean or null`)
  }
  return value
}

function textInput(body: unknown, where: string): TextInput {
  if (!plainObject(body)) throw new ApiError(400, 'invalid_document', `${where}: a document must be an object`)
  const { text, pages, title, metadata, format } = body
  if (pages !== undefined && (!Array.isArray(pages) || !pages.every(p => typeof p === 'string'))) throw new ApiError(400, 'invalid_document', `${where}: "pages" must be a list of strings`)
  if (pages === undefined && typeof text !== 'string') throw new ApiError(400, 'invalid_document', `${where}: "text" (a string) or "pages" is required`)
  const size = typeof text === 'string' ? text.length : (pages as string[]).reduce((n, p) => n + p.length, 0)
  if (size > MAX_TEXT) throw new ApiError(413, 'too_large', `${where}: text is limited to ${MAX_TEXT} characters`)
  if (title !== undefined && (typeof title !== 'string' || title.length > 500)) throw new ApiError(400, 'invalid_document', `${where}: "title" must be a string of up to 500 characters`)
  if (format !== undefined && format !== 'txt' && format !== 'md') throw new ApiError(400, 'invalid_document', `${where}: "format" must be "txt" or "md"`)
  return { ...(pages ? { pages: pages as string[] } : { text: text as string }), ...(title ? { title: title as string } : {}), metadata: checkMetadata(metadata, where), ...(format ? { format: format as 'txt' | 'md' } : {}) }
}

/**
 * The developer API: versioned, key-authenticated endpoints for apps that add document search, separate from
 * the /api endpoints the Duct UI uses. Mounted at /v1 by createServer().
 */
export function createApiRouter(duct: Duct, collections: Collections, opts: ApiOptions = {}): express.Router {
  const router = express.Router()
  const maxMb = opts.uploadLimitMb ?? 50
  const incoming = join(tmpdir(), 'duct-api-incoming')

  router.get('/openapi.json', (_req, res) => { res.json(openApiSpec()) })

  router.use((_req, _res, next) => {
    if (!duct.getFeatures().developerApi) return next(new FeatureDisabledError('developerApi'))
    next()
  })

  // Every other route needs a key: "Authorization: Bearer duct_…". Cookies are never accepted, so browsers
  // can't be tricked into calling the API (no CSRF).
  router.use((req, res, next) => {
    const header = req.headers.authorization
    const given = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    let caller: Caller | undefined
    if (given && opts.adminToken && sameSecret(given, opts.adminToken)) caller = { scopes: [...API_SCOPES], collections: null, keyId: null }
    else if (given) {
      const key = duct.verifyApiKey(given)
      if (key) caller = { scopes: key.scopes.filter((s): s is ApiScope => (API_SCOPES as readonly string[]).includes(s)), collections: key.collections, keyId: key.id }
    }
    if (!caller) {
      res.setHeader('WWW-Authenticate', 'Bearer')
      res.status(401).json({ error: 'A valid API key is required: Authorization: Bearer duct_…', code: 'unauthorized' })
      return
    }
    res.locals.caller = caller
    next()
  })

  router.use(express.json({ limit: '10mb' }))

  router.use(rateLimit({
    windowMs: 60_000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (_req, res) => (res.locals.caller as Caller).keyId ?? 'admin',
    message: { error: 'Rate limit: 600 requests per minute per key.', code: 'rate_limited' },
  }))

  const allows = (caller: Caller, scope: ApiScope) => caller.scopes.includes('admin') || caller.scopes.includes(scope) || (scope === 'search' && caller.scopes.includes('write'))
  const need = (scope: ApiScope): express.RequestHandler => (_req, res, next) => {
    if (allows(res.locals.caller, scope)) next()
    else next(new ApiError(403, 'insufficient_scope', `This key needs the "${scope}" scope`))
  }
  const mayUse = (caller: Caller, name: string) => !caller.collections || caller.collections.includes(name)

  /** The collection named in the URL, if it exists and this key may use it. */
  const collection = (req: express.Request, res: express.Response) => {
    const name = req.params.collection as string
    const index = mayUse(res.locals.caller, name) ? collections.get(name) : undefined
    if (!index) throw new ApiError(404, 'collection_not_found', `No collection "${name}"`)
    return { name, index }
  }

  const findDocument = (name: string, index: Duct, id: string): DocumentInfo | undefined => {
    const text = index.getDocument(TEXT_PREFIX + id)
    if (text) return text
    const dir = join(collections.filesDir(name), id)
    if (!existsSync(dir)) return undefined
    const file = readdirSync(dir)[0]
    return file ? index.getDocument(join(dir, file)) : undefined
  }

  const removeDocument = async (name: string, index: Duct, id: string): Promise<boolean> => {
    const doc = findDocument(name, index, id)
    if (!doc) return false
    await index.removeDocument(doc.path)
    if (!doc.path.startsWith(TEXT_PREFIX)) rmSync(dirname(doc.path), { recursive: true, force: true })
    return true
  }

  const documentJson = (doc: DocumentInfo, text?: string) => ({
    id: idOf(doc.path),
    title: doc.displayName && doc.displayName !== doc.path ? doc.displayName : null,
    format: doc.format,
    status: doc.status ?? 'indexed',
    ...(doc.error ? { error: doc.error } : {}),
    chunks: doc.chunkCount,
    size: doc.size,
    indexed_at: new Date(doc.indexedAt).toISOString(),
    metadata: doc.metadata,
    ...(text !== undefined ? { text } : {}),
  })

  const wrap = (fn: (req: express.Request, res: express.Response) => Promise<void> | void): express.RequestHandler =>
    (req, res, next) => { Promise.resolve().then(() => fn(req, res)).catch(next) }

  // ---------- service ----------

  router.get('/', (_req, res) => {
    const caller = res.locals.caller as Caller
    res.json({ version: VERSION, api: 'v1', scopes: caller.scopes, collections: collections.list().filter(c => mayUse(caller, c)), semantic: duct.semanticAvailable() })
  })

  // ---------- collections ----------

  router.get('/collections', need('search'), (_req, res) => {
    const caller = res.locals.caller as Caller
    res.json({ collections: collections.list().filter(c => mayUse(caller, c)).map(name => ({ name, ...collections.get(name)!.stats() })) })
  })

  router.post('/collections', need('admin'), wrap((req, res) => {
    const name = req.body?.name
    if (typeof name !== 'string' || !COLLECTION_NAME.test(name)) throw new ApiError(400, 'invalid_name', 'Collection names use lower-case letters, digits, "-" and "_" (up to 63 characters)')
    if (!mayUse(res.locals.caller, name)) throw new ApiError(403, 'forbidden', 'This key may not create that collection')
    if (collections.has(name)) throw new ApiError(409, 'collection_exists', `Collection "${name}" already exists`)
    const mode = req.body?.settings?.search_mode
    if (mode !== undefined && !['bm25', 'vector', 'hybrid'].includes(mode)) throw new ApiError(400, 'invalid_settings', 'search_mode must be bm25, vector or hybrid')
    const ocr = req.body?.settings?.ocr
    const index = collections.create(name, { searchMode: mode, ocr: typeof ocr === 'boolean' ? ocr : undefined })
    res.status(201).json({ name, ...index.stats(), search_mode: index.getConfig().searchMode, semantic: index.semanticAvailable() })
  }))

  router.get('/collections/:collection', need('search'), wrap((req, res) => {
    const { name, index } = collection(req, res)
    const cfg = index.getConfig()
    res.json({ name, ...index.stats(), search_mode: cfg.searchMode, ocr: cfg.ocr, semantic: index.semanticAvailable(), indexing: index.activity() })
  }))

  router.delete('/collections/:collection', need('admin'), wrap((req, res) => {
    const { name } = collection(req, res)
    collections.delete(name)
    res.status(204).end()
  }))

  // ---------- documents ----------

  router.get('/collections/:collection/documents', need('search'), wrap((req, res) => {
    const { index } = collection(req, res)
    const limit = int(req.query.limit, 20, 1, 100)
    const offset = int(req.query.offset, 0, 0, 1_000_000)
    const page = index.pageDocuments(limit, offset)
    res.json({ documents: page.documents.map(d => documentJson(d)), total: page.total, offset, limit })
  }))

  // Bulk: { documents: [{ id, text | pages, title?, metadata?, format? }, …] }, up to 1000 at a time.
  router.post('/collections/:collection/documents', need('write'), wrap(async (req, res) => {
    const { index } = collection(req, res)
    const list = Array.isArray(req.body?.documents) ? req.body.documents : null
    if (!list || list.length === 0) throw new ApiError(400, 'invalid_request', 'Send { "documents": [ { "id", "text", … } ] }')
    if (list.length > MAX_BULK) throw new ApiError(413, 'too_many', `At most ${MAX_BULK} documents per request`)
    // Validate everything first, so a bad document doesn't leave half a batch indexed.
    const parsed = list.map((d: unknown, i: number) => {
      const id = plainObject(d) ? d.id : undefined
      if (typeof id !== 'string' || !DOCUMENT_ID.test(id)) throw new ApiError(400, 'invalid_id', `documents[${i}]: "id" must match ${DOCUMENT_ID}`)
      return { id, input: textInput(d, `documents[${i}]`) }
    })
    const results = []
    for (const { id, input } of parsed) results.push({ id, ...(await index.indexText(TEXT_PREFIX + id, input)) })
    res.json({ results })
  }))

  router.put('/collections/:collection/documents/:id', need('write'), wrap(async (req, res) => {
    const { name, index } = collection(req, res)
    const id = req.params.id as string
    if (!DOCUMENT_ID.test(id)) throw new ApiError(400, 'invalid_id', `Document ids must match ${DOCUMENT_ID}`)
    const input = textInput(req.body, 'document')
    // An id belongs to one document: text replaces an uploaded file with the same id.
    const existing = findDocument(name, index, id)
    if (existing && !existing.path.startsWith(TEXT_PREFIX)) await removeDocument(name, index, id)
    res.json({ id, ...(await index.indexText(TEXT_PREFIX + id, input)) })
  }))

  router.get('/collections/:collection/documents/:id', need('search'), wrap((req, res) => {
    const { name, index } = collection(req, res)
    const doc = findDocument(name, index, req.params.id as string)
    if (!doc) throw new ApiError(404, 'document_not_found', 'No document with that id')
    res.json(documentJson(doc, req.query.include === 'text' ? (index.documentText(doc.path) ?? '') : undefined))
  }))

  router.delete('/collections/:collection/documents/:id', need('write'), wrap(async (req, res) => {
    const { name, index } = collection(req, res)
    if (!(await removeDocument(name, index, req.params.id as string))) throw new ApiError(404, 'document_not_found', 'No document with that id')
    res.status(204).end()
  }))

  // A file (PDF, Word, scan…) read by Duct's extractors: multipart field "file", optional "id", "title" and "metadata" (JSON).
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => { mkdirSync(incoming, { recursive: true }); cb(null, incoming) },
      filename: (_req, _file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    }),
    limits: { fileSize: maxMb * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (isSupportedFile(file.originalname)) cb(null, true)
      else cb(new ApiError(415, 'unsupported_type', `Unsupported file type. Duct reads ${SUPPORTED_SUMMARY}.`))
    },
  })

  router.post('/collections/:collection/files', need('write'), (req, res, next) => {
    try { collection(req, res) } catch (err) { return next(err) }
    upload.single('file')(req, res, err => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') return next(new ApiError(413, 'too_large', `Files are limited to ${maxMb} MB`))
      if (err) return next(err)
      next()
    })
  }, wrap(async (req, res) => {
    const file = req.file
    try {
      if (!file) throw new ApiError(400, 'invalid_request', 'Send the file in a multipart field named "file"')
      const { name, index } = collection(req, res)
      const id = typeof req.body?.id === 'string' && req.body.id ? req.body.id : createHash('sha256').update(file.originalname + file.size + Date.now()).digest('hex').slice(0, 16)
      if (!DOCUMENT_ID.test(id)) throw new ApiError(400, 'invalid_id', `Document ids must match ${DOCUMENT_ID}`)
      let metadata: Record<string, unknown> | undefined
      if (typeof req.body?.metadata === 'string' && req.body.metadata) {
        try { metadata = checkMetadata(JSON.parse(req.body.metadata), 'metadata') } catch (e) { throw e instanceof ApiError ? e : new ApiError(400, 'invalid_metadata', 'metadata must be a JSON object') }
      }
      const title = typeof req.body?.title === 'string' && req.body.title ? req.body.title.slice(0, 500) : file.originalname
      await removeDocument(name, index, id)
      const dir = join(collections.filesDir(name), id)
      mkdirSync(dir, { recursive: true })
      const path = join(dir, safeFileName(file.originalname))
      renameSync(file.path, path)
      const result = await index.index(path, metadata ?? {}, { source: 'api', displayName: title })
      const doc = index.getDocument(path)
      res.status(doc?.status === 'failed' ? 422 : 200).json({ id, ...(doc ? documentJson(doc) : {}), documents: result.documents })
    } finally {
      if (file && existsSync(file.path)) rmSync(file.path, { force: true })
    }
  }))

  // ---------- search ----------

  const search = wrap(async (req, res) => {
    const { index } = collection(req, res)
    const p = req.method === 'GET' ? req.query : (req.body ?? {})
    const q = typeof p.q === 'string' ? p.q.trim() : ''
    const limit = int(p.limit, 10, 1, 100)
    const offset = int(p.offset, 0, 0, MAX_RESULTS - limit)
    let filter: Record<string, unknown> | undefined
    const rawFilter = typeof p.filter === 'string' ? (() => { try { return JSON.parse(p.filter) } catch { throw new ApiError(400, 'invalid_filter', 'filter must be a JSON object') } })() : p.filter
    if (rawFilter !== undefined) filter = checkMetadata(rawFilter, 'filter')
    const list = (v: unknown) => Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? v.split(',') : []
    const facetFields = list(p.facets).slice(0, 10)
    const formats = list(p.formats)
    const known = new Set<string>([...FORMATS.map(f => f.format), 'url'])
    if (formats.some(f => !known.has(f))) throw new ApiError(400, 'invalid_formats', `Unknown format in "formats". Known: ${[...known].join(', ')}`)
    const group = p.group === 'passage' ? 'passage' : 'document'
    // sort=<metadata field>:asc|desc orders the matches by that field instead of relevance (missing values last).
    const sortMatch = typeof p.sort === 'string' && p.sort ? /^([^:"\\]{1,100}):(asc|desc)$/.exec(p.sort) : null
    if (typeof p.sort === 'string' && p.sort && !sortMatch) throw new ApiError(400, 'invalid_sort', 'sort must look like "year:desc"')
    const scope = formats.length ? { formats: formats as DocumentFormat[] } : undefined
    const started = Date.now()

    let hits: object[] = []
    let hasMore = false
    if (q) {
      const wanted = offset + limit + 1
      const results: SearchResult[] = await index.search(q, Math.min(MAX_RESULTS * 3, group === 'document' ? wanted * 3 : wanted), filter, scope)
      const picked: SearchResult[] = []
      const seen = new Set<string>()
      for (const r of results) {
        if (group === 'document') { if (seen.has(r.chunk.documentPath)) continue; seen.add(r.chunk.documentPath) }
        picked.push(r)
      }
      if (sortMatch) {
        const [, field, dir] = sortMatch
        const sign = dir === 'asc' ? 1 : -1
        const val = (r: SearchResult) => r.chunk.metadata?.[field] as string | number | boolean | null | undefined
        picked.sort((a, b) => {
          const x = val(a), y = val(b)
          if (x == null || y == null) return x == null && y == null ? 0 : x == null ? 1 : -1
          return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * sign
        })
      }
      hasMore = picked.length > offset + limit
      hits = picked.slice(offset, offset + limit).map(r => {
        const meta = { ...(r.chunk.metadata ?? {}) }
        const title = typeof meta.title === 'string' ? meta.title : null
        delete meta.title
        return {
          id: idOf(r.chunk.documentPath),
          title,
          score: Math.round(r.score * 10000) / 10000,
          format: r.chunk.documentFormat,
          ...(r.chunk.page ? { page: r.chunk.page, page_label: `${pageLabel(r.chunk.documentFormat)} ${r.chunk.page}` } : {}),
          ...(r.chunk.heading ? { heading: r.chunk.heading } : {}),
          ...snippetParts(r.snippet, r.chunk.content),
          metadata: meta,
        }
      })
    }
    const facets = facetFields.length ? index.facets(q, facetFields, 20, filter, scope) : undefined
    res.json({ hits, offset, limit, has_more: hasMore, ...(facets ? { facets } : {}), took_ms: Date.now() - started })
  })
  router.get('/collections/:collection/search', need('search'), search)
  router.post('/collections/:collection/search', need('search'), search)

  // ---------- keys ----------

  router.get('/keys', need('admin'), (_req, res) => {
    res.json({ keys: duct.listApiKeys().map(keyJson) })
  })

  router.post('/keys', need('admin'), wrap((req, res) => {
    const caller = res.locals.caller as Caller
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 100) : ''
    const scopes = Array.isArray(req.body?.scopes) ? req.body.scopes : ['search']
    const wanted = req.body?.collections
    if (!name) throw new ApiError(400, 'invalid_request', '"name" is required')
    if (!scopes.length || !scopes.every((s: unknown) => (API_SCOPES as readonly unknown[]).includes(s))) throw new ApiError(400, 'invalid_scopes', `scopes must be among: ${API_SCOPES.join(', ')}`)
    if (wanted !== undefined && wanted !== null && (!Array.isArray(wanted) || !wanted.every((c: unknown) => typeof c === 'string' && COLLECTION_NAME.test(c)))) {
      throw new ApiError(400, 'invalid_collections', 'collections must be a list of collection names, or null for all')
    }
    // A key can't hand out more than it has.
    const limited = caller.collections ? (Array.isArray(wanted) ? wanted.filter((c: string) => caller.collections!.includes(c)) : caller.collections) : (wanted ?? null)
    const created = duct.createApiKey(name, scopes, limited)
    res.status(201).json({ ...keyJson(duct.listApiKeys().find(k => k.id === created.id)!), key: created.key })
  }))

  router.delete('/keys/:id', need('admin'), wrap((req, res) => {
    if (!duct.revokeApiKey(req.params.id as string)) throw new ApiError(404, 'key_not_found', 'No key with that id')
    res.status(204).end()
  }))

  // ---------- errors ----------

  router.use((_req, res) => { res.status(404).json({ error: 'Not found', code: 'not_found' }) })
  router.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ApiError) { res.status(err.status).json({ error: err.message, code: err.code }); return }
    if (err instanceof FeatureDisabledError) { res.status(403).json({ error: err.message, code: 'feature_disabled', feature: err.feature }); return }
    const e = err as { type?: string; message?: string }
    if (e.type === 'entity.too.large') { res.status(413).json({ error: 'Request body too large', code: 'too_large' }); return }
    if (e.type === 'entity.parse.failed') { res.status(400).json({ error: 'Invalid JSON', code: 'invalid_json' }); return }
    res.status(500).json({ error: e.message || 'Server error', code: 'server_error' })
  })

  return router
}

function keyJson(k: StoredApiKey) {
  return {
    id: k.id, name: k.name, scopes: k.scopes, collections: k.collections,
    created_at: new Date(k.createdAt).toISOString(), last_used_at: k.lastUsedAt ? new Date(k.lastUsedAt).toISOString() : null,
  }
}
