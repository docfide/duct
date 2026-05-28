import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { Duct } from '../src/index.js'
import { extract, detectFormat } from '../src/extract/index.js'
import { chunk } from '../src/chunk/index.js'
import { BM25Searcher } from '../src/search/bm25.js'
import { MemoryVectorStore } from '../src/store/memory.js'

const fixturesDir = join(import.meta.dirname, 'fixtures')

describe('detectFormat', () => {
  it('detects txt files', () => {
    expect(detectFormat('doc.txt')).toBe('txt')
  })

  it('detects pdf files', () => {
    expect(detectFormat('doc.pdf')).toBe('pdf')
  })

  it('detects md files', () => {
    expect(detectFormat('doc.md')).toBe('md')
    expect(detectFormat('doc.markdown')).toBe('md')
  })

  it('detects html files', () => {
    expect(detectFormat('doc.html')).toBe('html')
    expect(detectFormat('doc.htm')).toBe('html')
  })

  it('detects docx files', () => {
    expect(detectFormat('doc.docx')).toBe('docx')
  })

  it('detects image files', () => {
    expect(detectFormat('photo.png')).toBe('image')
    expect(detectFormat('photo.jpg')).toBe('image')
    expect(detectFormat('photo.jpeg')).toBe('image')
    expect(detectFormat('photo.tiff')).toBe('image')
    expect(detectFormat('photo.bmp')).toBe('image')
    expect(detectFormat('photo.gif')).toBe('image')
    expect(detectFormat('photo.webp')).toBe('image')
  })

  it('falls back to txt for unknown extensions', () => {
    expect(detectFormat('data.csv')).toBe('txt')
    expect(detectFormat('script.js')).toBe('txt')
  })
})

describe('extract', () => {
  it('extracts text from .txt files', async () => {
    const doc = await extract(join(fixturesDir, 'sample.txt'))
    expect(doc.format).toBe('txt')
    expect(doc.content.toLowerCase()).toContain('termination')
    expect(doc.content.toLowerCase()).toContain('indemnification')
    expect(doc.metadata.size).toBeGreaterThan(0)
  })

  it('extracts text from .md files', async () => {
    const doc = await extract(join(fixturesDir, 'sample.md'))
    expect(doc.format).toBe('md')
    expect(doc.content).toContain('# Sample Document')
    expect(doc.content).toContain('termination')
    expect(doc.metadata.headings).toBeDefined()
    const headings = doc.metadata.headings as { level: number; text: string }[]
    expect(headings.length).toBeGreaterThanOrEqual(4)
    expect(headings[0].text).toBe('Sample Document')
  })

  it('extracts text from .html files', async () => {
    const doc = await extract(join(fixturesDir, 'sample.html'))
    expect(doc.format).toBe('html')
    expect(doc.content).toContain('termination')
    expect(doc.metadata.title).toBe('Test HTML')
  })
})

describe('chunk', () => {
  const content = 'word '.repeat(5000).trim()

  it('splits content into chunks with sliding-window', () => {
    const chunks = chunk(content, '/test.txt', 'txt', 'sliding-window', 1500, 200)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0].documentPath).toBe('/test.txt')
    expect(chunks[0].documentFormat).toBe('txt')
    expect(chunks[0].content.length).toBeLessThanOrEqual(1500)
    expect(chunks[0].id).toBeTruthy()
  })

  it('splits content into chunks with by-heading', () => {
    const mdContent = '# Title\n\nContent\n\n## Section 1\n\nSection text\n\n## Section 2\n\nMore text'
    const chunks = chunk(mdContent, '/test.md', 'md', 'by-heading')
    expect(chunks.length).toBeGreaterThanOrEqual(1)
  })
})

describe('BM25Searcher', () => {
  it('indexes and searches chunks', async () => {
    const searcher = new BM25Searcher()
    const chunks = [
      { id: '1', documentPath: '/a.txt', documentFormat: 'txt' as const, content: 'termination clause agreement', index: 0, metadata: {} },
      { id: '2', documentPath: '/b.txt', documentFormat: 'txt' as const, content: 'payment terms invoice due', index: 1, metadata: {} },
    ]
    await searcher.add(chunks)
    const results = await searcher.search('termination', 5)
    expect(results.length).toBe(1)
    expect(results[0].chunk.id).toBe('1')
    expect(results[0].score).toBeGreaterThan(0)
  })

  it('returns empty for unmatched queries', async () => {
    const searcher = new BM25Searcher()
    const chunks = [
      { id: '1', documentPath: '/a.txt', documentFormat: 'txt' as const, content: 'hello world', index: 0, metadata: {} },
    ]
    await searcher.add(chunks)
    const results = await searcher.search('xyznonexistent', 5)
    expect(results.length).toBe(0)
  })

  it('persists and reloads', async () => {
    const tmpDir = join(import.meta.dirname, '..', 'tmp-test-bm25')
    mkdirSync(tmpDir, { recursive: true })

    const searcher = new BM25Searcher()
    const chunks = [
      { id: '1', documentPath: '/a.txt', documentFormat: 'txt' as const, content: 'persistence test data', index: 0, metadata: {} },
    ]
    await searcher.add(chunks)
    await searcher.save(join(tmpDir, 'bm25.json'))

    const searcher2 = new BM25Searcher()
    await searcher2.load(join(tmpDir, 'bm25.json'))
    const results = await searcher2.search('persistence', 5)
    expect(results.length).toBe(1)
    expect(results[0].chunk.content).toContain('persistence')

    rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe('MemoryVectorStore', () => {
  it('stores and searches embeddings', async () => {
    const store = new MemoryVectorStore()
    const chunks = [
      { id: '1', documentPath: '/a.txt', documentFormat: 'txt' as const, content: 'a', index: 0, metadata: {} },
      { id: '2', documentPath: '/b.txt', documentFormat: 'txt' as const, content: 'b', index: 1, metadata: {} },
    ]
    await store.add(chunks, [[1, 0, 0], [0, 1, 0]])
    const results = await store.search([0.9, 0.1, 0], 5)
    expect(results.length).toBe(2)
    expect(results[0].chunk.id).toBe('1')
  })

  it('persists and reloads', async () => {
    const tmpDir = join(import.meta.dirname, '..', 'tmp-test-vec')
    mkdirSync(tmpDir, { recursive: true })

    const store = new MemoryVectorStore()
    const chunks = [
      { id: '1', documentPath: '/a.txt', documentFormat: 'txt' as const, content: 'a', index: 0, metadata: {} },
    ]
    await store.add(chunks, [[1, 0]])
    await store.save(join(tmpDir, 'vectors.json'))

    const store2 = new MemoryVectorStore()
    await store2.load(join(tmpDir, 'vectors.json'))
    const results = await store2.search([1, 0], 5)
    expect(results.length).toBe(1)

    rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe('Duct integration', () => {
  it('indexes a file and searches it', async () => {
    const duct = new Duct()
    const result = await duct.index(join(fixturesDir, 'sample.txt'))
    expect(result.documents).toBe(1)
    expect(result.chunks).toBeGreaterThanOrEqual(1)
    expect(result.time).toBeGreaterThanOrEqual(0)

    const searchResults = await duct.search('termination', 5)
    expect(searchResults.length).toBeGreaterThanOrEqual(1)
    expect(searchResults[0].score).toBeGreaterThan(0)
  })

  it('indexes multiple files', async () => {
    const duct = new Duct()
    const result = await duct.index(join(fixturesDir, 'sample.md'))
    expect(result.documents).toBe(1)

    const searchResults = await duct.search('indemnification', 5)
    expect(searchResults.length).toBeGreaterThan(0)
  })

  it('deduplicates files', async () => {
    const duct = new Duct()
    const r1 = await duct.index(join(fixturesDir, 'sample.txt'))
    const r2 = await duct.index(join(fixturesDir, 'sample.txt'))
    expect(r2.documents).toBe(0)
    expect(r2.chunks).toBe(0)
    expect(duct.stats().documents).toBe(1)
  })

  it('clears all data', async () => {
    const duct = new Duct()
    await duct.index(join(fixturesDir, 'sample.txt'))
    expect(duct.stats().documents).toBe(1)
    await duct.clear()
    expect(duct.stats().documents).toBe(0)
    expect(duct.stats().chunks).toBe(0)
  })

  it('indexes and searches with heading-aware chunking', async () => {
    const duct = new Duct({ chunk: { strategy: 'by-heading' } })
    await duct.index(join(fixturesDir, 'sample.md'))
    const results = await duct.search('termination', 5)
    expect(results.length).toBeGreaterThanOrEqual(1)
  })

  it('persists and reloads index', async () => {
    const tmpDir = join(import.meta.dirname, '..', 'tmp-test-duct')
    mkdirSync(tmpDir, { recursive: true })

    const duct1 = new Duct({ persistPath: tmpDir })
    await duct1.index(join(fixturesDir, 'sample.txt'))
    await duct1.index(join(fixturesDir, 'sample.md'))

    const duct2 = new Duct({ persistPath: tmpDir })
    expect(duct2.stats().documents).toBe(0)
    const results = await duct2.search('termination', 5)
    expect(results.length).toBeGreaterThan(0)
    expect(duct2.stats().documents).toBe(2)

    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('ranks relevant results higher', async () => {
    const duct = new Duct()
    await duct.index(join(fixturesDir, 'sample.md'))
    const results = await duct.search('termination', 5)
    expect(results.length).toBeGreaterThan(0)
    const top = results[0]
    expect(top.chunk.content.toLowerCase()).toContain('termination')
    expect(top.score).toBeGreaterThan(0)
  })
})
