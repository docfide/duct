import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duct } from '../src/index.js'
import { kindOf, recurringNames } from '../src/discover.js'

const work = mkdtempSync(join(tmpdir(), 'duct-discover-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

describe('a first look at the library', () => {
  it('tells kinds of document apart from names and opening text', () => {
    expect(kindOf('INV-2041.pdf', 'Tax invoice. Bill to: Okafor & Co. Amount due 1,200,000 NGN', 'pdf')).toBe('invoice')
    expect(kindOf('Supply agreement.docx', 'This Agreement is made between the parties. Whereas the Supplier…', 'docx')).toBe('contract')
    expect(kindOf('Ada Okafor CV.pdf', 'Work experience …', 'pdf')).toBe('cv')
    expect(kindOf('board.docx', 'Minutes of the board meeting. Attendees: …', 'docx')).toBe('minutes')
    expect(kindOf('Q3.pptx', 'Quarterly review', 'pptx')).toBe('slides')
    expect(kindOf('budget.xlsx', 'Invoice register', 'xlsx')).toBe('invoice')
    expect(kindOf('budget.xlsx', 'Line items', 'xlsx')).toBe('sheets')
    expect(kindOf('notes.txt', 'Groceries: rice, beans', 'txt')).toBe('other')
  })

  it('finds names that recur across documents, not sentence starts or common words', () => {
    const names = recurringNames([
      'Payment was made to Okafor in Lagos. The total is due.',
      'Our office in Lagos signed with Okafor yesterday. Monday is fine.',
      'Nothing about them here, but Abuja once.',
    ])
    expect(names).toEqual(['Lagos', 'Okafor'])
  })

  it('counts kinds and suggests searches that find something', async () => {
    const dir = mkdtempSync(join(work, 'lib-'))
    writeFileSync(join(dir, 'INV-001.txt'), 'Tax invoice for Okafor Ltd. Amount due: 500,000. Payment terms: 30 days.')
    writeFileSync(join(dir, 'INV-002.txt'), 'Invoice. Amount due: 75,000. Delivered to the office in Lagos for Okafor.')
    writeFileSync(join(dir, 'NDA.txt'), 'This Non-Disclosure Agreement is made between Okafor Ltd and Bello. Confidentiality lasts three years. Either party may give notice of termination in Lagos.')
    writeFileSync(join(dir, 'groceries.txt'), 'rice beans plantain')
    const duct = new Duct({ embed: false })
    await duct.index(dir)
    const d = await duct.discover()
    expect(d.documents).toBe(4)
    expect(d.kinds).toEqual([{ id: 'invoice', label: 'invoices', one: 'invoice', count: 2 }, { id: 'contract', label: 'contracts', one: 'contract', count: 1 }])
    expect(d.suggestions).toEqual(['amount due', 'Okafor', 'payment terms', 'Lagos'])
    for (const q of d.suggestions) expect((await duct.search(q, 1)).length).toBe(1)
  })
})
