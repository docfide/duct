export interface ExtractedDocument {
  path: string
  format: DocumentFormat
  content: string
  metadata: Record<string, unknown>
}

export type DocumentFormat = 'pdf' | 'docx' | 'md' | 'html' | 'txt'

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
    provider?: 'openai' | 'gemini'
    model?: string
  }
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>
  readonly dimensions: number
}

export interface VectorStore {
  add(chunks: Chunk[], embeddings: number[][]): Promise<void>
  search(query: number[], topK: number): Promise<SearchResult[]>
  clear(): Promise<void>
}

export interface Searcher {
  add(chunks: Chunk[]): Promise<void>
  search(query: string, topK: number): Promise<SearchResult[]>
  clear(): Promise<void>
}

export interface Extractor {
  extract(path: string): Promise<ExtractedDocument>
}
