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
    const results: number[][] = []
    for (const text of texts) {
      const result = await model.embedContent(text)
      results.push(result.embedding.values)
    }
    return results
  }
}
