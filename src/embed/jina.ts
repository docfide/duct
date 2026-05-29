import type { EmbeddingProvider } from '../types.js'

export class JinaEmbedder implements EmbeddingProvider {
  readonly dimensions = 1024
  private client: import('openai').default | null = null
  private model: string
  private apiKey: string

  constructor(apiKey?: string, model?: string) {
    this.apiKey = apiKey || process.env['JINA_API_KEY'] || ''
    this.model = model || 'jina-embeddings-v3'
  }

  private async getClient(): Promise<import('openai').default> {
    if (!this.client) {
      if (!this.apiKey) throw new Error('JINA_API_KEY environment variable is not set')
      const { default: OpenAI } = await import('openai')
      this.client = new OpenAI({
        baseURL: 'https://api.jina.ai/v1',
        apiKey: this.apiKey,
      })
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
