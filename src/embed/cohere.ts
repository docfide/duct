import type { EmbeddingProvider } from '../types.js'

export class CohereEmbedder implements EmbeddingProvider {
  readonly dimensions = 1024
  private client: any = null
  private model: string
  private apiKey: string

  constructor(apiKey?: string, model?: string) {
    this.apiKey = apiKey || process.env['COHERE_API_KEY'] || ''
    this.model = model || 'embed-v4.0'
  }

  private async getClient(): Promise<any> {
    if (!this.client) {
      if (!this.apiKey) throw new Error('COHERE_API_KEY environment variable is not set')
      const { CohereClientV2 } = await import('cohere-ai') as any
      this.client = new CohereClientV2({ token: this.apiKey })
    }
    return this.client
  }

  async embed(texts: string[]): Promise<number[][]> {
    const client = await this.getClient()
    const response = await client.embed({
      model: this.model,
      texts,
      inputType: 'search_document',
      embeddingTypes: ['float'],
    })
    return (response.embeddings?.float as number[][]) || []
  }
}
