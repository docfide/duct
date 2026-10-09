// Copyright Tensflare Ltd. Licensed under the Elastic License 2.0; see src/team/LICENSE.
// Connected sources: each keeps a local copy of its readable files under <data>/connectors/<id>/files and indexes
// them like any other document (source "connector", with the file's web address in its metadata). Changes are
// fetched incrementally from the source's cursor; files deleted there are removed here.

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Duct } from '../../index.js'
import { safeFileName } from '../../library.js'
import { GoogleDrive, MicrosoftDrive, S3Source, authorizeSource } from './sources.js'
import type { WebCallback } from './oauth.js'
import type { ClientIds, ConnectorKind, ConnectorSource, RemoteFile, S3Credentials, Tokens } from './sources.js'

/** Where connector tokens are kept: the system keychain in the desktop app, a private file elsewhere. */
export interface TokenVault {
  load(): Record<string, Tokens | S3Credentials>
  save(all: Record<string, Tokens | S3Credentials>): void
}

export class FileTokenVault implements TokenVault {
  constructor(private path: string) {}
  load() { try { return existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf-8')) : {} } catch { return {} } }
  save(all: Record<string, Tokens | S3Credentials>) { writeFileSync(this.path, JSON.stringify(all), { mode: 0o600 }) }
}

/**
 * Who sees a source's files on a shared server: `source` follows each file's sharing at the source (plus the
 * person who connected it), `everyone` is everyone who can use the server, `custom` the people and domains in
 * `allow`. On the desktop app nobody else uses the index, so it doesn't matter there.
 */
export type Visibility = 'source' | 'everyone' | 'custom'

export interface ConnectorInfo {
  id: string
  kind: ConnectorKind
  label: string
  visibility?: Visibility
  /** For `custom`: principals (src/access.ts). */
  allow?: string[]
  /** The account that connected the source, for `source` visibility. */
  owner?: string
  /** Sharing must be read again for files that haven't changed (after switching to `source`). */
  recheckAccess?: boolean
  /** SharePoint: the site's document library; OneDrive and Google: unset. */
  drive?: string
  cursor: string | null
  files: Record<string, { version: string; name: string; access?: string[] | null }>
  addedAt: string
  lastSync?: string
  syncing?: boolean
  error?: string
}

export const MAX_FILE_BYTES = 100 * 1024 * 1024

export interface ConnectorOptions {
  dir: string
  vault: TokenVault
  clientIds: ClientIds
  openUrl: (url: string) => void | Promise<void>
  fetch?: typeof fetch
  /** Whether connectors are on this plan (entitlement "team.connectors"). */
  entitled: () => boolean
  onChange?: () => void
  /** Visibility for new Google Drive and Microsoft sources: `source` on a server with sign-in, else `everyone`. */
  defaultVisibility?: Visibility
  /** On a server in the cloud: sign-ins come back to <public-url>/connectors/callback instead of a loopback port. */
  web?: WebCallback
}

export class ConnectorManager {
  private state: ConnectorInfo[]
  private running = new Map<string, Promise<void>>()
  private fetchImpl: typeof fetch

  constructor(private duct: Duct, private opts: ConnectorOptions) {
    this.fetchImpl = opts.fetch ?? fetch
    mkdirSync(opts.dir, { recursive: true })
    try { this.state = JSON.parse(readFileSync(join(opts.dir, 'connectors.json'), 'utf-8')) } catch { this.state = [] }
    for (const c of this.state) c.syncing = false
  }

  private persist(): void {
    writeFileSync(join(this.opts.dir, 'connectors.json'), JSON.stringify(this.state, null, 2))
  }

  available(): { google: boolean; microsoft: boolean; entitled: boolean } {
    return { google: !!this.opts.clientIds.google, microsoft: !!this.opts.clientIds.microsoft, entitled: this.opts.entitled() }
  }

  list() {
    return this.state.map(({ files, cursor: _c, recheckAccess: _r, ...c }) => ({ ...c, visibility: c.visibility ?? 'everyone', fileCount: Object.keys(files).length, filesDir: this.filesDir(c.id) }))
  }

  private localPath(c: ConnectorInfo, remoteId: string, name: string): string {
    return join(this.filesDir(c.id), remoteId.replace(/[^\w.-]/g, '_'), safeFileName(name))
  }

  /** Who may see one of a source's files, by the source's visibility (null: everyone). */
  private principalsFor(c: ConnectorInfo, sourceAccess: string[] | null | undefined): string[] | null {
    const v = c.visibility ?? 'everyone'
    if (v === 'everyone') return null
    if (v === 'custom') return c.allow ?? []
    // Unknown sharing stays with the person who connected the source: fail closed.
    return [...(sourceAccess ?? []), ...(c.owner ? [`user:${c.owner}`] : [])]
  }

  private applyAccess(c: ConnectorInfo, remoteId: string): void {
    const f = c.files[remoteId]
    if (f) this.duct.setDocumentAccess(this.localPath(c, remoteId, f.name), this.principalsFor(c, f.access))
  }

  /** Changes who sees a source's files; applied to what's already indexed at once. */
  async setVisibility(id: string, visibility: Visibility, allow: string[] = []): Promise<void> {
    const c = this.state.find(x => x.id === id)
    if (!c) throw Object.assign(new Error('No such source'), { status: 404 })
    c.visibility = visibility
    c.allow = visibility === 'custom' ? [...new Set(allow)] : undefined
    for (const remoteId of Object.keys(c.files)) this.applyAccess(c, remoteId)
    // Files whose sharing hasn't been read yet are read on the next sync (until then: the owner only).
    if (visibility === 'source' && Object.values(c.files).some(f => f.access === undefined)) {
      c.recheckAccess = true
      if (c.kind === 'gdrive') c.cursor = null   // a full listing carries every file's sharing
    }
    this.persist()
    this.opts.onChange?.()
    if (c.recheckAccess) this.sync(id).catch(() => {})
  }

  private filesDir(id: string) { return join(this.opts.dir, id, 'files') }

  private source(c: ConnectorInfo): ConnectorSource {
    const secret = this.opts.vault.load()[c.id]
    if (!secret) throw new Error('This source needs reconnecting')
    const ctx = { fetch: this.fetchImpl, saveTokens: (t: Tokens) => { const all = this.opts.vault.load(); all[c.id] = t; this.opts.vault.save(all) } }
    if (c.kind === 's3') return new S3Source(secret as S3Credentials, ctx)
    return c.kind === 'gdrive' ? new GoogleDrive(secret as Tokens, this.opts.clientIds.google, ctx) : new MicrosoftDrive(secret as Tokens, this.opts.clientIds.microsoft, ctx, c.drive)
  }

  /** Signs in to a source in the browser, then starts reading it in the background. */
  get web(): WebCallback | undefined { return this.opts.web }

  /** `openUrl` overrides where the sign-in page is sent (a server hands it to the admin's browser). */
  async add(kind: ConnectorKind, options: { siteUrl?: string; s3?: S3Credentials; openUrl?: (url: string) => void } = {}): Promise<ReturnType<ConnectorManager['list']>[number]> {
    if (!this.opts.entitled()) throw Object.assign(new Error('Connectors are part of the Team plan.'), { status: 403 })
    if (kind === 's3' && !options.s3) throw new Error('Bucket details are required')
    const tokens = kind === 's3' ? options.s3! : await authorizeSource(kind, this.opts.clientIds, options.openUrl ?? this.opts.openUrl, this.fetchImpl, this.opts.web)
    const id = `${kind}-${randomBytes(4).toString('hex')}`
    const all = this.opts.vault.load()
    all[id] = tokens
    this.opts.vault.save(all)
    // S3 has no per-file sharing to follow; its files are for everyone until an admin says otherwise.
    const visibility: Visibility = kind === 's3' ? 'everyone' : this.opts.defaultVisibility ?? 'everyone'
    const info: ConnectorInfo = { id, kind, label: kind === 'gdrive' ? 'Google Drive' : kind === 's3' ? 'S3' : 'Microsoft 365', visibility, cursor: null, files: {}, addedAt: new Date().toISOString() }
    try {
      const src = this.source(info)
      if (kind === 'microsoft' && options.siteUrl) info.drive = await (src as MicrosoftDrive).resolveSite(options.siteUrl)
      // S3: check the credentials and bucket now, with one listing.
      if (kind === 's3') await src.changes(null)
      info.label = await this.source(info).label()
      const email = /[^\s()<>]+@[^\s()<>]+\.[^\s()<>]+/.exec(info.label)?.[0]
      if (email) info.owner = email.toLowerCase()
    } catch (err) {
      delete all[id]
      this.opts.vault.save(all)
      throw err
    }
    this.state.push(info)
    this.persist()
    this.sync(id).catch(() => {})
    return this.list().find(c => c.id === id)!
  }

  /** Fetches changes and updates the local copies and the index. One run per source at a time. */
  sync(id: string): Promise<void> {
    const existing = this.running.get(id)
    if (existing) return existing
    const run = this.runSync(id).finally(() => this.running.delete(id))
    this.running.set(id, run)
    return run
  }

  private async runSync(id: string): Promise<void> {
    const c = this.state.find(x => x.id === id)
    if (!c) throw new Error('No such source')
    c.syncing = true
    c.error = undefined
    this.opts.onChange?.()
    try {
      if (!this.opts.entitled()) throw new Error('Connectors are part of the Team plan; reading is paused.')
      const src = this.source(c)
      const changes = await src.changes(c.cursor)
      // A full listing replaces what we know: anything not listed any more is gone.
      if (changes.full) {
        const listed = new Set(changes.upserts.map(f => f.id))
        for (const known of Object.keys(c.files)) if (!listed.has(known)) changes.removed.push(known)
      }
      for (const remoteId of changes.removed) await this.removeFile(c, remoteId)
      for (const f of changes.upserts) {
        const known = c.files[f.id]
        if (known?.version === f.version) {
          // Unchanged content, but sharing can change on its own: keep the access list current.
          if ((c.visibility ?? 'everyone') === 'source') {
            const access = f.access ?? (c.recheckAccess && known.access === undefined && src.access ? await src.access(f) : known.access)
            if (JSON.stringify(access) !== JSON.stringify(known.access)) { known.access = access; this.applyAccess(c, f.id) }
          }
          continue
        }
        try { await this.fetchFile(c, src, f) } catch (err) { c.error = `Some files couldn’t be read: ${(err as Error).message}` }
      }
      if (c.recheckAccess && (c.kind !== 'gdrive' || changes.full)) delete c.recheckAccess
      c.cursor = changes.cursor
      c.lastSync = new Date().toISOString()
    } catch (err) {
      c.error = (err as Error).message
    } finally {
      c.syncing = false
      this.persist()
      this.opts.onChange?.()
    }
  }

  private async fetchFile(c: ConnectorInfo, src: ConnectorSource, f: RemoteFile): Promise<void> {
    if (f.size && f.size > MAX_FILE_BYTES) return
    const dir = join(this.filesDir(c.id), f.id.replace(/[^\w.-]/g, '_'))
    // A renamed file: drop the old copy first.
    if (existsSync(dir)) {
      for (const old of readdirSync(dir)) await this.duct.removeDocument(join(dir, old))
      rmSync(dir, { recursive: true, force: true })
    }
    const bytes = await src.download(f)
    if (bytes.length > MAX_FILE_BYTES) return
    mkdirSync(dir, { recursive: true })
    const path = join(dir, safeFileName(f.name))
    writeFileSync(path, bytes)
    // Who may see it is set before it's indexed, so it's never briefly visible to everyone.
    const access = (c.visibility ?? 'everyone') === 'source' ? (f.access ?? (src.access ? await src.access(f) : null)) : undefined
    this.duct.setDocumentAccess(path, this.principalsFor(c, access))
    await this.duct.index(path, { connector: c.kind, connectorId: c.id, remoteId: f.id, ...(f.webUrl ? { webUrl: f.webUrl } : {}) }, { source: 'connector', displayName: f.name })
    c.files[f.id] = { version: f.version, name: f.name, ...(access !== undefined ? { access } : {}) }
  }

  private async removeFile(c: ConnectorInfo, remoteId: string): Promise<void> {
    const dir = join(this.filesDir(c.id), remoteId.replace(/[^\w.-]/g, '_'))
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) await this.duct.removeDocument(join(dir, f))
      rmSync(dir, { recursive: true, force: true })
    }
    delete c.files[remoteId]
  }

  /** Disconnects a source: its local copies leave the index and the disk, and its tokens are deleted. */
  async remove(id: string): Promise<boolean> {
    const c = this.state.find(x => x.id === id)
    if (!c) return false
    await this.running.get(id)?.catch(() => {})
    for (const remoteId of Object.keys(c.files)) await this.removeFile(c, remoteId)
    rmSync(join(this.opts.dir, id), { recursive: true, force: true })
    const all = this.opts.vault.load()
    delete all[id]
    this.opts.vault.save(all)
    this.state = this.state.filter(x => x.id !== id)
    this.persist()
    return true
  }

  /** Reads every source now and then every `minutes`. */
  start(minutes = 15): void {
    const all = () => { for (const c of this.state) this.sync(c.id).catch(() => {}) }
    all()
    setInterval(all, minutes * 60_000).unref()
  }
}
