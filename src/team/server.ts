// Copyright Tensflare Ltd. Licensed under the Elastic License 2.0; see src/team/LICENSE.
// You may not move, change, disable or circumvent the licence checks in this file, or remove or obscure the
// functionality they protect.
//
// Duct's team features on the server: sign-in (OIDC), the audit log, connectors, notebook sharing and public
// links. The core server (src/server.ts, Apache 2.0) calls `teamServer()` and mounts its routes with a few
// helpers; everything here is behind the licence check in ./licence.ts. Without these routes Duct is a complete
// search app for one person.

import type express from 'express'
import rateLimit from 'express-rate-limit'
import type { Duct, Notebook } from '../index.js'
import type { TensflareAccount } from '../account.js'
import type { DocumentFormat } from '../types.js'
import type { NotebookRole } from '../notebooks.js'
import { parsePrincipal, principalsFor } from '../access.js'
import { pageLabel } from '../formats.js'
import { notebookPage, sharedFrom } from '../notebook-page.js'
import { cleanSharing } from './sharing.js'
import { TeamLicence } from './licence.js'
import type { LicenceStatus } from './licence.js'
import type { OidcLogin, SessionUser } from './oidc.js'
import type { ConnectorManager } from './connectors/manager.js'
import type { S3Credentials } from './connectors/sources.js'
import { callbackPage } from './connectors/oauth.js'

/** What the core server lends the team routes. */
export interface TeamHelpers {
  audit: (res: express.Response, action: string, target?: string, detail?: string) => void
  auditOn: boolean
  auditQueries: boolean
  adminOnly: express.RequestHandler
  sendError: (res: express.Response, err: unknown, status?: number) => void
  notebookFor: (id: string, res: express.Response, needs: NotebookRole) => { nb: Notebook; role: NotebookRole } | null
}

export interface TeamServer {
  licence: TeamLicence
  /** The signed-in person on this request, or why they can't be let in (the licence has lapsed). */
  session(req: express.Request): SessionUser | { error: string } | null
  /** For the notebooks list: can notebooks be shared with people here, and published as public links? */
  notebookFlags(): { sharing: boolean; publicLinks: boolean }
  /** The licence, for /api/info and the admin's banner; null without sign-in. */
  licenceInfo(): LicenceStatus | null
  /** Routes that don't need a signed-in person: /auth, the connector callback, public notebook pages. */
  mountPublic(app: express.Express): void
  /** Routes under /api, after authentication. */
  mount(app: express.Express, h: TeamHelpers): void
}

export function teamServer(duct: Duct, opts: { oidc?: OidcLogin; connectors?: ConnectorManager; account?: TensflareAccount; now?: () => number }): TeamServer {
  const oidc = opts.oidc
  const licence = new TeamLicence(duct, opts.account, opts.now)
  /** Public links need a server people sign in to (so there's an owner who chose to publish) and the switch on. */
  const publicLinksOn = () => !!oidc && duct.getFeatures().publicLinks
  /** Answers 402 with what to do when the licence doesn't cover `entitlement`. The admin token always gets through. */
  const licensed = (entitlement: string): express.RequestHandler => (_req, res, next) => {
    if (res.locals.actor === 'admin-token') return next()
    const s = licence.status(entitlement)
    if (s.active) return next()
    res.status(402).json({ error: s.message, code: 'licence' })
  }

  return {
    licence,
    session(req) {
      const user = oidc?.session(req)
      if (!user) return null
      const s = licence.status('team.sso')
      return s.active ? user : { error: s.message! }
    },
    notebookFlags: () => ({ sharing: !!oidc && licence.allows('team.workspace'), publicLinks: publicLinksOn() && licence.allows('team.workspace') }),
    licenceInfo: () => (oidc ? licence.status('team.sso') : null),

    mountPublic(app) {
      if (oidc) app.use('/auth', oidc.router(user => {
        try { duct.recordAudit({ actor: user.email, role: user.role, action: 'signin' }) } catch {}
      }))
      else app.get('/auth/mode', (_req, res) => { res.json({ oidc: false }) })

      // Connector sign-ins on a public server come back here; the random state ties it to the sign-in an admin started.
      app.get('/connectors/callback', (req, res) => {
        const web = opts.connectors?.web
        const ok = !!web && web.complete(new URLSearchParams(req.query as Record<string, string>))
        res.status(ok ? 200 : 400).set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'").type('html').send(callbackPage(ok))
      })

      // A notebook's public page. It shows the notes its owner can see (someone without an owner: only notes from
      // documents open to everyone), leaves out who added them, and isn't indexed by search engines. Each open
      // counts a view; nothing about the visitor is kept.
      const publicLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false })
      app.get('/n/:token', publicLimiter, (req, res) => {
        const nb = publicLinksOn() && licence.allows('team.workspace') ? duct.openPublicNotebook(req.params.token) : undefined
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'")
        res.setHeader('X-Robots-Tag', 'noindex, nofollow')
        if (!nb) { res.status(404).type('text/plain').send('This link doesn’t work any more. Ask whoever sent it for a new one.'); return }
        const hidden = duct.hiddenFrom(principalsFor(nb.owner ?? undefined))
        const notes = duct.listNotes(nb.id).filter(n => !hidden.has(n.path)).map(n => ({ ...n, author: null }))
        res.type('html').send(notebookPage(sharedFrom(nb.name, notes, f => pageLabel(f as DocumentFormat)), { noindex: true }))
      })
    },

    mount(app, { audit, auditOn, auditQueries, adminOnly, sendError, notebookFor }) {
      // The audit log, newest first: ?before=<id>&actor=&action=&limit=, or ?format=csv for the lot (admin).
      app.get('/api/audit', adminOnly, licensed('team.sso'), (req, res) => {
        const q = req.query
        if (q['format'] === 'csv') {
          const rows = duct.auditLog({ limit: 1000, actor: q['actor'] as string | undefined, action: q['action'] as string | undefined })
          const cell = (v: unknown) => { let t = v == null ? '' : String(v); if (/^[=+\-@]/.test(t)) t = "'" + t; return `"${t.replace(/"/g, '""')}"` }
          res.type('text/csv').setHeader('Content-Disposition', 'attachment; filename="duct-audit.csv"')
          res.send('\ufeff' + [['time', 'actor', 'role', 'action', 'target', 'detail'], ...rows.map(r => [new Date(r.at).toISOString(), r.actor, r.role, r.action, r.target, r.detail])].map(r => r.map(cell).join(',')).join('\r\n'))
          return
        }
        res.json({ enabled: auditOn, queries: auditQueries, entries: duct.auditLog({ before: Number(q['before']) || undefined, limit: Number(q['limit']) || 100, actor: q['actor'] as string | undefined, action: q['action'] as string | undefined }) })
      })

      // ---------- connectors (Google Drive, OneDrive, SharePoint, S3) ----------

      const connectors = opts.connectors
      let connecting: { kind: string; error?: string; running: boolean } | null = null

      app.get('/api/connectors', (_req, res) => {
        if (!connectors) { res.json({ available: false, connectors: [] }); return }
        res.json({ available: true, ...connectors.available(), connectors: connectors.list(), connecting })
      })

      // Opens the provider's sign-in in the browser on this machine; the page polls GET /api/connectors.
      app.post('/api/connectors', adminOnly, (req, res) => {
        if (!connectors) { res.status(404).json({ error: 'Connectors aren’t available here.' }); return }
        const kind = req.body?.kind
        if (kind !== 'gdrive' && kind !== 'microsoft' && kind !== 's3') { res.status(400).json({ error: 'kind must be gdrive, microsoft or s3' }); return }
        if (!connectors.available().entitled) { res.status(403).json({ error: 'Connectors are part of the Team plan.' }); return }
        if (kind === 's3') {
          // No browser sign-in: the keys are checked with one listing before the source is saved.
          let s3
          try { s3 = s3Details(req.body) } catch (err) { res.status(400).json({ error: (err as Error).message }); return }
          audit(res, 'connector-add', 's3', `s3://${s3.bucket}/${s3.prefix ?? ''}`)
          connectors.add('s3', { s3 }).then(c => res.status(201).json(c), err => res.status(400).json({ error: `Couldn’t read the bucket: ${(err as Error).message}` }))
          return
        }
        const siteUrl = typeof req.body?.siteUrl === 'string' && req.body.siteUrl.trim() ? req.body.siteUrl.trim() : undefined
        if (connecting?.running) { res.status(409).json({ error: 'Finish the sign-in that’s already open first.' }); return }
        connecting = { kind, running: true }
        audit(res, 'connector-add', kind, siteUrl)
        // A public server sends the admin's browser to the provider; on the desktop the system browser opens.
        let handOver: ((url: string) => void) | undefined
        const signInUrl = connectors.web ? new Promise<string>(resolve => { handOver = resolve }) : null
        connectors.add(kind, { siteUrl, ...(handOver ? { openUrl: handOver } : {}) }).then(() => { connecting = null }, err => { connecting = { kind, running: false, error: (err as Error).message }; handOver?.('') })
        if (!signInUrl) { res.status(202).json({ started: true }); return }
        signInUrl.then(url => url ? res.status(202).json({ started: true, url }) : res.status(400).json({ error: connecting?.error ?? 'Couldn’t start the sign-in' }))
      })

      // Who sees a source's files: { visibility: 'source' | 'everyone' | 'custom', allow?: ['ada@okafor.ng', 'okafor.ng'] }
      app.put('/api/connectors/:id/visibility', adminOnly, async (req, res) => {
        if (!connectors) { res.status(404).end(); return }
        const visibility = req.body?.visibility
        if (visibility !== 'source' && visibility !== 'everyone' && visibility !== 'custom') { res.status(400).json({ error: 'visibility must be source, everyone or custom' }); return }
        const raw: unknown[] = Array.isArray(req.body?.allow) ? req.body.allow : []
        const allow = raw.map(a => typeof a === 'string' ? parsePrincipal(a) : null)
        if (allow.some(a => a === null)) { res.status(400).json({ error: 'Each entry must be an email address or a domain (okafor.ng)' }); return }
        if (visibility === 'custom' && allow.length === 0) { res.status(400).json({ error: 'Add at least one email address or domain' }); return }
        try {
          await connectors.setVisibility(req.params['id'] as string, visibility, allow as string[])
          audit(res, 'connector-visibility', req.params['id'] as string, visibility === 'custom' ? (allow as string[]).join(', ') : visibility)
          res.json(connectors.list().find(c => c.id === req.params['id']))
        } catch (err) { sendError(res, err, (err as { status?: number }).status ?? 500) }
      })

      app.post('/api/connectors/:id/sync', adminOnly, (req, res) => {
        if (!connectors) { res.status(404).end(); return }
        connectors.sync(req.params['id'] as string).catch(() => {})
        res.status(202).json({ started: true })
      })

      app.delete('/api/connectors/:id', adminOnly, async (req, res) => {
        if (!connectors || !(await connectors.remove(req.params['id'] as string))) { res.status(404).json({ error: 'No such source' }); return }
        audit(res, 'connector-remove', req.params['id'] as string)
        res.json({ ok: true })
      })

      // Who a notebook is shared with: { "sharing": [{ "to": "ada@okafor.ng" | "okafor.ng" | "anyone", "can": "view" | "edit" }] }.
      app.put('/api/notebooks/:id/sharing', licensed('team.workspace'), (req, res) => {
        if (!oidc) { res.status(400).json({ error: 'Sharing with people needs a Duct server where people sign in. On this computer, export the notebook as a page to send it.' }); return }
        const found = notebookFor(req.params.id, res, 'owner')
        if (!found) return
        try {
          const sharing = duct.shareNotebook(req.params.id, cleanSharing(req.body?.sharing, found.nb.owner))
          audit(res, 'notes', undefined, sharing.length ? `shared a notebook with ${sharing.map(s => `${s.to.replace(/^(user|domain):/, '')} (${s.can})`).join(', ')}` : 'stopped sharing a notebook')
          res.json({ sharing })
        } catch (err) {
          sendError(res, err, 400)
        }
      })

      // A public link: anyone who has it can read the notebook, without signing in. Owner only; a new link replaces
      // the old one. { on: false } (or DELETE) turns it off.
      app.post('/api/notebooks/:id/public-link', licensed('team.workspace'), (req, res) => {
        if (!publicLinksOn()) { res.status(403).json({ error: oidc ? 'Public links are switched off on this server (Settings › Features).' : 'Public links need a Duct server where people sign in. On this computer, send the notebook as a page instead.' }); return }
        if (!notebookFor(req.params.id, res, 'owner')) return
        const token = duct.setNotebookPublic(req.params.id, true)!
        audit(res, 'notes', undefined, 'made a public link to a notebook')
        res.status(201).json({ publicLink: `/n/${token}`, publicViews: 0 })
      })

      app.delete('/api/notebooks/:id/public-link', (req, res) => {
        if (!notebookFor(req.params.id, res, 'owner')) return
        duct.setNotebookPublic(req.params.id, false)
        audit(res, 'notes', undefined, 'turned off a notebook’s public link')
        res.json({ publicLink: null })
      })
    },
  }
}

export function s3Details(body: Record<string, unknown> | undefined): S3Credentials {
  const str = (k: string) => typeof body?.[k] === 'string' ? (body[k] as string).trim() : ''
  const bucket = str('bucket'), accessKeyId = str('accessKeyId'), secretAccessKey = str('secretAccessKey')
  const region = str('region') || 'us-east-1'
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('Enter the bucket’s name')
  if (!accessKeyId || !secretAccessKey) throw new Error('Enter an access key and its secret')
  if (!/^[a-z0-9-]+$/.test(region)) throw new Error('The region looks wrong (e.g. eu-west-2, or auto for R2)')
  const endpoint = str('endpoint')
  if (endpoint) {
    let u: URL
    try { u = new URL(endpoint) } catch { throw new Error('The endpoint isn’t a web address') }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('The endpoint must use https')
  }
  const prefix = str('prefix').replace(/^\/+/, '')
  return { bucket, region, accessKeyId, secretAccessKey, ...(endpoint ? { endpoint } : {}), ...(prefix ? { prefix } : {}) }
}
