#!/usr/bin/env node

import { Command } from 'commander'
import { Duct } from './index.js'
import { createServer } from './server.js'

const program = new Command()

program
  .name('duct')
  .description('Document intelligence pipeline — extract, chunk, embed, search, ask')
  .version('0.1.0')

program
  .command('index')
  .description('Index documents for search')
  .argument('<paths...>', 'Files, directories, or URLs to index')
  .option('-s, --strategy <strategy>', 'Chunking strategy: sliding-window or by-heading')
  .option('--chunk-size <size>', 'Chunk size in characters', (v) => parseInt(v))
  .option('--chunk-overlap <overlap>', 'Chunk overlap in characters', (v) => parseInt(v))
  .option('--embed <provider>', 'Embedding provider: openai or gemini')
  .option('--no-embed', 'Skip embeddings, use keyword search only')
  .option('--ocr', 'Attempt OCR for scanned PDFs and image files')
  .option('--persist <path>', 'Directory for persistent index storage')
  .option('--search-mode <mode>', 'Search mode: bm25, vector, or hybrid')
  .option('--alpha <n>', 'Hybrid search alpha (0=BM25, 1=vector)', (v) => parseFloat(v), 0.5)
  .action(async (paths: string[], options) => {
    try {
      const embed = options.embed
        ? { provider: options.embed as 'openai' | 'gemini' }
        : options.embed === false ? undefined : undefined
      const duct = new Duct({
        chunk: {
          strategy: options.strategy as 'sliding-window' | 'by-heading' | undefined,
          size: options.chunkSize,
          overlap: options.chunkOverlap,
        },
        embed,
        ocr: options.ocr ?? false,
        persistPath: options.persist,
        search: {
          mode: options.searchMode as 'bm25' | 'vector' | 'hybrid' | undefined,
          alpha: options.alpha,
        },
      })

      for (const p of paths) {
        const result = await duct.index(p)
        console.log(`  Indexed ${result.documents} document(s) → ${result.chunks} chunk(s) in ${result.time}ms`)
      }
      result(duct)
    } catch (err) {
      console.error(`  Error: ${(err as Error).message}`)
      process.exit(1)
    }
  })

program
  .command('search')
  .description('Search documents')
  .argument('<query>', 'Search query')
  .option('-k, --top-k <count>', 'Number of results', (v) => parseInt(v), 10)
  .option('-i, --index <path>', 'Index files in this path before searching')
  .option('-s, --strategy <strategy>', 'Chunking strategy (with --index)')
  .option('--embed <provider>', 'Embedding provider: openai or gemini')
  .option('--no-embed', 'Skip embeddings')
  .option('--ocr', 'Attempt OCR for scanned PDFs and image files')
  .option('--persist <path>', 'Directory for persistent index storage')
  .option('--search-mode <mode>', 'Search mode: bm25, vector, or hybrid')
  .option('--alpha <n>', 'Hybrid search alpha', (v) => parseFloat(v), 0.5)
  .option('--rerank', 'Enable re-ranking')
  .option('--hyde', 'Enable HyDE query expansion')
  .option('--json', 'Output as JSON')
  .action(async (query: string, options) => {
    try {
      const embed = options.embed
        ? { provider: options.embed as 'openai' | 'gemini' }
        : options.embed === false ? undefined : undefined
      const duct = new Duct({
        chunk: { strategy: options.strategy as 'sliding-window' | 'by-heading' | undefined },
        embed,
        ocr: options.ocr ?? false,
        persistPath: options.persist,
        search: {
          mode: options.searchMode as 'bm25' | 'vector' | 'hybrid' | undefined,
          alpha: options.alpha,
          rerank: options.rerank ?? false,
          hyde: options.hyde ?? false,
        },
      })

      if (options.index) await duct.index(options.index)
      const results = await duct.search(query, options.topK)
      if (results.length === 0) {
        if (options.json) {
          console.log(JSON.stringify([], null, 2))
          return
        }
        console.log(options.index
          ? '  No results found.'
          : '  No results. Index some documents first: duct index ./docs, or use --index')
        return
      }
      
      if (options.json) {
        console.log(JSON.stringify(results, null, 2))
        return
      }
      
      for (const r of results) {
        const heading = r.chunk.heading ? ` / ${r.chunk.heading}` : ''
        console.log(`  [${r.score.toFixed(2)}] ${r.chunk.documentPath}${heading}`)
        console.log(`  ${r.chunk.content.slice(0, 200).replace(/\n/g, ' ')}${r.chunk.content.length > 200 ? '...' : ''}`)
        console.log()
      }
    } catch (err) {
      console.error(`  Error: ${(err as Error).message}`)
      process.exit(1)
    }
  })

program
  .command('ask')
  .description('Ask a question and get an AI-generated answer with citations')
  .argument('<question>', 'Your question')
  .option('-k, --top-k <count>', 'Number of sources', (v) => parseInt(v), 5)
  .option('-i, --index <path>', 'Index files in this path before asking')
  .option('--persist <path>', 'Directory for persistent index storage')
  .option('--llm <provider>', 'LLM provider: ollama, openai, or gemini')
  .option('--model <name>', 'LLM model name')
  .option('--base-url <url>', 'LLM base URL (for Ollama or OpenAI-compatible)')
  .option('--hyde', 'Enable HyDE query expansion')
  .option('--no-answer', 'Skip LLM, show retrieved context only')
  .option('--json', 'Output as JSON')
  .action(async (question: string, options) => {
    try {
      const duct = new Duct({
        ocr: false,
        persistPath: options.persist,
        search: { hyde: options.hyde ?? false },
        llm: options.llm ? { provider: options.llm as 'ollama' | 'openai' | 'gemini', model: options.model, baseUrl: options.baseUrl } : undefined,
      })

      if (options.index) await duct.index(options.index)

      if (options.answer === false) {
        const results = await duct.search(question, options.topK)
        if (options.json) {
          console.log(JSON.stringify(results, null, 2))
          return
        }
        console.log(`\n  Context for: "${question}"\n`)
        for (const r of results) {
          console.log(`  [${r.score.toFixed(2)}] ${r.chunk.documentPath}${r.chunk.heading ? ' > ' + r.chunk.heading : ''}`)
          console.log(`  ${r.chunk.content.slice(0, 500)}`)
          console.log()
        }
        return
      }

      const result = await duct.ask(question, options.topK)
      if (options.json) {
        console.log(JSON.stringify(result, null, 2))
        return
      }
      
      console.log(`\n  Searching for: "${question}"...`)
      console.log(`\n  Answer (${result.time}ms):\n`)
      console.log(`  ${result.answer}\n`)
      if (result.sources.length > 0) {
        console.log(`  Sources:`)
        for (const s of result.sources) {
          console.log(`    [${s.score.toFixed(2)}] ${s.documentPath}${s.heading ? ' > ' + s.heading : ''}`)
        }
        console.log()
      }
    } catch (err) {
      console.error(`  Error: ${(err as Error).message}`)
      process.exit(1)
    }
  })

program
  .command('watch')
  .description('Watch directories and auto-index new/changed files')
  .argument('<directories...>', 'Directories to watch')
  .option('-s, --strategy <strategy>', 'Chunking strategy')
  .option('--ocr', 'Enable OCR')
  .option('--persist <path>', 'Persistent index directory')
  .option('--embed <provider>', 'Embedding provider')
  .action(async (dirs: string[], options) => {
    try {
      const duct = new Duct({
        chunk: { strategy: options.strategy as 'sliding-window' | 'by-heading' | undefined },
        ocr: options.ocr ?? false,
        persistPath: options.persist,
        embed: options.embed ? { provider: options.embed as 'openai' | 'gemini' } : undefined,
      })

      console.log(`  Watching ${dirs.length} director(ies) for changes...`)
      console.log(`  Press Ctrl+C to stop.\n`)

      duct.watch(dirs, () => {
        const s = duct.stats()
        console.log(`  Indexed. Total: ${s.documents} docs, ${s.chunks} chunks`)
      })

      let shuttingDown = false
      const shutdown = () => {
        if (shuttingDown) return
        shuttingDown = true
        duct.unwatch()
        const s = duct.stats()
        console.log(`\n  Stopped. Total: ${s.documents} docs, ${s.chunks} chunks`)
        process.exit(0)
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)

      await new Promise(() => {})
    } catch (err) {
      console.error(`  Error: ${(err as Error).message}`)
      process.exit(1)
    }
  })

program
  .command('extract')
  .description('Extract structured data from documents')
  .argument('<fields...>', 'Fields in format: name:type:description (e.g. "invoice_date:date:Invoice issue date")')
  .option('-i, --index <path>', 'Index path containing documents')
  .option('--persist <path>', 'Persistent index directory')
  .option('--llm <provider>', 'LLM provider for extraction')
  .option('--model <name>', 'LLM model name')
  .option('--json', 'Output as JSON')
  .action(async (fields: string[], options) => {
    try {
      const parsedFields = fields.map(f => {
        const parts = f.split(/:(.+)/)
        return { name: parts[0], type: parts[1]?.startsWith(':') ? parts[1].slice(1) : parts[1], description: parts[2] || '' } as { name: string; type: 'string' | 'number' | 'date' | 'boolean'; description: string }
      }).map(f => ({ ...f, type: (f.type || 'string') as 'string' | 'number' | 'date' | 'boolean' }))

      const duct = new Duct({
        persistPath: options.persist,
        llm: options.llm ? { provider: options.llm as 'ollama' | 'openai' | 'gemini', model: options.model } : undefined,
      })

      if (options.index) await duct.index(options.index)

      console.log(`  Extracting ${parsedFields.map(f => f.name).join(', ')}...`)
      const results = await duct.extractSchema(parsedFields)
      if (options.json) {
        console.log(JSON.stringify(results, null, 2))
      } else {
        for (const r of results) {
          console.log(`\n  ${r.path}`)
          for (const [key, val] of Object.entries(r.fields)) {
            console.log(`    ${key}: ${val ?? '(not found)'}`)
          }
        }
        console.log()
      }
    } catch (err) {
      console.error(`  Error: ${(err as Error).message}`)
      process.exit(1)
    }
  })

program
  .command('diff')
  .description('Show changes between document versions')
  .argument('<path>', 'Document path to diff')
  .option('--persist <path>', 'Persistent index directory')
  .action(async (path: string, options) => {
    try {
      const duct = new Duct({ persistPath: options.persist })
      const d = await duct.diff(path)
      if (!d) {
        console.log('  No version history found for this document. Re-index it to create versions.')
        return
      }
      console.log(`\n  Changes in "${d.path}" (v${d.versionA} → v${d.versionB}):\n`)
      if (d.additions.length > 0) {
        console.log('  Added lines:')
        for (const line of d.additions) console.log(`    + ${line.slice(0, 120)}`)
        console.log()
      }
      if (d.removals.length > 0) {
        console.log('  Removed lines:')
        for (const line of d.removals) console.log(`    - ${line.slice(0, 120)}`)
        console.log()
      }
      if (d.additions.length === 0 && d.removals.length === 0) {
        console.log('  No significant text changes detected.')
      }
    } catch (err) {
      console.error(`  Error: ${(err as Error).message}`)
      process.exit(1)
    }
  })

program
  .command('serve')
  .description('Start the web server with full UI')
  .option('-p, --port <port>', 'Port to listen on', (v) => parseInt(v), 3456)
  .option('-s, --strategy <strategy>', 'Chunking strategy: sliding-window or by-heading')
  .option('--embed <provider>', 'Embedding provider: openai or gemini')
  .option('--no-embed', 'Skip embeddings, use keyword search only')
  .option('--ocr', 'Attempt OCR for scanned PDFs and image files')
  .option('--persist <path>', 'Directory for persistent index storage')
  .option('--auth-token <token>', 'Bearer token required for API requests (env: DUCT_AUTH_TOKEN)')
  .option('--upload-limit <mb>', 'Max upload file size in MB', (v) => parseInt(v), 50)
  .option('--search-mode <mode>', 'Search mode: bm25, vector, or hybrid')
  .option('--alpha <n>', 'Hybrid search alpha', (v) => parseFloat(v), 0.5)
  .option('--llm <provider>', 'Default LLM provider: ollama, openai, gemini')
  .action(async (options) => {
    try {
      const embed = options.embed
        ? { provider: options.embed as 'openai' | 'gemini' }
        : options.embed === false ? undefined : undefined
      const duct = new Duct({
        chunk: { strategy: options.strategy as 'sliding-window' | 'by-heading' | undefined },
        embed,
        ocr: options.ocr ?? false,
        persistPath: options.persist,
        search: { mode: options.searchMode as 'bm25' | 'vector' | 'hybrid' | undefined, alpha: options.alpha, rerank: true },
        llm: options.llm ? { provider: options.llm as 'ollama' | 'openai' | 'gemini' } : undefined,
      })
      const token = options.authToken || process.env['DUCT_AUTH_TOKEN']
      const server = createServer(duct, { authToken: token, uploadLimitMb: options.uploadLimit })
      server.listen(options.port, () => {
        console.log(`\n  Duct server running at http://localhost:${options.port}`)
        if (token) console.log(`  Auth: token required`)
        console.log(`  Upload limit: ${options.uploadLimit} MB`)
        console.log(`  Embedding: ${duct['embedder'] ? 'enabled' : 'disabled (keyword search only)'}`)
        console.log(`  LLM: ${duct['llmProvider'] ? duct['llmProvider']!.name : 'none (configure in settings)'}`)
        console.log(`  Search: ${options.searchMode || 'bm25'}${options.alpha ? ' (alpha=' + options.alpha + ')' : ''}\n`)
      })
    } catch (err) {
      console.error(`  Error: ${(err as Error).message}`)
      process.exit(1)
    }
  })

function result(duct: Duct) {
  const s = duct.stats()
  console.log(`\n  Total: ${s.documents} document(s), ${s.chunks} chunk(s)\n`)
}

program.parse()
