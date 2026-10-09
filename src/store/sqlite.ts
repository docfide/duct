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

export interface AuditEntry { id: number; at: number; actor: string; role: string | null; action: string; target: string | null; detail: string | null }

export interface Notebook { id: string; name: string; createdAt: number; updatedAt: number; notes: number }
export interface Note {
  id: string
  notebookId: string
  position: number
  /** The document's path in the index. Kept even if the document is later removed. */
  path: string
  docName: string
  format: string
  page: number | null
  quote: string
  comment: string
  createdAt: number
  updatedAt: number
}

export interface StoredApiKey {
  id: string
  name: string
  scopes: string[]
  /** Collections the key may use; null means all. */
  collections: string[] | null
  createdAt: number
  lastUsedAt: number | null
}

interface ApiKeyRow {
  id: string
  name: string
  key_hash: string
  scopes: string
  collections: string | null
  created_at: number
  last_used_at: number | null
}

function toApiKey(r: ApiKeyRow): StoredApiKey {
  return { id: r.id, name: r.name, scopes: r.scopes.split(' ').filter(Boolean), collections: r.collections ? JSON.parse(r.collections) : null, createdAt: r.created_at, lastUsedAt: r.last_used_at }
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

/**
 * Turns a user query into an FTS5 expression: "quoted phrases" stay phrases, other words are OR'ed, and
 * numbers match however they were written (see numberVariants).
 */
export function toFtsQuery(input: string): string | null {
  const parts: string[] = []
  const words = (s: string) => (s.normalize('NFKC').replace(CJK, ' ').match(/[\p{L}\p{N}]+/gu) || [])
  // "1 200" typed with a space is one amount, not the words 1 and 200: join the groups first.
  const joined = input.replace(/(^|\s)(\d{1,3}(?: \d{3})+(?:[.,]\d{1,2})?)(?=\s|$)/g, (_, pre: string, num: string) => pre + num.replace(/ /g, '_'))
  for (const m of joined.matchAll(/"([^"]+)"|(\S+)/g)) {
    const numbers = m[2] !== undefined ? numberVariants(m[2]) : null
    if (numbers) { parts.push(`(${numbers.map(v => `"${v}"`).join(' OR ')})`); continue }
    const tokens = words(m[1] ?? m[2])
    if (tokens.length === 0) continue
    if (m[1] !== undefined && tokens.length > 1) parts.push(`"${tokens.join(' ')}"`)
    else for (const t of tokens) parts.push(`"${t}"`)
  }
  return parts.length > 0 ? parts.join(' OR ') : null
}

/**
 * The ways an amount can appear in a document, as FTS phrases. The tokenizer splits "1,200.00" into
 * 1 / 200 / 00, so "1200", "1,200", "1.200", "1 200" and "1,200.00" are all made to find each other.
 * Returns null for anything that isn't a number of 4+ digits or one with separators.
 */
export function numberVariants(raw: string): string[] | null {
  const token = raw.replace(/^[^\d]+|[^\d]+$/g, '') // currency signs, trailing punctuation
  const m = /^(\d{1,3}(?:[,.\u00a0\u202f'_ ]\d{3})+|\d{4,})(?:[.,](\d{1,2}))?$/.exec(token)
  if (!m) return null
  const whole = m[1].replace(/\D/g, '')
  const cents = m[2]
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  const out = new Set<string>()
  for (const w of [whole, grouped]) {
    if (cents) out.add(`${w} ${cents}`)
    if (!cents || /^0+$/.test(cents)) out.add(w)
  }
  return [...out]
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
  for (const tag of scope?.tags ?? []) {
    sql += ' AND d.path IN (SELECT path FROM tags WHERE tag = ?)'
    params.push(tag)
  }
  // A document's date is its file's modification time, or when it was indexed for web pages and API text.
  if (scope?.modifiedAfter !== undefined) {
    sql += ' AND coalesce(d.mtime_ms, d.indexed_at) >= ?'
    params.push(scope.modifiedAfter)
  }
  if (scope?.modifiedBefore !== undefined) {
    sql += ' AND coalesce(d.mtime_ms, d.indexed_at) < ?'
    params.push(scope.modifiedBefore)
  }
  // Permission-aware search: a document with an access list is only seen by the people on it.
  if (scope?.viewer) {
    const v = viewerClause(scope.viewer)
    sql += v.sql
    params.push(...v.params)
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

/** Documents (alias d) the viewer may see: no access list, or one that names them, their domain or anyone. */
function viewerClause(viewer: string[] | undefined): { sql: string; params: string[] } {
  if (!viewer) return { sql: '', params: [] }
  if (viewer.length === 0) return { sql: ' AND NOT EXISTS (SELECT 1 FROM access a WHERE a.path = d.path)', params: [] }
  return {
    sql: ` AND (NOT EXISTS (SELECT 1 FROM access a WHERE a.path = d.path) OR EXISTS (SELECT 1 FROM access a, json_each(a.principals) j WHERE a.path = d.path AND j.value IN (${viewer.map(() => '?').join(', ')})))`,
    params: viewer,
  }
}

/** The matched words in a snippet (between \u0002 and \u0003), in order, without repeats. */
export function markedWords(snippet: string | undefined): string[] {
  if (!snippet) return []
  const out = new Set<string>()
  for (const m of snippet.matchAll(/\u0002([^\u0003]*)\u0003/g)) if (m[1].trim()) out.add(m[1].trim())
  return [...out].slice(0, 8)
}

/** Edit distance counting a swap of two neighbouring letters as one edit ("recieve" → "receive"). */
export function osaDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[a.length][b.length]
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
      -- Who may see a document on a shared server (src/access.ts); no row: everyone. Keyed by path, like tags, so
      -- it survives re-indexing.
      CREATE TABLE IF NOT EXISTS access (path TEXT PRIMARY KEY, principals TEXT NOT NULL);
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
      CREATE TABLE IF NOT EXISTS tags (path TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (path, tag));
      CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag);
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY,
        at INTEGER NOT NULL,
        actor TEXT NOT NULL,
        role TEXT,
        action TEXT NOT NULL,
        target TEXT,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
      CREATE TABLE IF NOT EXISTS notebooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        path TEXT NOT NULL,
        doc_name TEXT NOT NULL,
        format TEXT NOT NULL,
        page INTEGER,
        quote TEXT NOT NULL,
        comment TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS notes_notebook ON notes(notebook_id, position);
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL,
        collections TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
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
    this.db.prepare('DELETE FROM tags WHERE path = ?').run(path)
    this.db.prepare('DELETE FROM access WHERE path = ?').run(path)
    this.changed()
    return Number(changes) > 0
  }

  clear(): void {
    this.transaction(() => {
      this.db.exec('DELETE FROM documents; DELETE FROM versions; DELETE FROM tags; DELETE FROM access;')
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

  /** The newest stored text of a document, if versions are kept for it. */
  latestContent(path: string): string | undefined {
    const row = this.db.prepare('SELECT content FROM versions WHERE path = ? ORDER BY version DESC LIMIT 1').get(path) as { content: string } | undefined
    return row?.content
  }

  /** A document's indexed passages in order. */
  chunksOf(path: string): { heading: string; page: number | null; content: string }[] {
    return this.db.prepare('SELECT c.heading, c.page, c.content FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = ? ORDER BY c.idx').all(path) as unknown as { heading: string; page: number | null; content: string }[]
  }

  /** One page of documents, newest first, and the total. */
  pageDocuments(limit: number, offset: number): { documents: StoredDocument[]; total: number } {
    const rows = this.db.prepare('SELECT * FROM documents ORDER BY indexed_at DESC, id DESC LIMIT ? OFFSET ?').all(limit, offset) as unknown as DocumentRow[]
    const total = (this.db.prepare('SELECT count(*) AS n FROM documents').get() as { n: number }).n
    return { documents: rows.map(r => this.toDocument(r)), total }
  }

  /**
   * For each metadata field, how many matching documents have each value (top `limit` values). Matching means
   * the keyword query matches the text, or every document when the query is empty.
   */
  facetCounts(query: string, fields: string[], limit: number, filter?: Record<string, unknown>, scope?: SearchScope): Record<string, Record<string, number>> {
    const where = filterClause(filter, scope)
    const out: Record<string, Record<string, number>> = {}
    if (!where) return out
    const fts = query.trim() ? toFtsQuery(query) : null
    if (query.trim() && !fts) return out
    for (const field of fields) {
      if (/["\\]/.test(field)) continue
      const value = `json_extract(d.chunk_metadata, '$."${field}"')`
      const rows = (fts
        ? this.db.prepare(`
            SELECT ${value} AS v, count(DISTINCT d.id) AS n FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN documents d ON d.id = c.document_id
            WHERE chunks_fts MATCH ?${where.sql} AND ${value} IS NOT NULL GROUP BY v ORDER BY n DESC, v LIMIT ?`).all(fts, ...where.params, limit)
        : this.db.prepare(`
            SELECT ${value} AS v, count(*) AS n FROM documents d
            WHERE d.status != 'failed'${where.sql} AND ${value} IS NOT NULL GROUP BY v ORDER BY n DESC, v LIMIT ?`).all(...where.params, limit)
      ) as { v: string | number; n: number }[]
      out[field] = Object.fromEntries(rows.map(r => [String(r.v), r.n]))
    }
    return out
  }

  // ---------- tags ----------

  /** Replaces a document's tags. Tags are kept by path, so they survive re-indexing. */
  setTags(path: string, tags: string[]): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM tags WHERE path = ?').run(path)
      const insert = this.db.prepare('INSERT OR IGNORE INTO tags (path, tag) VALUES (?, ?)')
      for (const t of tags) insert.run(path, t)
    })
  }

  tagsFor(path: string): string[] {
    return (this.db.prepare('SELECT tag FROM tags WHERE path = ? ORDER BY tag').all(path) as { tag: string }[]).map(r => r.tag)
  }

  /** Every tag on an indexed document, with how many documents carry it. */
  allTags(): { tag: string; count: number }[] {
    return this.db.prepare('SELECT t.tag, count(*) AS count FROM tags t JOIN documents d ON d.path = t.path GROUP BY t.tag ORDER BY t.tag').all() as { tag: string; count: number }[]
  }

  /** Tags of every document, for lists. */
  tagMap(): Map<string, string[]> {
    const map = new Map<string, string[]>()
    for (const r of this.db.prepare('SELECT path, tag FROM tags ORDER BY tag').all() as { path: string; tag: string }[]) {
      map.set(r.path, [...(map.get(r.path) ?? []), r.tag])
    }
    return map
  }

  // ---------- API keys ----------

  // ---------- audit log ----------

  addAudit(e: { at: number; actor: string; role?: string; action: string; target?: string; detail?: string }): void {
    this.db.prepare('INSERT INTO audit (at, actor, role, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)').run(e.at, e.actor, e.role ?? null, e.action, e.target ?? null, e.detail ?? null)
  }

  listAudit(opts: { before?: number; limit: number; actor?: string; action?: string }): AuditEntry[] {
    let sql = 'SELECT id, at, actor, role, action, target, detail FROM audit WHERE 1 = 1'
    const params: (string | number)[] = []
    if (opts.before) { sql += ' AND id < ?'; params.push(opts.before) }
    if (opts.actor) { sql += ' AND actor = ?'; params.push(opts.actor) }
    if (opts.action) { sql += ' AND action = ?'; params.push(opts.action) }
    sql += ' ORDER BY id DESC LIMIT ?'
    params.push(opts.limit)
    return this.db.prepare(sql).all(...params) as unknown as AuditEntry[]
  }

  pruneAudit(olderThan: number): number {
    return Number(this.db.prepare('DELETE FROM audit WHERE at < ?').run(olderThan).changes)
  }

  addApiKey(key: { id: string; name: string; keyHash: string; scopes: string[]; collections: string[] | null }): void {
    this.db.prepare('INSERT INTO api_keys (id, name, key_hash, scopes, collections, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(key.id, key.name, key.keyHash, key.scopes.join(' '), key.collections ? JSON.stringify(key.collections) : null, Date.now())
  }

  // ---------- notebooks ----------

  listNotebooks(): Notebook[] {
    return (this.db.prepare(`
      SELECT b.id, b.name, b.created_at AS createdAt, b.updated_at AS updatedAt, count(n.id) AS notes
      FROM notebooks b LEFT JOIN notes n ON n.notebook_id = b.id
      GROUP BY b.id ORDER BY b.updated_at DESC
    `).all() as unknown as Notebook[])
  }

  getNotebook(id: string): Notebook | undefined {
    return this.listNotebooks().find(b => b.id === id)
  }

  createNotebook(id: string, name: string): Notebook {
    const now = Date.now()
    this.db.prepare('INSERT INTO notebooks (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, name, now, now)
    return { id, name, createdAt: now, updatedAt: now, notes: 0 }
  }

  renameNotebook(id: string, name: string): boolean {
    return this.db.prepare('UPDATE notebooks SET name = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), id).changes > 0
  }

  deleteNotebook(id: string): boolean {
    return this.db.prepare('DELETE FROM notebooks WHERE id = ?').run(id).changes > 0
  }

  listNotes(notebookId: string): Note[] {
    return this.db.prepare(`
      SELECT id, notebook_id AS notebookId, position, path, doc_name AS docName, format, page, quote, comment, created_at AS createdAt, updated_at AS updatedAt
      FROM notes WHERE notebook_id = ? ORDER BY position, created_at
    `).all(notebookId) as unknown as Note[]
  }

  addNote(n: Omit<Note, 'position' | 'createdAt' | 'updatedAt'>): Note {
    const now = Date.now()
    const { next } = this.db.prepare('SELECT coalesce(max(position), -1) + 1 AS next FROM notes WHERE notebook_id = ?').get(n.notebookId) as { next: number }
    this.db.prepare('INSERT INTO notes (id, notebook_id, position, path, doc_name, format, page, quote, comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(n.id, n.notebookId, next, n.path, n.docName, n.format, n.page, n.quote, n.comment, now, now)
    this.db.prepare('UPDATE notebooks SET updated_at = ? WHERE id = ?').run(now, n.notebookId)
    return { ...n, position: next, createdAt: now, updatedAt: now }
  }

  updateNoteComment(id: string, comment: string): boolean {
    const now = Date.now()
    const { changes } = this.db.prepare('UPDATE notes SET comment = ?, updated_at = ? WHERE id = ?').run(comment, now, id)
    if (changes) this.db.prepare('UPDATE notebooks SET updated_at = ? WHERE id = (SELECT notebook_id FROM notes WHERE id = ?)').run(now, id)
    return changes > 0
  }

  deleteNote(id: string): boolean {
    return this.db.prepare('DELETE FROM notes WHERE id = ?').run(id).changes > 0
  }

  /** The path of the document a note quotes. */
  notePath(id: string): string | undefined {
    return (this.db.prepare('SELECT path FROM notes WHERE id = ?').get(id) as { path: string } | undefined)?.path
  }

  /** Sets the order of a notebook's notes to `ids` (ids not in the notebook are ignored; notes left out go last). */
  reorderNotes(notebookId: string, ids: string[]): void {
    this.transaction(() => {
      const update = this.db.prepare('UPDATE notes SET position = ? WHERE id = ? AND notebook_id = ?')
      const have = new Set(this.listNotes(notebookId).map(n => n.id))
      const order = [...ids.filter(i => have.has(i)), ...[...have].filter(i => !ids.includes(i))]
      order.forEach((id, i) => update.run(i, id, notebookId))
    })
  }

  listApiKeys(): StoredApiKey[] {
    return (this.db.prepare('SELECT * FROM api_keys WHERE revoked_at IS NULL ORDER BY created_at').all() as unknown as ApiKeyRow[]).map(toApiKey)
  }

  apiKeyByHash(keyHash: string): StoredApiKey | undefined {
    const row = this.db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL').get(keyHash) as ApiKeyRow | undefined
    return row ? toApiKey(row) : undefined
  }

  touchApiKey(id: string): void {
    this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), id)
  }

  revokeApiKey(id: string): boolean {
    return Number(this.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), id).changes) > 0
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
      for (const r of rows) merged.set(r.uid, { chunk: this.toChunk(r), score: r.score ?? 0, snippet: r.snippet, why: { words: markedWords(r.snippet) } })
    }

    // File names: a document whose name contains every query word is a strong match (people search by name).
    const nameWords = (query.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(w => w.length > 2).slice(0, 8)
    if (nameWords.length && scope?.fileNames !== false) {
      const rows = this.db.prepare(`
        SELECT c.uid, c.idx, c.heading, c.page, c.content, d.path, d.format, d.chunk_metadata
        FROM documents d JOIN chunks c ON c.document_id = d.id AND c.idx = (SELECT min(idx) FROM chunks WHERE document_id = d.id)
        WHERE ${nameWords.map(() => "lower(d.display_name) LIKE ? ESCAPE '\\'").join(' AND ')}${where.sql}
        LIMIT ?
      `).all(...nameWords.map(likePattern), ...where.params, limit) as unknown as ChunkRow[]
      const best = Math.max(0, ...[...merged.values()].map(r => r.score))
      for (const r of rows) {
        const existing = merged.get(r.uid)
        if (existing) { existing.score += best + 1; existing.why = { ...existing.why!, fileName: true } }
        else merged.set(r.uid, { chunk: this.toChunk(r), score: best + 1, snippet: r.content.slice(0, 200), why: { words: [], fileName: true } })
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
        const found = segments.filter(s => r.content.includes(s))
        if (existing) { existing.score += score; existing.why = { ...existing.why!, words: [...new Set([...existing.why!.words, ...found])] } }
        else merged.set(r.uid, { chunk: this.toChunk(r), score, snippet: substringSnippet(r.content, segments), why: { words: found } })
      }
    }

    return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit)
  }

  // ---------- access lists (permission-aware team search) ----------

  /** Sets who may see a document (principals), or clears the list (`null`: everyone). Kept across re-indexing. */
  setAccess(path: string, principals: string[] | null): void {
    if (principals === null) this.db.prepare('DELETE FROM access WHERE path = ?').run(path)
    else this.db.prepare('INSERT INTO access (path, principals) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET principals = excluded.principals').run(path, JSON.stringify([...new Set(principals)].sort()))
    this.changed()
  }

  getAccess(path: string): string[] | null {
    const row = this.db.prepare('SELECT principals FROM access WHERE path = ?').get(path) as { principals: string } | undefined
    return row ? JSON.parse(row.principals) as string[] : null
  }

  /** Readable documents the viewer may see. */
  countReadable(viewer?: string[]): number {
    const v = viewerClause(viewer)
    return (this.db.prepare(`SELECT count(*) AS n FROM documents d WHERE d.status = 'indexed'${v.sql}`).get(...v.params) as { n: number }).n
  }

  /** Paths of documents the viewer may not see. */
  hiddenPaths(viewer: string[]): Set<string> {
    const rows = this.db.prepare('SELECT path, principals FROM access').all() as { path: string; principals: string }[]
    return new Set(rows.filter(r => !(JSON.parse(r.principals) as string[]).some(p => viewer.includes(p))).map(r => r.path))
  }

  // ---------- the deadlines radar ----------

  /** Passages that mention expiry, due dates or renewals, for `Duct.deadlines` to read dates from. */
  deadlineCandidates(limit: number, viewer?: string[]): { path: string; name: string; format: string; page: number | null; heading: string | null; content: string }[] {
    const v = viewerClause(viewer)
    return this.db.prepare(`
      SELECT d.path, d.display_name AS name, d.format, c.page, c.heading, c.content
      FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN documents d ON d.id = c.document_id
      WHERE chunks_fts MATCH ? AND d.status = 'indexed'${v.sql}
      LIMIT ?
    `).all(// The index holds Porter stems, so prefixes are stems too ("termin*" for terminates, "laps*" for lapses).
      'expir* OR due OR deadlin* OR renew* OR payabl* OR termin* OR laps* OR "valid until" OR "no later than" OR "on or before" OR "closing date"', ...v.params, limit) as { path: string; name: string; format: string; page: number | null; heading: string | null; content: string }[]
  }

  // ---------- a first look at the library ----------

  /** Each readable document's name, format and opening text, newest first (for `Duct.discover`). */
  openings(limit: number, viewer?: string[]): { name: string; format: string; text: string }[] {
    const v = viewerClause(viewer)
    return this.db.prepare(`
      SELECT d.display_name AS name, d.format AS format, substr(c.content, 1, 2500) AS text
      FROM documents d JOIN chunks c ON c.document_id = d.id AND c.idx = (SELECT min(idx) FROM chunks WHERE document_id = d.id)
      WHERE d.status = 'indexed'${v.sql} ORDER BY d.indexed_at DESC LIMIT ?
    `).all(...v.params, limit) as { name: string; format: string; text: string }[]
  }

  // ---------- when a search finds nothing ----------

  /** How much of the library is searchable, and what isn't (for an empty search). */
  coverage(viewer?: string[]): { documents: number; needsOcr: number; failed: number; passwordProtected: number } {
    const v = viewerClause(viewer)
    const rows = this.db.prepare(`SELECT d.status, count(*) AS n FROM documents d WHERE 1 = 1${v.sql} GROUP BY d.status`).all(...v.params) as { status: string; n: number }[]
    const n = (status: string) => rows.find(r => r.status === status)?.n ?? 0
    const locked = this.db.prepare(`SELECT count(*) AS n FROM documents d WHERE d.status = 'failed' AND (lower(d.error) LIKE '%password%' OR lower(d.error) LIKE '%encrypt%')${v.sql}`).get(...v.params) as { n: number }
    return { documents: n('indexed'), needsOcr: n('no-text'), failed: n('failed'), passwordProtected: locked.n }
  }

  /**
   * "Did you mean": for words that match nothing, the closest word that is in the documents. The index holds
   * Porter stems ("termin" for "termination"), so each typed word is compared with stems of about its length,
   * and the suggestion is the stem's most common spelling in the text.
   */
  suggestSpelling(query: string): string | undefined {
    const words = [...new Set((query.normalize('NFKC').toLowerCase().match(/\p{L}{4,}/gu) || []))].slice(0, 6)
    if (words.length === 0) return undefined
    this.db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS temp.chunks_vocab USING fts5vocab(main, chunks_fts, row)')
    const hits = this.db.prepare('SELECT 1 FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT 1')
    const vocab = this.db.prepare('SELECT term, doc FROM temp.chunks_vocab WHERE term >= ? AND term < ?')
    const sample = this.db.prepare(`SELECT snippet(chunks_fts, 0, char(2), char(3), '', 4) AS s FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT 20`)
    let changed = false
    let out = query
    for (const word of words) {
      if (hits.get(`"${word}"`)) continue
      const first = word[0]
      const next = String.fromCodePoint(first.codePointAt(0)! + 1)
      let best: { term: string; d: number; doc: number } | undefined
      for (const { term, doc } of vocab.all(first, next) as { term: string; doc: number }[]) {
        if (term.length < Math.max(4, Math.floor(word.length * 0.6)) || term.length > word.length + 2 || /\d/.test(term)) continue
        // A stem is usually a prefix of the word: compare it with that much of the typed word.
        const d = osaDistance(term.length < word.length ? word.slice(0, term.length) : word, term)
        const limit = word.length >= 8 ? 2 : 1
        if (d === 0 && term.length === word.length) continue
        if (d <= limit && (!best || d < best.d || (d === best.d && doc > best.doc))) best = { term, d, doc }
      }
      if (!best) continue
      // The stem's most common spelling in the documents ("termin" → "termination").
      const counts = new Map<string, number>()
      for (const { s } of sample.all(`"${best.term}"`) as { s: string }[]) for (const w of markedWords(s)) counts.set(w.toLowerCase(), (counts.get(w.toLowerCase()) ?? 0) + 1)
      const spelling = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? best.term
      if (spelling === word) continue
      out = out.replace(new RegExp(`(?<![\\p{L}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'iu'), spelling)
      changed = true
    }
    return changed ? out : undefined
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
      results.push({ chunk: e.chunk, score: dot / (qn * e.norm), why: { words: [], meaning: true } })
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
