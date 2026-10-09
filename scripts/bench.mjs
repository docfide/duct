// Measures indexing speed, search latency and (optionally) accuracy on a folder of real documents.
//
//   npm run build
//   npm run bench -- <folder> [queries.json] [--ocr]
//
// queries.json is a list of questions you know the answer to:
//   [{ "query": "termination notice period", "file": "MSA 2024.pdf", "page": 12 }, ...]
// "page" is optional. A query counts as a hit when that file (and page) is in the top 3 results.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { performance } from 'node:perf_hooks'

const args = process.argv.slice(2)
const ocr = args.includes('--ocr')
const [folder, queriesFile] = args.filter(a => !a.startsWith('--'))
if (!folder) {
  console.error('Usage: npm run bench -- <folder> [queries.json] [--ocr]')
  process.exit(1)
}

const { Duct } = await import('../dist/index.js')
const dataDir = mkdtempSync(join(tmpdir(), 'duct-bench-'))

try {
  const duct = new Duct({ persistPath: dataDir, ocr, embed: false })

  let t = performance.now()
  const first = await duct.index(folder)
  const indexMs = performance.now() - t
  const docs = duct.getDocuments()
  const noText = docs.filter(d => d.status === 'no-text').length

  t = performance.now()
  await duct.index(folder)
  const reindexMs = performance.now() - t

  const queries = queriesFile ? JSON.parse(readFileSync(queriesFile, 'utf-8')) : [{ query: 'the' }, { query: 'agreement' }, { query: '"payment terms"' }]
  const latencies = []
  let hits = 0
  const misses = []
  for (const q of queries) {
    let results = []
    for (let i = 0; i < 5; i++) {
      const start = performance.now()
      results = await duct.search(q.query, 10)
      latencies.push(performance.now() - start)
    }
    if (q.file) {
      const top3 = results.slice(0, 3)
      const hit = top3.some(r => basename(r.chunk.documentPath) === q.file && (q.page === undefined || r.chunk.page === q.page))
      if (hit) hits++
      else misses.push({ query: q.query, expected: `${q.file}${q.page ? ' p.' + q.page : ''}`, got: top3.map(r => `${basename(r.chunk.documentPath)}${r.chunk.page ? ' p.' + r.chunk.page : ''}`).join(' | ') || '(nothing)' })
    }
  }
  latencies.sort((a, b) => a - b)
  const pct = p => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))].toFixed(1)

  const stats = duct.stats()
  console.log(`\nFolder:          ${folder}`)
  console.log(`Documents:       ${stats.documents} (${noText} with no text${ocr ? '' : ', try --ocr'}${first.failed ? `, ${first.failed} failed` : ''}), ${stats.chunks} chunks`)
  console.log(`Index (cold):    ${(indexMs / 1000).toFixed(1)} s  (${(stats.documents / (indexMs / 1000)).toFixed(1)} docs/s)`)
  console.log(`Re-index:        ${(reindexMs / 1000).toFixed(2)} s  (unchanged files are skipped)`)
  console.log(`Search latency:  p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms  (${latencies.length} searches)`)
  const scored = queries.filter(q => q.file).length
  if (scored > 0) {
    console.log(`Accuracy:        ${hits}/${scored} queries found the right ${queries.some(q => q.page) ? 'file and page' : 'file'} in the top 3`)
    for (const m of misses) console.log(`  miss: "${m.query}" expected ${m.expected}, got ${m.got}`)
  }
  duct.close()
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}
