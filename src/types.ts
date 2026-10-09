export interface ExtractedDocument {
  path: string
  format: DocumentFormat
  content: string
  metadata: Record<string, unknown>
  /** Text per page (PDF), slide (PPTX), sheet or chapter, in order; `content` is these joined. */
  pages?: string[]
  /** Named parts without page numbers, e.g. an email's attachments or the files inside a ZIP. Chunks get the title as heading. */
  sections?: { title: string; text: string }[]
}

export type DocumentFormat =
  | 'pdf' | 'docx' | 'doc' | 'odt' | 'rtf' | 'pages' | 'md' | 'html' | 'epub'
  | 'xlsx' | 'ods' | 'numbers' | 'pptx' | 'odp' | 'key'
  | 'eml' | 'msg' | 'txt' | 'code' | 'svg' | 'image' | 'zip' | 'url'

export interface DocumentInfo {
  path: string
  format: DocumentFormat
  chunkCount: number
  size: number
  indexedAt: number
  metadata: Record<string, unknown>
  /** Name to show users (the original filename for uploads). */
  displayName?: string
  /** How the document entered the index: 'path', 'url', 'watch' or 'library'. */
  source?: string
  /** 'no-text' means extraction found no text (often a scan that needs OCR). */
  status?: 'indexed' | 'no-text' | 'failed'
  error?: string
  /** The file's modification time (ms), when it came from a file. */
  modifiedAt?: number
  /** Labels people added, e.g. "client: Acme" or "won". */
  tags?: string[]
}

export interface Chunk {
  id: string
  documentPath: string
  documentFormat: DocumentFormat
  content: string
  index: number
  heading?: string
  /** 1-based page (PDF) or slide (PPTX) the chunk comes from. */
  page?: number
  metadata: Record<string, unknown>
}

export interface IndexResult {
  documents: number
  chunks: number
  time: number
  /** Files that could not be extracted. */
  failed?: number
}

export interface IndexOptions {
  /** Recorded on the document; defaults to 'url' for URLs and 'path' otherwise. */
  source?: string
  /** Name shown to users; defaults to the file name. */
  displayName?: string
  /** Run OCR for this call regardless of the `ocr` setting. */
  ocr?: boolean
  /** Re-extract even if the file looks unchanged. */
  force?: boolean
}

export interface IndexFailure {
  path: string
  name: string
  error: string
}

export interface IndexActivity {
  indexing: boolean
  /** Files finished and queued across all running index() calls. */
  done: number
  total: number
  /** Display name of the file being indexed. */
  current: string
  embedding: boolean
  /** Why semantic search is paused (e.g. a missing API key); keyword search keeps working. Cleared by configure(). */
  embeddingError?: string
  /** The most recent finished run. `id` increases with every run, so short runs aren't missed by pollers. */
  lastRun?: { id: number; done: number; failed: number; failures: IndexFailure[]; finishedAt: number }
}

/** Narrows a search to some document formats and/or one folder (or a single file). */
export interface SearchScope {
  formats?: DocumentFormat[]
  under?: string
  /** Also match file names (default true). */
  fileNames?: boolean
  /** Only documents carrying every one of these tags. */
  tags?: string[]
  /** Only documents last modified at or after / before these times (ms since epoch). */
  modifiedAfter?: number
  modifiedBefore?: number
  /**
   * Who is searching, on a shared server: their principals ("user:ada@okafor.ng", "domain:okafor.ng", "anyone").
   * Documents with an access list they aren't on are left out. Unset: no restriction.
   */
  viewer?: string[]
}

export interface SearchResult {
  chunk: Chunk
  score: number
  /** Short excerpt around the match; matched words are wrapped in \u0002 … \u0003. */
  snippet?: string
  /** Why it matched ("Why this result"). */
  why?: MatchReason
}

/** Why a result matched. */
export interface MatchReason {
  /** Words in the passage that matched, as written there. They can differ from what was typed ("termination" for "terminate", "1,200" for "1200"). */
  words: string[]
  /** Every searched word is in the file name. */
  fileName?: boolean
  /** Found by meaning (search by meaning), not only by its words. */
  meaning?: boolean
}

/** What Duct can say when a search finds nothing, so it is never a dead end. */
export interface SearchHelp {
  /** Documents that were searched. */
  documents: number
  /** Scans and images with no text yet: they need OCR before their words can be found. */
  needsOcr: number
  /** Files that couldn't be read at all. */
  failed: number
  /** Of those, files locked with a password. */
  passwordProtected: number
  /** Duct is still reading files, so some aren't searchable yet. */
  indexing: { done: number; total: number } | null
  /** Results the same search finds without the current filters (up to 100). */
  outsideFilters: number
  /** The search with misspelt words replaced by words that are in the documents. */
  didYouMean?: string
}

export interface DuctConfig {
  chunk?: {
    strategy?: 'sliding-window' | 'by-heading'
    size?: number
    overlap?: number
  }
  /** Embedding settings; `false` disables embeddings even when API keys are present. */
  embed?: false | {
    provider?: 'openai' | 'gemini' | 'cohere' | 'voyage' | 'mistral' | 'jina' | 'ollama' | 'openai-compatible' | 'tensflare'
    model?: string
    baseUrl?: string
    apiKey?: string
  }
  ocr?: boolean
  persistPath?: string
  /** Refuse to fetch URLs that resolve to loopback, private or link-local addresses. Enabled by `duct serve`. */
  blockPrivateUrls?: boolean
  llm?: {
    provider?: 'ollama' | 'openai' | 'gemini' | 'tensflare'
    model?: string
    baseUrl?: string
  }
  search?: {
    mode?: 'bm25' | 'vector' | 'hybrid'
    alpha?: number
    rerank?: boolean
    hyde?: boolean
  }
  /** Features to switch off (all are on by default). Overrides saved feature settings for the names given. */
  features?: import('./features.js').FeaturesPatch
}

export interface RuntimeConfig {
  ocr: boolean
  chunkStrategy: 'sliding-window' | 'by-heading'
  chunkSize: number
  chunkOverlap: number
  searchMode: 'bm25' | 'vector' | 'hybrid'
  searchAlpha: number
  rerank: boolean
  hyde: boolean
  llmProvider: string
  llmModel: string
  llmBaseUrl: string
  openaiKey: string
  geminiKey: string
  embedProvider: string
  embedModel: string
  embedBaseUrl: string
  cohereKey: string
  voyageKey: string
  mistralKey: string
  jinaKey: string
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>
  /** Embeds a search query, for models that encode queries differently from documents. Defaults to embed(). */
  embedQuery?(text: string): Promise<number[]>
  readonly dimensions: number
}

export interface VectorStore {
  add(chunks: Chunk[], embeddings: number[][]): Promise<void>
  search(query: number[], topK: number): Promise<SearchResult[]>
  clear(): Promise<void>
  remove(documentPath: string): Promise<void>
  save(path: string): Promise<void>
  load(path: string): Promise<void>
}

export interface Searcher {
  add(chunks: Chunk[]): Promise<void>
  search(query: string, topK: number): Promise<SearchResult[]>
  clear(): Promise<void>
  remove(documentPath: string): Promise<void>
  save(path: string): Promise<void>
  load(path: string): Promise<void>
}

export interface Reranker {
  rerank(query: string, results: SearchResult[], topK: number): Promise<SearchResult[]>
}

export interface Extractor {
  extract(path: string): Promise<ExtractedDocument>
}

export interface LLMProvider {
  generate(prompt: string, system?: string): Promise<string>
  embed?(texts: string[]): Promise<number[][]>
  readonly name: string
}

export interface QAResult {
  answer: string
  sources: { documentPath: string; score: number; content: string; heading?: string }[]
  time: number
}

export interface SchemaField {
  name: string
  type: 'string' | 'number' | 'date' | 'boolean'
  description: string
}

export interface ExtractionResult {
  path: string
  fields: Record<string, unknown>
}

export interface DocDiff {
  path: string
  versionA: number
  versionB: number
  additions: string[]
  removals: string[]
  changes: { field: string; from: unknown; to: unknown }[]
}

export interface TableData {
  headers: string[]
  rows: string[][]
}
