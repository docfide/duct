import type { EmbeddingProvider } from '../types.js'
import { OpenAIEmbedder } from './openai.js'
import { GeminiEmbedder } from './gemini.js'
import { CohereEmbedder } from './cohere.js'
import { VoyageEmbedder } from './voyage.js'
import { MistralEmbedder } from './mistral.js'
import { JinaEmbedder } from './jina.js'
import { OllamaEmbedder } from './ollama.js'
import { OpenAICompatibleEmbedder } from './openai-compatible.js'

export type EmbedProvider = 'openai' | 'gemini' | 'cohere' | 'voyage' | 'mistral' | 'jina' | 'ollama' | 'openai-compatible'

export interface EmbedderConfig {
  provider?: EmbedProvider
  model?: string
  baseUrl?: string
  apiKey?: string
}

export function createEmbedder(config?: EmbedderConfig): EmbeddingProvider | null {
  const provider = config?.provider || guessProvider()
  if (!provider) return null

  const model = config?.model
  const baseUrl = config?.baseUrl
  const apiKey = config?.apiKey

  switch (provider) {
    case 'openai':
      return new OpenAIEmbedder(model)
    case 'gemini':
      return new GeminiEmbedder(model)
    case 'cohere':
      return new CohereEmbedder(apiKey, model)
    case 'voyage':
      return new VoyageEmbedder(apiKey, model)
    case 'mistral':
      return new MistralEmbedder(apiKey, model)
    case 'jina':
      return new JinaEmbedder(apiKey, model)
    case 'ollama':
      return new OllamaEmbedder(baseUrl, model)
    case 'openai-compatible':
      return new OpenAICompatibleEmbedder(baseUrl, model, apiKey)
    default:
      return null
  }
}

function guessProvider(): EmbedProvider | null {
  if (process.env['OPENAI_API_KEY']) return 'openai'
  if (process.env['GEMINI_API_KEY']) return 'gemini'
  if (process.env['COHERE_API_KEY']) return 'cohere'
  if (process.env['VOYAGE_API_KEY']) return 'voyage'
  if (process.env['MISTRAL_API_KEY']) return 'mistral'
  if (process.env['JINA_API_KEY']) return 'jina'
  return null
}
