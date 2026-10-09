// The privacy ledger: a record, kept on this device, of every connection Duct makes to another computer: where to,
// how many times and how much was sent. It watches both ways Node sends requests (the global fetch and the
// http/https modules, which some provider SDKs use), so it doesn't depend on each feature remembering to report.
// Requests to this computer itself (the app's own server, a local Ollama) aren't counted: they never leave it.

import http from 'node:http'
import https from 'node:https'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'

export type LedgerCategory = 'tensflare' | 'ai' | 'cloud' | 'signin' | 'web'

export const LEDGER_CATEGORY_LABELS: Record<LedgerCategory, string> = {
  tensflare: 'Tensflare (account, usage counts, feedback, hosted AI, notebook links)',
  ai: 'AI provider you chose',
  cloud: 'Cloud sources you connected',
  signin: 'Sign-in providers',
  web: 'Web pages you added',
}

export interface LedgerHost {
  host: string
  category: LedgerCategory
  requests: number
  /** Bytes sent: request bodies, as far as they're known (a streamed upload is counted as it's written). */
  bytesOut: number
  lastAt: number
}

export interface LedgerDay { day: string; hosts: LedgerHost[] }

export interface LedgerEntry {
  at: number
  host: string
  category: LedgerCategory
  method: string
  /** Only for Tensflare's own endpoints (fixed addresses such as /v1/duct/report); other paths can name files. */
  path?: string
  bytesOut: number
}

const DAYS_KEPT = 30
const RECENT_KEPT = 100

const AI_HOSTS = ['api.openai.com', 'generativelanguage.googleapis.com', 'api.cohere.ai', 'api.cohere.com', 'api.voyageai.com', 'api.mistral.ai', 'api.jina.ai', 'api.anthropic.com']
const CLOUD_HOSTS = ['www.googleapis.com', 'graph.microsoft.com']
const SIGNIN_HOSTS = ['oauth2.googleapis.com', 'accounts.google.com', 'login.microsoftonline.com']

export function categorize(host: string): LedgerCategory {
  const h = host.toLowerCase()
  if (h === 'tensflare.com' || h.endsWith('.tensflare.com')) return 'tensflare'
  if (AI_HOSTS.includes(h)) return 'ai'
  if (CLOUD_HOSTS.includes(h) || h.endsWith('.amazonaws.com') || h.endsWith('.r2.cloudflarestorage.com') || h.endsWith('.wasabisys.com') || h.endsWith('.backblazeb2.com') || h.endsWith('.sharepoint.com')) return 'cloud'
  if (SIGNIN_HOSTS.includes(h)) return 'signin'
  return 'web'
}

const isLoopback = (host: string) => /^(localhost|127(\.\d+){3}|\[?::1\]?|0\.0\.0\.0)$/i.test(host)

function bodySize(body: unknown): number {
  if (body == null) return 0
  if (typeof body === 'string') return Buffer.byteLength(body)
  if (body instanceof URLSearchParams) return Buffer.byteLength(body.toString())
  if (body instanceof ArrayBuffer) return body.byteLength
  if (ArrayBuffer.isView(body)) return body.byteLength
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size
  return 0
}

export class PrivacyLedger {
  private days: Record<string, Record<string, LedgerHost>> = {}
  private recentEntries: LedgerEntry[] = []
  private saveTimer: NodeJS.Timeout | null = null
  private file?: string
  readonly since: number

  constructor(dir?: string, private now: () => number = Date.now) {
    this.since = now()
    if (dir) {
      this.file = join(dir, 'ledger.json')
      try {
        if (existsSync(this.file)) {
          const saved = JSON.parse(readFileSync(this.file, 'utf-8')) as { days?: PrivacyLedger['days']; recent?: LedgerEntry[] }
          this.days = saved.days ?? {}
          this.recentEntries = saved.recent ?? []
        }
      } catch { /* a damaged ledger starts again */ }
    }
  }

  record(url: URL | string, method = 'GET', bytesOut = 0): void {
    let u: URL
    try { u = typeof url === 'string' ? new URL(url) : url } catch { return }
    const host = u.hostname.replace(/^\[|\]$/g, '')
    if (!host || isLoopback(host)) return
    const at = this.now()
    const day = new Date(at).toISOString().slice(0, 10)
    const category = categorize(host)
    const hosts = this.days[day] ??= {}
    const h = hosts[host] ??= { host, category, requests: 0, bytesOut: 0, lastAt: at }
    h.requests++
    h.bytesOut += bytesOut
    h.lastAt = at
    this.recentEntries.unshift({ at, host, category, method: method.toUpperCase(), ...(category === 'tensflare' ? { path: u.pathname } : {}), bytesOut })
    this.recentEntries.length = Math.min(this.recentEntries.length, RECENT_KEPT)
    this.scheduleSave()
  }

  /** Adds bytes written after the request was recorded (a streamed body). */
  addBytes(host: string, bytes: number): void {
    const day = new Date(this.now()).toISOString().slice(0, 10)
    const h = this.days[day]?.[host]
    if (h) { h.bytesOut += bytes; this.scheduleSave() }
  }

  /** Per day, newest first, for the last `days` days. */
  summary(days = 7): LedgerDay[] {
    const cutoff = new Date(this.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10)
    return Object.keys(this.days).filter(d => d >= cutoff).sort().reverse()
      .map(day => ({ day, hosts: Object.values(this.days[day]).sort((a, b) => b.requests - a.requests) }))
  }

  recent(limit = 50): LedgerEntry[] { return this.recentEntries.slice(0, limit) }

  clear(): void {
    this.days = {}
    this.recentEntries = []
    this.save()
  }

  private scheduleSave(): void {
    if (!this.file || this.saveTimer) return
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save() }, 2000)
    this.saveTimer.unref()
  }

  save(): void {
    if (!this.file) return
    const cutoff = new Date(this.now() - DAYS_KEPT * 86_400_000).toISOString().slice(0, 10)
    for (const d of Object.keys(this.days)) if (d < cutoff) delete this.days[d]
    try { writeFileSync(this.file, JSON.stringify({ days: this.days, recent: this.recentEntries }), { mode: 0o600 }) } catch { /* best effort */ }
  }
}

let installed: PrivacyLedger | null = null

/** The ledger for this process, once `installLedger` has run. */
export function currentLedger(): PrivacyLedger | null { return installed }

/**
 * Starts recording this process's outgoing connections. Call once, early. Wraps globalThis.fetch and
 * http/https.request/get; the requests themselves are untouched.
 */
export function installLedger(dir?: string): PrivacyLedger {
  if (installed) return installed
  const ledger = new PrivacyLedger(dir)
  installed = ledger

  const realFetch = globalThis.fetch
  if (realFetch) {
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      try {
        const url = input instanceof Request ? input.url : String(input)
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
        ledger.record(url, method, bodySize(init?.body))
      } catch { /* never get in the way of a request */ }
      return realFetch(input, init)
    }) as typeof fetch
  }

  for (const mod of [http, https] as const) {
    const scheme = mod === https ? 'https:' : 'http:'
    const wrap = (real: typeof http.request) => function (this: unknown, ...args: unknown[]) {
      const req = (real as (...a: unknown[]) => http.ClientRequest).apply(this, args)
      try {
        const host = (req.host || '').replace(/^\[|\]$/g, '')
        if (host && !isLoopback(host)) {
          ledger.record(new URL(`${scheme}//${host}${req.path || '/'}`), req.method)
          const write = req.write.bind(req)
          const count = (chunk: unknown) => { const n = bodySize(chunk); if (n) ledger.addBytes(host, n) }
          req.write = ((chunk: unknown, ...rest: unknown[]) => { count(chunk); return (write as (...a: unknown[]) => boolean)(chunk, ...rest) }) as typeof req.write
          const end = req.end.bind(req)
          req.end = ((chunk?: unknown, ...rest: unknown[]) => { if (chunk && typeof chunk !== 'function') count(chunk); return (end as (...a: unknown[]) => http.ClientRequest)(chunk, ...rest) }) as typeof req.end
        }
      } catch { /* never get in the way of a request */ }
      return req
    }
    const realRequest = mod.request
    const wrapped = wrap(realRequest)
    ;(mod as { request: unknown }).request = wrapped
    // get() is request() + end(); route it through the wrapper so it's counted once.
    ;(mod as { get: unknown }).get = function (...args: unknown[]) {
      const req = (wrapped as (...a: unknown[]) => http.ClientRequest)(...args)
      req.end()
      return req
    }
  }
  // Modules that imported { request } from 'node:http' see the wrapper too.
  syncBuiltinESMExports()
  return ledger
}
