import { createRequire } from 'node:module'
import { sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Chunk, DocumentFormat, DocumentInfo, SearchResult, SearchScope } from '../types.js'

const require = createRequire(import.meta.url)

const SCHEMA_VERSION = '2'
const SNIPPET_TOKENS = 32
const VERSIONS_KEPT = 2

function openDatabase(path: string): DatabaseSync {
  // Some Node versions print an ExperimentalWarning when node:sqlite loads; keep CLI output clean.
  const original = process.emitWarning
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === 'string' ? warning : warning.message
    if (/sqlite/i.test(message)) return
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest)
  }) as typeof process.emitWarning
  try {
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
    return new DatabaseSync(path)
  } finally {
    process.emitWarning = original
  }
}

export interface StoredDocument extends DocumentInfo {
  id: number
  mtimeMs: number | null
  contentHash: string | null
}

export interface NewDocument {
  path: string
  displayName: string
  source: string
  format: DocumentFormat
  size: number
  mtimeMs: number | null
  contentHash: string
  status: 'indexed' | 'no-text' | 'failed'
  error?: string
  metadata: Record<string, unknown>
  chunkMetadata: Record<string, unknown>
}

interface DocumentRow {
  id: number
  path: string
  display_name: string
  source: string
  format: string
  size: number
  mtime_ms: number | null
  content_hash: string | null
  chunk_count: number
  indexed_at: number
  status: string
  error: string | null
  metadata: string
}

interface ChunkRow {
  uid: string
  idx: number
  heading: string
  page: number | null
  snippet?: string
  content: string
  path: string
  format: string
  chunk_metadata: string
  score?: number
}

interface VectorEntry { chunk: Chunk; vector: Float32Array; norm: number; meta: Record<string, unknown> }

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu

/** Turns a user query into an FTS5 expression: "quoted phrases" stay phrases, other words are OR'ed. */
export function toFtsQuery(input: string): string | null {
  const parts: string[] = []
  const words = (s: string) => (s.normalize('NFKC').replace(CJK, ' ').match(/[\p{L}\p{N}]+/gu) || [])
  for (const m of input.matchAll(/"([^"]+)"|(\S+)/g)) {
    const tokens = words(m[1] ?? m[2])
    if (tokens.length === 0) continue
    if (m[1] !== undefined && tokens.length > 1) parts.push(`"${tokens.join(' ')}"`)
    else for (const t of tokens) parts.push(`"${t}"`)
  }
  return parts.length > 0 ? parts.join(' OR ') : null
}

function cjkSegments(input: string): string[] {
  return [...input.normalize('NFKC').matchAll(CJK)].map(m => m[0])
}

function filterClause(filter: Record<string, unknown> | undefined, scope?: SearchScope): { sql: string; params: (string | number | null)[] } | null {
  let sql = ''
  const params: (string | number | null)[] = []
  if (scope?.formats?.length) {
    sql += ` AND d.format IN (${scope.formats.map(() => '?').join(', ')})`
    params.push(...scope.formats)
  }
  if (scope?.under) {
    const prefix = scope.under.endsWith(sep) ? scope.under : scope.under + sep
    sql += " AND (d.path = ? OR d.path LIKE ? ESCAPE '\\')"
    params.push(scope.under, likePattern(prefix).slice(1))
  }
  if (!filter) return { sql, params }
  for (const [key, value] of Object.entries(filter)) {
    if (/["\\]/.test(key)) return null
    let bound: string | number | null
    if (value === null) bound = null
    else if (typeof value === 'boolean') bound = value ? 1 : 0
    else if (typeof value === 'string' || typeof value === 'number') bound = value
    else return null
    sql += ` AND json_extract(d.chunk_metadata, '$."${key}"') IS ?`
    params.push(bound)
  }
  return { sql, params }
}

/** An excerpt around the first match, with every match wrapped in \u0002 … \u0003 (same markers as FTS5's snippet()). */
export function substringSnippet(content: string, needles: string[], radius = 80): string {
  const first = Math.min(...needles.map(n => content.indexOf(n)).filter(i => i >= 0))
  if (!Number.isFinite(first)) return content.slice(0, radius * 2)
  const start = Math.max(0, first - radius)
  const end = Math.min(content.length, first + radius)
  let excerpt = content.slice(start, end)
  for (const n of needles) excerpt = excerpt.split(n).join(`\u0002${n}\u0003`)
  return (start > 0 ? '…' : '') + excerpt + (end < content.length ? '…' : '')
}

function likePattern(s: string): string {
  return '%' + s.replace(/[\\%_]/g, c => '\\' + c) + '%'
}

export class SqliteStore {
  private db: DatabaseSync
  private vectorCache = new Map<string, VectorEntry[]>()

  constructor(readonly path: string) {
    this.db = openDatabase(path)
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'path',
        format TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        mtime_ms REAL,
        content_hash TEXT,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        indexed_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'indexed',
        error TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        chunk_metadata TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS documents_hash ON documents(content_hash);
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY,
        uid TEXT NOT NULL UNIQUE,
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        heading TEXT NOT NULL DEFAULT '',
        page INTEGER,
        content TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chunks_document ON chunks(document_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        content, heading, content='chunks', content_rowid='id',
        tokenize='porter unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, content, heading) VALUES (new.id, new.content, new.heading);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content, heading) VALUES ('delete', old.id, old.content, old.heading);
      END;
      CREATE TABLE IF NOT EXISTS vectors (
        chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        embedding BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        version INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS versions_path ON versions(path, version);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources (path TEXT PRIMARY KEY, kind TEXT NOT NULL, added_at INTEGER NOT NULL);
    `)
    // v1 -> v2: chunks gained a page number. Re-extract PDFs and slide decks so their chunks get one.
    const columns = this.db.prepare('PRAGMA table_info(chunks)').all() as unknown as { name: string }[]
    if (!columns.some(c => c.name === 'page')) {
      this.db.exec("ALTER TABLE chunks ADD COLUMN page INTEGER; UPDATE documents SET mtime_ms = NULL, content_hash = '' WHERE format IN ('pdf', 'pptx');")
    }
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('schema_version', SCHEMA_VERSION)
  }

  close(): void {
    this.db.close()
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  private changed(): void {
    this.vectorCache.clear()
  }

  // ---------- documents ----------

  private toDocument(row: DocumentRow): StoredDocument {
    return {
      id: row.id,
      path: row.path,
      displayName: row.display_name,
      source: row.source,
      format: row.format as DocumentFormat,
      chunkCount: row.chunk_count,
      size: row.size,
      indexedAt: row.indexed_at,
      status: row.status as StoredDocument['status'],
      error: row.error ?? undefined,
      metadata: JSON.parse(row.metadata),
      mtimeMs: row.mtime_ms,
      contentHash: row.content_hash,
    }
  }

  getDocument(path: string): StoredDocument | undefined {
    const row = this.db.prepare('SELECT * FROM documents WHERE path = ?').get(path) as DocumentRow | undefined
    return row ? this.toDocument(row) : undefined
  }

  findByHash(hash: string): StoredDocument | undefined {
    const row = this.db.prepare("SELECT * FROM documents WHERE content_hash = ? AND status != 'failed' LIMIT 1").get(hash) as DocumentRow | undefined
    return row ? this.toDocument(row) : undefined
  }

  /** Documents that need re-extracting: migrated from an older index format and not failed. */
  staleDocuments(): StoredDocument[] {
    return (this.db.prepare("SELECT * FROM documents WHERE (content_hash IS NULL OR content_hash = '') AND status != 'failed'").all() as unknown as DocumentRow[]).map(r => this.toDocument(r))
  }

  listDocuments(): StoredDocument[] {
    return (this.db.prepare('SELECT * FROM documents ORDER BY indexed_at DESC').all() as unknown as DocumentRow[]).map(r => this.toDocument(r))
  }

  /** Documents at `dir` or anywhere below it. */
  documentsUnder(dir: string): StoredDocument[] {
    const prefix = dir.endsWith(sep) ? dir : dir + sep
    const rows = this.db.prepare("SELECT * FROM documents WHERE path = ? OR path LIKE ? ESCAPE '\\'").all(dir, likePattern(prefix).slice(1)) as unknown as DocumentRow[]
    return rows.map(r => this.toDocument(r))
  }

  stats(): { documents: number; chunks: number } {
    const docs = this.db.prepare("SELECT count(*) AS n FROM documents WHERE status != 'failed'").get() as { n: number }
    const chunks = this.db.prepare('SELECT count(*) AS n FROM chunks').get() as { n: number }
    return { documents: docs.n, chunks: chunks.n }
  }

  /** Replaces a document and all its chunks atomically. Returns chunk row ids in chunk order. */
  replaceDocument(doc: NewDocument, chunks: Chunk[]): number[] {
    const ids = this.transaction(() => {
      this.db.prepare('DELETE FROM documents WHERE path = ?').run(doc.path)
      const { lastInsertRowid } = this.db.prepare(`
        INSERT INTO documents (path, display_name, source, format, size, mtime_ms, content_hash, chunk_count, indexed_at, status, error, metadata, chunk_metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(doc.path, doc.displayName, doc.source, doc.format, doc.size, doc.mtimeMs, doc.contentHash, chunks.length, Date.now(),
        doc.status, doc.error ?? null, JSON.stringify(doc.metadata), JSON.stringify(doc.chunkMetadata))
      const insert = this.db.prepare('INSERT INTO chunks (uid, document_id, idx, heading, page, content) VALUES (?, ?, ?, ?, ?, ?)')
      return chunks.map(c => Number(insert.run(c.id, lastInsertRowid, c.index, c.heading ?? '', c.page ?? null, c.content).lastInsertRowid))
    })
    this.changed()
    return ids
  }

  /** Records that a file was seen again unchanged (e.g. touched without edits). */
  touchDocument(path: string, mtimeMs: number | null, size: number): void {
    this.db.prepare('UPDATE documents SET mtime_ms = ?, size = ? WHERE path = ?').run(mtimeMs, size, path)
  }

  removeDocument(path: string): boolean {
    const { changes } = this.db.prepare('DELETE FROM documents WHERE path = ?').run(path)
    this.db.prepare('DELETE FROM versions WHERE path = ?').run(path)
    this.changed()
    return Number(changes) > 0
  }

  clear(): void {
    this.transaction(() => {
      this.db.exec('DELETE FROM documents; DELETE FROM versions;')
    })
    this.changed()
  }

  // ---------- versions (for diff) ----------

  addVersion(path: string, contentHash: string, content: string): void {
    const last = this.db.prepare('SELECT version, content_hash FROM versions WHERE path = ? ORDER BY version DESC LIMIT 1').get(path) as { version: number; content_hash: string } | undefined
    if (last?.content_hash === contentHash) return
    const version = (last?.version ?? 0) + 1
    this.db.prepare('INSERT INTO versions (path, version, content_hash, content, created_at) VALUES (?, ?, ?, ?, ?)').run(path, version, contentHash, content, Date.now())
    this.db.prepare('DELETE FROM versions WHERE path = ? AND version <= ?').run(path, version - VERSIONS_KEPT)
  }

  lastVersions(path: string): { version: number; content: string; createdAt: number }[] {
    const rows = this.db.prepare('SELECT version, content, created_at FROM versions WHERE path = ? ORDER BY version DESC LIMIT 2').all(path) as unknown as { version: number; content: string; created_at: number }[]
    return rows.reverse().map(r => ({ version: r.version, content: r.content, createdAt: r.created_at }))
  }

  // ---------- keyword search ----------

  private toChunk(row: ChunkRow): Chunk {
    return {
      id: row.uid,
      documentPath: row.path,
      documentFormat: row.format as DocumentFormat,
      content: row.content,
      index: row.idx,
      heading: row.heading || undefined,
      ...(row.page != null ? { page: row.page } : {}),
      metadata: JSON.parse(row.chunk_metadata),
    }
  }

  searchText(query: string, limit: number, filter?: Record<string, unknown>, scope?: SearchScope): SearchResult[] {
    const where = filterClause(filter, scope)
    if (!where) return []
    const merged = new Map<string, SearchResult>()

    const fts = toFtsQuery(query)
    if (fts) {
      const rows = this.db.prepare(`
        SELECT c.uid, c.idx, c.heading, c.page, c.content, d.path, d.format, d.chunk_metadata, -bm25(chunks_fts, 1.0, 2.0) AS score,
          snippet(chunks_fts, 0, char(2), char(3), '…', ${SNIPPET_TOKENS}) AS snippet
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.rowid
        JOIN documents d ON d.id = c.document_id
        WHERE chunks_fts MATCH ?${where.sql}
        ORDER BY bm25(chunks_fts, 1.0, 2.0)
        LIMIT ?
      `).all(fts, ...where.params, limit) as unknown as ChunkRow[]
      for (const r of rows) merged.set(r.uid, { chunk: this.toChunk(r), score: r.score ?? 0, snippet: r.snippet })
    }

    // File names: a document whose name contains every query word is a strong match (people search by name).
    const nameWords = (query.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(w => w.length > 2).slice(0, 8)
    if (nameWords.length) {
      const rows = this.db.prepare(`
        SELECT c.uid, c.idx, c.heading, c.page, c.content, d.path, d.format, d.chunk_metadata
        FROM documents d JOIN chunks c ON c.document_id = d.id AND c.idx = (SELECT min(idx) FROM chunks WHERE document_id = d.id)
        WHERE ${nameWords.map(() => "lower(d.display_name) LIKE ? ESCAPE '\\'").join(' AND ')}${where.sql}
        LIMIT ?
      `).all(...nameWords.map(likePattern), ...where.params, limit) as unknown as ChunkRow[]
      const best = Math.max(0, ...[...merged.values()].map(r => r.score))
      for (const r of rows) {
        const existing = merged.get(r.uid)
        if (existing) existing.score += best + 1
        else merged.set(r.uid, { chunk: this.toChunk(r), score: best + 1, snippet: r.content.slice(0, 200) })
      }
    }

    // CJK text has no spaces between words, so match it as substrings instead of tokens.
    const segments = cjkSegments(query)
    if (segments.length > 0) {
      const rows = this.db.prepare(`
        SELECT c.uid, c.idx, c.heading, c.page, c.content, d.path, d.format, d.chunk_metadata
        FROM chunks c JOIN documents d ON d.id = c.document_id
        WHERE ${segments.map(() => "c.content LIKE ? ESCAPE '\\'").join(' AND ')}${where.sql}
        LIMIT ?
      `).all(...segments.map(likePattern), ...where.params, limit) as unknown as ChunkRow[]
      for (const r of rows) {
        const hits = segments.reduce((n, s) => n + r.content.split(s).length - 1, 0)
        const score = hits / Math.sqrt(Math.max(1, r.content.length / 500))
        const existing = merged.get(r.uid)
        if (existing) existing.score += score
        else merged.set(r.uid, { chunk: this.toChunk(r), score, snippet: substringSnippet(r.content, segments) })
      }
    }

    return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit)
  }

  // ---------- vectors ----------

  addVectors(rows: { chunkRowId: number; model: string; vector: number[] }[]): void {
    // Chunks can be replaced while their embeddings are in flight; skip vectors for chunks that are gone.
    const insert = this.db.prepare('INSERT OR REPLACE INTO vectors (chunk_id, model, embedding) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM chunks WHERE id = ?)')
    this.transaction(() => {
      for (const r of rows) insert.run(r.chunkRowId, r.model, new Uint8Array(new Float32Array(r.vector).buffer), r.chunkRowId)
    })
    this.changed()
  }

  /** Chunks that have no vector for `model` yet (new chunks, or vectors from a previous embedding model). */
  chunksNeedingVectors(model: string, limit: number): { rowId: number; content: string }[] {
    return this.db.prepare(`
      SELECT c.id AS rowId, c.content FROM chunks c LEFT JOIN vectors v ON v.chunk_id = c.id
      WHERE v.chunk_id IS NULL OR v.model != ? ORDER BY c.id LIMIT ?
    `).all(model, limit) as unknown as { rowId: number; content: string }[]
  }

  /** Re-tags vectors stored under an unknown model id (e.g. migrated from the JSON index) when their size matches. */
  adoptVectors(fromModel: string, toModel: string, dims: number): void {
    this.db.prepare('UPDATE vectors SET model = ? WHERE model = ? AND length(embedding) = ?').run(toModel, fromModel, dims * 4)
    this.changed()
  }

  private loadVectors(model: string): VectorEntry[] {
    const cached = this.vectorCache.get(model)
    if (cached) return cached
    const rows = this.db.prepare(`
      SELECT c.uid, c.idx, c.heading, c.page, c.content, d.path, d.format, d.chunk_metadata, v.embedding
      FROM vectors v JOIN chunks c ON c.id = v.chunk_id JOIN documents d ON d.id = c.document_id
      WHERE v.model = ?
    `).all(model) as unknown as (ChunkRow & { embedding: Uint8Array })[]
    const entries = rows.map(r => {
      const vector = new Float32Array(r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.embedding.byteLength))
      let norm = 0
      for (const x of vector) norm += x * x
      const chunk = this.toChunk(r)
      return { chunk, vector, norm: Math.sqrt(norm), meta: chunk.metadata }
    })
    this.vectorCache.set(model, entries)
    return entries
  }

  searchVectors(query: number[], model: string, limit: number, filter?: Record<string, unknown>, scope?: SearchScope): SearchResult[] {
    const under = scope?.under ? (scope.under.endsWith(sep) ? scope.under : scope.under + sep) : undefined
    let qn = 0
    for (const x of query) qn += x * x
    qn = Math.sqrt(qn)
    if (qn === 0) return []
    const results: SearchResult[] = []
    for (const e of this.loadVectors(model)) {
      if (e.vector.length !== query.length || e.norm === 0) continue
      if (filter && Object.entries(filter).some(([k, v]) => e.meta[k] !== v)) continue
      if (scope?.formats?.length && !scope.formats.includes(e.chunk.documentFormat)) continue
      if (under && e.chunk.documentPath !== scope!.under && !e.chunk.documentPath.startsWith(under)) continue
      let dot = 0
      for (let i = 0; i < query.length; i++) dot += query[i] * e.vector[i]
      results.push({ chunk: e.chunk, score: dot / (qn * e.norm) })
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  // ---------- settings & sources ----------

  getSettings(): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as unknown as { key: string; value: string }[]
    return Object.fromEntries(rows.map(r => [r.key, JSON.parse(r.value)]))
  }

  setSettings(values: Record<string, unknown>): void {
    const upsert = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    this.transaction(() => {
      for (const [k, v] of Object.entries(values)) if (v !== undefined) upsert.run(k, JSON.stringify(v))
    })
  }

  listSources(): { path: string; kind: string }[] {
    return this.db.prepare('SELECT path, kind FROM sources ORDER BY added_at').all() as unknown as { path: string; kind: string }[]
  }

  addSource(path: string, kind: string): void {
    this.db.prepare('INSERT OR IGNORE INTO sources (path, kind, added_at) VALUES (?, ?, ?)').run(path, kind, Date.now())
  }

  removeSource(path: string): void {
    this.db.prepare('DELETE FROM sources WHERE path = ?').run(path)
  }
}
