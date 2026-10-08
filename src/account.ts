// "Sign in with Tensflare": optional accounts for paid features (see the Duct Accounts and Telemetry Spec).
// Everything local works signed out. Signing in runs OAuth 2.0 with PKCE in the system browser and a
// one-request loopback listener (RFC 8252); Duct never sees a password. The entitlement is an Ed25519-signed
// token that keeps paid features working offline until it expires (30 days).

import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { hostname } from 'node:os'
import { dirname } from 'node:path'

export const CLIENT_ID = 'duct-desktop'
const ENTITLEMENT_AUDIENCE = 'duct-desktop'

export interface AccountState {
  refreshToken: string
  email?: string
  accountId?: string
  /** Signed entitlement JWT and when to ask for a fresh one. */
  entitlement?: string
  refreshAfter?: number
  /** Public keys from the JWKS, so the entitlement can be checked offline. */
  jwks?: { keys: Record<string, unknown>[] }
  signedInAt: number
}

/** Where the account's tokens are kept: the system keychain in the desktop app, a private file elsewhere. */
export interface AccountStorage {
  load(): AccountState | null
  save(state: AccountState | null): void
}

/** A file only the current user can read (mode 0600). Used by the command line and `duct serve`. */
export class FileAccountStorage implements AccountStorage {
  constructor(private path: string) {}
  load(): AccountState | null {
    try { return existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf-8')) : null } catch { return null }
  }
  save(state: AccountState | null): void {
    if (!state) { rmSync(this.path, { force: true }); return }
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(state), { mode: 0o600 })
    try { chmodSync(this.path, 0o600) } catch {}
  }
}

export class MemoryAccountStorage implements AccountStorage {
  private state: AccountState | null = null
  load() { return this.state }
  save(state: AccountState | null) { this.state = state }
}

export type Plan = 'free' | 'pro' | 'team' | 'enterprise'

export interface AccountStatus {
  signedIn: boolean
  email?: string
  plan: Plan
  entitlements: string[]
  limits: Record<string, number>
  /** When the cached entitlement stops working offline (ms). */
  expiresAt?: number
  /** Signed in, but the entitlement has expired or failed its check: paid features are paused. */
  needsReconnect?: boolean
}

export interface AccountOptions {
  storage: AccountStorage
  /** https://accounts.tensflare.com (sign-in, tokens, keys). */
  accountsUrl?: string
  /** https://api.tensflare.com (profile and entitlements). */
  apiUrl?: string
  /** Opens the sign-in page in the system browser. */
  openUrl?: (url: string) => void | Promise<void>
  fetch?: typeof fetch
  now?: () => number
}

const b64url = (b: Buffer) => b.toString('base64url')

/** Checks an EdDSA JWT against a JWKS. Returns its claims, or null if the signature, issuer or audience is wrong. */
export function verifyJwt(token: string, jwks: { keys: Record<string, unknown>[] }, expect: { iss: string; aud: string }): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString())
    if (header.alg !== 'EdDSA') return null
    const jwk = jwks.keys.find(k => k['kid'] === header.kid)
    if (!jwk) return null
    const key = createPublicKey({ key: jwk as import('node:crypto').JsonWebKey, format: 'jwk' })
    if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) return null
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
    if (claims.iss !== expect.iss || claims.aud !== expect.aud) return null
    return claims
  } catch {
    return null
  }
}

const SIGNED_IN_PAGE = `<!doctype html><meta charset="utf-8"><title>Duct</title>
<style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;background:#0c0c0b;color:#f2f2ee}p{color:#a3a39c}</style>
<div><h1>You're signed in to Duct</h1><p>You can close this tab and go back to Duct.</p></div>`
const FAILED_PAGE = `<!doctype html><meta charset="utf-8"><title>Duct</title>
<style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;background:#0c0c0b;color:#f2f2ee}p{color:#a3a39c}</style>
<div><h1>Sign-in didn't finish</h1><p>Close this tab and try again from Duct.</p></div>`

export class TensflareAccount {
  readonly accountsUrl: string
  readonly apiUrl: string
  private storage: AccountStorage
  private openUrl?: AccountOptions['openUrl']
  private fetchImpl: typeof fetch
  private now: () => number
  private pending: Promise<AccountStatus> | null = null

  constructor(opts: AccountOptions) {
    this.accountsUrl = (opts.accountsUrl ?? process.env['DUCT_ACCOUNTS_URL'] ?? 'https://accounts.tensflare.com').replace(/\/+$/, '')
    this.apiUrl = (opts.apiUrl ?? process.env['DUCT_API_URL'] ?? 'https://api.tensflare.com').replace(/\/+$/, '')
    this.storage = opts.storage
    this.openUrl = opts.openUrl
    this.fetchImpl = opts.fetch ?? fetch
    this.now = opts.now ?? Date.now
  }

  /** What this install may use, checked offline from the cached entitlement. */
  status(): AccountStatus {
    const state = this.storage.load()
    const free: AccountStatus = { signedIn: false, plan: 'free', entitlements: [], limits: {} }
    if (!state) return free
    const signedIn = { ...free, signedIn: true, ...(state.email ? { email: state.email } : {}) }
    const claims = state.entitlement && state.jwks ? verifyJwt(state.entitlement, state.jwks, { iss: this.accountsUrl, aud: ENTITLEMENT_AUDIENCE }) : null
    if (!claims) return { ...signedIn, needsReconnect: !!state.entitlement }
    const expiresAt = Number(claims['exp']) * 1000
    if (!(expiresAt > this.now())) return { ...signedIn, expiresAt, needsReconnect: true }
    const plan = (['pro', 'team', 'enterprise'].includes(String(claims['plan'])) ? claims['plan'] : 'free') as Plan
    return {
      ...signedIn,
      plan,
      entitlements: Array.isArray(claims['entitlements']) ? (claims['entitlements'] as unknown[]).filter((e): e is string => typeof e === 'string') : [],
      limits: (typeof claims['limits'] === 'object' && claims['limits'] !== null ? claims['limits'] : {}) as Record<string, number>,
      expiresAt,
    }
  }

  has(entitlement: string): boolean {
    return this.status().entitlements.includes(entitlement)
  }

  /**
   * Opens the sign-in page and waits (up to `timeoutMs`) for the browser to come back. Only one sign-in runs at
   * a time; a second call joins the first.
   */
  signIn(options: { deviceName?: string; timeoutMs?: number } = {}): Promise<AccountStatus> {
    this.pending ??= this.runSignIn(options).finally(() => { this.pending = null })
    return this.pending
  }

  private async runSignIn({ deviceName = hostname().slice(0, 60), timeoutMs = 5 * 60_000 }: { deviceName?: string; timeoutMs?: number }): Promise<AccountStatus> {
    if (!this.openUrl) throw new Error('No way to open a browser here')
    const verifier = b64url(randomBytes(32))
    const challenge = b64url(createHash('sha256').update(verifier).digest())
    const state = b64url(randomBytes(16))

    // Listen on a random loopback port for exactly one callback.
    let finish!: (r: { code?: string; error?: string }) => void
    const result = new Promise<{ code?: string; error?: string }>(resolve => { finish = resolve })
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return }
      const ok = url.searchParams.get('state') === state && !!url.searchParams.get('code') &&
        (!url.searchParams.get('iss') || url.searchParams.get('iss') === this.accountsUrl)
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" })
      res.end(ok ? SIGNED_IN_PAGE : FAILED_PAGE)
      finish(ok ? { code: url.searchParams.get('code')! } : { error: url.searchParams.get('error_description') || url.searchParams.get('error') || 'The sign-in response did not match' })
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()) })
    const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`
    const timer = setTimeout(() => finish({ error: 'Sign-in timed out' }), timeoutMs)
    try {
      const authorize = new URL(`${this.accountsUrl}/oauth/authorize`)
      for (const [k, v] of Object.entries({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state, scope: 'profile entitlements offline_access', device_name: deviceName })) {
        authorize.searchParams.set(k, v)
      }
      await this.openUrl(authorize.toString())
      const r = await result
      if (r.error || !r.code) throw new Error(r.error ?? 'Sign-in failed')

      const tokens = await this.token({ grant_type: 'authorization_code', code: r.code, code_verifier: verifier, redirect_uri: redirectUri })
      const fresh: AccountState = { refreshToken: tokens.refresh_token, signedInAt: this.now() }
      await this.loadProfile(fresh, tokens.access_token)
      this.storage.save(fresh)
      return this.status()
    } finally {
      clearTimeout(timer)
      server.close()
    }
  }

  /** Revokes the session on the server (best effort) and forgets it here. Local features are unaffected. */
  async signOut(): Promise<void> {
    const state = this.storage.load()
    this.storage.save(null)
    if (!state) return
    try {
      await this.fetchImpl(`${this.accountsUrl}/oauth/revoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: state.refreshToken, client_id: CLIENT_ID }), signal: AbortSignal.timeout(10_000),
      })
    } catch {}
  }

  /**
   * Fetches a fresh entitlement when the cached one is due (or `force`). Offline, the cached one keeps
   * working until it expires. A revoked session signs out.
   */
  async refresh(force = false): Promise<AccountStatus> {
    const state = this.storage.load()
    if (!state) return this.status()
    if (!force && state.refreshAfter && state.refreshAfter > this.now()) return this.status()
    let tokens: { access_token: string; refresh_token: string }
    try {
      tokens = await this.token({ grant_type: 'refresh_token', refresh_token: state.refreshToken })
    } catch (err) {
      if ((err as { oauth?: string }).oauth === 'invalid_grant') this.storage.save(null)
      return this.status()
    }
    // The old refresh token is now spent: save the new one before anything else can fail.
    const next: AccountState = { ...state, refreshToken: tokens.refresh_token }
    this.storage.save(next)
    try {
      await this.loadProfile(next, tokens.access_token)
      this.storage.save(next)
    } catch {}
    return this.status()
  }

  private async token(params: Record<string, string>): Promise<{ access_token: string; refresh_token: string }> {
    const res = await this.fetchImpl(`${this.accountsUrl}/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, ...params }), signal: AbortSignal.timeout(15_000),
    })
    const body = await res.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; error?: string; error_description?: string }
    if (!res.ok || !body.access_token || !body.refresh_token) {
      throw Object.assign(new Error(body.error_description || body.error || `Sign-in failed (HTTP ${res.status})`), { oauth: body.error })
    }
    return { access_token: body.access_token, refresh_token: body.refresh_token }
  }

  /** Fills in email, keys and the signed entitlement, checking its signature before keeping it. */
  private async loadProfile(state: AccountState, accessToken: string): Promise<void> {
    const get = async (url: string, auth = true) => {
      const res = await this.fetchImpl(url, { headers: auth ? { Authorization: `Bearer ${accessToken}` } : {}, signal: AbortSignal.timeout(15_000) })
      if (!res.ok) throw new Error(`${url} answered ${res.status}`)
      return res.json() as Promise<Record<string, unknown>>
    }
    const [jwks, me, ent] = await Promise.all([get(`${this.accountsUrl}/.well-known/jwks.json`, false), get(`${this.apiUrl}/v1/me`), get(`${this.apiUrl}/v1/entitlements`)])
    const keys = jwks as { keys: Record<string, unknown>[] }
    if (typeof ent['token'] !== 'string' || !verifyJwt(ent['token'], keys, { iss: this.accountsUrl, aud: ENTITLEMENT_AUDIENCE })) {
      throw new Error('The entitlement from Tensflare failed its signature check')
    }
    state.jwks = keys
    state.entitlement = ent['token']
    state.refreshAfter = typeof ent['refresh_after'] === 'string' ? Date.parse(ent['refresh_after']) : this.now() + 6 * 3600_000
    if (typeof me['email'] === 'string') state.email = me['email']
    if (typeof me['id'] === 'string') state.accountId = me['id']
  }
}
