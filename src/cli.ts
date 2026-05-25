#!/usr/bin/env node

import { Command } from 'commander'
import { Duct } from './index.js'
import { createServer } from './server.js'

const program = new Command()

program
  .name('duct')
  .description('Document intelligence pipeline — extract, chunk, embed, search')
  .version('0.1.0')

program
  .command('index')
  .description('Index documents for search')
  .argument('<paths...>', 'Files or directories to index')
  .option('-s, --strategy <strategy>', 'Chunking strategy: sliding-window or by-heading')
  .option('--chunk-size <size>', 'Chunk size in characters', (v) => parseInt(v))
  .option('--chunk-overlap <overlap>', 'Chunk overlap in characters', (v) => parseInt(v))
  .option('--embed <provider>', 'Embedding provider: openai or gemini')
  .option('--no-embed', 'Skip embeddings, use keyword search only')
  .action(async (paths: string[], options) => {
    const embed = options.embed
      ? { provider: options.embed as 'openai' | 'gemini' }
      : options.embed === false
        ? undefined
        : undefined
    const duct = new Duct({
      chunk: {
        strategy: options.strategy as 'sliding-window' | 'by-heading' | undefined,
        size: options.chunkSize,
        overlap: options.chunkOverlap,
      },
      embed,
    })

    for (const p of paths) {
      const result = await duct.index(p)
      console.log(`  Indexed ${result.documents} document(s) → ${result.chunks} chunk(s) in ${result.time}ms`)
    }

    result(duct)
  })

program
  .command('search')
  .description('Search documents')
  .argument('<query>', 'Search query')
  .option('-k, --top-k <count>', 'Number of results', (v) => parseInt(v), 10)
  .option('-i, --index <path>', 'Index files in this path before searching')
  .option('-s, --strategy <strategy>', 'Chunking strategy (with --in)')
  .option('--embed <provider>', 'Embedding provider: openai or gemini')
  .option('--no-embed', 'Skip embeddings')
  .action(async (query: string, options) => {
    const embed = options.embed
      ? { provider: options.embed as 'openai' | 'gemini' }
      : options.embed === false
        ? undefined
        : undefined
    const duct = new Duct({
      chunk: { strategy: options.strategy as 'sliding-window' | 'by-heading' | undefined },
      embed,
    })

    if (options.index) {
      await duct.index(options.index)
    }

    const results = await duct.search(query, options.topK)
    if (results.length === 0) {
      console.log(options.index
        ? '  No results found.'
        : '  No results. Index some documents first: duct index ./docs, or use --index')
      process.exit(0)
    }
    for (const r of results) {
      const heading = r.chunk.heading ? ` / ${r.chunk.heading}` : ''
      console.log(`  [${r.score.toFixed(2)}] ${r.chunk.documentPath}${heading}`)
      console.log(`  ${r.chunk.content.slice(0, 200).replace(/\n/g, ' ')}${r.chunk.content.length > 200 ? '...' : ''}`)
      console.log()
    }
  })

program
  .command('serve')
  .description('Start the demo web server')
  .option('-p, --port <port>', 'Port to listen on', (v) => parseInt(v), 3456)
  .option('-s, --strategy <strategy>', 'Chunking strategy: sliding-window or by-heading')
  .option('--embed <provider>', 'Embedding provider: openai or gemini')
  .option('--no-embed', 'Skip embeddings, use keyword search only')
  .action(async (options) => {
    const embed = options.embed
      ? { provider: options.embed as 'openai' | 'gemini' }
      : options.embed === false
        ? undefined
        : undefined
    const duct = new Duct({
      chunk: { strategy: options.strategy as 'sliding-window' | 'by-heading' | undefined },
      embed,
    })
    const server = createServer(duct)
    server.listen(options.port, () => {
      console.log(`\n  Duct server running at http://localhost:${options.port}`)
      console.log(`  Embedding: ${duct['embedder'] ? 'enabled' : 'disabled (keyword search only)'}\n`)
    })
  })

function result(duct: Duct) {
  const s = duct.stats()
  console.log(`\n  Total: ${s.documents} document(s), ${s.chunks} chunk(s)\n`)
}

program.parse()
