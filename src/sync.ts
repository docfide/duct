// Settings sync between a person's devices (Pro and Team, entitlement "sync.devices"). Only Duct's search and
// AI settings and its feature switches are synced: never API keys, documents, file or folder names, or paths.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Duct } from './index.js'
import type { RuntimeConfig } from './types.js'
import type { FeaturesPatch } from './features.js'
import type { TensflareAccount } from './account.js'

/** The settings that travel. Machine-specific ones (local server URLs) and every API key stay put. */
export const SYNCED_SETTINGS = ['searchMode', 'searchAlpha', 'rerank', 'hyde', 'ocr', 'chunkStrategy', 'chunkSize', 'chunkOverlap', 'embedProvider', 'embedModel', 'llmProvider', 'llmModel'] as const

export interface SyncDocument {
  settings: Partial<Pick<RuntimeConfig, typeof SYNCED_SETTINGS[number]>>
  features: FeaturesPatch
}

interface SyncState { enabled: boolean; version: number; lastSync?: string; error?: string }

export class SettingsSync {
  private path: string
  private state: SyncState
  private timer: NodeJS.Timeout | null = null
  private applying = false

  constructor(private duct: Duct, private account: TensflareAccount, dir: string, private fetchImpl: typeof fetch = fetch) {
    this.path = join(dir, 'sync.json')
    this.state = { enabled: false, version: 0 }
    try { if (existsSync(this.path)) this.state = { ...this.state, ...JSON.parse(readFileSync(this.path, 'utf-8')) } } catch {}
  }

  private save(): void { try { writeFileSync(this.path, JSON.stringify(this.state), { mode: 0o600 }) } catch {} }

  status(): SyncState & { available: boolean } {
    return { ...this.state, available: this.account.has('sync.devices') }
  }

  /** What this device would send. */
  snapshot(): SyncDocument {
    const cfg = this.duct.getConfig()
    const settings = Object.fromEntries(SYNCED_SETTINGS.map(k => [k, cfg[k]])) as SyncDocument['settings']
    if (cfg.llmProvider === 'none') delete settings.llmProvider
    return { settings, features: this.duct.getFeatures() }
  }

  private apply(doc: SyncDocument): void {
    this.applying = true
    try {
      const settings = Object.fromEntries(Object.entries(doc.settings ?? {}).filter(([k]) => (SYNCED_SETTINGS as readonly string[]).includes(k)))
      if (Object.keys(settings).length) this.duct.configure(settings as Partial<RuntimeConfig>)
      if (doc.features) this.duct.setFeatures(doc.features)
    } finally {
      this.applying = false
    }
  }

  private async request(method: 'GET' | 'PUT', body?: unknown) {
    const res = await this.fetchImpl(`${this.account.apiUrl}/v1/sync/settings`, {
      method, headers: { Authorization: `Bearer ${await this.account.accessToken()}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    })
    const data = await res.json().catch(() => ({})) as Record<string, unknown>
    return { status: res.status, data }
  }

  /** Turning sync on takes the account's settings if it has some, otherwise uploads this device's. */
  async enable(on: boolean): Promise<SyncState> {
    this.state = { ...this.state, enabled: on, error: undefined }
    this.save()
    if (on) await this.pull(true)
    return this.state
  }

  /** Fetches the account's settings and applies them if they are newer than what this device last saw. */
  async pull(firstTime = false): Promise<void> {
    if (!this.state.enabled) return
    try {
      const { status, data } = await this.request('GET')
      if (status !== 200) throw new Error(String(data['error'] ?? `HTTP ${status}`))
      const version = Number(data['version'] ?? 0)
      if (data['data'] && version > this.state.version) this.apply(data['data'] as SyncDocument)
      else if (!data['data'] && firstTime) { this.state.version = version; return void (await this.push()) }
      this.state = { ...this.state, version, lastSync: new Date().toISOString(), error: undefined }
    } catch (err) {
      this.state = { ...this.state, error: (err as Error).message }
    }
    this.save()
  }

  /** Sends this device's settings. On a conflict the newer server copy wins and is applied here. */
  async push(): Promise<void> {
    if (!this.state.enabled || this.applying) return
    try {
      const { status, data } = await this.request('PUT', { data: this.snapshot(), version: this.state.version })
      if (status === 409 && data['data']) {
        this.apply(data['data'] as SyncDocument)
        this.state = { ...this.state, version: Number(data['version']), lastSync: new Date().toISOString(), error: undefined }
      } else if (status === 200) {
        this.state = { ...this.state, version: Number(data['version']), lastSync: new Date().toISOString(), error: undefined }
      } else throw new Error(String(data['error'] ?? `HTTP ${status}`))
    } catch (err) {
      this.state = { ...this.state, error: (err as Error).message }
    }
    this.save()
  }

  /** Call after a local settings change; pushes a few seconds later so bursts of changes go together. */
  changed(): void {
    if (!this.state.enabled || this.applying) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.push().catch(() => {}) }, 3000)
    this.timer.unref()
  }

  /** Pulls now and then hourly. */
  start(): void {
    this.pull().catch(() => {})
    setInterval(() => { this.pull().catch(() => {}) }, 3600_000).unref()
  }
}
