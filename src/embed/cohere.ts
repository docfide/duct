import type { EmbeddingProvider } from '../types.js'
import type { CohereClientV2, CohereModule } from './sdk-types.js'

export class CohereEmbedder implements EmbeddingProvider {
  readonly dimensions = 1024
  private client: CohereClientV2 | null = null
  private model: string
  private apiKey: string

  constructor(apiKey?: string, model?: string) {
    this.apiKey = apiKey || process.env['COHERE_API_KEY'] || ''
    this.model = model || 'embed-v4.0'
  }

  private async getClient(): Promise<CohereClientV2> {
    if (!this.client) {
      if (!this.apiKey) throw new Error('COHERE_API_KEY environment variable is not set')
      const mod = await import('cohere-ai') as CohereModule
      this.client = new mod.CohereClientV2({ token: this.apiKey })
    }
    return this.client
  }

  async embed(texts: string[]): Promise<number[][]> {
    return this.request(texts, 'search_document')
  }

  async embedQuery(text: string): Promise<number[]> {
    return (await this.request([text], 'search_query'))[0]
  }

  private async request(texts: string[], inputType: 'search_document' | 'search_query'): Promise<number[][]> {
    const client = await this.getClient()
    const response = await client.embed({
      model: this.model,
      texts,
      inputType,
      embeddingTypes: ['float'],
    })
    return (response.embeddings?.float as number[][]) || []
  }
}
