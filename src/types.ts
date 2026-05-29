export interface ExtractedDocument {
  path: string
  format: DocumentFormat
  content: string
  metadata: Record<string, unknown>
}

export type DocumentFormat = 'pdf' | 'docx' | 'md' | 'html' | 'txt' | 'image' | 'url'

export interface DocumentInfo {
  path: string
  format: DocumentFormat
  chunkCount: number
  size: number
  indexedAt: number
}

export interface Chunk {
  id: string
  documentPath: string
  documentFormat: DocumentFormat
  content: string
  index: number
  heading?: string
  metadata: Record<string, unknown>
}

export interface IndexResult {
  documents: number
  chunks: number
  time: number
}

export interface SearchResult {
  chunk: Chunk
  score: number
}

export interface DuctConfig {
  chunk?: {
    strategy?: 'sliding-window' | 'by-heading'
    size?: number
    overlap?: number
  }
  embed?: {
    provider?: 'openai' | 'gemini' | 'cohere' | 'voyage' | 'mistral' | 'jina' | 'ollama' | 'openai-compatible'
    model?: string
    baseUrl?: string
    apiKey?: string
  }
  ocr?: boolean
  persistPath?: string
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
