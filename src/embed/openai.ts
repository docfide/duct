import type { EmbeddingProvider } from '../types.js'

export class OpenAIEmbedder implements EmbeddingProvider {
  readonly dimensions: number
  private client: import('openai').default | null = null
  private model: string

  constructor(model = 'text-embedding-3-small') {
    this.model = model
    this.dimensions = model === 'text-embedding-3-large' ? 3072 : 1536
  }

  private async getClient(): Promise<import('openai').default> {
    if (!this.client) {
      const key = process.env['OPENAI_API_KEY']
      if (!key) throw new Error('OPENAI_API_KEY environment variable is not set')
      const { default: OpenAI } = await import('openai')
      this.client = new OpenAI({ apiKey: key })
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
