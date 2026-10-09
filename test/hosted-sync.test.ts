import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duct } from '../src/index.js'
import { setHostedAi } from '../src/hosted.js'
import { SettingsSync } from '../src/sync.js'
import type { TensflareAccount } from '../src/account.js'

const work = mkdtempSync(join(tmpdir(), 'duct-hosted-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))
afterEach(() => setHostedAi(null))

describe('hosted AI providers', () => {
  it('embeds and answers through the signed-in account', async () => {
    const calls: string[] = []
    setHostedAi({
      dimensions: 3,
      embed: async (texts, kind) => { calls.push(kind); return texts.map(t => [t.includes('notice') ? 1 : 0, 1, 0]) },
      generate: async prompt => { calls.push('generate'); return prompt.includes('notice') ? 'Thirty days [1].' : '?' },
    })
    const dir = join(work, 'docs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'msa.txt'), 'Either party may give notice of termination.')
    const duct = new Duct({ embed: { provider: 'tensflare' }, llm: { provider: 'tensflare' }, search: { mode: 'hybrid' } })
    await duct.index(dir)
    await duct.embedPending()
    expect(calls).toContain('document')
    const hits = await duct.search('notice')
    expect(hits[0].chunk.content).toContain('notice')
    expect(calls).toContain('query')
    expect((await duct.ask('What is the notice period?')).answer).toBe('Thirty days [1].')
    duct.close()
  })

  it('asks people to sign in when no account is registered', async () => {
    const dir = join(work, 'docs2')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'The notice period is thirty days.')
    const duct = new Duct({ embed: false, llm: { provider: 'tensflare' } })
    await duct.index(dir)
    const result = await duct.ask('notice period').then(r => r.answer, (e: Error) => e.message)
    expect(result).toMatch(/Sign in with a Tensflare/)
    duct.close()
  })
})

describe('settings sync', () => {
  let server: http.Server
  let url: string
  let stored: { data: unknown; version: number } = { data: null, version: 0 }
  const bodies: string[] = []
  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      let body = ''
      for await (const c of req) body += c
      if (req.method === 'PUT') {
        bodies.push(body)
        const b = JSON.parse(body)
        if (b.version !== stored.version) { res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'conflict', ...stored })); return }
        stored = { data: b.data, version: stored.version + 1 }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ version: stored.version }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(stored))
    }).listen(0, '127.0.0.1')
    await new Promise(r => server.once('listening', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => server.close())

  const fakeAccount = () => ({ apiUrl: url, accessToken: async () => 'token', has: () => true }) as unknown as TensflareAccount

  it('uploads the first device’s settings and brings them to the second, never keys or paths', async () => {
    const laptop = new Duct({ embed: false, persistPath: join(work, 'laptop') })
    laptop.configure({ searchMode: 'hybrid', rerank: true, openaiKey: 'sk-must-not-sync', llmBaseUrl: 'http://192.168.1.5:11434' })
    laptop.setFeatures({ ask: false, formats: { image: false } })
    const s1 = new SettingsSync(laptop, fakeAccount(), join(work, 'laptop'))
    await s1.enable(true)
    expect(stored.version).toBe(1)
    expect(bodies[0]).not.toContain('sk-must-not-sync')
    expect(bodies[0]).not.toContain('192.168.1.5')

    const desktop = new Duct({ embed: false, persistPath: join(work, 'desktop') })
    const s2 = new SettingsSync(desktop, fakeAccount(), join(work, 'desktop'))
    await s2.enable(true)
    expect(desktop.getConfig()).toMatchObject({ searchMode: 'hybrid', rerank: true })
    expect(desktop.getFeatures()).toMatchObject({ ask: false, formats: { image: false } })

    // A change on the desktop goes up; the laptop takes it on its next pull.
    desktop.configure({ searchMode: 'bm25' })
    await s2.push()
    await s1.pull()
    expect(laptop.getConfig().searchMode).toBe('bm25')
    laptop.close()
    desktop.close()
  })
})
