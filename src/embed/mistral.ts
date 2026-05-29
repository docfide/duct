import type { EmbeddingProvider } from '../types.js'

export class MistralEmbedder implements EmbeddingProvider {
  readonly dimensions = 1024
  private client: any = null
  private model: string
  private apiKey: string

  constructor(apiKey?: string, model?: string) {
    this.apiKey = apiKey || process.env['MISTRAL_API_KEY'] || ''
    this.model = model || 'mistral-embed'
  }

  private async getClient(): Promise<any> {
    if (!this.client) {
      if (!this.apiKey) throw new Error('MISTRAL_API_KEY environment variable is not set')
      const { Mistral } = await import('@mistralai/mistralai') as any
      this.client = new Mistral({ apiKey: this.apiKey })
    }
    return this.client
  }

  async embed(texts: string[]): Promise<number[][]> {
    const client = await this.getClient()
    const response = await client.embeddings.create({
      model: this.model,
      inputs: texts,
    })
    return response.data?.map((d: any) => d.embedding as number[]) || []
  }
}
