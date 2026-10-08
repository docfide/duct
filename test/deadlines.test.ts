import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duct } from '../src/index.js'
import { findDeadlines } from '../src/deadlines.js'

const work = mkdtempSync(join(tmpdir(), 'duct-deadlines-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const found = (t: string) => findDeadlines(t).map(f => [f.date, f.kind])

describe('reading deadlines from text', () => {
  it('reads dates by the words before them, in the usual formats', () => {
    expect(found('This Agreement expires on 31 March 2027.')).toEqual([['2027-03-31', 'expires']])
    expect(found('Amount due by 15/10/2026. Thank you.')).toEqual([['2026-10-15', 'due']])
    expect(found('The licence renews automatically on October 31, 2026.')).toEqual([['2026-10-31', 'renews']])
    expect(found('Bids must be submitted no later than 2026-11-02 at noon.')).toEqual([['2026-11-02', 'due']])
    expect(found('Valid until the 1st day of December 2026')).toEqual([['2026-12-01', 'expires']])
    expect(found('Payment due 10/25/2026')).toEqual([['2026-10-25', 'due']])   // can only be month-first
  })

  it('ignores dates that aren\'t deadlines', () => {
    expect(found('This Agreement is dated 1 March 2026 and signed by both parties.')).toEqual([])
    expect(found('Invoice date: 01/10/2026')).toEqual([])
    expect(found('Born 12 May 1990 in Kano.')).toEqual([])
    expect(found('Valid from 1 January 2026 until 31 December 2026.')).toEqual([['2026-12-31', 'expires']])
    expect(found('Meeting held on 30 February 2026, payment due.')).toEqual([])   // not a real date
  })
})

describe('the radar', () => {
  it('groups what passed, what is coming in 30 days and later, once per document', async () => {
    const dir = mkdtempSync(join(work, 'lib-'))
    writeFileSync(join(dir, 'lease.txt'), 'Lease of the Ikoyi office. This lease expires on 20 October 2026. The tenant may renew. The lease expires on 20 October 2026.')
    writeFileSync(join(dir, 'INV-77.txt'), 'Invoice date: 1 September 2026. Amount due by 30 September 2026.')
    writeFileSync(join(dir, 'msa.txt'), 'Master services agreement dated 1 March 2026. It terminates on 28 February 2027.')
    writeFileSync(join(dir, 'old.txt'), 'The 2019 contract expired on 1 January 2020.')
    const duct = new Duct({ embed: false })
    await duct.index(dir)
    const r = duct.deadlines({ now: new Date('2026-10-08T09:00:00Z') })
    expect(r.passed.map(d => [d.name, d.date, d.kind])).toEqual([['INV-77.txt', '2026-09-30', 'due']])
    expect(r.soon.map(d => [d.name, d.date, d.kind])).toEqual([['lease.txt', '2026-10-20', 'expires']])
    expect(r.later.map(d => [d.name, d.date, d.kind])).toEqual([['msa.txt', '2027-02-28', 'expires']])
    expect(r.soon[0].text).toBe('This lease expires on \u000220 October 2026\u0003.')

    duct.setFeatures({ deadlines: false })
    expect(() => duct.deadlines()).toThrow(/Deadlines radar/)
  })
})
