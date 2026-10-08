import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import https from 'node:https'
import { PrivacyLedger, categorize, installLedger } from '../src/ledger.js'

const work = mkdtempSync(join(tmpdir(), 'duct-ledger-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

describe('privacy ledger', () => {
  it('sorts hosts into what they are for', () => {
    expect(categorize('telemetry.tensflare.com')).toBe('tensflare')
    expect(categorize('api.openai.com')).toBe('ai')
    expect(categorize('graph.microsoft.com')).toBe('cloud')
    expect(categorize('okafor-docs.s3.eu-west-2.amazonaws.com')).toBe('cloud')
    expect(categorize('login.microsoftonline.com')).toBe('signin')
    expect(categorize('example.org')).toBe('web')
  })

  it('counts requests and bytes per host and day, keeps paths only for Tensflare, and survives a restart', () => {
    let now = Date.parse('2026-10-08T10:00:00Z')
    const l = new PrivacyLedger(work, () => now)
    l.record('https://telemetry.tensflare.com/v1/duct/report?x=1', 'post', 120)
    l.record('https://api.openai.com/v1/embeddings', 'POST', 5000)
    l.record('https://api.openai.com/v1/embeddings', 'POST', 3000)
    l.record('https://www.googleapis.com/drive/v3/files/secret-file-id?alt=media')
    l.record('http://localhost:11434/api/embed', 'POST', 900)   // Ollama on this computer: never left it
    now += 86_400_000
    l.record('https://accounts.tensflare.com/oauth/token', 'POST', 80)
    const [today, yesterday] = l.summary(7)
    expect(today.hosts).toEqual([expect.objectContaining({ host: 'accounts.tensflare.com', requests: 1, bytesOut: 80 })])
    expect(yesterday.hosts.find(h => h.host === 'api.openai.com')).toMatchObject({ category: 'ai', requests: 2, bytesOut: 8000 })
    expect(yesterday.hosts.some(h => h.host === 'localhost')).toBe(false)
    const recent = l.recent()
    expect(recent[recent.length - 1]).toMatchObject({ host: 'telemetry.tensflare.com', method: 'POST', path: '/v1/duct/report' })
    expect(recent.find(e => e.host === 'www.googleapis.com')!.path).toBeUndefined()
    l.save()
    const again = new PrivacyLedger(work, () => now)
    expect(again.summary(7)).toEqual(l.summary(7))
    again.clear()
    expect(again.summary(30)).toEqual([])
  })

  it('records fetch and the http modules (which SDKs use), without changing the requests', async () => {
    const seen: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => { seen.push(String(input)); return new Response('ok') }) as typeof fetch
    const ledger = installLedger()
    expect(await (await fetch('https://api.voyageai.com/v1/embeddings', { method: 'POST', body: 'hello' })).text()).toBe('ok')
    expect(seen).toEqual(['https://api.voyageai.com/v1/embeddings'])

    const req = https.request('https://api.anthropic.com/v1/messages', { method: 'POST' })
    req.on('error', () => {})
    req.write('abcdef')
    req.destroy()
    const { request } = await import('node:https')   // a named import sees the wrapper too
    const req2 = request({ host: 'api.mistral.ai', path: '/v1/embeddings', method: 'POST' })
    req2.on('error', () => {})
    req2.destroy()
    const hosts = Object.fromEntries(ledger.summary(1)[0].hosts.map(h => [h.host, h]))
    expect(hosts['api.voyageai.com']).toMatchObject({ requests: 1, bytesOut: 5 })
    expect(hosts['api.anthropic.com']).toMatchObject({ requests: 1, bytesOut: 6 })
    expect(hosts['api.mistral.ai']).toMatchObject({ requests: 1 })
    expect(installLedger()).toBe(ledger)
  })
})
