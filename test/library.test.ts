import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duct } from '../src/index.js'
import { createServer } from '../src/server.js'
import { addToLibrary, safeFileName } from '../src/library.js'

const work = mkdtempSync(join(tmpdir(), 'duct-library-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

function upload(base: string, name: string, content: string) {
  const form = new FormData()
  form.append('files', new Blob([content], { type: 'text/plain' }), name)
  return fetch(`${base}/api/index`, { method: 'POST', body: form })
}

describe('library uploads', () => {
  const libraryDir = join(work, 'Duct Library')
  let server: Server
  let base: string
  let duct: Duct

  beforeAll(async () => {
    duct = new Duct()
    server = createServer(duct, { libraryDir }).listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => server.close())

  it('keeps uploads in the library under their original names', async () => {
    const res = await upload(base, 'Quarterly Report.txt', 'quarterly revenue grew with avocados')
    expect(res.status).toBe(200)
    const { results } = await res.json()
    expect(results[0]).toMatchObject({ file: 'Quarterly Report.txt', documents: 1 })
    expect(existsSync(join(libraryDir, 'Quarterly Report.txt'))).toBe(true)
    expect(readdirSync(join(libraryDir, '.incoming'))).toHaveLength(0)

    const { documents } = await (await fetch(`${base}/api/documents`)).json()
    expect(documents[0]).toMatchObject({ displayName: 'Quarterly Report.txt', source: 'library' })
  })

  it('reports identical content as a duplicate instead of storing it twice', async () => {
    const res = await upload(base, 'copy of report.txt', 'quarterly revenue grew with avocados')
    const { results } = await res.json()
    expect(results[0].duplicateOf).toBe('Quarterly Report.txt')
    expect(existsSync(join(libraryDir, 'copy of report.txt'))).toBe(false)
    expect(duct.stats().documents).toBe(1)
  })

  it('keeps both files when different content has the same name', async () => {
    await upload(base, 'Quarterly Report.txt', 'a different quarter with figs')
    expect(existsSync(join(libraryDir, 'Quarterly Report (2).txt'))).toBe(true)
    expect(duct.stats().documents).toBe(2)
  })

  it('deletes the library copy when its document is removed', async () => {
    const path = join(libraryDir, 'Quarterly Report (2).txt')
    const res = await fetch(`${base}/api/documents?path=${encodeURIComponent(path)}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(existsSync(path)).toBe(false)
  })

  it('only unindexes files that live outside the library', async () => {
    const outside = join(work, 'outside.txt')
    writeFileSync(outside, 'keep this file on disk: dates')
    await duct.index(outside)
    const res = await fetch(`${base}/api/documents?path=${encodeURIComponent(outside)}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(existsSync(outside)).toBe(true)
    expect(duct.getDocument(outside)).toBeUndefined()
  })
})

describe('addToLibrary', () => {
  it('copies a local file without touching the original', async () => {
    const duct = new Duct()
    const src = join(work, 'original.md')
    writeFileSync(src, '# Notes\n\nabout quinces')
    const libraryDir = join(work, 'lib2')
    const r = await addToLibrary(duct, libraryDir, src)
    expect(r.documents).toBe(1)
    expect(existsSync(src)).toBe(true)
    expect(existsSync(join(libraryDir, 'original.md'))).toBe(true)
  })

  it('makes file names safe', () => {
    expect(safeFileName('../../etc/passwd.txt')).toBe('passwd.txt')
    expect(safeFileName('a<b>c:d.PDF')).toBe('abcd.pdf')
    expect(safeFileName('.hidden.txt')).toBe('hidden.txt')
    expect(safeFileName('???.txt')).toBe('document.txt')
  })
})
