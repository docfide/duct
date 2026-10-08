import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duct } from '../src/index.js'
import { createServer } from '../src/server.js'
import { Telemetry, range, smallRange, dayRange, DEFAULT_ON } from '../src/telemetry.js'
import { FileAccountStorage, MemoryAccountStorage, TensflareAccount } from '../src/account.js'

const work = mkdtempSync(join(tmpdir(), 'duct-acct-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))
const DAY = 86_400_000

describe('usage counts', () => {
  let duct: Duct
  beforeAll(async () => {
    // A library full of things that must never leave the machine.
    const dir = join(work, 'Confidential Okafor Matter')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settlement-zebrafinch.txt'), 'The settlement with Quillbright Holdings is 4,750,000 naira.')
    writeFileSync(join(dir, 'board-minutes.md'), '# Minutes\n\nThe board discussed the xylophone acquisition.')
    writeFileSync(join(dir, 'broken.pdf'), 'not really a pdf')
    duct = new Duct({ embed: false })
    await duct.index(dir)
    await duct.search('Quillbright settlement')
  })
  afterAll(() => duct.close())
  const make = (over: Partial<ConstructorParameters<typeof Telemetry>[0]> = {}) =>
    new Telemetry({ dir: mkdtempSync(join(work, 't-')), channel: 'desktop', duct, env: {}, region: 'NG', ...over })

  it('uses ranges, never exact numbers', () => {
    expect([0, 1, 10, 11, 1000, 1001, 20000].map(range)).toEqual(['0', '1-10', '1-10', '11-100', '101-1000', '1001-10000', '10000+'])
    expect([0, 1, 3, 9, 50].map(smallRange)).toEqual(['0', '1', '2-5', '6-20', '21+'])
    expect([0, 3, 20, 60, 200, 900].map(dayRange)).toEqual(['0', '1-7', '8-30', '31-90', '91-365', '365+'])
  })

  it('is off until switched on (launch default), and off means no request at all', async () => {
    expect(DEFAULT_ON).toBe(false)
    let calls = 0
    const t = make({ fetch: (async () => { calls++; return new Response(null, { status: 204 }) }) as typeof fetch })
    expect(t.enabled()).toBe(false)
    t.record('searches')
    expect(await t.maybeSend()).toBe('off')
    expect(calls).toBe(0)
  })

  it('never contains file names, paths, folder names or words from the documents', () => {
    const t = make()
    t.setEnabled(true)
    const report = t.report()!
    const text = JSON.stringify(report)
    for (const secret of ['Confidential', 'Okafor', 'zebrafinch', 'settlement', 'Quillbright', '4,750,000', '4750000', 'board-minutes', 'xylophone', 'broken', work, tmpdir()]) {
      expect(text, secret).not.toContain(secret)
    }
    expect(report).toMatchObject({ schema: 1, event: 'install', channel: 'desktop', plan: 'free', documents: '1-10', formats: ['md', 'txt'], sources: { watched: '0', library: false, web: false }, errors: { 'extract_failed.pdf': '1-10' } })
    expect(report.install_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(Object.keys(report).sort()).toEqual(['activity', 'app_version', 'arch', 'channel', 'day', 'days_since_install', 'documents', 'errors', 'event', 'formats', 'install_id', 'language', 'os', 'os_version', 'plan', 'schema', 'settings', 'sources'].sort())
  })

  it('reports the previous day’s activity and sends at most once a day, dropping failures', async () => {
    let now = Date.parse('2026-10-08T10:00:00Z')
    const bodies: string[] = []
    let fail = false
    const t = make({ now: () => now, fetch: (async (_u: unknown, init?: RequestInit) => { bodies.push(String(init?.body)); if (fail) throw new Error('offline'); return new Response(null, { status: 204 }) }) as typeof fetch })
    t.setEnabled(true)
    for (let i = 0; i < 12; i++) t.record('searches')
    t.record('opens')
    expect(await t.maybeSend()).toBe('sent')
    expect(await t.maybeSend()).toBe('already')
    now += DAY
    const r = JSON.parse((t.report() && JSON.stringify(t.report()))!)
    expect(r.activity).toEqual({ searches: '11-100', opens: '1-10', ask: '0', ocr: '0' })
    expect(r.event).toBe('daily')
    fail = true
    expect(await t.maybeSend()).toBe('failed')
    expect(await t.maybeSend()).toBe('already')
    expect(bodies).toHaveLength(2)
  })

  it('respects DO_NOT_TRACK and DUCT_TELEMETRY=0 over the setting', () => {
    for (const env of [{ DO_NOT_TRACK: '1' }, { DUCT_TELEMETRY: '0' }, { CI: 'true' }]) {
      const t = make({ env })
      t.setEnabled(true)
      expect(t.enabled(), JSON.stringify(env)).toBe(false)
      expect(t.blockedBy()).toBeTruthy()
    }
  })

  it('asks first in the EU, and starts a new install id when switched back on', () => {
    const eu = make({ region: 'DE' })
    expect(eu.needsConsent()).toBe(true)
    expect(eu.enabled()).toBe(false)
    const t = make()
    t.setEnabled(true)
    const first = t.report()!.install_id
    t.setEnabled(false)
    t.setEnabled(true)
    expect(t.report()!.install_id).not.toBe(first)
  })
})

// ---------- a fake Tensflare Accounts service ----------

function fakeAccounts() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const kid = 'test-key'
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig' }
  const jwt = (claims: object) => {
    const h = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid })).toString('base64url')
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return `${h}.${p}.${sign(null, Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`
  }
  const state = { plan: 'pro', refresh: new Set<string>(), revoked: [] as string[], challenge: '', issued: 0, ttl: 30 * DAY / 1000 }
  let base = ''
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, base)
    let body = ''
    for await (const chunk of req) body += chunk
    const form = new URLSearchParams(body)
    const json = (status: number, data: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    if (url.pathname === '/oauth/authorize') {
      // A real service shows the sign-in pages; this one signs straight in.
      state.challenge = url.searchParams.get('code_challenge')!
      const back = new URL(url.searchParams.get('redirect_uri')!)
      back.searchParams.set('code', 'the-code')
      back.searchParams.set('state', url.searchParams.get('state')!)
      back.searchParams.set('iss', base)
      res.writeHead(303, { Location: back.toString() }).end()
    } else if (url.pathname === '/oauth/token') {
      const ok = form.get('grant_type') === 'authorization_code'
        ? form.get('code') === 'the-code' && createHash('sha256').update(form.get('code_verifier')!).digest('base64url') === state.challenge
        : state.refresh.delete(form.get('refresh_token')!)
      if (!ok) return json(400, { error: 'invalid_grant' })
      const refresh = `r${++state.issued}`
      state.refresh.add(refresh)
      json(200, { access_token: 'access', refresh_token: refresh, token_type: 'Bearer', expires_in: 3600 })
    } else if (url.pathname === '/oauth/revoke') {
      state.revoked.push(form.get('token')!)
      state.refresh.delete(form.get('token')!)
      res.writeHead(200).end()
    } else if (url.pathname === '/.well-known/jwks.json') {
      json(200, { keys: [jwk] })
    } else if (url.pathname === '/v1/me') {
      json(200, { id: 'acct_1', email: 'ada@example.com' })
    } else if (url.pathname === '/v1/entitlements') {
      const iat = Math.floor(Date.now() / 1000)
      json(200, { token: jwt({ iss: base, aud: 'duct-desktop', sub: 'acct_1', plan: state.plan, entitlements: state.plan === 'pro' ? ['ai.hosted', 'sync.devices'] : [], limits: { 'sync.devices': 3 }, iat, exp: iat + state.ttl }), refresh_after: new Date(Date.now() + 6 * 3600_000).toISOString() })
    } else json(404, {})
  })
  return {
    state,
    jwt,
    async start() {
      server.listen(0, '127.0.0.1')
      await new Promise(r => server.once('listening', r))
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      return base
    },
    close: () => server.close(),
  }
}

/** Plays the browser: follows the sign-in page's redirect back to Duct's loopback listener. */
const browser = async (url: string) => { await fetch(url) }

describe('Sign in with Tensflare', () => {
  const fake = fakeAccounts()
  let base: string
  beforeAll(async () => { base = await fake.start() })
  afterAll(() => fake.close())
  const account = (storage = new MemoryAccountStorage(), now?: () => number) => new TensflareAccount({ storage, accountsUrl: base, apiUrl: base, openUrl: browser, now })

  it('is free and signed out by default', () => {
    expect(account().status()).toEqual({ signedIn: false, plan: 'free', entitlements: [], limits: {} })
  })

  it('signs in with PKCE through a loopback redirect and checks the entitlement signature', async () => {
    const a = account()
    const s = await a.signIn({ deviceName: 'test' })
    expect(s).toMatchObject({ signedIn: true, email: 'ada@example.com', plan: 'pro', entitlements: ['ai.hosted', 'sync.devices'] })
    expect(a.has('ai.hosted')).toBe(true)
    expect(s.expiresAt! - Date.now()).toBeGreaterThan(29 * DAY)
  })

  it('keeps paid features offline until the entitlement expires, then asks to reconnect', async () => {
    let now = Date.now()
    const storage = new MemoryAccountStorage()
    const a = account(storage, () => now)
    await a.signIn()
    now += 29 * DAY
    expect(a.status().plan).toBe('pro')
    now += 2 * DAY
    expect(a.status()).toMatchObject({ signedIn: true, plan: 'free', needsReconnect: true })
  })

  it('rejects an entitlement that was tampered with', async () => {
    const storage = new MemoryAccountStorage()
    const a = account(storage)
    await a.signIn()
    const s = storage.load()!
    const [h, , sig] = s.entitlement!.split('.')
    const forged = Buffer.from(JSON.stringify({ iss: base, aud: 'duct-desktop', plan: 'enterprise', entitlements: ['enterprise.byoc'], exp: 9999999999 })).toString('base64url')
    storage.save({ ...s, entitlement: `${h}.${forged}.${sig}` })
    expect(a.status()).toMatchObject({ plan: 'free', needsReconnect: true })
  })

  it('rotates the refresh token, and signs out when the session was revoked', async () => {
    const storage = new MemoryAccountStorage()
    const a = account(storage)
    await a.signIn()
    const first = storage.load()!.refreshToken
    fake.state.plan = 'free'
    expect((await a.refresh(true)).plan).toBe('free')
    expect(storage.load()!.refreshToken).not.toBe(first)
    fake.state.refresh.clear()
    expect((await a.refresh(true)).signedIn).toBe(false)
    fake.state.plan = 'pro'
  })

  it('revokes the session on sign out', async () => {
    const storage = new MemoryAccountStorage()
    const a = account(storage)
    await a.signIn()
    const token = storage.load()!.refreshToken
    await a.signOut()
    expect(fake.state.revoked).toContain(token)
    expect(a.status().signedIn).toBe(false)
  })

  it('keeps the CLI session in a file only this user can read', async () => {
    const path = join(work, 'cli', 'account.json')
    const a = account(new FileAccountStorage(path) as unknown as MemoryAccountStorage)
    await a.signIn()
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf-8')).toContain('refreshToken')
  })

  it('is driven from the app through /api/account', async () => {
    const duct = new Duct({ embed: false })
    const a = account()
    const server = createServer(duct, { account: a }).listen(0, '127.0.0.1')
    await new Promise(r => server.once('listening', r))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      expect(await (await fetch(`${url}/api/account`)).json()).toMatchObject({ available: true, signedIn: false })
      expect((await fetch(`${url}/api/account/signin`, { method: 'POST' })).status).toBe(202)
      let status: { signedIn?: boolean } = {}
      for (let i = 0; i < 50 && !status.signedIn; i++) { await new Promise(r => setTimeout(r, 20)); status = await (await fetch(`${url}/api/account`)).json() }
      expect(status).toMatchObject({ signedIn: true, plan: 'pro', email: 'ada@example.com' })
      await fetch(`${url}/api/account/signout`, { method: 'POST' })
      expect((await (await fetch(`${url}/api/account`)).json()).signedIn).toBe(false)
    } finally {
      server.close()
      duct.close()
    }
  })
})
