#!/usr/bin/env node

import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Duct, FEATURE_LABELS, FEATURE_NAMES, FORMAT_KINDS } from './index.js'
import type { FeaturesPatch } from './index.js'
import type { DuctConfig } from './types.js'
import { createServer } from './server.js'
import { FileAccountStorage, TensflareAccount } from './account.js'
import { Telemetry } from './telemetry.js'
import { installCrashHandlers } from './diagnostics.js'
import { setHostedAi } from './hosted.js'
import { OidcLogin } from './team/oidc.js'
import { randomBytes } from 'node:crypto'
import { SettingsSync } from './sync.js'
import { ConnectorManager, FileTokenVault } from './team/connectors/manager.js'
import { WebCallback } from './team/connectors/oauth.js'
import { installLedger } from './ledger.js'
import { clientIdsFromEnv } from './team/connectors/sources.js'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { VERSION } from './version.js'

/** --embed <provider> picks a provider, --no-embed turns embeddings off, neither auto-detects from API keys. */
function embedOption(value: string | boolean | undefined): DuctConfig['embed'] {
  if (value === false) return false
  if (typeof value === 'string') return { provider: value as Exclude<DuctConfig['embed'], false | undefined>['provider'] }
  return undefined
}

/** Where the CLI keeps its index unless --persist is given: $DUCT_HOME, else ~/.duct. */
function dataDir(persist?: string): string {
  return persist || process.env['DUCT_HOME'] || join(homedir(), '.duct')
}

/** Opens a URL in the default browser (best effort; the URL is printed too). */
function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  try { spawn(cmd, args as string[], { stdio: 'ignore', detached: true }).on('error', () => {}).unref() } catch {}
}

function accountFor(dir: string, open = true): TensflareAccount {
  return new TensflareAccount({
    storage: new FileAccountStorage(join(dir, 'account.json')),
    openUrl: url => {
      console.log(`\n  Opening the Tensflare sign-in page. If it doesn't open, visit:\n  ${chalk.cyan(url)}\n`)
      if (open) openBrowser(url)
    },
  })
}

const program = new Command()

program
  .name('duct')
  .description('Document intelligence pipeline — extract, chunk, embed, search, ask')
  .version(VERSION)

program
  .command('index')
  .description('Index documents for search')
  .argument('<paths...>', 'Files, directories, or URLs to index')
  .option('-s, --strategy <strategy>', 'Chunking strategy: sliding-window or by-heading')
  .option('--chunk-size <size>', 'Chunk size in characters', (v) => parseInt(v))
  .option('--chunk-overlap <overlap>', 'Chunk overlap in characters', (v) => parseInt(v))
  .option('--embed <provider>', 'Embedding provider: openai, gemini, cohere, voyage, mistral, jina, ollama, openai-compatible')
  .option('--no-embed', 'Skip embeddings, use keyword search only')
  .option('--ocr', 'Attempt OCR for scanned PDFs and image files')
  .option('--persist <path>', 'Index directory (default: $DUCT_HOME or ~/.duct)')
  .option('--search-mode <mode>', 'Search mode: bm25, vector, or hybrid')
  .option('--alpha <n>', 'Hybrid search alpha (0=BM25, 1=vector)', (v) => parseFloat(v), 0.5)
  .action(async (paths: string[], options) => {
    try {
      const embed = embedOption(options.embed)
      const duct = new Duct({
        chunk: {
          strategy: options.strategy as 'sliding-window' | 'by-heading' | undefined,
          size: options.chunkSize,
          overlap: options.chunkOverlap,
        },
        embed,
        ocr: options.ocr ?? false,
        persistPath: dataDir(options.persist),
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
  .option('--embed <provider>', 'Embedding provider: openai, gemini, cohere, voyage, mistral, jina, ollama, openai-compatible')
  .option('--no-embed', 'Skip embeddings')
  .option('--ocr', 'Attempt OCR for scanned PDFs and image files')
  .option('--persist <path>', 'Index directory (default: $DUCT_HOME or ~/.duct)')
  .option('--search-mode <mode>', 'Search mode: bm25, vector, or hybrid')
  .option('--alpha <n>', 'Hybrid search alpha', (v) => parseFloat(v), 0.5)
  .option('--rerank', 'Enable re-ranking')
  .option('--hyde', 'Enable HyDE query expansion')
  .option('--json', 'Output as JSON')
  .action(async (query: string, options) => {
    try {
      const embed = embedOption(options.embed)
      const duct = new Duct({
        chunk: { strategy: options.strategy as 'sliding-window' | 'by-heading' | undefined },
        embed,
        ocr: options.ocr ?? false,
        persistPath: dataDir(options.persist),
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
  .option('--persist <path>', 'Index directory (default: $DUCT_HOME or ~/.duct)')
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
        persistPath: dataDir(options.persist),
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
  .option('--persist <path>', 'Index directory (default: $DUCT_HOME or ~/.duct)')
  .option('--embed <provider>', 'Embedding provider: openai, gemini, cohere, voyage, mistral, jina, ollama, openai-compatible')
  .action(async (dirs: string[], options) => {
    try {
      const duct = new Duct({
        chunk: { strategy: options.strategy as 'sliding-window' | 'by-heading' | undefined },
        ocr: options.ocr ?? false,
        persistPath: dataDir(options.persist),
        embed: embedOption(options.embed),
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
  .option('--persist <path>', 'Index directory (default: $DUCT_HOME or ~/.duct)')
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
        persistPath: dataDir(options.persist),
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
  .option('--persist <path>', 'Index directory (default: $DUCT_HOME or ~/.duct)')
  .action(async (path: string, options) => {
    try {
      const duct = new Duct({ persistPath: dataDir(options.persist) })
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

const account = program.command('account').description('Sign in with Tensflare (optional: only paid features need it)')

account
  .command('signin')
  .description('Sign in in your browser')
  .option('--persist <path>', 'Index directory (default: $DUCT_HOME or ~/.duct)')
  .action(async (options) => {
    try {
      const status = await accountFor(dataDir(options.persist)).signIn()
      console.log(`  ${chalk.green('✓')} Signed in as ${chalk.bold(status.email ?? 'your account')} (${status.plan})`)
    } catch (err) {
      console.error(`  ${chalk.red('✗')} ${chalk.red((err as Error).message)}`)
      process.exitCode = 1
    }
  })

account
  .command('signout')
  .description('Sign out and forget this device\'s session')
  .option('--persist <path>', 'Index directory (default: $DUCT_HOME or ~/.duct)')
  .action(async (options) => {
    await accountFor(dataDir(options.persist), false).signOut()
    console.log(`  ${chalk.green('✓')} Signed out. Everything local keeps working.`)
  })

account
  .command('status')
  .description('Show who is signed in and what the plan includes')
  .option('--persist <path>', 'Index directory (default: $DUCT_HOME or ~/.duct)')
  .action(async (options) => {
    const a = accountFor(dataDir(options.persist), false)
    const s = await a.refresh()
    if (!s.signedIn) { console.log(chalk.dim('\n  Not signed in. Everything local works without an account. Sign in with: duct account signin\n')); return }
    console.log(`\n  ${chalk.bold(s.email ?? 'Signed in')}  ${s.plan}${s.needsReconnect ? chalk.yellow('  (reconnect to keep paid features)') : ''}`)
    if (s.entitlements.length) console.log(`  ${chalk.dim('Includes:')} ${s.entitlements.join(', ')}`)
    if (s.expiresAt) console.log(`  ${chalk.dim('Works offline until:')} ${new Date(s.expiresAt).toISOString().slice(0, 10)}\n`)
  })

const telemetryCmd = program.command('telemetry').description('Anonymous usage counts: show exactly what is sent, or turn them on or off')

telemetryCmd
  .command('show')
  .description('Print the report that would be sent next')
  .option('--persist <path>', 'Index directory (default: $DUCT_HOME or ~/.duct)')
  .action((options) => {
    const duct = new Duct({ persistPath: dataDir(options.persist), embed: false })
    const t = new Telemetry({ dir: dataDir(options.persist), channel: 'cli', duct, plan: () => accountFor(dataDir(options.persist), false).status().plan })
    const s = t.status()
    console.log(`\n  Usage counts are ${s.enabled ? chalk.green('on') : chalk.dim('off')}${s.blockedBy ? chalk.dim(` (${s.blockedBy})`) : ''}. ${s.enabled ? 'This is sent at most once a day:' : 'Nothing is sent. If they were on, this would be sent at most once a day:'}\n`)
    console.log(JSON.stringify(t.report(), null, 2))
    console.log(chalk.dim(`\n  Never sent: document text, file or folder names, paths, searches, questions, URLs, or exact counts.\n`))
    duct.close()
  })

for (const [name, on] of [['on', true], ['off', false]] as const) {
  telemetryCmd
    .command(name)
    .description(on ? 'Turn usage counts on' : 'Turn usage counts off (no requests are made at all)')
    .option('--persist <path>', 'Index directory (default: $DUCT_HOME or ~/.duct)')
    .action((options) => {
      const duct = new Duct({ persistPath: dataDir(options.persist), embed: false })
      const t = new Telemetry({ dir: dataDir(options.persist), channel: 'cli', duct })
      t.setEnabled(on)
      const s = t.status()
      console.log(`  ${chalk.green('✓')} Usage counts ${on ? 'on' : 'off'}${on && s.blockedBy ? chalk.yellow(` (but ${s.blockedBy}, so nothing is sent)`) : ''}`)
      duct.close()
    })
}

const keys = program.command('keys').description('API keys for the developer API (/v1)')

keys
  .command('create')
  .description('Create an API key; it is shown once')
  .requiredOption('--name <name>', 'What the key is for, e.g. "website search"')
  .option('--scopes <list>', 'Comma-separated: search, write, admin', 'search')
  .option('--collections <list>', 'Limit the key to these collections (default: all)')
  .option('--persist <path>', 'Index directory (default: $DUCT_HOME or ~/.duct)')
  .action((options) => {
    const duct = new Duct({ persistPath: dataDir(options.persist), embed: false })
    try {
      const scopes = String(options.scopes).split(',').map(s => s.trim()).filter(Boolean)
      const bad = scopes.filter(s => !['search', 'write', 'admin'].includes(s))
      if (bad.length || !scopes.length) throw new Error(`Unknown scope: ${bad.join(', ') || '(none)'}. Use search, write or admin.`)
      const collections = options.collections ? String(options.collections).split(',').map(s => s.trim()).filter(Boolean) : null
      const { id, key } = duct.createApiKey(options.name, scopes, collections)
      console.log(`\n  ${chalk.green('✓')} Key ${chalk.bold(id)} (${scopes.join(', ')}${collections ? `; ${collections.join(', ')}` : ''})\n`)
      console.log(`  ${key}\n`)
      console.log(chalk.dim('  Copy it now: only its hash is stored. Use it as "Authorization: Bearer <key>".\n'))
    } catch (err) {
      console.error(`  ${chalk.red('✗')} ${chalk.red((err as Error).message)}`)
      process.exitCode = 1
    } finally {
      duct.close()
    }
  })

keys
  .command('list')
  .description('List API keys')
  .option('--persist <path>', 'Index directory (default: $DUCT_HOME or ~/.duct)')
  .action((options) => {
    const duct = new Duct({ persistPath: dataDir(options.persist), embed: false })
    const list = duct.listApiKeys()
    if (!list.length) console.log(chalk.dim('\n  No API keys. Create one with: duct keys create --name "my app"\n'))
    for (const k of list) {
      const used = k.lastUsedAt ? `last used ${new Date(k.lastUsedAt).toISOString().slice(0, 16).replace('T', ' ')}` : 'never used'
      console.log(`  ${chalk.bold(k.id)}  ${k.name.padEnd(24)} ${k.scopes.join(',').padEnd(18)} ${(k.collections?.join(',') ?? 'all collections').padEnd(20)} ${chalk.dim(used)}`)
    }
    duct.close()
  })

keys
  .command('revoke')
  .description('Revoke an API key')
  .argument('<id>', 'Key id from "duct keys list"')
  .option('--persist <path>', 'Index directory (default: $DUCT_HOME or ~/.duct)')
  .action((id: string, options) => {
    const duct = new Duct({ persistPath: dataDir(options.persist), embed: false })
    if (duct.revokeApiKey(id)) console.log(`  ${chalk.green('✓')} Revoked ${id}`)
    else { console.error(`  ${chalk.red('✗')} No key ${id}`); process.exitCode = 1 }
    duct.close()
  })

program
  .command('features')
  .description('Show which features are on, or switch them: duct features ask=off formats.image=off')
  .argument('[changes...]', 'name=on|off, or formats.<family>=on|off')
  .option('--persist <path>', 'Index directory (default: $DUCT_HOME or ~/.duct)')
  .action((changes: string[], options) => {
    const duct = new Duct({ persistPath: dataDir(options.persist), embed: false })
    try {
      if (changes.length) {
        const patch: FeaturesPatch = {}
        for (const change of changes) {
          const m = change.match(/^([\w.]+)=(on|off|true|false)$/)
          if (!m) throw new Error(`Expected name=on or name=off, got "${change}"`)
          const on = m[2] === 'on' || m[2] === 'true'
          if (m[1].startsWith('formats.')) patch.formats = { ...patch.formats, [m[1].slice(8)]: on } as FeaturesPatch['formats']
          else (patch as Record<string, boolean>)[m[1]] = on
        }
        duct.setFeatures(patch)
      }
      const f = duct.getFeatures()
      const mark = (on: boolean) => on ? chalk.green('on ') : chalk.dim('off')
      console.log()
      for (const name of FEATURE_NAMES) console.log(`  ${mark(f[name])}  ${name.padEnd(18)} ${chalk.dim(FEATURE_LABELS[name])}`)
      console.log(`\n  ${chalk.bold('File families')}`)
      for (const kind of FORMAT_KINDS) console.log(`  ${mark(f.formats[kind])}  formats.${kind}`)
      console.log()
    } catch (err) {
      console.error(`  ${chalk.red('✗')} ${chalk.red((err as Error).message)}`)
      process.exitCode = 1
    } finally {
      duct.close()
    }
  })

program
  .command('serve')
  .description('Start the web server with full UI')
  .option('-p, --port <port>', 'Port to listen on', (v) => parseInt(v), 3456)
  .option('-s, --strategy <strategy>', 'Chunking strategy: sliding-window or by-heading')
  .option('--embed <provider>', 'Embedding provider: openai, gemini, cohere, voyage, mistral, jina, ollama, openai-compatible')
  .option('--no-embed', 'Skip embeddings, use keyword search only')
  .option('--ocr', 'Attempt OCR for scanned PDFs and image files')
  .option('--persist <path>', 'Index directory (default: $DUCT_HOME or ~/.duct)')
  .option('--auth-token <token>', 'Bearer token required for API requests (env: DUCT_AUTH_TOKEN)')
  .option('--upload-limit <mb>', 'Max upload file size in MB', (v) => parseInt(v), 50)
  .option('--search-mode <mode>', 'Search mode: bm25, vector, or hybrid')
  .option('--alpha <n>', 'Hybrid search alpha', (v) => parseFloat(v), 0.5)
  .option('--llm <provider>', 'Default LLM provider: ollama, openai, gemini')
  .option('--host <host>', 'Interface to listen on. Anything other than localhost requires --auth-token', '127.0.0.1')
  .option('--watch-root <dir>', 'Allow the API to watch this directory and its subfolders (repeatable)', (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option('--library <dir>', 'Folder where uploaded files are kept (default: ~/Duct Library)')
  .option('--watch <dir>', 'Watch this folder from startup, e.g. a mounted shared drive (repeatable)', (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option('--rescan <minutes>', 'Also rescan watched folders on a timer, for network drives where file events are unreliable (0 = off)', (v) => parseFloat(v), 15)
  .option('--member-token <token>', 'Token for team members: search, open and upload, but no settings or deletes (repeatable; env: DUCT_MEMBER_TOKENS, comma-separated)', (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option('--public-url <url>', 'This server\'s public address (needed for sign-in), e.g. https://duct.example.com (env: DUCT_PUBLIC_URL)')
  .option('--oidc-issuer <url>', 'Sign people in with your identity provider (OpenID Connect issuer URL; env: DUCT_OIDC_ISSUER)')
  .option('--oidc-client-id <id>', 'OIDC client id (env: DUCT_OIDC_CLIENT_ID)')
  .option('--admin-email <email>', 'Admin when signing in (repeatable; env: DUCT_ADMIN_EMAILS, comma-separated)', (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option('--allow-domain <domain>', 'Members: anyone with an email at this domain (repeatable; env: DUCT_ALLOW_DOMAINS)', (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option('--allow-email <email>', 'Members: this person (repeatable; env: DUCT_ALLOW_EMAILS)', (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option('--audit-queries', 'Also record search terms and questions in the audit log')
  .option('--audit-days <days>', 'Keep audit entries this many days', (v) => parseInt(v), 365)
  .option('--no-audit', 'Don\'t keep an audit log')
  .option('--trust-proxy <hops>', 'Behind a reverse proxy: trust this many proxy hops for client addresses and https (env: DUCT_TRUST_PROXY)', (v) => parseInt(v))
  .option('--allowed-host <name>', 'Extra hostname accepted in the Host header, e.g. duct.example.com (repeatable)', (v: string, prev: string[]) => [...prev, v], [] as string[])
  .action(async (options) => {
    try {
      const token = options.authToken || process.env['DUCT_AUTH_TOKEN']
      const memberTokens = [...options.memberToken, ...(process.env['DUCT_MEMBER_TOKENS'] ?? '').split(',').map((t: string) => t.trim()).filter(Boolean)]
      if (memberTokens.length > 0 && !token) {
        console.error(`  ${chalk.red('✗')} ${chalk.red('Member tokens need an admin token too: set --auth-token or DUCT_AUTH_TOKEN.')}`)
        process.exit(1)
      }
      const list = (flag: string[], env?: string) => [...flag, ...(env ?? '').split(',').map(s => s.trim()).filter(Boolean)]
      const issuer = options.oidcIssuer || process.env['DUCT_OIDC_ISSUER']
      const publicUrl = options.publicUrl || process.env['DUCT_PUBLIC_URL']
      let oidc: OidcLogin | undefined
      if (issuer) {
        const clientId = options.oidcClientId || process.env['DUCT_OIDC_CLIENT_ID']
        const clientSecret = process.env['DUCT_OIDC_CLIENT_SECRET']
        if (!clientId || !clientSecret || !publicUrl) {
          console.error(`  ${chalk.red('✗')} ${chalk.red('Sign-in needs --oidc-client-id, DUCT_OIDC_CLIENT_SECRET and --public-url.')}`)
          process.exit(1)
        }
        const admins = list(options.adminEmail, process.env['DUCT_ADMIN_EMAILS'])
        if (admins.length === 0) {
          console.error(`  ${chalk.red('✗')} ${chalk.red('Sign-in needs at least one --admin-email.')}`)
          process.exit(1)
        }
        let sessionSecret = process.env['DUCT_SESSION_SECRET'] ?? ''
        if (sessionSecret.length < 32) {
          sessionSecret = randomBytes(32).toString('hex')
          console.log(`    ${chalk.yellow('!')} DUCT_SESSION_SECRET isn't set: people will need to sign in again after a restart.`)
        }
        oidc = new OidcLogin({ issuer, clientId, clientSecret, publicUrl, admins, allowDomains: list(options.allowDomain, process.env['DUCT_ALLOW_DOMAINS']), allowEmails: list(options.allowEmail, process.env['DUCT_ALLOW_EMAILS']), sessionSecret })
      }
      const loopback = ['127.0.0.1', 'localhost', '::1'].includes(options.host)
      if (!loopback && !token && !oidc) {
        console.error(`  ${chalk.red('✗')} ${chalk.red(`Refusing to listen on ${options.host} without authentication.`)}`)
        console.error(`    ${chalk.dim('Set --auth-token <token> or DUCT_AUTH_TOKEN, or sign-in with --oidc-issuer, or keep the default --host 127.0.0.1.')}`)
        process.exit(1)
      }
      const embed = embedOption(options.embed)
      const duct = new Duct({
        chunk: { strategy: options.strategy as 'sliding-window' | 'by-heading' | undefined },
        embed,
        ocr: options.ocr ?? false,
        persistPath: dataDir(options.persist),
        blockPrivateUrls: true,
        search: { mode: options.searchMode as 'bm25' | 'vector' | 'hybrid' | undefined, alpha: options.alpha, rerank: true },
        llm: options.llm ? { provider: options.llm as 'ollama' | 'openai' | 'gemini' } : undefined,
      })
      // On loopback only local names are accepted; when exposed, the token protects the API and any Host is allowed
      // unless --allowed-host narrows it.
      const allowedHosts = loopback
        ? ['localhost', '127.0.0.1', '::1', ...options.allowedHost]
        : options.allowedHost.length > 0 ? ['localhost', '127.0.0.1', '::1', ...options.allowedHost] : '*' as const
      installLedger(dataDir(options.persist))
      const account = accountFor(dataDir(options.persist))
      const channel = existsSync('/.dockerenv') ? 'docker' : 'server'
      const crashDir = join(dataDir(options.persist), 'crashes')
      installCrashHandlers(crashDir, channel)
      const telemetry = new Telemetry({ dir: dataDir(options.persist), channel, duct, plan: () => account.status().plan })
      telemetry.start()
      account.refresh().catch(() => {})
      setHostedAi(account.hostedAi())
      const sync = new SettingsSync(duct, account, dataDir(options.persist))
      sync.start()
      const connectors = new ConnectorManager(duct, {
        dir: join(dataDir(options.persist), 'connectors'),
        vault: new FileTokenVault(join(dataDir(options.persist), 'connector-tokens.json')),
        clientIds: clientIdsFromEnv(process.env),
        openUrl: url => { console.log(`\n  Opening sign-in for a cloud source. If it doesn't open, visit:\n  ${chalk.cyan(url)}\n`); openBrowser(url) },
        entitled: () => account.has('team.connectors'),
        ...(publicUrl ? { web: new WebCallback(publicUrl) } : {}),
        // With sign-in, results from Drive and SharePoint follow each file's sharing by default.
        ...(oidc ? { defaultVisibility: 'source' as const } : {}),
      })
      connectors.start()
      const server = createServer(duct, {
        authToken: token,
        memberTokens,
        uploadLimitMb: options.uploadLimit,
        watchRoots: options.watchRoot,
        allowedHosts,
        trustProxy: options.trustProxy ?? (Number(process.env['DUCT_TRUST_PROXY']) || undefined),
        libraryDir: options.library,
        account,
        telemetry,
        crashDir,
        channel,
        sync,
        connectors,
        oidc,
        audit: options.audit === false ? false : { queries: !!options.auditQueries, days: options.auditDays },
      })
      server.listen(options.port, options.host, () => {
        const shownHost = loopback ? 'localhost' : options.host
        console.log(`\n  ${chalk.green('✓')} ${chalk.bold('Duct server running at')} ${chalk.cyan(`http://${shownHost}:${options.port}`)}`)
        if (token) console.log(`    ${chalk.dim('Auth:')} token required`)
        if (oidc) console.log(`    ${chalk.dim('Sign-in:')} ${issuer} (${publicUrl}/auth/callback)`)
        if (options.watchRoot.length > 0) console.log(`    ${chalk.dim('Watch roots:')} ${options.watchRoot.join(', ')}`)
        if (memberTokens.length > 0) console.log(`    ${chalk.dim('Members:')} ${memberTokens.length} token(s)`)
        // Resume folders watched earlier (via `duct watch` or the API), add --watch folders, then keep them in sync.
        ;(async () => {
          await duct.restoreSources()
          if (options.watch.length > 0) await duct.watch(options.watch)
          const dirs = duct.listSources().map(s => s.path)
          if (dirs.length > 0) console.log(`    ${chalk.dim('Watching:')} ${dirs.join(', ')}`)
          if (options.rescan > 0) {
            const timer = setInterval(() => {
              duct.rescanSources().catch(err => console.error(`  ${chalk.red('✗')} Rescan failed: ${(err as Error).message}`))
            }, options.rescan * 60_000)
            timer.unref()
          }
        })().catch(err => console.error(`  ${chalk.red('✗')} Could not resume watched folders: ${(err as Error).message}`))
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
