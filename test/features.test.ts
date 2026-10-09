import { describe, it, expect, afterAll } from 'vitest'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duct, FeatureDisabledError } from '../src/index.js'
import { createServer } from '../src/server.js'
import { addToLibrary } from '../src/library.js'
import { mergeFeatures, defaultFeatures } from '../src/features.js'

const work = mkdtempSync(join(tmpdir(), 'duct-features-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

function folder(name: string, files: Record<string, string>): string {
  const dir = join(work, name)
  mkdirSync(dir, { recursive: true })
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text)
  return dir
}

describe('feature switches', () => {
  it('start all on and reject unknown names or non-boolean values', () => {
    const f = defaultFeatures()
    expect(f.ask && f.uploads && f.formats.image).toBe(true)
    expect(() => mergeFeatures(f, { teleport: false })).toThrow(/Unknown feature/)
    expect(() => mergeFeatures(f, { ask: 'no' })).toThrow(/true or false/)
    expect(() => mergeFeatures(f, { formats: { video: false } })).toThrow(/Unknown file family/)
  })

  it('refuse a switched-off feature with FeatureDisabledError', async () => {
    const duct = new Duct({ embed: false, features: { ask: false, diff: false, watchedFolders: false, webPages: false } })
    await expect(duct.ask('anything')).rejects.toBeInstanceOf(FeatureDisabledError)
    await expect(duct.diff('x')).rejects.toThrow(/turned off/)
    await expect(duct.watch([work])).rejects.toBeInstanceOf(FeatureDisabledError)
    await expect(duct.index('https://example.com/')).rejects.toBeInstanceOf(FeatureDisabledError)
    expect(await duct.restoreSources()).toEqual([])
    duct.close()
  })

  it('skip a switched-off file family when indexing and hide it from search', async () => {
    const dir = folder('families', { 'notes.txt': 'walrus migration notes', 'guide.md': '# Guide\n\nwalrus feeding guide' })
    const duct = new Duct({ embed: false })
    await duct.index(dir)
    expect((await duct.search('walrus')).length).toBe(2)

    duct.setFeatures({ formats: { text: false } })
    const hits = await duct.search('walrus')
    expect(hits.map(h => h.chunk.documentFormat)).toEqual(['md'])
    expect(await duct.search('walrus', 10, undefined, { formats: ['txt'] })).toEqual([])

    const fresh = new Duct({ embed: false, features: { formats: { text: false } } })
    const r = await fresh.index(dir)
    expect(r.documents).toBe(1)
    fresh.close()
    duct.close()
  })

  it('stop matching file names when file name search is off', async () => {
    const dir = folder('names', { 'quarterly-budget.txt': 'numbers only' })
    const duct = new Duct({ embed: false })
    await duct.index(dir)
    expect((await duct.search('quarterly budget')).length).toBe(1)
    duct.setFeatures({ fileNameSearch: false })
    expect((await duct.search('quarterly budget')).length).toBe(0)
    duct.close()
  })

  it('are saved with the index; constructor switches win but are not saved', () => {
    const dir = join(work, 'persist')
    const a = new Duct({ persistPath: dir, embed: false })
    a.setFeatures({ export: false, formats: { code: false } })
    a.close()
    const b = new Duct({ persistPath: dir, embed: false, features: { export: true, ask: false } })
    expect(b.getFeatures()).toMatchObject({ export: true, ask: false, formats: { code: false } })
    b.close()
    const c = new Duct({ persistPath: dir, embed: false })
    expect(c.getFeatures()).toMatchObject({ export: false, ask: true, formats: { code: false } })
    c.close()
  })

  it('stop files being added to the Library', async () => {
    const src = folder('lib-src', { 'memo.txt': 'memo' })
    const duct = new Duct({ embed: false, features: { uploads: false } })
    await expect(addToLibrary(duct, join(work, 'library'), join(src, 'memo.txt'))).rejects.toBeInstanceOf(FeatureDisabledError)
    duct.close()
  })
})

describe('feature switches on the server', () => {
  async function start(duct: Duct) {
    const server = createServer(duct, { authToken: 'admin-token', memberTokens: ['member-token'], libraryDir: join(work, 'srv-library') }).listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
  }
  const as = (token: string, init: RequestInit = {}) => ({ ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers as object) } })

  it('lets admins switch features and answers 403 for switched-off routes', async () => {
    const duct = new Duct({ embed: false })
    const { server, base } = await start(duct)
    try {
      const info = await (await fetch(`${base}/api/info`, as('member-token'))).json()
      expect(info.features.ask).toBe(true)

      const denied = await fetch(`${base}/api/features`, as('member-token', { method: 'PUT', body: JSON.stringify({ ask: false }) }))
      expect(denied.status).toBe(403)
      const bad = await fetch(`${base}/api/features`, as('admin-token', { method: 'PUT', body: JSON.stringify({ nope: false }) }))
      expect(bad.status).toBe(400)

      const put = await fetch(`${base}/api/features`, as('admin-token', { method: 'PUT', body: JSON.stringify({ ask: false, export: false, uploads: false, webPages: false }) }))
      expect((await put.json()).features).toMatchObject({ ask: false, export: false })

      const ask = await fetch(`${base}/api/ask`, as('member-token', { method: 'POST', body: JSON.stringify({ question: 'hi' }) }))
      expect(ask.status).toBe(403)
      expect((await ask.json()).feature).toBe('ask')
      expect((await fetch(`${base}/api/export?q=x`, as('member-token'))).status).toBe(403)
      const url = await fetch(`${base}/api/index`, as('admin-token', { method: 'POST', body: JSON.stringify({ url: 'https://example.com/' }) }))
      expect(url.status).toBe(403)
      const form = new FormData()
      form.append('files', new Blob(['hello']), 'hello.txt')
      const upload = await fetch(`${base}/api/index`, { method: 'POST', body: form, headers: { Authorization: 'Bearer admin-token' } })
      expect(upload.status).toBe(403)
      expect((await fetch(`${base}/api/search?q=x`, as('member-token'))).status).toBe(200)
    } finally {
      server.close()
      duct.close()
    }
  })
})
