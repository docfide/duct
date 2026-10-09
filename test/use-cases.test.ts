import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { Duct } from '../src/index.js'
import { createServer } from '../src/server.js'
import { numberVariants, toFtsQuery } from '../src/store/sqlite.js'
import { cleanDetails } from '../src/extract/common.js'
import { toCsv, toDocx } from '../src/export.js'

const work = mkdtempSync(join(tmpdir(), 'duct-usecases-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

function files(name: string, contents: Record<string, string>): string {
  const dir = join(work, name)
  mkdirSync(dir, { recursive: true })
  for (const [f, text] of Object.entries(contents)) writeFileSync(join(dir, f), text)
  return dir
}

describe('numbers in different formats (finance)', () => {
  it('builds variants for grouped, plain and decimal amounts', () => {
    expect(numberVariants('1200')).toEqual(['1200', '1 200'])
    expect(numberVariants('1,200.00')).toEqual(['1200 00', '1200', '1 200 00', '1 200'])
    expect(numberVariants('$45,000')).toEqual(['45000', '45 000'])
    expect(numberVariants('2.5')).toBeNull()
    expect(numberVariants('invoice')).toBeNull()
    expect(toFtsQuery('invoice 1200')).toBe('"invoice" OR ("1200" OR "1 200")')
  })

  it('finds an amount however it was written', async () => {
    const dir = files('amounts', {
      'a.txt': 'Invoice INV-77 total due: 1,200.00 NGN',
      'b.txt': 'Approved payment of 1 200 to the supplier',
      'c.txt': 'Ledger line 1200',
      'd.txt': 'Unrelated memo about 12 apples',
    })
    const duct = new Duct({ embed: false })
    await duct.index(dir)
    for (const q of ['1200', '1,200', '1,200.00', '1 200']) {
      const names = (await duct.search(q)).map(r => basename(r.chunk.documentPath)).sort()
      expect(names, q).toEqual(['a.txt', 'b.txt', 'c.txt'])
    }
    duct.close()
  })
})

describe('tags and dates (bids, legal)', () => {
  it('tags documents, filters by them and keeps them through re-indexing', async () => {
    const dir = files('tenders', { 'roads.txt': 'Methodology for road maintenance', 'bridges.txt': 'Methodology for bridge inspection' })
    const duct = new Duct({ embed: false })
    await duct.index(dir)
    const roads = join(dir, 'roads.txt')
    expect(duct.setTags(roads, [' client: Lagos State ', 'won', 'won', ''])).toEqual(['client: Lagos State', 'won'])
    expect((await duct.search('methodology', 10, undefined, { tags: ['won'] })).map(r => r.chunk.documentPath)).toEqual([roads])
    expect(await duct.search('methodology', 10, undefined, { tags: ['won', 'lost'] })).toEqual([])
    expect(duct.listTags()).toEqual([{ tag: 'client: Lagos State', count: 1 }, { tag: 'won', count: 1 }])

    writeFileSync(roads, 'Methodology for road maintenance, revised')
    await duct.index(roads)
    expect(duct.getDocument(roads)?.tags).toEqual(['client: Lagos State', 'won'])
    await duct.removeDocument(roads)
    expect(duct.listTags()).toEqual([])
    duct.close()
  })

  it('filters by modification date', async () => {
    const dir = files('dates', { 'old.txt': 'quarterly report', 'new.txt': 'quarterly report' })
    const twoYearsAgo = (Date.now() - 2 * 365 * 86400000) / 1000
    utimesSync(join(dir, 'old.txt'), twoYearsAgo, twoYearsAgo)
    const duct = new Duct({ embed: false })
    await duct.index(dir)
    const yearAgo = Date.now() - 365 * 86400000
    expect((await duct.search('quarterly', 10, undefined, { modifiedAfter: yearAgo })).map(r => basename(r.chunk.documentPath))).toEqual(['new.txt'])
    expect((await duct.search('quarterly', 10, undefined, { modifiedBefore: yearAgo })).map(r => basename(r.chunk.documentPath))).toEqual(['old.txt'])
    expect(duct.getDocument(join(dir, 'old.txt'))?.modifiedAt).toBeLessThan(yearAgo)
    duct.close()
  })
})

describe('document details (research)', () => {
  it('keeps real titles and authors and drops tool placeholders', () => {
    expect(cleanDetails({ title: 'Land Tenure in Lagos', author: 'A. Okafor', year: 2019 })).toEqual({ title: 'Land Tenure in Lagos', author: 'A. Okafor', year: 2019 })
    expect(cleanDetails({ title: 'Microsoft Word - draft3.docx', author: 'User', year: 1601 })).toEqual({})
    expect(cleanDetails({ title: 'Untitled', author: '  ' })).toEqual({})
  })
})

describe('export with sources', () => {
  const items = [
    { name: 'Audit 2025.pdf', path: '/a/Audit 2025.pdf', location: 'p. 4', text: 'Revenue of 1,200,000 was recognised.\nSee note 3.', tags: ['fy2025'] },
    { name: 'ledger.csv', path: '/a/ledger.csv', text: '=HYPERLINK("http://evil")', score: 1.23456 },
  ]

  it('writes CSV that Excel reads as UTF-8 and never runs formulas', () => {
    const csv = toCsv(items)
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv).toContain('"Audit 2025.pdf","p. 4","","Revenue of 1,200,000 was recognised.\nSee note 3.","/a/Audit 2025.pdf","fy2025",""')
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`)
  })

  it('writes a Word document Word can open, with each passage and its source', async () => {
    const mammoth = await import('mammoth')
    const docx = await toDocx(items, 'Evidence for FY2025 audit')
    const text = (await mammoth.extractRawText({ buffer: docx })).value
    expect(text).toContain('Evidence for FY2025 audit')
    expect(text).toContain('Revenue of 1,200,000 was recognised.')
    expect(text).toContain('Audit 2025.pdf, p. 4')
  })
})

describe('export and tag endpoints', () => {
  let server: Server
  let base: string
  let duct: Duct
  let dir: string
  beforeAll(async () => {
    dir = files('server', { 'nda.txt': 'This agreement terminates after two years.', 'msa.txt': 'Either party may terminate on notice.' })
    duct = new Duct({ embed: false })
    await duct.index(dir)
    server = createServer(duct, { authToken: 'admin', memberTokens: ['member'], libraryDir: join(work, 'lib') }).listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => { server.close(); duct.close() })
  const as = (token: string, init: RequestInit = {}) => ({ ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } })

  it('lets members tag, and filters search and export by tag', async () => {
    const nda = join(dir, 'nda.txt')
    const put = await fetch(`${base}/api/documents/tags`, as('member', { method: 'PUT', body: JSON.stringify({ path: nda, tags: ['nda'] }) }))
    expect(await put.json()).toEqual({ path: nda, tags: ['nda'] })
    expect((await (await fetch(`${base}/api/tags`, as('member'))).json()).tags).toEqual([{ tag: 'nda', count: 1 }])
    const search = await (await fetch(`${base}/api/search?q=terminate&tag=nda`, as('member'))).json()
    expect(search.results.map((r: { chunk: { documentPath: string } }) => r.chunk.documentPath)).toEqual([nda])
    const csv = await (await fetch(`${base}/api/export?q=terminate&tag=nda&format=csv`, as('member'))).text()
    expect(csv).toContain('nda.txt')
    expect(csv).not.toContain('msa.txt')
    expect((await fetch(`${base}/api/documents/tags`, as('member', { method: 'PUT', body: JSON.stringify({ path: '/etc/passwd', tags: ['x'] }) }))).status).toBe(404)
  })

  it('exports collected passages, only from indexed documents', async () => {
    const res = await fetch(`${base}/api/export`, as('member', { method: 'POST', body: JSON.stringify({ format: 'md', title: 'Termination clauses', items: [{ path: join(dir, 'msa.txt'), text: 'Either party may terminate on notice.' }] }) }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''duct-termination-clauses.md")
    expect(await res.text()).toContain('> Either party may terminate on notice.\n\n— **msa.txt**')
    const bad = await fetch(`${base}/api/export`, as('member', { method: 'POST', body: JSON.stringify({ format: 'md', items: [{ path: '/etc/hosts', text: 'x' }] }) }))
    expect(bad.status).toBe(400)
  })
})
