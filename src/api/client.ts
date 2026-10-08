/**
 * A small client for the Duct developer API (/v1). No dependencies: it uses fetch, so it runs on Node 18+,
 * Deno, Bun and edge runtimes. Import it from "@docfide/duct/client".
 *
 *   const duct = new DuctClient({ url: 'https://search.example.com', key: process.env.DUCT_API_KEY })
 *   await duct.upsert('help', 'refunds', { title: 'Refunds', text: '…', metadata: { lang: 'en' } })
 *   const { hits } = await duct.search('help', { q: 'refund', filter: { lang: 'en' } })
 */

export type Metadata = Record<string, string | number | boolean | null>

export interface TextDocument {
  text?: string
  pages?: string[]
  title?: string
  metadata?: Metadata
  format?: 'txt' | 'md'
}

export interface IndexResult { id: string; status: 'indexed' | 'no-text' | 'unchanged'; chunks: number }

export interface DocumentRecord {
  id: string
  title: string | null
  format: string
  status: 'indexed' | 'no-text' | 'failed'
  error?: string
  chunks: number
  size: number
  indexed_at: string
  metadata: Metadata
  text?: string
}

export interface SearchRequest {
  q: string
  limit?: number
  offset?: number
  filter?: Metadata
  facets?: string[]
  formats?: string[]
  group?: 'document' | 'passage'
  /** "field:asc" or "field:desc" to order by a metadata field instead of relevance. */
  sort?: string
}

export interface Hit {
  id: string
  title: string | null
  score: number
  format: string
  page?: number
  page_label?: string
  heading?: string
  snippet: string
  /** HTML-escaped snippet with matches wrapped in <mark>. */
  highlight: string
  metadata: Metadata
}

export interface SearchResponse {
  hits: Hit[]
  offset: number
  limit: number
  has_more: boolean
  facets?: Record<string, Record<string, number>>
  took_ms: number
}

export interface Collection { name: string; documents: number; chunks: number; search_mode?: string; semantic?: boolean }

export class DuctApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'DuctApiError'
  }
}

export class DuctClient {
  private base: string
  private key: string
  private fetchImpl: typeof fetch

  constructor(options: { url: string; key: string; fetch?: typeof fetch }) {
    if (!options.key) throw new Error('DuctClient needs an API key')
    this.base = options.url.replace(/\/+$/, '') + '/v1'
    this.key = options.key
    this.fetchImpl = options.fetch ?? fetch
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData
    const res = await this.fetchImpl(this.base + path, {
      method,
      headers: { Authorization: `Bearer ${this.key}`, ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    })
    if (res.status === 204) return undefined as T
    const data = await res.json().catch(() => ({})) as { error?: string; code?: string }
    if (!res.ok) throw new DuctApiError(res.status, data.code ?? 'error', data.error ?? `HTTP ${res.status}`)
    return data as T
  }

  private c(collection: string): string {
    return `/collections/${encodeURIComponent(collection)}`
  }

  listCollections(): Promise<{ collections: Collection[] }> {
    return this.request('GET', '/collections')
  }

  createCollection(name: string, settings?: { search_mode?: 'bm25' | 'vector' | 'hybrid'; ocr?: boolean }): Promise<Collection> {
    return this.request('POST', '/collections', { name, settings })
  }

  getCollection(name: string): Promise<Collection> {
    return this.request('GET', this.c(name))
  }

  deleteCollection(name: string): Promise<void> {
    return this.request('DELETE', this.c(name))
  }

  /** Adds or replaces one text document under your id. Unchanged text is skipped. */
  upsert(collection: string, id: string, doc: TextDocument): Promise<IndexResult> {
    return this.request('PUT', `${this.c(collection)}/documents/${encodeURIComponent(id)}`, doc)
  }

  /** Adds or replaces up to 1000 documents at once. */
  upsertMany(collection: string, documents: (TextDocument & { id: string })[]): Promise<{ results: IndexResult[] }> {
    return this.request('POST', `${this.c(collection)}/documents`, { documents })
  }

  /** Uploads a file (PDF, Word, Excel, PowerPoint, email, image…) for Duct to read. */
  uploadFile(collection: string, file: Blob, options: { filename: string; id?: string; title?: string; metadata?: Metadata }): Promise<DocumentRecord> {
    const form = new FormData()
    form.append('file', file, options.filename)
    if (options.id) form.append('id', options.id)
    if (options.title) form.append('title', options.title)
    if (options.metadata) form.append('metadata', JSON.stringify(options.metadata))
    return this.request('POST', `${this.c(collection)}/files`, form)
  }

  getDocument(collection: string, id: string, options: { includeText?: boolean } = {}): Promise<DocumentRecord> {
    return this.request('GET', `${this.c(collection)}/documents/${encodeURIComponent(id)}${options.includeText ? '?include=text' : ''}`)
  }

  listDocuments(collection: string, options: { limit?: number; offset?: number } = {}): Promise<{ documents: DocumentRecord[]; total: number; offset: number; limit: number }> {
    const q = new URLSearchParams()
    if (options.limit !== undefined) q.set('limit', String(options.limit))
    if (options.offset !== undefined) q.set('offset', String(options.offset))
    return this.request('GET', `${this.c(collection)}/documents${q.size ? `?${q}` : ''}`)
  }

  deleteDocument(collection: string, id: string): Promise<void> {
    return this.request('DELETE', `${this.c(collection)}/documents/${encodeURIComponent(id)}`)
  }

  search(collection: string, request: SearchRequest): Promise<SearchResponse> {
    return this.request('POST', `${this.c(collection)}/search`, request)
  }
}
