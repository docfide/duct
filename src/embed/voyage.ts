import type { EmbeddingProvider } from '../types.js'

export class VoyageEmbedder implements EmbeddingProvider {
  readonly dimensions = 1024
  private client: any = null
  private model: string
  private apiKey: string

  constructor(apiKey?: string, model?: string) {
    this.apiKey = apiKey || process.env['VOYAGE_API_KEY'] || ''
    this.model = model || 'voyage-3-large'
  }

  private async getClient(): Promise<any> {
    if (!this.client) {
      if (!this.apiKey) throw new Error('VOYAGE_API_KEY environment variable is not set')
      const { VoyageAIClient } = await import('voyageai') as any
      this.client = new VoyageAIClient({ apiKey: this.apiKey })
    }
    return this.client
  }

  async embed(texts: string[]): Promise<number[][]> {
    const client = await this.getClient()
    const response = await client.embed({
      input: texts,
      model: this.model,
    })
    return (response.embeddings as number[][]) || []
  }
}
