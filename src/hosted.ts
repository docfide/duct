// Hosted AI from a Tensflare account (Pro and Team): the "tensflare" embedding provider and LLM provider.
// The host (the desktop app or `duct serve`) registers a signed-in account here; without one, these providers
// report that sign-in is needed and Duct falls back to keyword search.

import type { EmbeddingProvider, LLMProvider } from './types.js'

export interface HostedAiClient {
  embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]>
  generate(prompt: string, system?: string): Promise<string>
  /** Vector size of the hosted embedding model (known after the first info call; 1024 until then). */
  readonly dimensions: number
}

let client: HostedAiClient | null = null

export function setHostedAi(c: HostedAiClient | null): void { client = c }

function need(): HostedAiClient {
  if (!client) throw new Error('Sign in with a Tensflare Pro or Team account to use hosted AI (Settings › Account)')
  return client
}

export class HostedEmbedder implements EmbeddingProvider {
  get dimensions(): number { return client?.dimensions ?? 1024 }
  embed(texts: string[]): Promise<number[][]> { return need().embed(texts, 'document') }
  async embedQuery(text: string): Promise<number[]> { return (await need().embed([text], 'query'))[0] }
}

export class HostedLLM implements LLMProvider {
  readonly name = 'tensflare'
  generate(prompt: string, system?: string): Promise<string> { return need().generate(prompt, system) }
}
