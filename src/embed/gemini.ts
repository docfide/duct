import type { EmbeddingProvider } from '../types.js'

export class GeminiEmbedder implements EmbeddingProvider {
  readonly dimensions = 768
  private model: import('@google/generative-ai').GenerativeModel | null = null
  private modelName: string

  constructor(model = 'text-embedding-004') {
    this.modelName = model
  }

  private async getModel(): Promise<import('@google/generative-ai').GenerativeModel> {
    if (!this.model) {
      const key = process.env['GEMINI_API_KEY']
      if (!key) throw new Error('GEMINI_API_KEY environment variable is not set')
      const { GoogleGenerativeAI } = await import('@google/generative-ai')
      const genAI = new GoogleGenerativeAI(key)
      this.model = genAI.getGenerativeModel({ model: this.modelName })
    }
    return this.model
  }

  async embed(texts: string[]): Promise<number[][]> {
    const model = await this.getModel()
    // One request per batch instead of one per text (the API accepts up to 100 per call).
    const results: number[][] = []
    for (let i = 0; i < texts.length; i += 100) {
      const batch = texts.slice(i, i + 100)
      const response = await model.batchEmbedContents({
        requests: batch.map(text => ({ content: { role: 'user', parts: [{ text }] } })),
      })
      results.push(...response.embeddings.map(e => e.values))
    }
    return results
  }
}
