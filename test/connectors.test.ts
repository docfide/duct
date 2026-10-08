import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duct } from '../src/index.js'
import { ConnectorManager } from '../src/connectors/manager.js'
import type { TokenVault } from '../src/connectors/manager.js'
import type { Tokens } from '../src/connectors/sources.js'
import { makeDocx } from './helpers.js'

const work = mkdtempSync(join(tmpdir(), 'duct-conn-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

class MemoryVault implements TokenVault {
  data: Record<string, Tokens> = {}
  load() { return JSON.parse(JSON.stringify(this.data)) }
  save(all: Record<string, Tokens>) { this.data = all }
}

/** Plays the browser: the sign-in page "approves" by calling the loopback redirect. */
const browser = async (url: string) => {
  const u = new URL(url)
  expect(u.searchParams.get('code_challenge_method')).toBe('S256')
  const back = new URL(u.searchParams.get('redirect_uri')!)
  back.searchParams.set('code', 'auth-code')
  back.searchParams.set('state', u.searchParams.get('state')!)
  await fetch(back)
}

// ---------- a fake Google Drive ----------

let drive: Record<string, { name: string; mimeType: string; md5?: string; body?: string | Buffer; trashed?: boolean }>
let driveChanges: { fileId: string; removed?: boolean }[]
let tokenCalls: URLSearchParams[]
let expireNext = false

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })
const meta = (id: string) => { const f = drive[id]; return { id, name: f.name, mimeType: f.mimeType, modifiedTime: '2026-10-01T00:00:00Z', md5Checksum: f.md5, trashed: f.trashed, webViewLink: `https://drive.google.com/file/d/${id}/view` } }

const googleFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input))
  if (url.href === 'https://oauth2.googleapis.com/token') {
    const form = new URLSearchParams(String(init?.body))
    tokenCalls.push(form)
    return json({ access_token: form.get('grant_type') === 'refresh_token' ? 'access-2' : 'access-1', refresh_token: 'refresh-g', expires_in: 3600 })
  }
  const auth = (init?.headers as Record<string, string>)?.['Authorization']
  if (expireNext && auth === 'Bearer access-1') { expireNext = false; return json({ error: 'expired' }, 401) }
  const p = url.pathname.replace('/drive/v3', '')
  if (p === '/about') return json({ user: { emailAddress: 'ada@okafor.ng' } })
  if (p === '/changes/startPageToken') return json({ startPageToken: 'tok-1' })
  if (p === '/files') return json({ files: Object.keys(drive).filter(id => !drive[id].trashed && !drive[id].mimeType.endsWith('folder')).map(meta) })
  if (p === '/changes') return json({ changes: driveChanges.map(c => ({ ...c, ...(c.removed ? {} : { file: meta(c.fileId) }) })), newStartPageToken: 'tok-2' })
  const exp = /^\/files\/([^/]+)\/export$/.exec(p)
  if (exp) return new Response(drive[exp[1]].body as Buffer)
  const media = /^\/files\/([^/]+)$/.exec(p)
  if (media && url.searchParams.get('alt') === 'media') return new Response(drive[media[1]].body as string)
  return json({ error: 'not found ' + url.href }, 404)
}) as typeof fetch

describe('Google Drive', () => {
  let duct: Duct
  let vault: MemoryVault
  let manager: ConnectorManager
  let entitled = true
  beforeEach(async () => {
    tokenCalls = []
    entitled = true
    drive = {
      a: { name: 'Board minutes.txt', mimeType: 'text/plain', md5: 'm1', body: 'The board approved the Lagos office lease.' },
      b: { name: 'Leave policy', mimeType: 'application/vnd.google-apps.document', body: await makeDocx(['Annual leave is twenty working days.']) },
      c: { name: 'Folder', mimeType: 'application/vnd.google-apps.folder' },
      d: { name: 'tool.exe', mimeType: 'application/octet-stream', md5: 'x' },
      e: { name: 'Form', mimeType: 'application/vnd.google-apps.form' },
      f: { name: 'Old.txt', mimeType: 'text/plain', md5: 'm9', body: 'gone', trashed: true },
    }
    driveChanges = []
    duct = new Duct({ embed: false })
    vault = new MemoryVault()
    manager = new ConnectorManager(duct, { dir: mkdtempSync(join(work, 'g-')), vault, clientIds: { google: { clientId: 'gid', clientSecret: 'gsecret' } }, openUrl: browser, fetch: googleFetch, entitled: () => entitled })
  })

  it('connects with PKCE, reads readable files and exports Google Docs', async () => {
    const c = await manager.add('gdrive')
    expect(c.label).toBe('ada@okafor.ng')
    expect(tokenCalls[0].get('code_verifier')).toBeTruthy()
    expect(tokenCalls[0].get('client_secret')).toBe('gsecret')
    await manager.sync(c.id)
    const listed = manager.list()[0]
    expect(listed.fileCount).toBe(2)
    expect(listed.error).toBeUndefined()
    const hit = (await duct.search('lease'))[0]
    expect(hit.chunk.metadata).toMatchObject({ connector: 'gdrive', webUrl: 'https://drive.google.com/file/d/a/view' })
    expect((await duct.search('annual leave'))[0].chunk.documentFormat).toBe('docx')
    expect(duct.getDocuments().map(d => d.displayName).sort()).toEqual(['Board minutes.txt', 'Leave policy.docx'])
  })

  it('applies changes: edits are re-read, deletions removed', async () => {
    const c = await manager.add('gdrive')
    await manager.sync(c.id)
    drive.a = { ...drive.a, md5: 'm2', body: 'The board approved the Abuja office lease.' }
    driveChanges = [{ fileId: 'a' }, { fileId: 'b', removed: true }]
    await manager.sync(c.id)
    expect((await duct.search('Abuja')).length).toBe(1)
    expect((await duct.search('Lagos')).length).toBe(0)
    expect((await duct.search('annual leave')).length).toBe(0)
    expect(manager.list()[0].fileCount).toBe(1)
  })

  it('refreshes an expired token and keeps the new one', async () => {
    const c = await manager.add('gdrive')
    expireNext = true
    await manager.sync(c.id)
    expect(tokenCalls.some(t => t.get('grant_type') === 'refresh_token')).toBe(true)
    expect(vault.data[c.id].access).toBe('access-2')
    expect(manager.list()[0].fileCount).toBe(2)
  })

  it('is a Team feature', async () => {
    entitled = false
    await expect(manager.add('gdrive')).rejects.toThrow(/Team plan/)
  })

  it('disconnecting removes the documents, the local copies and the tokens', async () => {
    const c = await manager.add('gdrive')
    await manager.sync(c.id)
    const dir = manager.list()[0].filesDir
    expect(await manager.remove(c.id)).toBe(true)
    expect(duct.getDocuments()).toHaveLength(0)
    expect(existsSync(dir)).toBe(false)
    expect(vault.data[c.id]).toBeUndefined()
  })
})

// ---------- a fake Microsoft Graph ----------

describe('OneDrive and SharePoint', () => {
  it('reads with delta queries across pages, then only changes', async () => {
    let round = 0
    const graphCalls: string[] = []
    const graphFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      graphCalls.push(url)
      if (url.startsWith('https://login.microsoftonline.com/')) {
        const form = new URLSearchParams(String(init?.body))
        expect(form.get('client_secret')).toBeNull()   // a public client: PKCE only
        return json({ access_token: 'ms-access', refresh_token: 'ms-refresh', expires_in: 3600 })
      }
      if (url.includes('/me?')) return json({ mail: 'ada@okafor.ng' })
      if (url.includes('/sites/okafor.sharepoint.com:/sites/Legal')) return json({ id: 'site-123' })
      if (url.includes('/root/delta?$select') && round === 0) {
        return json({ value: [{ id: '1', name: 'Contracts', folder: {} }, { id: '2', name: 'MSA.txt', file: {}, cTag: 'c1', webUrl: 'https://okafor.sharepoint.com/MSA.txt' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/sites/site-123/drive/root/delta?page=2' })
      }
      if (url.includes('page=2')) return json({ value: [{ id: '3', name: 'NDA.txt', file: {}, cTag: 'c1' }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/sites/site-123/drive/root/delta?token=d1' })
      if (url.includes('token=d1')) return json({ value: [{ id: '3', deleted: {} }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/sites/site-123/drive/root/delta?token=d2' })
      const content = /items\/(\d)\/content/.exec(url)
      if (content) return new Response(content[1] === '2' ? 'Indemnity survives termination.' : 'Confidentiality lasts three years.')
      return json({}, 404)
    }) as typeof fetch
    const duct = new Duct({ embed: false })
    const manager = new ConnectorManager(duct, { dir: mkdtempSync(join(work, 'm-')), vault: new MemoryVault(), clientIds: { microsoft: { clientId: 'mid' } }, openUrl: browser, fetch: graphFetch, entitled: () => true })
    const c = await manager.add('microsoft', { siteUrl: 'https://okafor.sharepoint.com/sites/Legal' })
    expect(c.label).toBe('ada@okafor.ng (SharePoint)')
    await manager.sync(c.id)
    expect(graphCalls.some(u => u.includes('/sites/site-123/drive/root/delta'))).toBe(true)
    expect(manager.list()[0].fileCount).toBe(2)
    expect((await duct.search('indemnity'))[0].chunk.metadata).toMatchObject({ connector: 'microsoft', webUrl: 'https://okafor.sharepoint.com/MSA.txt' })
    round = 1
    await manager.sync(c.id)
    expect(graphCalls.at(-1)).toContain('token=d1')
    expect((await duct.search('confidentiality')).length).toBe(0)
    expect(manager.list()[0].fileCount).toBe(1)
    await expect(manager.add('microsoft', { siteUrl: 'https://evil.example/sites/x' })).rejects.toThrow(/SharePoint/)
  })
})
