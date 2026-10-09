import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duct } from '../src/index.js'
import { ConnectorManager } from '../src/team/connectors/manager.js'
import type { TokenVault } from '../src/team/connectors/manager.js'
import type { S3Credentials, Tokens } from '../src/team/connectors/sources.js'
import { drivePrincipals, signS3Get } from '../src/team/connectors/sources.js'
import { createServer, s3Details } from '../src/server.js'
import { WebCallback } from '../src/team/connectors/oauth.js'
import { makeDocx } from './helpers.js'

const work = mkdtempSync(join(tmpdir(), 'duct-conn-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

class MemoryVault implements TokenVault {
  data: Record<string, Tokens | S3Credentials> = {}
  load() { return JSON.parse(JSON.stringify(this.data)) }
  save(all: Record<string, Tokens | S3Credentials>) { this.data = all }
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

let drive: Record<string, { name: string; mimeType: string; md5?: string; body?: string | Buffer; trashed?: boolean; perms?: { type: string; emailAddress?: string; domain?: string; allowFileDiscovery?: boolean }[] }>
let driveChanges: { fileId: string; removed?: boolean }[]
let tokenCalls: URLSearchParams[]
let expireNext = false

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })
const meta = (id: string) => { const f = drive[id]; return { id, name: f.name, mimeType: f.mimeType, modifiedTime: '2026-10-01T00:00:00Z', md5Checksum: f.md5, trashed: f.trashed, webViewLink: `https://drive.google.com/file/d/${id}/view`, ...(f.perms ? { permissions: f.perms } : {}) } }

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
    expect((vault.data[c.id] as Tokens).access).toBe('access-2')
    expect(manager.list()[0].fileCount).toBe(2)
  })

  it('on a public server, sends the admin\'s browser to Google and takes the redirect at /connectors/callback', async () => {
    const dir = mkdtempSync(join(work, 'w-'))
    const web = new WebCallback('https://duct.okafor.ng/')
    const m = new ConnectorManager(duct, { dir, vault, clientIds: { google: { clientId: 'gid', clientSecret: 'gsecret' } }, openUrl: () => { throw new Error('no system browser on a server') }, fetch: googleFetch, entitled: () => true, web })
    const server = createServer(duct, { authToken: 'admin-token', connectors: m, allowedHosts: '*' }).listen(0)
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    try {
      const r = await (await fetch(`${base}/api/connectors`, { method: 'POST', headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'gdrive' }) })).json() as { url: string }
      const auth = new URL(r.url)
      expect(auth.origin).toBe('https://accounts.google.com')
      expect(auth.searchParams.get('redirect_uri')).toBe('https://duct.okafor.ng/connectors/callback')
      expect((await fetch(`${base}/connectors/callback?state=forged&code=x`)).status).toBe(400)
      const back = await fetch(`${base}/connectors/callback?state=${auth.searchParams.get('state')}&code=auth-code`)
      expect(back.status).toBe(200)
      for (let i = 0; i < 50 && m.list().length === 0; i++) await new Promise(res => setTimeout(res, 20))
      expect(m.list()[0].label).toBe('ada@okafor.ng')
      expect(tokenCalls[0].get('redirect_uri')).toBe('https://duct.okafor.ng/connectors/callback')
    } finally { server.close() }
  })

  it('on a server, follows each file\'s sharing: people and discoverable domains count, links don\'t', async () => {
    const m = new ConnectorManager(duct, { dir: mkdtempSync(join(work, 'p-')), vault, clientIds: { google: { clientId: 'gid', clientSecret: 'gsecret' } }, openUrl: browser, fetch: googleFetch, entitled: () => true, defaultVisibility: 'source' })
    drive.a.perms = [{ type: 'user', emailAddress: 'Chidi@okafor.ng' }, { type: 'anyone', allowFileDiscovery: false }]
    drive.b.perms = [{ type: 'domain', domain: 'okafor.ng', allowFileDiscovery: true }]
    const c = await m.add('gdrive')
    expect(c).toMatchObject({ visibility: 'source', owner: 'ada@okafor.ng' })
    await m.sync(c.id)
    const pathOf = (name: string) => duct.getDocuments().find(d => d.displayName === name)!.path
    expect(duct.documentAccess(pathOf('Board minutes.txt'))).toEqual(['user:ada@okafor.ng', 'user:chidi@okafor.ng'])
    expect(duct.documentAccess(pathOf('Leave policy.docx'))).toEqual(['domain:okafor.ng', 'user:ada@okafor.ng'])
    expect((await duct.search('lease', 5, undefined, { viewer: ['user:bello@other.com', 'domain:other.com', 'anyone'] })).length).toBe(0)
    expect((await duct.search('lease', 5, undefined, { viewer: ['user:chidi@okafor.ng', 'domain:okafor.ng', 'anyone'] })).length).toBe(1)

    // Sharing changed at the source, content didn't: the access list follows.
    drive.a.perms = [{ type: 'user', emailAddress: 'bello@other.com' }]
    driveChanges = [{ fileId: 'a' }]
    await m.sync(c.id)
    expect(duct.documentAccess(pathOf('Board minutes.txt'))).toEqual(['user:ada@okafor.ng', 'user:bello@other.com'])

    await m.setVisibility(c.id, 'everyone')
    expect(duct.documentAccess(pathOf('Board minutes.txt'))).toBeNull()
    await m.setVisibility(c.id, 'custom', ['domain:okafor.ng'])
    expect(duct.documentAccess(pathOf('Leave policy.docx'))).toEqual(['domain:okafor.ng'])
    // Re-indexing keeps the list.
    await duct.index(pathOf('Leave policy.docx'), undefined, { force: true })
    expect(duct.documentAccess(pathOf('Leave policy.docx'))).toEqual(['domain:okafor.ng'])
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

  it('notices when a file is un-shared, though Graph’s change feed doesn’t report it', async () => {
    let clock = Date.parse('2026-10-09T09:00:00Z')
    let shared = ['chidi@okafor.ng']
    let deltaRound = 0
    let permissionCalls = 0
    const graphFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('https://login.microsoftonline.com/')) return json({ access_token: 'ms-access', refresh_token: 'ms-refresh', expires_in: 3600 })
      if (url.includes('/me?')) return json({ mail: 'ada@okafor.ng' })
      if (url.includes('/root/delta?$select')) return json({ value: [{ id: '7', name: 'Salary review.txt', file: {}, cTag: 'c1' }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/drive/root/delta?token=d1' })
      // Later rounds: nothing edited, so the feed is empty, as it is when only sharing changes.
      if (url.includes('token=d')) { deltaRound++; return json({ value: [], '@odata.deltaLink': `https://graph.microsoft.com/v1.0/me/drive/root/delta?token=d${deltaRound + 1}` }) }
      if (url.endsWith('/items/7/permissions')) { permissionCalls++; return json({ value: shared.map(email => ({ grantedToV2: { user: { email } } })) }) }
      if (url.includes('/items/7/content')) return new Response('The salary review for 2027 is attached.')
      void init
      return json({}, 404)
    }) as typeof fetch
    const duct = new Duct({ embed: false })
    const manager = new ConnectorManager(duct, { dir: mkdtempSync(join(work, 'ms-')), vault: new MemoryVault(), clientIds: { microsoft: { clientId: 'mid' } }, openUrl: browser, fetch: graphFetch, entitled: () => true, defaultVisibility: 'source', now: () => clock })
    const c = await manager.add('microsoft')
    await manager.sync(c.id)
    const chidi = ['user:chidi@okafor.ng', 'domain:okafor.ng', 'anyone']
    expect(await duct.search('salary', 10, undefined, { viewer: chidi })).toHaveLength(1)

    shared = []   // un-shared in Microsoft 365; the file itself is untouched
    clock += 60 * 60 * 1000
    await manager.sync(c.id)
    expect(permissionCalls).toBe(1)   // within the interval, nothing is read again
    clock += 6 * 60 * 60 * 1000
    await manager.sync(c.id)
    expect(permissionCalls).toBe(2)
    expect(await duct.search('salary', 10, undefined, { viewer: chidi })).toHaveLength(0)
    expect(await duct.search('salary', 10, undefined, { viewer: ['user:ada@okafor.ng', 'domain:okafor.ng', 'anyone'] })).toHaveLength(1)   // who connected it
  })
})

// ---------- a fake S3 bucket that checks Signature Version 4 ----------

describe('S3 and S3-compatible storage', () => {
  const creds = { bucket: 'okafor-docs', region: 'eu-west-2', prefix: 'legal/', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }

  it('signs requests the way AWS documents', () => {
    // "GET Bucket (List Objects)" from the S3 Signature Version 4 examples.
    const h = signS3Get({ bucket: 'examplebucket', region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }, new URL('https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J'), new Date('2013-05-24T00:00:00Z'))
    expect(h.Authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7')
  })

  it('lists, reads only changed objects and drops deleted ones', async () => {
    let objects: Record<string, { etag: string; body: string }> = {
      'legal/MSA.txt': { etag: '"e1"', body: 'Indemnity survives termination.' },
      'legal/NDA.txt': { etag: '"e2"', body: 'Confidentiality lasts three years.' },
      'legal/': { etag: '"d"', body: '' },
      'legal/setup.exe': { etag: '"x"', body: '' },
    }
    const gets: string[] = []
    const s3Fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      const headers = init?.headers as Record<string, string>
      // Re-sign the same request: a server would reject anything else.
      const now = headers['x-amz-date'].replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z')
      if (signS3Get({ ...creds, endpoint: 'http://localhost:9000' }, url, new Date(now)).Authorization !== headers.Authorization) {
        return new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', { status: 403 })
      }
      expect(url.pathname.startsWith('/okafor-docs')).toBe(true)   // path-style for custom endpoints
      if (url.searchParams.get('list-type') === '2') {
        expect(url.searchParams.get('prefix')).toBe('legal/')
        const keys = Object.keys(objects)
        const page = url.searchParams.get('continuation-token') ? keys.slice(2) : keys.slice(0, 2)
        const more = !url.searchParams.get('continuation-token') && keys.length > 2
        return new Response(`<?xml version="1.0"?><ListBucketResult>${page.map(k => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key><LastModified>2026-10-01T00:00:00.000Z</LastModified><ETag>${objects[k].etag.replace(/"/g, '&quot;')}</ETag><Size>${objects[k].body.length}</Size></Contents>`).join('')}<IsTruncated>${more}</IsTruncated>${more ? '<NextContinuationToken>p2</NextContinuationToken>' : ''}</ListBucketResult>`)
      }
      const key = decodeURIComponent(url.pathname.replace('/okafor-docs/', ''))
      gets.push(key)
      return new Response(objects[key].body)
    }) as typeof fetch

    const duct = new Duct({ embed: false })
    const vault = new MemoryVault()
    const manager = new ConnectorManager(duct, { dir: mkdtempSync(join(work, 's3-')), vault, clientIds: {}, openUrl: () => { throw new Error('S3 needs no browser') }, fetch: s3Fetch, entitled: () => true })
    await expect(manager.add('s3', { s3: { ...creds, endpoint: 'http://localhost:9000', secretAccessKey: 'wrong' } })).rejects.toThrow(/SignatureDoesNotMatch/)
    expect(manager.list()).toHaveLength(0)
    expect(Object.keys(vault.data)).toHaveLength(0)

    const c = await manager.add('s3', { s3: { ...creds, endpoint: 'http://localhost:9000' } })
    expect(c.label).toBe('s3://okafor-docs/legal/')
    await manager.sync(c.id)
    expect(manager.list()[0].fileCount).toBe(2)
    expect((await duct.search('indemnity'))[0].chunk.metadata).toMatchObject({ connector: 's3', remoteId: 'legal/MSA.txt' })

    gets.length = 0
    objects = { 'legal/MSA.txt': { etag: '"e3"', body: 'Indemnity ends with the agreement.' } }
    await manager.sync(c.id)
    expect(gets).toEqual(['legal/MSA.txt'])
    expect((await duct.search('confidentiality')).length).toBe(0)
    expect((await duct.search('agreement')).length).toBe(1)
    expect(manager.list()[0].fileCount).toBe(1)
  })

  it('validates the bucket form', () => {
    expect(() => s3Details({ bucket: 'docs', accessKeyId: 'a', secretAccessKey: 'b', endpoint: 'http://minio.example.com' })).toThrow(/https/)
    expect(() => s3Details({ bucket: 'Bad_Bucket', accessKeyId: 'a', secretAccessKey: 'b' })).toThrow(/bucket/)
    expect(s3Details({ bucket: 'docs', accessKeyId: 'a', secretAccessKey: 'b', prefix: '/contracts/' })).toEqual({ bucket: 'docs', region: 'us-east-1', accessKeyId: 'a', secretAccessKey: 'b', prefix: 'contracts/' })
  })
})

describe('sharing at the source', () => {
  it('reads Drive permissions without letting links make files public', () => {
    expect(drivePrincipals(undefined)).toBeUndefined()
    expect(drivePrincipals([
      { type: 'user', emailAddress: 'Ada@Okafor.ng' },
      { type: 'group', emailAddress: 'legal@okafor.ng' },
      { type: 'domain', domain: 'okafor.ng', allowFileDiscovery: false },
      { type: 'anyone', allowFileDiscovery: false },
    ])).toEqual(['user:ada@okafor.ng', 'group:legal@okafor.ng'])
    expect(drivePrincipals([{ type: 'anyone', allowFileDiscovery: true }])).toEqual(['anyone'])
  })

  it('reads Microsoft permissions: people named in them; links and site groups don\'t count', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/items/42/permissions')) return json({ value: [
        { grantedToV2: { user: { email: 'Ada@okafor.ng' } } },
        { link: { scope: 'organization' }, grantedToIdentitiesV2: [] },
        { link: { scope: 'users' }, grantedToIdentitiesV2: [{ user: { email: 'chidi@okafor.ng' } }] },
        { grantedToV2: { siteGroup: { displayName: 'Legal Members' } } },
      ] })
      return json({}, 404)
    }) as typeof fetch
    const { MicrosoftDrive } = await import('../src/team/connectors/sources.js')
    const src = new MicrosoftDrive({ access: 't', expiresAt: Date.now() + 3600_000 }, { clientId: 'mid' }, { fetch: fetchImpl, saveTokens: () => {} })
    expect(await src.access({ id: '42', name: 'x.txt', modified: '', version: '1' })).toEqual(['user:ada@okafor.ng', 'user:chidi@okafor.ng'])
    expect(await src.access({ id: '43', name: 'y.txt', modified: '', version: '1' })).toBeNull()
  })
})
