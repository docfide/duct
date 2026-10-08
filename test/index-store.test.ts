import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import http from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duct } from '../src/index.js'
import { BM25Searcher } from '../src/search/bm25.js'

const work = mkdtempSync(join(tmpdir(), 'duct-store-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

let n = 0
function freshDir(name: string): string {
  const dir = join(work, `${name}-${n++}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = async () => {
      if (await check()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting for condition'))
      setTimeout(tick, 50)
    }
    tick()
  })
}

describe('change detection', () => {
  it('re-indexes a file changed while Duct was not running, and skips unchanged ones', async () => {
    const data = freshDir('data')
    const docs = freshDir('docs')
    const file = join(docs, 'notes.txt')
    writeFileSync(file, 'The original wording mentions apricots.')
    writeFileSync(join(docs, 'other.txt'), 'Unrelated text about pears.')

    const first = new Duct({ persistPath: data })
    expect((await first.index(docs)).documents).toBe(2)
    first.close()

    writeFileSync(file, 'The revised wording mentions blueberries.')
    utimesSync(file, new Date(), new Date(Date.now() + 5000))

    const second = new Duct({ persistPath: data })
    const result = await second.index(docs)
    expect(result.documents).toBe(1)
    expect(await second.search('blueberries')).toHaveLength(1)
    expect(await second.search('apricots')).toHaveLength(0)

    const diff = await second.diff(file)
    expect(diff?.additions.join(' ')).toContain('blueberries')
    expect(diff?.removals.join(' ')).toContain('apricots')
    second.close()
  })

  it('does not duplicate chunks when the same file is indexed concurrently', async () => {
    const duct = new Duct()
    const file = join(freshDir('race'), 'race.txt')
    writeFileSync(file, 'concurrency check with kiwis')
    await Promise.all([duct.index(file), duct.index(file), duct.index(file)])
    expect(duct.stats()).toEqual({ documents: 1, chunks: 1 })
    expect(await duct.search('kiwis')).toHaveLength(1)
  })

  it('records documents without text and failures separately', async () => {
    const dir = freshDir('status')
    writeFileSync(join(dir, 'empty.txt'), '   ')
    writeFileSync(join(dir, 'broken.pdf'), 'this is not really a pdf')
    const duct = new Duct()
    const result = await duct.index(dir)
    expect(result.failed).toBe(1)
    const byName = Object.fromEntries(duct.getDocuments().map(d => [d.displayName, d]))
    expect(byName['empty.txt'].status).toBe('no-text')
    expect(byName['broken.pdf'].status).toBe('failed')
    expect(byName['broken.pdf'].error).toBeTruthy()
    expect(duct.stats().documents).toBe(1)
  })
})

describe('watched folders', () => {
  it('indexes new files and drops deleted ones', async () => {
    const dir = freshDir('watch')
    writeFileSync(join(dir, 'existing.md'), '# Existing\n\nAlready here: mangoes.')
    const duct = new Duct()
    await duct.watch([dir])
    expect(await duct.search('mangoes')).toHaveLength(1)

    writeFileSync(join(dir, 'new.txt'), 'Freshly added: papayas.')
    await waitFor(async () => (await duct.search('papayas')).length === 1)

    unlinkSync(join(dir, 'existing.md'))
    await waitFor(async () => (await duct.search('mangoes')).length === 0)
    expect(duct.stats().documents).toBe(1)
    duct.close()
  })

  it('remembers folders and catches up on changes made while closed', async () => {
    const data = freshDir('data')
    const dir = freshDir('watched')
    writeFileSync(join(dir, 'keep.txt'), 'keep me: lemons')
    writeFileSync(join(dir, 'remove.txt'), 'remove me: limes')

    const first = new Duct({ persistPath: data })
    await first.watch([dir])
    expect(first.stats().documents).toBe(2)
    first.close()

    unlinkSync(join(dir, 'remove.txt'))
    writeFileSync(join(dir, 'added.txt'), 'added later: oranges')

    const second = new Duct({ persistPath: data })
    expect(await second.restoreSources()).toEqual([dir.startsWith('/private') ? dir : expect.stringContaining('watched')])
    expect(await second.search('oranges')).toHaveLength(1)
    expect(await second.search('limes')).toHaveLength(0)
    expect(second.stats().documents).toBe(2)

    await second.removeSource(dir)
    expect(second.stats().documents).toBe(0)
    expect(second.listSources()).toHaveLength(0)
    second.close()
  })
})

describe('settings', () => {
  it('saves configured settings, but constructor options take precedence', () => {
    const data = freshDir('data')
    const first = new Duct({ persistPath: data })
    first.configure({ chunkSize: 700, searchMode: 'hybrid', rerank: true, llmProvider: 'none' })
    first.close()

    const second = new Duct({ persistPath: data })
    const cfg = second.getConfig()
    expect(cfg.chunkSize).toBe(700)
    expect(cfg.searchMode).toBe('hybrid')
    expect(cfg.rerank).toBe(true)
    expect(cfg.llmProvider).toBe('none')
    second.close()

    const third = new Duct({ persistPath: data, chunk: { size: 1200 } })
    expect(third.getConfig().chunkSize).toBe(1200)
    third.close()
  })
})

describe('search quality', () => {
  let duct: Duct
  beforeAll(async () => {
    duct = new Duct()
    const dir = freshDir('lang')
    writeFileSync(join(dir, 'fr.txt'), 'La résiliation du contrat est immédiate.')
    writeFileSync(join(dir, 'zh.txt'), '本合同的终止条款如下。')
    writeFileSync(join(dir, 'en.txt'), 'Either party may terminate this agreement with notice. The notice period is thirty days.')
    await duct.index(dir)
  })

  it('matches words with or without accents', async () => {
    expect(await duct.search('résiliation')).toHaveLength(1)
    expect(await duct.search('resiliation')).toHaveLength(1)
  })

  it('finds Chinese text', async () => {
    const results = await duct.search('终止条款')
    expect(results).toHaveLength(1)
    expect(results[0].chunk.documentPath).toMatch(/zh\.txt$/)
  })

  it('matches word forms (stemming)', async () => {
    expect(await duct.search('termination')).toHaveLength(1)
  })

  it('supports quoted phrases', async () => {
    expect(await duct.search('"notice period"')).toHaveLength(1)
    expect(await duct.search('"period notice"')).toHaveLength(0)
  })

  it('applies metadata filters before limiting results', async () => {
    const filtered = new Duct()
    const dir = freshDir('filter')
    for (let i = 0; i < 40; i++) writeFileSync(join(dir, `doc${i}.txt`), `invoice number ${i} for consulting`)
    for (let i = 0; i < 40; i++) {
      await filtered.index(join(dir, `doc${i}.txt`), { team: i % 4 === 0 ? 'legal' : 'sales' })
    }
    const results = await filtered.search('invoice', 10, { team: 'legal' })
    expect(results).toHaveLength(10)
    expect(results.every(r => r.chunk.metadata.team === 'legal')).toBe(true)
  })
})

describe('legacy JSON index', () => {
  it('migrates an index written by Duct 0.2', async () => {
    const data = freshDir('legacy')
    const searcher = new BM25Searcher()
    const chunk = { id: 'c1', documentPath: '/old/report.txt', documentFormat: 'txt' as const, content: 'legacy content about walnuts', index: 0, metadata: { team: 'ops' } }
    await searcher.add([chunk])
    await searcher.save(join(data, 'bm25.json'))
    writeFileSync(join(data, 'meta.json'), JSON.stringify({ documents: [{ path: '/old/report.txt', format: 'txt', chunkCount: 1, size: 28, indexedAt: 1, metadata: { team: 'ops' } }], chunks: 1 }))

    const duct = new Duct({ persistPath: data })
    expect(duct.stats().documents).toBe(1)
    const results = await duct.search('walnuts')
    expect(results).toHaveLength(1)
    expect(results[0].chunk.metadata.team).toBe('ops')
    expect(existsSync(join(data, 'bm25.json'))).toBe(false)
    expect(existsSync(join(data, 'bm25.json.migrated'))).toBe(true)
    duct.close()
  })
})

describe('embeddings', () => {
  let server: Server
  let baseUrl: string
  let calls = 0
  beforeAll(async () => {
    // A fake Ollama: each model maps a text to a different deterministic vector.
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        calls++
        const { model, input } = JSON.parse(body) as { model: string; input: string[] }
        const seed = model.length
        const embeddings = input.map(t => Array.from({ length: 768 }, (_, i) => Math.sin((t.length + i) * seed) + (t.includes('cherries') ? 1 : 0)))
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ embeddings }))
      })
    }).listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => server.close())

  it('embeds new chunks and re-embeds everything when the model changes', async () => {
    const dir = freshDir('embed')
    writeFileSync(join(dir, 'a.txt'), 'a bowl of cherries')
    writeFileSync(join(dir, 'b.txt'), 'a crate of plums')
    const duct = new Duct({ embed: { provider: 'ollama', baseUrl, model: 'model-a' }, search: { mode: 'hybrid' } })
    await duct.index(dir)
    const before = calls
    expect(before).toBeGreaterThan(0)
    expect((await duct.search('cherries'))[0].chunk.content).toContain('cherries')

    duct.configure({ embedModel: 'model-b-longer-name' })
    await waitFor(() => calls > before + 1)
    await duct.embedPending()
    expect((await duct.search('cherries'))[0].chunk.content).toContain('cherries')
  })
})

describe('run reports', () => {
  it('reports unreadable files from the last run, even after it finished', async () => {
    const dir = freshDir('report')
    writeFileSync(join(dir, 'good.txt'), 'readable text about figs')
    writeFileSync(join(dir, 'broken.pdf'), 'not a pdf at all')
    const duct = new Duct()
    expect(duct.activity().lastRun).toBeUndefined()
    await duct.index(dir)
    const first = duct.activity().lastRun!
    expect(first).toMatchObject({ done: 2, failed: 1 })
    expect(first.failures[0]).toMatchObject({ name: 'broken.pdf' })
    expect(first.failures[0].error).toBeTruthy()

    await duct.index(join(dir, 'good.txt'))
    const second = duct.activity().lastRun!
    expect(second.id).toBeGreaterThan(first.id)
    expect(second.failed).toBe(0)
  })
})
