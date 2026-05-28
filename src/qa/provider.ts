import type { LLMProvider } from '../types.js'

export class OpenAILLM implements LLMProvider {
  readonly name = 'openai'
  private model: string
  private baseUrl: string
  private key: string

  constructor(key: string, model = 'gpt-4o-mini', baseUrl = '') {
    this.key = key
    this.model = model
    this.baseUrl = baseUrl || 'https://api.openai.com/v1'
  }

  async generate(prompt: string, system?: string): Promise<string> {
    const { default: OpenAI } = await import('openai')
    const client = new OpenAI({ apiKey: this.key, baseURL: this.baseUrl })
    const res = await client.chat.completions.create({
      model: this.model,
      messages: [
        ...(system ? [{ role: 'system' as const, content: system }] : []),
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
    })
    return res.choices[0]?.message?.content || ''
  }
}

export class GeminiLLM implements LLMProvider {
  readonly name = 'gemini'
  private model: string
  private key: string

  constructor(key: string, model = 'gemini-2.0-flash') {
    this.key = key
    this.model = model
  }

  async generate(prompt: string, system?: string): Promise<string> {
    const { GoogleGenerativeAI } = await import('@google/generative-ai')
    const genAI = new GoogleGenerativeAI(this.key)
    const model = genAI.getGenerativeModel({ model: this.model, systemInstruction: system })
    const res = await model.generateContent(prompt)
    return res.response.text()
  }
}

export class OllamaLLM implements LLMProvider {
  readonly name = 'ollama'
  private model: string
  private baseUrl: string

  constructor(model = 'llama3.2', baseUrl = 'http://localhost:11434') {
    this.model = model
    this.baseUrl = baseUrl
  }

  async generate(prompt: string, system?: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
        stream: false,
        options: { temperature: 0.1 },
      }),
    })
    const data = await res.json() as { message?: { content: string }; error?: string }
    if (data.error) throw new Error(`Ollama error: ${data.error}`)
    return data.message?.content || ''
  }
}

export function createLLMProvider(cfg: {
  provider: string
  model?: string
  baseUrl?: string
  openaiKey?: string
  geminiKey?: string
}): LLMProvider | null {
  const p = cfg.provider || 'ollama'
  if (p === 'openai' && cfg.openaiKey) {
    return new OpenAILLM(cfg.openaiKey, cfg.model || 'gpt-4o-mini', cfg.baseUrl)
  }
  if (p === 'gemini' && cfg.geminiKey) {
    return new GeminiLLM(cfg.geminiKey, cfg.model || 'gemini-2.0-flash')
  }
  if (p === 'ollama') {
    return new OllamaLLM(cfg.model || 'llama3.2', cfg.baseUrl || 'http://localhost:11434')
  }
  return null
}
