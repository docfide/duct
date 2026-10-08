import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { Duct } from '../src/index.js'
import { makePptx, makeTextPdf } from './helpers.js'

const work = mkdtempSync(join(tmpdir(), 'duct-pages-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

describe('page numbers', () => {
  it('records the PDF page of every chunk', async () => {
    const pdf = join(work, 'contract.pdf')
    writeFileSync(pdf, makeTextPdf([
      [[20, 700, 'Definitions'], [12, 660, 'Words used in this agreement.']],
      [[20, 700, 'Payment'], [12, 660, 'Invoices are due within thirty days.']],
      [[20, 700, 'Termination'], [12, 660, 'Either party may terminate with notice.']],
    ]))
    const duct = new Duct()
    await duct.index(pdf)
    const [hit] = await duct.search('terminate')
    expect(hit.chunk.page).toBe(3)
    expect((await duct.search('invoices'))[0].chunk.page).toBe(2)
    expect(duct.stats().chunks).toBe(3)
  })

  it('numbers slides in order and keeps words inside runs together', async () => {
    const deck = join(work, 'deck.pptx')
    const slides = Array.from({ length: 11 }, (_, i) => [`Slide heading ${i + 1}`, i === 9 ? 'Quarterly roadmap review' : `Body text ${i + 1}`])
    writeFileSync(deck, await makePptx(slides))
    const duct = new Duct()
    await duct.index(deck)
    const [hit] = await duct.search('"quarterly roadmap"')
    expect(hit.chunk.page).toBe(10)
    expect(hit.chunk.content).toContain('Quarterly roadmap review')
  })
})

describe('snippets', () => {
  it('returns an excerpt around the match with the matched words marked', async () => {
    const file = join(work, 'long.txt')
    writeFileSync(file, 'Filler text. '.repeat(80) + 'The indemnification obligations survive termination. ' + 'More filler. '.repeat(80))
    const duct = new Duct()
    await duct.index(file)
    const [hit] = await duct.search('indemnification')
    expect(hit.snippet).toContain('\u0002indemnification\u0003')
    expect(hit.snippet!.length).toBeLessThan(400)
  })

  it('marks Chinese matches too', async () => {
    const file = join(work, 'zh.txt')
    writeFileSync(file, '前言部分。'.repeat(30) + '本合同的终止条款如下。')
    const duct = new Duct()
    await duct.index(file)
    expect((await duct.search('终止条款'))[0].snippet).toContain('\u0002终止条款\u0003')
  })
})

describe('upgrading an index without page numbers', () => {
  it('re-extracts PDFs indexed before pages were recorded', async () => {
    const data = join(work, 'old-index')
    const pdf = join(work, 'old.pdf')
    writeFileSync(pdf, makeTextPdf([[[12, 700, 'First page']], [[12, 700, 'Second page about walnuts']]]))
    const first = new Duct({ persistPath: data })
    await first.index(pdf)
    first.close()

    // Recreate the v1 schema: no page column.
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
    const db = new DatabaseSync(join(data, 'duct.db'))
    db.exec('ALTER TABLE chunks DROP COLUMN page')
    db.close()

    const second = new Duct({ persistPath: data })
    expect((await second.search('walnuts'))[0].chunk.page).toBeUndefined()
    expect(await second.refreshStale()).toBe(1)
    expect((await second.search('walnuts'))[0].chunk.page).toBe(2)
    second.close()
  })
})
