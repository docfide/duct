import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duct } from '../src/index.js'
import { createServer } from '../src/server.js'
import { OidcLogin } from '../src/team/oidc.js'

const ISSUER = 'https://login.example.com'
let duct: Duct
let server: Server
let base: string
let nonces: Map<string, string>
let nextEmail: string

/** A fake identity provider: discovery and a token endpoint that signs the person in as `nextEmail`. */
const idpFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  if (url === `${ISSUER}/.well-known/openid-configuration`) return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token` })
  if (url === `${ISSUER}/token`) {
    const form = new URLSearchParams(String(init?.body))
    expect(form.get('client_secret')).toBe('secret')
    expect(form.get('code_verifier')).toBeTruthy()
    const claims = { iss: ISSUER, aud: 'duct-server', nonce: nonces.get(form.get('code')!), exp: Math.floor(Date.now() / 1000) + 300, email: nextEmail, email_verified: true }
    return Response.json({ id_token: `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s` })
  }
  return new Response('not found', { status: 404 })
}) as typeof fetch

let docs: string

async function start(audit: { queries?: boolean } = {}, files: Record<string, string> = {}, tokens: { authToken?: string; memberTokens?: string[] } = {}) {
  docs = mkdtempSync(join(tmpdir(), 'duct-cloud-'))
  mkdirSync(docs, { recursive: true })
  writeFileSync(join(docs, 'policy.txt'), 'The travel policy covers economy flights.')
  for (const [name, text] of Object.entries(files)) writeFileSync(join(docs, name), text)
  duct = new Duct({ embed: false })
  await duct.index(docs)
  const oidc = new OidcLogin({ issuer: ISSUER, clientId: 'duct-server', clientSecret: 'secret', publicUrl: 'http://duct.test', admins: ['boss@okafor.ng'], allowDomains: ['okafor.ng'], allowEmails: ['auditor@external.com'], sessionSecret: 'x'.repeat(40) }, idpFetch)
  server = createServer(duct, { oidc, allowedHosts: '*', audit, libraryDir: join(docs, 'lib'), ...tokens }).listen(0, '127.0.0.1')
  await new Promise(r => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

beforeEach(() => { nonces = new Map(); nextEmail = 'chidi@okafor.ng' })
afterEach(() => { server?.close(); duct?.close() })

/** Signs in through the fake provider and returns the session cookie. */
async function signIn(email: string): Promise<string> {
  nextEmail = email
  const start = await fetch(`${base}/auth/login?next=/`, { redirect: 'manual' })
  const stateCookie = start.headers.getSetCookie()[0].split(';')[0]
  const auth = new URL(start.headers.get('location')!)
  expect(auth.origin + auth.pathname).toBe(`${ISSUER}/authorize`)
  expect(auth.searchParams.get('redirect_uri')).toBe('http://duct.test/auth/callback')
  const code = 'c-' + Math.random()
  nonces.set(code, auth.searchParams.get('nonce')!)
  const back = await fetch(`${base}/auth/callback?code=${code}&state=${auth.searchParams.get('state')}`, { redirect: 'manual', headers: { Cookie: stateCookie } })
  if (back.status !== 303) return `status:${back.status}`
  return back.headers.getSetCookie().find(c => c.startsWith('duct_session='))!.split(';')[0]
}

describe('Duct in your cloud: sign-in', () => {
  it('requires sign-in and tells the page where to go', async () => {
    await start()
    const res = await fetch(`${base}/api/stats`)
    expect(res.status).toBe(401)
    expect((await res.json()).login).toBe('/auth/login')
    expect(await (await fetch(`${base}/auth/mode`)).json()).toEqual({ oidc: true })
  })

  it('signs people in with the identity provider and gives roles by email and domain', async () => {
    await start()
    const member = await signIn('chidi@okafor.ng')
    expect(await (await fetch(`${base}/api/me`, { headers: { Cookie: member } })).json()).toEqual({ role: 'member', auth: true, user: 'chidi@okafor.ng' })
    expect((await fetch(`${base}/api/clear`, { method: 'DELETE', headers: { Cookie: member } })).status).toBe(403)
    const admin = await signIn('boss@okafor.ng')
    expect((await (await fetch(`${base}/api/me`, { headers: { Cookie: admin } })).json()).role).toBe('admin')
    expect(await signIn('auditor@external.com')).toMatch(/^duct_session=/)
    expect(await signIn('stranger@elsewhere.com')).toBe('status:403')
  })

  it('rejects a callback from another browser and a forged session', async () => {
    await start()
    const start1 = await fetch(`${base}/auth/login`, { redirect: 'manual' })
    const auth = new URL(start1.headers.get('location')!)
    nonces.set('c1', auth.searchParams.get('nonce')!)
    expect((await fetch(`${base}/auth/callback?code=c1&state=${auth.searchParams.get('state')}`, { redirect: 'manual' })).status).toBe(400)
    const forged = 'duct_session=' + Buffer.from(JSON.stringify({ e: 'boss@okafor.ng', r: 'admin', x: Date.now() + 1e6 })).toString('base64url') + '.bad'
    expect((await fetch(`${base}/api/stats`, { headers: { Cookie: forged } })).status).toBe(401)
  })
})

describe('Duct in your cloud: audit log', () => {
  it('records who did what, without search terms unless asked', async () => {
    await start()
    const member = await signIn('chidi@okafor.ng')
    const admin = await signIn('boss@okafor.ng')
    await fetch(`${base}/api/search?q=travel`, { headers: { Cookie: member } })
    const log = await (await fetch(`${base}/api/audit`, { headers: { Cookie: admin } })).json()
    expect(log.enabled).toBe(true)
    expect(log.entries.map((e: { actor: string; action: string }) => `${e.actor} ${e.action}`)).toEqual(['chidi@okafor.ng search', 'boss@okafor.ng signin', 'chidi@okafor.ng signin'])
    expect(JSON.stringify(log)).not.toContain('travel')
    expect((await fetch(`${base}/api/audit`, { headers: { Cookie: member } })).status).toBe(403)
    const csv = await (await fetch(`${base}/api/audit?format=csv`, { headers: { Cookie: admin } })).text()
    expect(csv).toContain('"chidi@okafor.ng","member","search"')
  })

  it('records search terms when the admin opted in', async () => {
    await start({ queries: true })
    const member = await signIn('chidi@okafor.ng')
    await fetch(`${base}/api/search?q=travel`, { headers: { Cookie: member } })
    expect(duct.auditLog()[0]).toMatchObject({ action: 'search', detail: 'travel' })
  })
})

describe('Duct in your cloud: results follow who may see each document', () => {
  const FILES = {
    'salaries.txt': 'Salary review: the payroll budget for 2027 rises by eight percent.',
    'board.txt': 'Board minutes: the payroll freeze ends. The lease expires on 20 October 2026.',
    'handbook.txt': 'Staff handbook: payroll is paid on the 25th.',
  }
  const get = (path: string, cookie: string) => fetch(`${base}${path}`, { headers: { Cookie: cookie } })
  const names = async (path: string, cookie: string) => ((await (await get(path, cookie)).json()).results as { chunk: { documentPath: string } }[]).map(r => r.chunk.documentPath.split('/').pop()).sort()

  it('searches, lists, opens and counts only what each person may see', async () => {
    await start({}, FILES)
    duct.setDocumentAccess(join(docs, 'salaries.txt'), ['user:boss@okafor.ng'])
    duct.setDocumentAccess(join(docs, 'board.txt'), ['user:chidi@okafor.ng', 'user:boss@okafor.ng'])
    duct.setDocumentAccess(join(docs, 'handbook.txt'), ['domain:okafor.ng'])
    const boss = await signIn('boss@okafor.ng')
    const chidi = await signIn('chidi@okafor.ng')
    const ada = await signIn('ada@okafor.ng')
    const auditor = await signIn('auditor@external.com')

    expect(await names('/api/search?q=payroll', boss)).toEqual(['board.txt', 'handbook.txt', 'salaries.txt'])
    expect(await names('/api/search?q=payroll', chidi)).toEqual(['board.txt', 'handbook.txt'])
    expect(await names('/api/search?q=payroll', ada)).toEqual(['handbook.txt'])
    expect(await names('/api/search?q=payroll', auditor)).toEqual([])
    expect(await names('/api/search?q=travel', auditor)).toEqual(['policy.txt'])   // no access list: everyone

    const listed = (await (await get('/api/documents', ada)).json()).documents.map((d: { path: string }) => d.path.split('/').pop()).sort()
    expect(listed).toEqual(['handbook.txt', 'policy.txt'])
    const salaries = encodeURIComponent(join(docs, 'salaries.txt'))
    expect((await get(`/api/file?path=${salaries}`, ada)).status).toBe(404)
    expect((await get(`/api/documents?path=${salaries}`, chidi)).status).toBe(404)
    expect((await get(`/api/file?path=${salaries}`, boss)).status).toBe(200)
    const exported = await fetch(`${base}/api/export`, { method: 'POST', headers: { Cookie: ada, 'Content-Type': 'application/json' }, body: JSON.stringify({ format: 'md', items: [{ path: join(docs, 'salaries.txt'), text: 'x' }] }) })
    expect(exported.status).toBe(404)

    const help = (await (await get('/api/search?q=zebra', ada)).json()).help
    expect(help.documents).toBe(2)
    const radar = await (await get('/api/deadlines?days=3650&pastDays=3650', ada)).json()
    expect([...radar.passed, ...radar.soon, ...radar.later]).toEqual([])
    const bossRadar = await (await get('/api/deadlines?days=3650&pastDays=3650', boss)).json()
    expect([...bossRadar.passed, ...bossRadar.soon, ...bossRadar.later].map((d: { name: string }) => d.name)).toEqual(['board.txt'])
  })

  it('member tokens carry no identity, so they only see documents open to everyone; the admin token sees all', async () => {
    await start({}, FILES, { authToken: 'admin-t', memberTokens: ['member-t'] })
    duct.setDocumentAccess(join(docs, 'salaries.txt'), ['user:boss@okafor.ng'])
    duct.setDocumentAccess(join(docs, 'handbook.txt'), ['anyone'])
    const search = async (t: string) => ((await (await fetch(`${base}/api/search?q=payroll`, { headers: { Authorization: `Bearer ${t}` } })).json()).results as { chunk: { documentPath: string } }[]).map(r => r.chunk.documentPath.split('/').pop()).sort()
    expect(await search('member-t')).toEqual(['board.txt', 'handbook.txt'])
    expect(await search('admin-t')).toEqual(['board.txt', 'handbook.txt', 'salaries.txt'])
  })
})
