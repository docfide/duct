import type { EmbeddingProvider } from '../types.js'

export class OllamaEmbedder implements EmbeddingProvider {
  readonly dimensions = 768
  private baseUrl: string
  private model: string

  constructor(baseUrl?: string, model?: string) {
    this.baseUrl = (baseUrl || process.env['OLLAMA_HOST'] || 'http://localhost:11434').replace(/\/$/, '')
    this.model = model || 'nomic-embed-text'
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Ollama embed error (${res.status}): ${body}`)
    }
    const data = await res.json() as { embeddings: number[][] }
    return data.embeddings || []
  }
}
