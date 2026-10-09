// Copyright Tensflare Ltd. Licensed under the Elastic License 2.0; see src/team/LICENSE.
// OAuth 2.0 for native apps (RFC 8252): the system browser, a one-request loopback listener and PKCE.
// Used by the connectors (Google Drive, Microsoft OneDrive and SharePoint) to get read-only tokens.
// A server in the cloud uses a WebCallback instead: the provider redirects to <public-url>/connectors/callback.

import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const PAGE = (title: string, text: string) => `<!doctype html><meta charset="utf-8"><title>Duct</title>
<style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;background:#0c0c0b;color:#f2f2ee}p{color:#a3a39c}</style>
<div><h1>${title}</h1><p>${text}</p></div>`

export interface LoopbackResult { code: string; redirectUri: string; verifier: string }

type Outcome = { code?: string; error?: string }

/** Receives the provider's redirect on a public server, for sign-ins started in someone else's browser. */
export class WebCallback {
  private waiting = new Map<string, (r: Outcome) => void>()
  readonly redirectUri: string
  constructor(publicUrl: string) { this.redirectUri = `${publicUrl.replace(/\/+$/, '')}/connectors/callback` }

  wait(state: string): Promise<Outcome> {
    return new Promise(resolve => this.waiting.set(state, r => { this.waiting.delete(state); resolve(r) }))
  }

  cancel(state: string, error: string): void { this.waiting.get(state)?.({ error }) }

  /** Handles GET /connectors/callback; false when the state isn't one we're waiting for. */
  complete(query: URLSearchParams): boolean {
    const done = this.waiting.get(query.get('state') ?? '')
    if (!done) return false
    const code = query.get('code')
    done(code ? { code } : { error: query.get('error_description') || query.get('error') || 'Authorization failed' })
    return !!code
  }
}

export const callbackPage = (ok: boolean) => ok
  ? PAGE('Connected to Duct', 'Duct is reading this source now. <a style="color:#a3e635" href="/">Back to Duct</a>')
  : PAGE('That didn’t work', 'Go back to Duct and try again. <a style="color:#a3e635" href="/">Back to Duct</a>')

/** Opens `authorizeUrl` (with PKCE, state and a loopback redirect added) and waits for the browser to come back. */
export async function loopbackAuthorize(opts: {
  authorizeUrl: string
  params: Record<string, string>
  openUrl: (url: string) => void | Promise<void>
  timeoutMs?: number
  web?: WebCallback
}): Promise<LoopbackResult> {
  const verifier = randomBytes(32).toString('base64url')
  const state = randomBytes(16).toString('base64url')
  if (opts.web) {
    const web = opts.web
    const result = web.wait(state)
    const timer = setTimeout(() => web.cancel(state, 'Timed out waiting for the browser'), opts.timeoutMs ?? 10 * 60_000)
    try {
      const url = new URL(opts.authorizeUrl)
      for (const [k, v] of Object.entries({ ...opts.params, redirect_uri: web.redirectUri, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', response_type: 'code' })) url.searchParams.set(k, v)
      await opts.openUrl(url.toString())
      const r = await result
      if (r.error || !r.code) throw new Error(r.error ?? 'Authorization failed')
      return { code: r.code, redirectUri: web.redirectUri, verifier }
    } finally {
      clearTimeout(timer)
    }
  }
  let finish!: (r: { code?: string; error?: string }) => void
  const result = new Promise<{ code?: string; error?: string }>(resolve => { finish = resolve })
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') { res.writeHead(404).end(); return }
    const ok = url.searchParams.get('state') === state && !!url.searchParams.get('code')
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" })
    res.end(ok ? PAGE('Connected to Duct', 'You can close this tab and go back to Duct.') : PAGE('That didn’t work', 'Close this tab and try again from Duct.'))
    finish(ok ? { code: url.searchParams.get('code')! } : { error: url.searchParams.get('error_description') || url.searchParams.get('error') || 'The response did not match' })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()) })
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`
  const timer = setTimeout(() => finish({ error: 'Timed out waiting for the browser' }), opts.timeoutMs ?? 5 * 60_000)
  try {
    const url = new URL(opts.authorizeUrl)
    for (const [k, v] of Object.entries({ ...opts.params, redirect_uri: redirectUri, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', response_type: 'code' })) url.searchParams.set(k, v)
    await opts.openUrl(url.toString())
    const r = await result
    if (r.error || !r.code) throw new Error(r.error ?? 'Authorization failed')
    return { code: r.code, redirectUri, verifier }
  } finally {
    clearTimeout(timer)
    server.close()
  }
}

/** POSTs a form to a token endpoint and returns the JSON, throwing with the provider's message on failure. */
export async function tokenRequest(fetchImpl: typeof fetch, url: string, form: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form), signal: AbortSignal.timeout(20_000) })
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok || typeof body['access_token'] !== 'string') {
    throw Object.assign(new Error(String(body['error_description'] ?? body['error'] ?? `Token request failed (HTTP ${res.status})`)), { oauth: body['error'] })
  }
  return body as { access_token: string; refresh_token?: string; expires_in?: number }
}
