import { describe, it, expect, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duct } from '../src/index.js'
import { reciprocalRankFusion } from '../src/search/hybrid.js'
import { markedWords, osaDistance } from '../src/store/sqlite.js'

const work = mkdtempSync(join(tmpdir(), 'duct-help-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

async function library(contents: Record<string, string | Buffer>): Promise<Duct> {
  const dir = mkdtempSync(join(work, 'lib-'))
  mkdirSync(dir, { recursive: true })
  for (const [f, body] of Object.entries(contents)) writeFileSync(join(dir, f), body)
  const duct = new Duct({ embed: false })
  await duct.index(dir)
  return duct
}

describe('why this result', () => {
  it('names the words as written in the passage, including other forms of the word', async () => {
    const duct = await library({ 'msa.txt': 'Either party may give notice of termination after the initial term.' })
    const [r] = await duct.search('terminate')
    expect(r.why).toEqual({ words: ['termination'] })
  })

  it('says when the file name matched', async () => {
    const duct = await library({ 'Lease agreement Ikoyi.txt': 'Rent is payable quarterly in advance.' })
    const [r] = await duct.search('ikoyi lease')
    expect(r.why?.fileName).toBe(true)
  })

  it('keeps snippets and reasons when keyword and meaning results are merged', () => {
    const chunk = (id: string) => ({ id, documentPath: '/x', documentFormat: 'txt' as const, content: 'x', index: 0, metadata: {} })
    const fused = reciprocalRankFusion(
      [{ chunk: chunk('a'), score: 2, snippet: '\u0002notice\u0003 period', why: { words: ['notice'] } }],
      [{ chunk: chunk('a'), score: 0.9, why: { words: [], meaning: true } }, { chunk: chunk('b'), score: 0.8, why: { words: [], meaning: true } }],
      10, 0.5)
    expect(fused[0]).toMatchObject({ snippet: '\u0002notice\u0003 period', why: { words: ['notice'], meaning: true } })
    expect(fused[1].why).toEqual({ words: [], meaning: true })
  })
})

describe('no dead ends', () => {
  it('suggests the spelling used in the documents', async () => {
    const duct = await library({
      'nda.txt': 'The confidentiality obligations survive termination of this agreement.',
      'msa.txt': 'Indemnification is capped at the fees paid. The indemnity survives.',
    })
    expect(await duct.search('confidentality')).toHaveLength(0)
    expect((await duct.searchHelp('confidentality')).didYouMean).toBe('confidentiality')
    expect((await duct.searchHelp('the indemnty clause')).didYouMean).toBe('the indemnity clause')
    expect((await duct.searchHelp('zebra')).didYouMean).toBeUndefined()
  })

  it('counts what was searched and what couldn\'t be, and results hidden by filters', async () => {
    const duct = await library({
      'memo.txt': 'Board approved the Lagos office lease.',
      'notes.md': '# Lease\nThe Lagos lease runs five years.',
      'scan.png': Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a10000000049454e44ae426082', 'hex'),
      'broken.pdf': 'not really a pdf',
    })
    const help = await duct.searchHelp('lagos', undefined, { formats: ['pdf'] })
    expect(help).toMatchObject({ documents: 2, needsOcr: 1, failed: 1, indexing: null, outsideFilters: 2 })
    expect((await duct.searchHelp('lagos')).outsideFilters).toBe(0)
  })

  it('helpers', () => {
    expect(osaDistance('recieve', 'receive')).toBe(1)
    expect(osaDistance('contarct', 'contract')).toBe(1)
    expect(osaDistance('kitten', 'sitting')).toBe(3)
    expect(markedWords('a \u0002Notice\u0003 b \u0002notice\u0003 \u0002period\u0003')).toEqual(['Notice', 'notice', 'period'])
  })
})
