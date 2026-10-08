export interface ExtractedDocument {
  path: string
  format: DocumentFormat
  content: string
  metadata: Record<string, unknown>
  /** Text per page (PDF) or slide (PPTX), in order; `content` is these joined. */
  pages?: string[]
}

export type DocumentFormat = 'pdf' | 'docx' | 'md' | 'html' | 'txt' | 'image' | 'url' | 'xlsx' | 'pptx'

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

export interface SearchResult {
  chunk: Chunk
  score: number
  /** Short excerpt around the match; matched words are wrapped in \u0002 … \u0003. */
  snippet?: string
}

export interface DuctConfig {
  chunk?: {
    strategy?: 'sliding-window' | 'by-heading'
    size?: number
    overlap?: number
  }
  /** Embedding settings; `false` disables embeddings even when API keys are present. */
  embed?: false | {
    provider?: 'openai' | 'gemini' | 'cohere' | 'voyage' | 'mistral' | 'jina' | 'ollama' | 'openai-compatible'
    model?: string
    baseUrl?: string
    apiKey?: string
  }
  ocr?: boolean
  persistPath?: string
  /** Refuse to fetch URLs that resolve to loopback, private or link-local addresses. Enabled by `duct serve`. */
  blockPrivateUrls?: boolean
  llm?: {
    provider?: 'ollama' | 'openai' | 'gemini'
    model?: string
    baseUrl?: string
  }
  search?: {
    mode?: 'bm25' | 'vector' | 'hybrid'
    alpha?: number
    rerank?: boolean
    hyde?: boolean
  }
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
