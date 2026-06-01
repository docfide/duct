#!/usr/bin/env node

import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
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
        const spinner = ora({ text: `Indexing ${chalk.cyan(p)}...`, color: 'green' }).start()
        const result = await duct.index(p)
        spinner.succeed(chalk.dim(`${result.documents} doc(s) → ${result.chunks} chunk(s) in ${result.time}ms`))
      }
      const s = duct.stats()
      console.log(`  ${chalk.green('✓')} ${chalk.bold(`Total: ${s.documents} document(s), ${s.chunks} chunk(s)`)}\n`)
    } catch (err) {
      console.error(`  ${chalk.red('✗')} ${chalk.red((err as Error).message)}`)
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

      if (options.index) {
        const spinner = ora({ text: `Indexing ${chalk.cyan(options.index)}...`, color: 'green' }).start()
        await duct.index(options.index)
        spinner.succeed('Indexed')
      }

      const results = await duct.search(query, options.topK)
      if (results.length === 0) {
        if (options.json) {
          console.log(JSON.stringify([], null, 2))
          return
        }
        console.log(options.index
          ? `  ${chalk.yellow('No results found.')}`
          : `  ${chalk.yellow('No results.')} ${chalk.dim('Index some documents first: duct index ./docs, or use --index')}`)
        return
      }

      if (options.json) {
        console.log(JSON.stringify(results, null, 2))
        return
      }

      const scoreStyle = (s: number) => {
        if (s > 0.7) return chalk.green(s.toFixed(2))
        if (s > 0.4) return chalk.yellow(s.toFixed(2))
        return chalk.red(s.toFixed(2))
      }

      console.log()
      for (const r of results) {
        const heading = r.chunk.heading ? chalk.dim(` › ${r.chunk.heading}`) : ''
        const file = r.chunk.documentPath
        console.log(`  ${scoreStyle(r.score)}  ${chalk.cyan(file)}${heading}`)
        const snippet = r.chunk.content.slice(0, 200).replace(/\n/g, ' ')
        console.log(`       ${chalk.dim(snippet)}${r.chunk.content.length > 200 ? chalk.dim('...') : ''}`)
        console.log()
      }
    } catch (err) {
      console.error(`  ${chalk.red('✗')} ${chalk.red((err as Error).message)}`)
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

      if (options.index) {
        const spinner = ora({ text: `Indexing ${chalk.cyan(options.index)}...`, color: 'green' }).start()
        await duct.index(options.index)
        spinner.succeed('Indexed')
      }

      if (options.answer === false) {
        const results = await duct.search(question, options.topK)
        if (options.json) {
          console.log(JSON.stringify(results, null, 2))
          return
        }
        console.log(`\n  ${chalk.bold(`Context for:`)} ${chalk.cyan(`"${question}"`)}\n`)
        for (const r of results) {
          const heading = r.chunk.heading ? chalk.dim(` › ${r.chunk.heading}`) : ''
          console.log(`  ${chalk.green(r.score.toFixed(2))}  ${chalk.cyan(r.chunk.documentPath)}${heading}`)
          console.log(`       ${chalk.dim(r.chunk.content.slice(0, 500))}`)
          console.log()
        }
        return
      }

      const spinner = ora({ text: 'Thinking...', color: 'yellow' }).start()
      const result = await duct.ask(question, options.topK)
      spinner.succeed(chalk.dim(`Answer in ${result.time}ms`))

      console.log(`\n  ${result.answer}\n`)

      if (result.sources.length > 0) {
        console.log(`  ${chalk.bold('Sources:')}`)
        for (const s of result.sources) {
          const heading = s.heading ? chalk.dim(` › ${s.heading}`) : ''
          console.log(`    ${chalk.green(s.score.toFixed(2))}  ${chalk.cyan(s.documentPath)}${heading}`)
        }
        console.log()
      }
    } catch (err) {
      console.error(`  ${chalk.red('✗')} ${chalk.red((err as Error).message)}`)
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

      console.log(`  ${chalk.green('✓')} Watching ${chalk.bold(String(dirs.length))} director(ies) for changes...`)
      console.log(`  ${chalk.dim('  Press Ctrl+C to stop.')}\n`)

      duct.watch(dirs, () => {
        const s = duct.stats()
        console.log(`  ${chalk.green('✓')} Indexed. ${chalk.dim(`Total: ${s.documents} docs, ${s.chunks} chunks`)}`)
      })

      let shuttingDown = false
      const shutdown = () => {
        if (shuttingDown) return
        shuttingDown = true
        duct.unwatch()
        const s = duct.stats()
        console.log(`\n  ${chalk.yellow('Stopped.')} ${chalk.dim(`Total: ${s.documents} docs, ${s.chunks} chunks`)}`)
        process.exit(0)
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)

      await new Promise(() => {})
    } catch (err) {
      console.error(`  ${chalk.red('✗')} ${chalk.red((err as Error).message)}`)
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

      if (options.index) {
        const spinner = ora({ text: `Indexing ${chalk.cyan(options.index)}...`, color: 'green' }).start()
        await duct.index(options.index)
        spinner.succeed('Indexed')
      }

      const spinner = ora({ text: `Extracting ${chalk.bold(parsedFields.map(f => f.name).join(', '))}...`, color: 'yellow' }).start()
      const results = await duct.extractSchema(parsedFields)
      spinner.succeed('Done')

      if (options.json) {
        console.log(JSON.stringify(results, null, 2))
      } else {
        const maxNameLen = Math.max(...parsedFields.map(f => f.name.length), 0)
        for (const r of results) {
          console.log(`\n  ${chalk.cyan(r.path)}`)
          for (const [key, val] of Object.entries(r.fields)) {
            const padded = key.padEnd(maxNameLen)
            console.log(`    ${chalk.dim(padded)}  ${val ?? chalk.dim('(not found)')}`)
          }
        }
        console.log()
      }
    } catch (err) {
      console.error(`  ${chalk.red('✗')} ${chalk.red((err as Error).message)}`)
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
        console.log(`  ${chalk.yellow('No version history found.')} ${chalk.dim('Re-index the document to create versions.')}`)
        return
      }
      console.log(`\n  ${chalk.bold('Changes in')} ${chalk.cyan(d.path)} ${chalk.dim(`(v${d.versionA} → v${d.versionB})`)}\n`)
      if (d.additions.length > 0) {
        console.log(`  ${chalk.green('Added:')}`)
        for (const line of d.additions) console.log(`    ${chalk.green('+')} ${line.slice(0, 120)}`)
        console.log()
      }
      if (d.removals.length > 0) {
        console.log(`  ${chalk.red('Removed:')}`)
        for (const line of d.removals) console.log(`    ${chalk.red('-')} ${line.slice(0, 120)}`)
        console.log()
      }
      if (d.additions.length === 0 && d.removals.length === 0) {
        console.log(`  ${chalk.dim('No significant text changes detected.')}`)
      }
    } catch (err) {
      console.error(`  ${chalk.red('✗')} ${chalk.red((err as Error).message)}`)
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
        console.log(`\n  ${chalk.green('✓')} ${chalk.bold('Duct server running at')} ${chalk.cyan(`http://localhost:${options.port}`)}`)
        if (token) console.log(`    ${chalk.dim('Auth:')} token required`)
        console.log(`    ${chalk.dim('Upload limit:')} ${options.uploadLimit} MB`)
        console.log(`    ${chalk.dim('Embedding:')} ${duct['embedder'] ? chalk.green('enabled') : chalk.dim('disabled (keyword search only)')}`)
        const llmName = duct['llmProvider'] ? duct['llmProvider']!.name : 'none'
        console.log(`    ${chalk.dim('LLM:')} ${llmName === 'none' ? chalk.dim('none (configure in settings)') : chalk.green(llmName)}`)
        const mode = options.searchMode || 'bm25'
        console.log(`    ${chalk.dim('Search:')} ${mode}${options.alpha ? chalk.dim(` (alpha=${options.alpha})`) : ''}\n`)
      })
    } catch (err) {
      console.error(`  ${chalk.red('✗')} ${chalk.red((err as Error).message)}`)
      process.exit(1)
    }
  })

program.parse()
