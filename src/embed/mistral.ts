import type { EmbeddingProvider } from '../types.js'
import type { MistralClient, MistralModule } from './sdk-types.js'

export class MistralEmbedder implements EmbeddingProvider {
  readonly dimensions = 1024
  private client: MistralClient | null = null
  private model: string
  private apiKey: string

  constructor(apiKey?: string, model?: string) {
    this.apiKey = apiKey || process.env['MISTRAL_API_KEY'] || ''
    this.model = model || 'mistral-embed'
  }

  private async getClient(): Promise<MistralClient> {
    if (!this.client) {
      if (!this.apiKey) throw new Error('MISTRAL_API_KEY environment variable is not set')
      const mod = await import('@mistralai/mistralai') as MistralModule
      this.client = new mod.Mistral({ apiKey: this.apiKey })
    }
    return this.client
  }

  async embed(texts: string[]): Promise<number[][]> {
    const client = await this.getClient()
    const response = await client.embeddings.create({
      model: this.model,
      inputs: texts,
    })
    return response.data?.map(d => d.embedding) || []
  }
}
