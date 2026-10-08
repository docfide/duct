import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { Duct } from '../src/index.js'
import { createServer } from '../src/server.js'
import { terminateOcr } from '../src/ocr/index.js'
import { makeTextPdf } from './helpers.js'

const work = mkdtempSync(join(tmpdir(), 'duct-api5-'))
let server: Server
let base: string
let duct: Duct
const pdf = join(work, 'docs', 'contract.pdf')
const html = join(work, 'docs', 'page.html')
const scan = join(work, 'docs', 'scan.png')

beforeAll(async () => {
  mkdirSync(join(work, 'docs'))
  writeFileSync(pdf, makeTextPdf([[[12, 700, 'Intro']], [[12, 700, 'Termination on page two']]]))
  writeFileSync(html, '<html><body><script>alert(1)</script>Policy text</body></html>')
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="200"><rect width="100%" height="100%" fill="white"/><text x="40" y="120" font-family="Helvetica, Arial" font-size="64">Scanned receipt total</text></svg>'
  writeFileSync(scan, await sharp(Buffer.from(svg)).png().toBuffer())
  duct = new Duct()
  server = createServer(duct, { libraryDir: join(work, 'lib') }).listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.close()
  await terminateOcr()
  rmSync(work, { recursive: true, force: true })
})

describe('GET /api/file', () => {
  it('serves indexed PDFs inline so the browser can open them at a page', async () => {
    await duct.index(pdf)
    const [hit] = await (await fetch(`${base}/api/search?q=termination`)).json().then(d => d.results)
    expect(hit.chunk.page).toBe(2)
    const res = await fetch(`${base}/api/file?path=${encodeURIComponent(hit.chunk.documentPath)}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toMatch(/^inline/)
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(100)
  })

  it('downloads other types instead of rendering them', async () => {
    await duct.index(html)
    const res = await fetch(`${base}/api/file?path=${encodeURIComponent(html)}`)
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/)
  })

  it('refuses files that are not in the index', async () => {
    writeFileSync(join(work, 'secret.txt'), 'not indexed')
    expect((await fetch(`${base}/api/file?path=${encodeURIComponent(join(work, 'secret.txt'))}`)).status).toBe(404)
    expect((await fetch(`${base}/api/file?path=${encodeURIComponent('/etc/hosts')}`)).status).toBe(404)
  })
})

describe('POST /api/ocr', () => {
  it('reads an image that was indexed without OCR', async () => {
    await duct.index(scan)
    expect(duct.getDocument(scan)?.status).toBe('no-text')
    const res = await fetch(`${base}/api/ocr`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: scan }) })
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.document.status).toBe('indexed')
    expect((await duct.search('receipt')).length).toBe(1)
  }, 60_000)
})

describe('activity and sources', () => {
  it('reports progress while indexing', async () => {
    const dir = join(work, 'many')
    mkdirSync(dir)
    for (let i = 0; i < 30; i++) writeFileSync(join(dir, `n${i}.txt`), `note ${i} about pistachios`)
    const running = duct.index(dir)
    let seen = false
    for (let i = 0; i < 50 && !seen; i++) {
      const a = await (await fetch(`${base}/api/activity`)).json()
      if (a.indexing && a.total === 30) seen = true
      else await new Promise(r => setTimeout(r, 5))
    }
    await running
    expect(seen).toBe(true)
    expect(await (await fetch(`${base}/api/activity`)).json()).toMatchObject({ indexing: false, done: 0, total: 0 })
  })

  it('lists and removes watched folders', async () => {
    const dir = join(work, 'watched')
    mkdirSync(dir)
    writeFileSync(join(dir, 'w.txt'), 'watched note about hazelnuts')
    await duct.watch([dir])
    const { sources, canAdd } = await (await fetch(`${base}/api/sources`)).json()
    expect(canAdd).toBe(false)
    expect(sources.map((s: { path: string }) => s.path)).toContain(dir)
    expect((await fetch(`${base}/api/sources?path=${encodeURIComponent(dir)}`, { method: 'DELETE' })).status).toBe(200)
    expect(await duct.search('hazelnuts')).toHaveLength(0)
    expect((await fetch(`${base}/api/sources?path=${encodeURIComponent('/not/watched')}`, { method: 'DELETE' })).status).toBe(404)
  })
})
