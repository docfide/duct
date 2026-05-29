import type { EmbeddingProvider } from '../types.js'

export class OpenAICompatibleEmbedder implements EmbeddingProvider {
  readonly dimensions = 1536
  private client: import('openai').default | null = null
  private baseUrl: string
  private model: string
  private apiKey: string

  constructor(baseUrl?: string, model?: string, apiKey?: string) {
    this.baseUrl = (baseUrl || process.env['EMBED_BASE_URL'] || 'https://api.openai.com/v1').replace(/\/$/, '')
    this.model = model || process.env['EMBED_MODEL'] || 'text-embedding-3-small'
    this.apiKey = apiKey || process.env['EMBED_API_KEY'] || process.env['OPENAI_API_KEY'] || ''
  }

  private async getClient(): Promise<import('openai').default> {
    if (!this.client) {
      if (!this.apiKey) throw new Error('EMBED_API_KEY or OPENAI_API_KEY environment variable is not set')
      const { default: OpenAI } = await import('openai')
      this.client = new OpenAI({ baseURL: this.baseUrl, apiKey: this.apiKey })
    }
    return this.client
  }

  async embed(texts: string[]): Promise<number[][]> {
    const client = await this.getClient()
    const response = await client.embeddings.create({
      model: this.model,
      input: texts,
    })
    return response.data.map(d => d.embedding)
  }
}
