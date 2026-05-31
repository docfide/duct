export interface CohereClientV2 {
  embed(opts: {
    model: string
    texts: string[]
    inputType: string
    embeddingTypes: string[]
  }): Promise<{ embeddings?: { float?: number[][] } }>
}

export interface VoyageAIClient {
  embed(opts: { input: string[]; model: string }): Promise<{ embeddings?: number[][] }>
}

export interface MistralClient {
  embeddings: {
    create(opts: { model: string; inputs: string[] }): Promise<{ data?: Array<{ embedding: number[] }> }>
  }
}

export type CohereModule = { CohereClientV2: new (opts: { token: string }) => CohereClientV2 }
export type VoyageModule = { VoyageAIClient: new (opts: { apiKey: string }) => VoyageAIClient }
export type MistralModule = { Mistral: new (opts: { apiKey: string }) => MistralClient }
