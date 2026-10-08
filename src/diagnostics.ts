// Diagnostics, crash records and feedback for testers. Nothing here may carry document content: error
// messages can contain paths, so they are reduced to codes, and crash records keep only the error's name and
// the app's own stack frames. People see exactly what is sent before they send it.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { arch, homedir } from 'node:os'
import { join } from 'node:path'
import type { Duct } from './index.js'
import { osInfo, range } from './telemetry.js'
import { VERSION } from './version.js'

export const FEEDBACK_URL = 'https://telemetry.tensflare.com/v1/duct/feedback'

/** A fixed code for an extraction or indexing error. The message itself is never reported. */
export function errorCode(message: string | undefined): string {
  const m = (message ?? '').toLowerCase()
  if (/password|encrypt/.test(m)) return 'encrypted'
  if (/enoent|no such file|not found/.test(m)) return 'missing_file'
  if (/eacces|eperm|permission/.test(m)) return 'permission_denied'
  if (/timed? ?out|timeout/.test(m)) return 'timeout'
  if (/invalid pdf|corrupt|bad xref|unexpected end|end of central directory|invalid zip/.test(m)) return 'damaged_file'
  if (/out of memory|heap|allocation/.test(m)) return 'out_of_memory'
  if (/ocr|tesseract/.test(m)) return 'ocr_failed'
  if (/unsupported|not a /.test(m)) return 'unsupported'
  return 'extract_failed'
}

export interface Diagnostics {
  app_version: string
  channel: string
  os: string
  os_version: string
  arch: string
  runtime: string
  documents: string
  formats: string[]
  failed: Record<string, string>
  search_mode: string
  semantic_search: 'off' | 'on' | 'paused'
  embedding_error?: string
  features_off: string[]
  watched_folders: string
  crashes: number
}

export function collectDiagnostics(duct: Duct, channel: string, crashDir?: string): Diagnostics {
  const docs = duct.getDocuments()
  const failed = new Map<string, number>()
  for (const d of docs) {
    if (d.status !== 'failed') continue
    const key = `${errorCode(d.error)}.${d.format}`
    failed.set(key, (failed.get(key) ?? 0) + 1)
  }
  const f = duct.getFeatures()
  const activity = duct.activity()
  const runtime = process.versions['electron'] ? `electron ${process.versions['electron']}` : `node ${process.versions.node}`
  return {
    app_version: VERSION,
    channel,
    ...osInfo(),
    arch: arch(),
    runtime,
    documents: range(docs.filter(d => d.status !== 'failed').length),
    formats: [...new Set(docs.map(d => d.format))].sort(),
    failed: Object.fromEntries([...failed].sort().map(([k, n]) => [k, range(n)])),
    search_mode: duct.getConfig().searchMode,
    semantic_search: !duct.semanticAvailable() ? 'off' : activity.embeddingError ? 'paused' : 'on',
    ...(activity.embeddingError ? { embedding_error: errorCode(activity.embeddingError) } : {}),
    features_off: [
      ...Object.entries(f).filter(([k, v]) => k !== 'formats' && v === false).map(([k]) => k),
      ...Object.entries(f.formats).filter(([, v]) => !v).map(([k]) => `formats.${k}`),
    ],
    watched_folders: String(duct.listSources().filter(s => s.kind === 'watch').length),
    crashes: crashDir ? listCrashes(crashDir).length : 0,
  }
}

// ---------- crash records ----------

export interface CrashRecord {
  id: string
  at: string
  app_version: string
  os: string
  os_version: string
  /** What crashed: the main process, a page, or a helper process. */
  where: string
  /** The error's type (e.g. TypeError) or the process exit reason; never its message. */
  kind: string
  /** Stack frames from Duct's own code only, as "function (file:line)". */
  frames: string[]
}

/** Keeps only frames from Duct's own files, with paths reduced to the file name inside the app. */
export function sanitizeStack(stack: string | undefined): string[] {
  if (!stack) return []
  const home = homedir()
  const frames: string[] = []
  for (const line of stack.split('\n').slice(1, 40)) {
    const m = /at (?:(.+?) \()?(.+?):(\d+):\d+\)?$/.exec(line.trim())
    if (!m) continue
    const file = m[2].split(home).join('~')
    // Duct's own code: dist/, src/, electron/ or assets/ui inside the app. Everything else is left out.
    const own = /(?:^|[\\/])(dist|src|electron|assets[\\/]ui)[\\/]([\w./\\-]+)$/.exec(file)
    if (!own) continue
    const fn = (m[1] ?? '<anonymous>').replace(/[^\w.$<>\[\] -]/g, '').slice(0, 80)
    frames.push(`${fn} (${own[1]}/${own[2].replace(/\\/g, '/')}:${m[3]})`)
    if (frames.length >= 15) break
  }
  return frames
}

export function recordCrash(dir: string, where: string, error: unknown): CrashRecord {
  const err = error instanceof Error ? error : null
  const record: CrashRecord = {
    id: randomUUID(),
    at: new Date().toISOString(),
    app_version: VERSION,
    ...osInfo(),
    where,
    kind: err ? (err.name || 'Error').replace(/[^\w]/g, '').slice(0, 40) : typeof error === 'string' ? error.replace(/[^\w-]/g, '').slice(0, 40) : 'unknown',
    frames: sanitizeStack(err?.stack),
  }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${record.at.replace(/[:.]/g, '-')}-${record.id.slice(0, 8)}.json`), JSON.stringify(record, null, 2))
    // Keep the 20 most recent.
    const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort()
    for (const old of files.slice(0, Math.max(0, files.length - 20))) rmSync(join(dir, old), { force: true })
  } catch {}
  return record
}

export function listCrashes(dir: string): CrashRecord[] {
  if (!existsSync(dir)) return []
  const out: CrashRecord[] = []
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse()) {
    try { out.push(JSON.parse(readFileSync(join(dir, f), 'utf-8'))) } catch {}
  }
  return out
}

export function clearCrashes(dir: string): void {
  if (!existsSync(dir)) return
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) rmSync(join(dir, f), { force: true })
}

/** Records uncaught errors in this process. Returns the handlers so tests can remove them. */
export function installCrashHandlers(dir: string, where = 'main') {
  const onError = (err: unknown) => { recordCrash(dir, where, err) }
  process.on('uncaughtExceptionMonitor', onError)
  process.on('unhandledRejection', onError)
  return () => { process.off('uncaughtExceptionMonitor', onError); process.off('unhandledRejection', onError) }
}

// ---------- feedback ----------

export interface FeedbackInput {
  message: string
  email?: string
  diagnostics?: Diagnostics
  crashes?: CrashRecord[]
}

export function validateFeedback(body: unknown): FeedbackInput {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const message = typeof b['message'] === 'string' ? b['message'].trim() : ''
  if (!message) throw new Error('Write a message first.')
  if (message.length > 5000) throw new Error('Feedback is limited to 5,000 characters.')
  const email = typeof b['email'] === 'string' && b['email'].trim() ? b['email'].trim() : undefined
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Error('That email address doesn’t look right.')
  return { message, ...(email ? { email } : {}) }
}

/** Sends feedback to Tensflare. Throws with a readable message if it can't be delivered. */
export async function sendFeedback(input: FeedbackInput, opts: { url?: string; fetch?: typeof fetch } = {}): Promise<void> {
  const res = await (opts.fetch ?? fetch)(opts.url ?? process.env['DUCT_FEEDBACK_URL'] ?? FEEDBACK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schema: 1, ...input }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Tensflare couldn’t take the feedback right now (HTTP ${res.status}). Try again, or email it instead.`)
}
