// Copyright Tensflare Ltd. Licensed under the Elastic License 2.0; see src/team/LICENSE.
// Sign-in for a shared Duct server with the organisation's own identity provider (OpenID Connect: Google
// Workspace, Microsoft Entra ID, Okta, Tensflare…), instead of handing out tokens. People sign in in the
// browser; admins and members are decided by email and domain. Sessions are HMAC-signed cookies.

import express from 'express'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export interface OidcOptions {
  /** The provider's issuer URL, e.g. https://login.microsoftonline.com/<tenant-id>/v2.0 or https://accounts.google.com */
  issuer: string
  clientId: string
  clientSecret: string
  /** This server's public address, e.g. https://duct.example.com; the callback is <publicUrl>/auth/callback. */
  publicUrl: string
  /** Emails that get the admin role. */
  admins: string[]
  /** Email domains whose people may sign in as members (e.g. "example.com"). */
  allowDomains: string[]
  /** Individual emails that may sign in as members. */
  allowEmails: string[]
  /** Signs session cookies. Set it so sessions survive restarts (DUCT_SESSION_SECRET). */
  sessionSecret: string
  sessionHours?: number
}

export interface SessionUser { email: string; role: 'admin' | 'member' }

const SESSION_COOKIE = 'duct_session'
const STATE_COOKIE = 'duct_oidc'

const b64 = (v: string | Buffer) => Buffer.from(v).toString('base64url')
const readCookie = (header: string | undefined, name: string) => {
  for (const part of (header ?? '').split(';')) { const [k, ...v] = part.trim().split('='); if (k === name) return decodeURIComponent(v.join('=')) }
  return undefined
}

export class OidcLogin {
  private meta: { authorization_endpoint: string; token_endpoint: string; issuer: string } | null = null
  private pending = new Map<string, { nonce: string; verifier: string; next: string; expires: number }>()
  private fetchImpl: typeof fetch

  constructor(readonly opts: OidcOptions, fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? fetch
    this.opts.admins = opts.admins.map(e => e.toLowerCase())
    this.opts.allowEmails = opts.allowEmails.map(e => e.toLowerCase())
    this.opts.allowDomains = opts.allowDomains.map(d => d.toLowerCase().replace(/^@/, ''))
  }

  private get secure() { return this.opts.publicUrl.startsWith('https://') }
  private get callback() { return `${this.opts.publicUrl.replace(/\/+$/, '')}/auth/callback` }

  roleFor(email: string): SessionUser['role'] | null {
    const e = email.toLowerCase()
    if (this.opts.admins.includes(e)) return 'admin'
    if (this.opts.allowEmails.includes(e) || this.opts.allowDomains.includes(e.split('@')[1] ?? '')) return 'member'
    return null
  }

  private async discover() {
    if (this.meta) return this.meta
    const res = await this.fetchImpl(`${this.opts.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`Couldn’t read the identity provider’s configuration (HTTP ${res.status})`)
    const m = await res.json() as { authorization_endpoint: string; token_endpoint: string; issuer: string }
    if (!m.authorization_endpoint || !m.token_endpoint) throw new Error('The identity provider’s configuration is incomplete')
    this.meta = m
    return m
  }

  // ---------- sessions ----------

  private sign(payload: string) { return createHmac('sha256', this.opts.sessionSecret).update(payload).digest('base64url') }

  issueSession(res: express.Response, user: SessionUser): void {
    const payload = b64(JSON.stringify({ e: user.email, r: user.role, x: Date.now() + (this.opts.sessionHours ?? 12) * 3600_000 }))
    res.cookie(SESSION_COOKIE, `${payload}.${this.sign(payload)}`, { httpOnly: true, sameSite: 'lax', secure: this.secure, path: '/', maxAge: (this.opts.sessionHours ?? 12) * 3600_000 })
  }

  /** The signed-in person, if the cookie is valid, unexpired, and they're still allowed. */
  session(req: express.Request): SessionUser | null {
    const raw = readCookie(req.headers.cookie, SESSION_COOKIE)
    if (!raw) return null
    const [payload, sig] = raw.split('.')
    if (!payload || !sig) return null
    const expected = this.sign(payload)
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
    try {
      const s = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { e: string; r: string; x: number }
      if (s.x < Date.now()) return null
      // Roles are re-checked on every request, so removing someone from the lists takes effect at once.
      const role = this.roleFor(s.e)
      return role ? { email: s.e, role } : null
    } catch { return null }
  }

  // ---------- routes: /auth/login, /auth/callback, /auth/logout, /auth/mode ----------

  router(onLogin?: (user: SessionUser) => void): express.Router {
    const r = express.Router()
    r.get('/mode', (_req, res) => { res.json({ oidc: true }) })

    r.get('/login', async (req, res) => {
      try {
        const m = await this.discover()
        const state = randomBytes(24).toString('base64url')
        const nonce = randomBytes(16).toString('base64url')
        const verifier = randomBytes(32).toString('base64url')
        const next = typeof req.query['next'] === 'string' && /^\/(?!\/)/.test(req.query['next']) ? req.query['next'] : '/'
        for (const [k, v] of this.pending) if (v.expires < Date.now()) this.pending.delete(k)
        this.pending.set(state, { nonce, verifier, next, expires: Date.now() + 10 * 60_000 })
        res.cookie(STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax', secure: this.secure, path: '/auth', maxAge: 10 * 60_000 })
        const url = new URL(m.authorization_endpoint)
        for (const [k, v] of Object.entries({ response_type: 'code', client_id: this.opts.clientId, redirect_uri: this.callback, scope: 'openid email profile', state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) url.searchParams.set(k, v)
        res.redirect(303, url.toString())
      } catch (err) {
        res.status(502).type('text').send(`Sign-in is unavailable: ${(err as Error).message}`)
      }
    })

    r.get('/callback', async (req, res) => {
      const state = typeof req.query['state'] === 'string' ? req.query['state'] : ''
      const pending = this.pending.get(state)
      this.pending.delete(state)
      const fail = (msg: string, status = 400) => res.status(status).type('html').send(`<!doctype html><meta charset="utf-8"><title>Duct</title><body style="font:16px system-ui;padding:40px;background:#0c0c0b;color:#f2f2ee"><h1>Sign-in didn’t finish</h1><p>${msg.replace(/[<>&]/g, '')}</p><p><a style="color:#a3e635" href="/auth/login">Try again</a></p>`)
      if (!pending || pending.expires < Date.now() || readCookie(req.headers.cookie, STATE_COOKIE) !== state) return fail('This sign-in expired or was started in another browser.')
      if (typeof req.query['error'] === 'string' || typeof req.query['code'] !== 'string') return fail('The identity provider didn’t sign you in.')
      try {
        const m = await this.discover()
        const tr = await this.fetchImpl(m.token_endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(15_000),
          body: new URLSearchParams({ grant_type: 'authorization_code', code: req.query['code'], redirect_uri: this.callback, client_id: this.opts.clientId, client_secret: this.opts.clientSecret, code_verifier: pending.verifier }),
        })
        const body = await tr.json().catch(() => ({})) as { id_token?: string }
        if (!tr.ok || !body.id_token) return fail('The identity provider didn’t complete the sign-in.', 502)
        // The ID token came straight from the token endpoint over TLS (OIDC Core 3.1.3.7): check its claims.
        const claims = JSON.parse(Buffer.from(body.id_token.split('.')[1] ?? '', 'base64url').toString()) as Record<string, unknown>
        const aud = Array.isArray(claims['aud']) ? claims['aud'] : [claims['aud']]
        if (claims['iss'] !== m.issuer || !aud.includes(this.opts.clientId) || claims['nonce'] !== pending.nonce || typeof claims['exp'] !== 'number' || claims['exp'] * 1000 < Date.now() - 60_000) {
          return fail('The sign-in token didn’t check out.')
        }
        const email = String(claims['email'] ?? claims['preferred_username'] ?? '').toLowerCase()
        if (!email.includes('@') || claims['email_verified'] === false) return fail('Your identity provider didn’t share a verified email address.')
        const role = this.roleFor(email)
        if (!role) return fail(`${email} isn’t allowed on this Duct server. Ask its admin to add you.`, 403)
        res.clearCookie(STATE_COOKIE, { path: '/auth' })
        this.issueSession(res, { email, role })
        onLogin?.({ email, role })
        res.redirect(303, pending.next)
      } catch (err) {
        fail(`Sign-in failed: ${(err as Error).message}`, 502)
      }
    })

    r.post('/logout', (_req, res) => {
      res.clearCookie(SESSION_COOKIE, { path: '/' })
      res.json({ ok: true })
    })
    return r
  }
}
