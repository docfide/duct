// Anonymous usage counts (see the Duct Accounts and Telemetry Spec, "Usage counts").
//
// The report is built from a fixed schema: every field is an enum, a range label, a version or a format name,
// so there is no field that could carry document text, file names, paths or searches. `duct telemetry show`
// prints exactly what would be sent. Off means off: when disabled, no request is ever made.
//
// Launch state: usage counts are OFF by default until the public "What Duct sends" page and the privacy
// notice are reviewed (spec rollout steps 1 and 2). Flip DEFAULT_ON then. EU and EEA installs always ask first.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { arch, platform, release } from 'node:os'
import { join } from 'node:path'
import type { Duct } from './index.js'
import type { DocumentFormat } from './types.js'
import { VERSION } from './version.js'

export const DEFAULT_ON = false
export const TELEMETRY_URL = 'https://telemetry.tensflare.com/v1/duct/report'
const SEND_TIMEOUT_MS = 5000

export type Channel = 'desktop' | 'cli' | 'server' | 'docker'
export type Activity = 'searches' | 'opens' | 'ask' | 'ocr'

export const RANGES = ['0', '1-10', '11-100', '101-1000', '1001-10000', '10000+'] as const
export const SMALL_RANGES = ['0', '1', '2-5', '6-20', '21+'] as const
export const DAY_RANGES = ['0', '1-7', '8-30', '31-90', '91-365', '365+'] as const

export function range(n: number): typeof RANGES[number] {
  return n <= 0 ? '0' : n <= 10 ? '1-10' : n <= 100 ? '11-100' : n <= 1000 ? '101-1000' : n <= 10000 ? '1001-10000' : '10000+'
}
export function smallRange(n: number): typeof SMALL_RANGES[number] {
  return n <= 0 ? '0' : n === 1 ? '1' : n <= 5 ? '2-5' : n <= 20 ? '6-20' : '21+'
}
export function dayRange(n: number): typeof DAY_RANGES[number] {
  return n <= 0 ? '0' : n <= 7 ? '1-7' : n <= 30 ? '8-30' : n <= 90 ? '31-90' : n <= 365 ? '91-365' : '365+'
}

/** EU and EEA regions, where usage counts are opt-in (ePrivacy Art. 5(3)). Decided from the OS region, never the IP. */
const EU_EEA = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO'])

export function osRegion(): string | undefined {
  try {
    const locale = new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale)
    return locale.maximize().region
  } catch {
    return undefined
  }
}

export interface DuctReport {
  schema: 1
  install_id: string
  day: string
  event: 'install' | 'daily'
  app_version: string
  channel: Channel
  os: 'macos' | 'windows' | 'linux'
  os_version: string
  arch: 'arm64' | 'x64' | 'ia32'
  language: string
  plan: 'free' | 'pro' | 'team' | 'enterprise'
  documents: string
  formats: DocumentFormat[]
  sources: { watched: string; library: boolean; web: boolean }
  activity: Record<Activity, string>
  settings: { search_mode: 'bm25' | 'vector' | 'hybrid'; embeddings: 'none' | 'local' | 'cloud'; island: boolean; sounds: boolean }
  errors: Record<string, string>
  days_since_install: string
}

interface State {
  installId: string
  installedAt: number
  /** The person's choice; null means they haven't chosen (the default applies). */
  consent: 'granted' | 'denied' | null
  lastSentDay?: string
  sentInstall?: boolean
  counts: { day: string } & Record<Activity, number>
  previous?: { day: string } & Record<Activity, number>
}

export interface TelemetryOptions {
  /** Folder for telemetry.json (the install id and counters). */
  dir: string
  channel: Channel
  duct: Duct
  plan?: () => DuctReport['plan']
  /** Desktop preferences reported as settings. */
  prefs?: () => { island: boolean; sounds: boolean }
  url?: string
  env?: NodeJS.ProcessEnv
  region?: string
  fetch?: typeof fetch
  now?: () => number
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const zero = (day: string) => ({ day, searches: 0, opens: 0, ask: 0, ocr: 0 })

export function osInfo(): { os: DuctReport['os']; os_version: string } {
  const [major, minor] = release().split('.').map(Number)
  if (platform() === 'darwin') return { os: 'macos', os_version: String(major >= 25 ? major + 1 : Math.max(10, major - 9)) }
  if (platform() === 'win32') return { os: 'windows', os_version: (Number(release().split('.')[2]) || 0) >= 22000 ? '11' : String(major || 10) }
  return { os: 'linux', os_version: `${major || 0}.${minor || 0}` }
}

export class Telemetry {
  private path: string
  private state: State
  private dirty = false
  private savedAt = 0
  private env: NodeJS.ProcessEnv
  private now: () => number
  private timers: NodeJS.Timeout[] = []

  constructor(private opts: TelemetryOptions) {
    this.path = join(opts.dir, 'telemetry.json')
    this.env = opts.env ?? process.env
    this.now = opts.now ?? Date.now
    this.state = this.load()
  }

  private load(): State {
    try {
      if (existsSync(this.path)) {
        const s = JSON.parse(readFileSync(this.path, 'utf-8')) as State
        if (s.installId && s.counts) return s
      }
    } catch {}
    return { installId: randomUUID(), installedAt: this.now(), consent: null, counts: zero(utcDay(this.now())) }
  }

  private save(force = false): void {
    if (!force && (!this.dirty || this.now() - this.savedAt < 60_000)) return
    try {
      mkdirSync(this.opts.dir, { recursive: true })
      writeFileSync(this.path, JSON.stringify(this.state), { mode: 0o600 })
      this.dirty = false
      this.savedAt = this.now()
    } catch {}
  }

  /** Why usage counts are off, or null if they are on. Environment switches can't be overridden from Settings. */
  blockedBy(): string | null {
    const e = this.env
    const off = (v: string | undefined) => v !== undefined && /^(1|true|yes)$/i.test(v)
    if (off(e['DO_NOT_TRACK'])) return 'DO_NOT_TRACK is set'
    if (e['DUCT_TELEMETRY'] !== undefined && /^(0|false|off|no)$/i.test(e['DUCT_TELEMETRY'])) return 'DUCT_TELEMETRY=0 is set'
    if (e['CI'] || e['VITEST'] || e['NODE_ENV'] === 'test') return 'running in CI or tests'
    return null
  }

  /** Whether the person must be asked before anything is sent (EU and EEA). */
  needsConsent(): boolean {
    const region = this.opts.region ?? osRegion()
    return !!region && EU_EEA.has(region)
  }

  enabled(): boolean {
    if (this.blockedBy()) return false
    if (this.state.consent) return this.state.consent === 'granted'
    return DEFAULT_ON && !this.needsConsent()
  }

  /** The person's choice. Turning usage counts back on starts a new install id. */
  setEnabled(on: boolean): void {
    const wasOff = !this.enabled()
    this.state.consent = on ? 'granted' : 'denied'
    if (on && wasOff) {
      this.state.installId = randomUUID()
      this.state.sentInstall = false
      this.state.lastSentDay = undefined
    }
    this.dirty = true
    this.save(true)
  }

  status() {
    return { enabled: this.enabled(), choice: this.state.consent, blockedBy: this.blockedBy(), needsConsent: this.needsConsent(), defaultOn: DEFAULT_ON, endpoint: this.opts.url ?? TELEMETRY_URL }
  }

  /** Counts one use of a feature for today. Nothing is counted while usage counts are off. */
  record(kind: Activity): void {
    if (!this.enabled()) return
    this.rollDay()
    this.state.counts[kind]++
    this.dirty = true
    this.save()
  }

  private rollDay(): void {
    const today = utcDay(this.now())
    if (this.state.counts.day === today) return
    this.state.previous = this.state.counts.day === utcDay(this.now() - 86_400_000) ? this.state.counts : zero(utcDay(this.now() - 86_400_000))
    this.state.counts = zero(today)
    this.dirty = true
  }

  /** The exact report that would be sent now. */
  report(): DuctReport | null {
    this.rollDay()
    const a = arch()
    if (a !== 'arm64' && a !== 'x64' && a !== 'ia32') return null
    const duct = this.opts.duct
    const docs = duct.getDocuments()
    const cfg = duct.getConfig()
    const localEmbed = cfg.embedProvider === 'ollama' || /^https?:\/\/(localhost|127\.|\[::1\])/.test(cfg.embedBaseUrl)
    const embeddings: DuctReport['settings']['embeddings'] = !duct.semanticAvailable() ? 'none' : localEmbed ? 'local' : 'cloud'
    const failed = new Map<string, number>()
    for (const d of docs) if (d.status === 'failed') failed.set(d.format, (failed.get(d.format) ?? 0) + 1)
    const yesterday = this.state.previous ?? zero('')
    const language = (Intl.DateTimeFormat().resolvedOptions().locale.split('-')[0] || 'en').toLowerCase()
    const prefs = this.opts.prefs?.() ?? { island: false, sounds: false }
    return {
      schema: 1,
      install_id: this.state.installId,
      day: utcDay(this.now()),
      event: this.state.sentInstall ? 'daily' : 'install',
      app_version: VERSION,
      channel: this.opts.channel,
      ...osInfo(),
      arch: a,
      language: /^[a-z]{2,3}$/.test(language) ? language : 'en',
      plan: this.opts.plan?.() ?? 'free',
      documents: range(docs.filter(d => d.status !== 'failed').length),
      formats: [...new Set(docs.filter(d => d.status !== 'failed').map(d => d.format))].sort(),
      sources: {
        watched: smallRange(duct.listSources().filter(s => s.kind === 'watch').length),
        library: docs.some(d => d.source === 'library'),
        web: docs.some(d => d.source === 'url'),
      },
      activity: { searches: range(yesterday.searches), opens: range(yesterday.opens), ask: range(yesterday.ask), ocr: range(yesterday.ocr) },
      settings: { search_mode: cfg.searchMode, embeddings, island: prefs.island, sounds: prefs.sounds },
      errors: Object.fromEntries([...failed].slice(0, 50).map(([format, n]) => [`extract_failed.${format}`, range(n)])),
      days_since_install: dayRange(Math.floor((this.now() - this.state.installedAt) / 86_400_000)),
    }
  }

  /**
   * Sends today's report if usage counts are on and none was sent today. A failure is dropped, not queued
   * or retried, so a slow connection never affects the app.
   */
  async maybeSend(): Promise<'sent' | 'off' | 'already' | 'failed'> {
    if (!this.enabled()) return 'off'
    const today = utcDay(this.now())
    if (this.state.lastSentDay === today) return 'already'
    const report = this.report()
    if (!report) return 'off'
    this.state.lastSentDay = today
    this.state.sentInstall = true
    this.dirty = true
    this.save(true)
    try {
      const res = await (this.opts.fetch ?? fetch)(this.opts.url ?? this.env['DUCT_TELEMETRY_URL'] ?? TELEMETRY_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report), signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
      return res.ok ? 'sent' : 'failed'
    } catch {
      return 'failed'
    }
  }

  /** Checks a few minutes after start (never at launch), then hourly. */
  start(firstDelayMs = 5 * 60_000): void {
    const run = () => { this.maybeSend().catch(() => {}) }
    this.timers.push(setTimeout(run, firstDelayMs).unref(), setInterval(run, 3600_000).unref())
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    this.save(true)
  }
}
