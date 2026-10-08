// Cloud sources Duct reads directly: Google Drive, and Microsoft OneDrive and SharePoint (through Microsoft Graph).
// Each adapter lists files, reports changes since a cursor, and downloads one file. Access is read-only.
//
// Google Drive API v3: https://developers.google.com/drive/api/reference/rest/v3
// Microsoft Graph delta: https://learn.microsoft.com/graph/api/driveitem-delta

import { extname } from 'node:path'
import { isSupportedFile } from '../formats.js'
import { loopbackAuthorize, tokenRequest } from './oauth.js'

export type ConnectorKind = 'gdrive' | 'microsoft'

export interface Tokens { access: string; refresh?: string; expiresAt: number }

export interface RemoteFile {
  id: string
  /** The file name to keep (Google Docs get .docx, Sheets .xlsx, Slides .pptx). */
  name: string
  modified: string
  size?: number
  webUrl?: string
  /** Changes when the content changes, so unchanged files aren't downloaded again. */
  version: string
  /** Google Docs, Sheets and Slides: the format they're exported as. */
  exportMime?: string
}

export interface Changes { upserts: RemoteFile[]; removed: string[]; cursor: string }

export interface SourceContext {
  fetch: typeof fetch
  /** Saves refreshed tokens (refresh tokens can rotate). */
  saveTokens: (t: Tokens) => void
}

export interface ConnectorSource {
  readonly kind: ConnectorKind
  label(): Promise<string>
  /** Everything (cursor null) or what changed since the cursor. */
  changes(cursor: string | null): Promise<Changes>
  download(file: RemoteFile): Promise<Buffer>
}

export interface ClientIds {
  google?: { clientId: string; clientSecret: string }
  microsoft?: { clientId: string }
}

export function clientIdsFromEnv(env: NodeJS.ProcessEnv): ClientIds {
  return {
    ...(env['DUCT_GOOGLE_CLIENT_ID'] && env['DUCT_GOOGLE_CLIENT_SECRET'] ? { google: { clientId: env['DUCT_GOOGLE_CLIENT_ID'], clientSecret: env['DUCT_GOOGLE_CLIENT_SECRET'] } } : {}),
    ...(env['DUCT_MICROSOFT_CLIENT_ID'] ? { microsoft: { clientId: env['DUCT_MICROSOFT_CLIENT_ID'] } } : {}),
  }
}

const GOOGLE_EXPORTS: Record<string, { mime: string; ext: string }> = {
  'application/vnd.google-apps.document': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx' },
  'application/vnd.google-apps.spreadsheet': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx' },
  'application/vnd.google-apps.presentation': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: '.pptx' },
}
const MS_SCOPE = 'offline_access Files.Read.All Sites.Read.All User.Read'
const MS_TOKEN = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'

/** Runs the browser sign-in for a source and returns its first tokens. */
export async function authorizeSource(kind: ConnectorKind, ids: ClientIds, openUrl: (url: string) => void | Promise<void>, fetchImpl: typeof fetch = fetch): Promise<Tokens> {
  if (kind === 'gdrive') {
    if (!ids.google) throw new Error('Google Drive isn’t set up in this build of Duct')
    const r = await loopbackAuthorize({ authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', openUrl, params: { client_id: ids.google.clientId, scope: 'https://www.googleapis.com/auth/drive.readonly', access_type: 'offline', prompt: 'consent' } })
    const t = await tokenRequest(fetchImpl, GOOGLE_TOKEN, { grant_type: 'authorization_code', code: r.code, redirect_uri: r.redirectUri, code_verifier: r.verifier, client_id: ids.google.clientId, client_secret: ids.google.clientSecret })
    return { access: t.access_token, refresh: t.refresh_token, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 }
  }
  if (!ids.microsoft) throw new Error('Microsoft 365 isn’t set up in this build of Duct')
  const r = await loopbackAuthorize({ authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', openUrl, params: { client_id: ids.microsoft.clientId, scope: MS_SCOPE, prompt: 'select_account' } })
  const t = await tokenRequest(fetchImpl, MS_TOKEN, { grant_type: 'authorization_code', code: r.code, redirect_uri: r.redirectUri, code_verifier: r.verifier, client_id: ids.microsoft.clientId, scope: MS_SCOPE })
  return { access: t.access_token, refresh: t.refresh_token, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 }
}

/** Shared token handling: refresh before expiry and once on a 401. */
abstract class OAuthSource {
  constructor(protected tokens: Tokens, protected ctx: SourceContext) {}
  protected abstract refresh(): Promise<Tokens>

  protected async get(url: string, raw = false): Promise<Response> {
    if (this.tokens.expiresAt < Date.now() + 60_000 && this.tokens.refresh) await this.renew()
    let res = await this.ctx.fetch(url, { headers: { Authorization: `Bearer ${this.tokens.access}` }, signal: AbortSignal.timeout(raw ? 300_000 : 30_000) })
    if (res.status === 401 && this.tokens.refresh) {
      await this.renew()
      res = await this.ctx.fetch(url, { headers: { Authorization: `Bearer ${this.tokens.access}` }, signal: AbortSignal.timeout(raw ? 300_000 : 30_000) })
    }
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}${res.status === 401 || res.status === 403 ? ' (reconnect this source)' : ''}`)
    return res
  }

  protected async json<T>(url: string): Promise<T> { return (await this.get(url)).json() as Promise<T> }

  private async renew() {
    this.tokens = await this.refresh()
    this.ctx.saveTokens(this.tokens)
  }

  async download(file: RemoteFile): Promise<Buffer> {
    return Buffer.from(await (await this.get(this.downloadUrl(file), true)).arrayBuffer())
  }

  protected abstract downloadUrl(file: RemoteFile): string
}

// ---------------------------------------------------------------- Google Drive

interface DriveFile { id: string; name: string; mimeType: string; modifiedTime: string; size?: string; webViewLink?: string; md5Checksum?: string; trashed?: boolean }

export class GoogleDrive extends OAuthSource implements ConnectorSource {
  readonly kind = 'gdrive' as const
  private static API = 'https://www.googleapis.com/drive/v3'
  private static FIELDS = 'id,name,mimeType,modifiedTime,size,webViewLink,md5Checksum,trashed'

  constructor(tokens: Tokens, private ids: ClientIds['google'], ctx: SourceContext) { super(tokens, ctx) }

  protected async refresh(): Promise<Tokens> {
    const t = await tokenRequest(this.ctx.fetch, GOOGLE_TOKEN, { grant_type: 'refresh_token', refresh_token: this.tokens.refresh!, client_id: this.ids!.clientId, client_secret: this.ids!.clientSecret })
    return { access: t.access_token, refresh: t.refresh_token ?? this.tokens.refresh, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 }
  }

  async label(): Promise<string> {
    const about = await this.json<{ user?: { emailAddress?: string; displayName?: string } }>(`${GoogleDrive.API}/about?fields=user(emailAddress,displayName)`)
    return about.user?.emailAddress ?? about.user?.displayName ?? 'Google Drive'
  }

  /** Readable files only: Google Docs, Sheets and Slides are exported; other Google types and folders are skipped. */
  private toRemote(f: DriveFile): RemoteFile | null {
    if (f.trashed) return null
    const exp = GOOGLE_EXPORTS[f.mimeType]
    if (f.mimeType.startsWith('application/vnd.google-apps.') && !exp) return null
    const name = exp && extname(f.name).toLowerCase() !== exp.ext ? f.name + exp.ext : f.name
    if (!isSupportedFile(name)) return null
    return { id: f.id, name, modified: f.modifiedTime, size: f.size ? Number(f.size) : undefined, webUrl: f.webViewLink, version: f.md5Checksum ?? f.modifiedTime, ...(exp ? { exportMime: exp.mime } : {}) }
  }

  async changes(cursor: string | null): Promise<Changes> {
    const common = 'supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=1000'
    if (!cursor) {
      // Take the change cursor first, so nothing changed during the full listing is missed.
      const start = await this.json<{ startPageToken: string }>(`${GoogleDrive.API}/changes/startPageToken?supportsAllDrives=true`)
      const upserts: RemoteFile[] = []
      let page: string | undefined
      do {
        const q = encodeURIComponent("trashed = false and mimeType != 'application/vnd.google-apps.folder'")
        const r = await this.json<{ files: DriveFile[]; nextPageToken?: string }>(`${GoogleDrive.API}/files?${common}&corpora=allDrives&q=${q}&fields=nextPageToken,files(${GoogleDrive.FIELDS})${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`)
        for (const f of r.files) { const rf = this.toRemote(f); if (rf) upserts.push(rf) }
        page = r.nextPageToken
      } while (page)
      return { upserts, removed: [], cursor: start.startPageToken }
    }
    const upserts: RemoteFile[] = []
    const removed: string[] = []
    let page: string | undefined = cursor
    let next = cursor
    const seen = new Set<string>()
    while (page) {
      if (seen.has(page)) throw new Error('Google Drive returned the same page twice')
      seen.add(page)
      const r: { changes: { fileId: string; removed?: boolean; file?: DriveFile }[]; nextPageToken?: string; newStartPageToken?: string } =
        await this.json(`${GoogleDrive.API}/changes?${common}&pageToken=${encodeURIComponent(page)}&fields=nextPageToken,newStartPageToken,changes(fileId,removed,file(${GoogleDrive.FIELDS}))`)
      for (const c of r.changes) {
        const rf = c.file && !c.removed ? this.toRemote(c.file) : null
        if (rf) upserts.push(rf)
        else removed.push(c.fileId)
      }
      page = r.nextPageToken
      if (r.newStartPageToken) next = r.newStartPageToken
    }
    return { upserts, removed, cursor: next }
  }

  protected downloadUrl(file: RemoteFile): string {
    return file.exportMime ? `${GoogleDrive.API}/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(file.exportMime)}` : `${GoogleDrive.API}/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`
  }
}

// ---------------------------------------------------------------- Microsoft OneDrive and SharePoint

interface GraphItem { id: string; name?: string; file?: { mimeType?: string }; folder?: unknown; deleted?: unknown; size?: number; lastModifiedDateTime?: string; webUrl?: string; cTag?: string; eTag?: string }

export class MicrosoftDrive extends OAuthSource implements ConnectorSource {
  readonly kind = 'microsoft' as const
  private static API = 'https://graph.microsoft.com/v1.0'

  /** `drive` is "/me/drive" for OneDrive or "/sites/{id}/drive" for a SharePoint site's documents. */
  constructor(tokens: Tokens, private ids: ClientIds['microsoft'], ctx: SourceContext, private drive = '/me/drive') { super(tokens, ctx) }

  protected async refresh(): Promise<Tokens> {
    const t = await tokenRequest(this.ctx.fetch, MS_TOKEN, { grant_type: 'refresh_token', refresh_token: this.tokens.refresh!, client_id: this.ids!.clientId, scope: MS_SCOPE })
    return { access: t.access_token, refresh: t.refresh_token ?? this.tokens.refresh, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 }
  }

  async label(): Promise<string> {
    const me = await this.json<{ mail?: string; userPrincipalName?: string }>(`${MicrosoftDrive.API}/me?$select=mail,userPrincipalName`)
    const who = me.mail ?? me.userPrincipalName ?? 'Microsoft 365'
    return this.drive === '/me/drive' ? `${who} (OneDrive)` : `${who} (SharePoint)`
  }

  /** Finds a SharePoint site's document library from its address, e.g. https://contoso.sharepoint.com/sites/Legal. */
  async resolveSite(siteUrl: string): Promise<string> {
    const u = new URL(siteUrl)
    if (!/\.sharepoint\.com$/i.test(u.hostname)) throw new Error('That isn’t a SharePoint site address')
    const site = await this.json<{ id: string }>(`${MicrosoftDrive.API}/sites/${u.hostname}:${u.pathname.replace(/\/+$/, '') || '/'}`)
    return `/sites/${site.id}/drive`
  }

  async changes(cursor: string | null): Promise<Changes> {
    const upserts: RemoteFile[] = []
    const removed: string[] = []
    let url: string | undefined = cursor ?? `${MicrosoftDrive.API}${this.drive}/root/delta?$select=id,name,file,folder,deleted,size,lastModifiedDateTime,webUrl,cTag,eTag`
    let deltaLink = cursor ?? ''
    const seen = new Set<string>()
    // Only Graph's own links are followed (the cursor is the last delta link Graph gave us), each once.
    while (url) {
      if (!url.startsWith(MicrosoftDrive.API + '/')) throw new Error('Unexpected Microsoft Graph link')
      if (seen.has(url)) throw new Error('Microsoft Graph returned the same page twice')
      seen.add(url)
      const r: { value: GraphItem[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string } = await this.json(url)
      for (const item of r.value) {
        if (item.deleted) { removed.push(item.id); continue }
        if (item.folder || !item.file || !item.name) continue
        if (!isSupportedFile(item.name)) { removed.push(item.id); continue }
        upserts.push({ id: item.id, name: item.name, modified: item.lastModifiedDateTime ?? '', size: item.size, webUrl: item.webUrl, version: item.cTag ?? item.eTag ?? item.lastModifiedDateTime ?? '' })
      }
      url = r['@odata.nextLink']
      if (r['@odata.deltaLink']) deltaLink = r['@odata.deltaLink']
    }
    return { upserts, removed, cursor: deltaLink }
  }

  protected downloadUrl(file: RemoteFile): string {
    return `${MicrosoftDrive.API}${this.drive}/items/${encodeURIComponent(file.id)}/content`
  }
}
