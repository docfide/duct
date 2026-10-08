import express from 'express'
import multer from 'multer'
import rateLimit from 'express-rate-limit'
import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Duct } from './index.js'
import type { DocumentFormat, SearchResult, SearchScope } from './types.js'
import { isUrl } from './extract/web.js'
import { addToLibrary, defaultLibraryDir } from './library.js'
import { VERSION } from './version.js'
import { viewerHtml } from './viewer.js'
import { ACCEPT_ATTRIBUTE, FORMATS, SUPPORTED_SUMMARY, isSupportedFile, pageLabel } from './formats.js'
import { islandHtml } from './island.js'
import { EXPORT_TYPES, exportFileName, isExportFormat, renderExport } from './export.js'
import type { ExportItem } from './export.js'
import { createApiRouter } from './api/v1.js'
import type { TensflareAccount } from './account.js'
import type { Telemetry } from './telemetry.js'
import type { SettingsSync } from './sync.js'
import type { ConnectorManager } from './connectors/manager.js'
import { clearCrashes, collectDiagnostics, listCrashes, sendFeedback, validateFeedback } from './diagnostics.js'
import { Collections } from './api/collections.js'
import { FEATURE_LABELS, FEATURE_NAMES, FORMAT_KINDS, FeatureDisabledError } from './features.js'
import type { FeatureName } from './features.js'

// Mascot art ships with the package; the dotLottie player and its wasm are served
// locally (never from a CDN) so the UI works offline.
const mascotDir = fileURLToPath(new URL('../assets/mascot', import.meta.url))
const lottiePlayerDir = dirname(createRequire(import.meta.url).resolve('@lottiefiles/dotlottie-web'))
// pdf.js (legacy build, for wider browser support) powers the /viewer page; served locally like the mascot.
const pdfjsDir = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))

function parseMetadata(raw: unknown): Record<string, unknown> | undefined {
  if (!raw) return undefined
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); if (typeof p === 'object' && p !== null && !Array.isArray(p)) return p } catch {}
  }
  return undefined
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1']
// The main UI (assets/ui) has no inline scripts, so scripts may only come from this server.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')
// The island and PDF viewer pages still carry their script inline.
const INLINE_SCRIPT_CSP = CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
const uiDir = fileURLToPath(new URL('../assets/ui', import.meta.url))
const API_KEY_FIELDS = ['openaiKey', 'geminiKey', 'cohereKey', 'voyageKey', 'mistralKey', 'jinaKey'] as const

export interface ServerOptions {
  /** Require this token (Bearer header or login cookie) on every /api request. Its holders are admins. */
  authToken?: string
  /**
   * Extra tokens for team members (requires authToken). Members can search, ask, open, upload and run OCR,
   * but can't change settings, delete documents, clear the index or change watched folders.
   */
  memberTokens?: string[]
  uploadLimitMb?: number
  /** Directories POST /api/watch may watch (and their subfolders). Empty or unset disables watching through the API. */
  watchRoots?: string[]
  /** Hostnames accepted in the Host header. Defaults to loopback names; '*' accepts any (only with authToken). */
  allowedHosts?: string[] | '*'
  /** Where uploaded files are kept. Defaults to ~/Duct Library; created on first upload. */
  libraryDir?: string
  /**
   * Called with API keys entered in Settings, so the host can store them securely (the desktop app uses
   * the system keychain). Keys are otherwise kept in memory only.
   */
  onSecrets?: (keys: Partial<Record<typeof API_KEY_FIELDS[number], string>>) => void
  /** Developer API collections. Defaults to <index>/collections (in memory for an in-memory index). */
  collections?: Collections
  /** "Sign in with Tensflare" for this install (optional; everything local works without it). */
  account?: TensflareAccount
  /** Anonymous usage counts (src/telemetry.ts). Without it the server counts and sends nothing. */
  telemetry?: Telemetry
  /** Where crash records are kept (see src/diagnostics.ts). */
  crashDir?: string
  /** How Duct is running, for diagnostics: desktop, server, docker or cli. */
  channel?: string
  /** Overrides where feedback is sent (tests, staging). */
  feedbackUrl?: string
  /** Settings sync between the account's devices (Pro and Team). */
  sync?: SettingsSync
  /** Google Drive, OneDrive and SharePoint sources (Team). */
  connectors?: ConnectorManager
}

/** 403 for a switched-off feature, otherwise `status` with the error's message. */
function sendError(res: express.Response, err: unknown, status = 500): void {
  if (err instanceof FeatureDisabledError) {
    res.status(403).json({ error: err.message, feature: err.feature })
    return
  }
  res.status(status).json({ error: (err as Error).message })
}

/** Search scope from query parameters: ?formats=pdf,docx &under=/folder &tag=a&tag=b &after=<ms> &before=<ms>. */
function scopeFrom(query: express.Request['query']): SearchScope | undefined {
  const scope: SearchScope = {}
  if (typeof query.formats === 'string' && query.formats) scope.formats = query.formats.split(',') as DocumentFormat[]
  if (typeof query.under === 'string' && query.under) scope.under = query.under
  const tags = ([] as unknown[]).concat(query.tag ?? []).filter((t): t is string => typeof t === 'string' && t.length > 0)
  if (tags.length) scope.tags = tags.slice(0, 10)
  const time = (v: unknown) => typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : undefined
  const after = time(query.after)
  const before = time(query.before)
  if (after !== undefined) scope.modifiedAfter = after
  if (before !== undefined) scope.modifiedBefore = before
  return Object.keys(scope).length ? scope : undefined
}

function hostnameOf(hostHeader: string | undefined): string {
  if (!hostHeader) return ''
  const v6 = hostHeader.match(/^\[([^\]]+)\]/)
  if (v6) return v6[1].toLowerCase()
  return hostHeader.replace(/:\d+$/, '').toLowerCase()
}

function sameToken(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return undefined
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

function realOrResolved(p: string): string {
  try { return realpathSync(p) } catch { return resolve(p) }
}

/** What a chunk's page number means per format ("slide", "sheet", "ch."), for the pages' labels. */
const PAGE_LABELS = JSON.stringify(Object.fromEntries(FORMATS.map(f => [f.format, f.pageLabel ?? 'p.'])))

/** Fills the island page's placeholders. */
function fillPage(page: string): string {
  return page
    .replace('__SUPPORTED__', SUPPORTED_SUMMARY)
    .replace('__PAGE_LABELS__', PAGE_LABELS)
}

export function createServer(duct: Duct, opts?: ServerOptions) {
  const app = express()
  const token = opts?.authToken
  const maxMb = opts?.uploadLimitMb ?? 50
  const allowedHosts = opts?.allowedHosts ?? LOOPBACK_HOSTS
  const watchRoots = opts?.watchRoots ?? []
  const libraryDir = resolve(opts?.libraryDir ?? defaultLibraryDir())
  const incomingDir = join(libraryDir, '.incoming')

  // Uploads land in the library's .incoming folder, then move into the library under their real name.
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        mkdirSync(incomingDir, { recursive: true })
        cb(null, incomingDir)
      } catch (err) {
        cb(err as Error, incomingDir)
      }
    },
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${randomBytes(6).toString('hex')}${extname(file.originalname).toLowerCase()}`),
  })

  const upload = multer({
    storage,
    limits: { fileSize: maxMb * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ext = extname(file.originalname).toLowerCase()
      if (isSupportedFile(file.originalname)) return cb(null, true)
      cb(new Error(`Unsupported file type: ${ext || file.originalname}. Duct reads ${SUPPORTED_SUMMARY}.`))
    },
  })

  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Rate limit: 120 requests per minute.' },
    // Only a shared (token-protected) server is rate limited; a local-only one serves just this machine.
    skip: () => !token,
  })

  const memberTokens = opts?.memberTokens ?? []
  if (memberTokens.length > 0 && !token) throw new Error('memberTokens require an authToken for admins')

  function roleFor(given: string | undefined): 'admin' | 'member' | null {
    if (!given) return null
    if (token && sameToken(given, token)) return 'admin'
    if (memberTokens.some(t => sameToken(given, t))) return 'member'
    return null
  }

  function auth(req: express.Request, res: express.Response, next: express.NextFunction): void {
    // Without a token the server only serves this machine, and its user is the admin.
    if (!token) { res.locals.role = 'admin'; return next() }
    const header = req.headers['authorization']
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined
    const role = roleFor(bearer) ?? roleFor(readCookie(req.headers.cookie, 'duct_token'))
    if (role) { res.locals.role = role; return next() }
    res.status(401).json({ error: 'Unauthorized. Provide a valid Bearer token.' })
  }

  function adminOnly(_req: express.Request, res: express.Response, next: express.NextFunction): void {
    if (res.locals.role === 'admin') return next()
    res.status(403).json({ error: 'Only an admin can do this.' })
  }

  // Security headers on every response.
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    next()
  })

  // Reject unexpected Host headers (DNS rebinding) and cross-site writes (CSRF).
  app.use((req, res, next) => {
    if (allowedHosts !== '*' && !allowedHosts.includes(hostnameOf(req.headers.host))) {
      res.status(403).json({ error: 'Host not allowed.' })
      return
    }
    const origin = req.headers.origin
    if (origin && req.method !== 'GET' && req.method !== 'HEAD') {
      let originHost = ''
      try { originHost = new URL(origin).host } catch {}
      if (originHost !== req.headers.host) {
        res.status(403).json({ error: 'Cross-origin request blocked.' })
        return
      }
    }
    next()
  })

  // The developer API: its own keys, scopes, body parsing and rate limit (see src/api/v1.ts and docs/developer-api.md).
  app.use('/v1', createApiRouter(duct, opts?.collections ?? new Collections(duct), { adminToken: token, uploadLimitMb: maxMb }))

  app.use(express.json({ limit: '10mb' }))

  app.use('/api/', apiLimiter)

  // Browser login: exchanges the token for an HttpOnly cookie so the UI works on a protected server.
  app.post('/api/login', (req, res) => {
    if (!token) { res.json({ ok: true }); return }
    const given = typeof req.body?.token === 'string' ? req.body.token : ''
    if (!roleFor(given)) { res.status(401).json({ error: 'Invalid token.' }); return }
    const secure = req.secure ? '; Secure' : ''
    res.setHeader('Set-Cookie', `duct_token=${encodeURIComponent(given)}; HttpOnly; SameSite=Strict; Path=/${secure}`)
    res.json({ ok: true })
  })

  app.use('/api/', auth)

  /** Answers 403 when a feature is switched off in Settings. */
  const needs = (name: FeatureName): express.RequestHandler => (_req, res, next) => {
    if (duct.getFeatures()[name]) next()
    else sendError(res, new FeatureDisabledError(name))
  }

  app.get('/api/me', (_req, res) => {
    res.json({ role: res.locals.role, auth: !!token })
  })

  // Everything the UI needs to know about this server, so the page itself can be a static file.
  app.get('/api/info', (_req, res) => {
    res.json({
      version: VERSION,
      role: res.locals.role,
      auth: !!token,
      libraryDir,
      canWatch: watchRoots.length > 0,
      supported: SUPPORTED_SUMMARY,
      accept: ACCEPT_ATTRIBUTE,
      formats: FORMATS.map(f => ({ format: f.format, kind: f.kind, label: f.label, pageLabel: f.pageLabel ?? 'p.' })),
      features: duct.getFeatures(),
    })
  })

  // ---------- account and usage counts ----------

  const account = opts?.account
  const telemetry = opts?.telemetry
  let signIn: { running: boolean; error?: string } = { running: false }

  app.get('/api/account', (_req, res) => {
    if (!account) { res.json({ available: false }); return }
    res.json({ available: true, ...account.status(), signingIn: signIn.running, ...(signIn.error ? { signInError: signIn.error } : {}) })
  })

  // Opens the Tensflare sign-in page in the browser and returns at once; the page polls GET /api/account.
  app.post('/api/account/signin', adminOnly, (_req, res) => {
    if (!account) { res.status(404).json({ error: 'Accounts are not available on this server.' }); return }
    if (!signIn.running) {
      signIn = { running: true }
      account.signIn().then(() => { signIn = { running: false } }, err => { signIn = { running: false, error: (err as Error).message } })
    }
    res.status(202).json({ started: true })
  })

  app.get('/api/account/billing', async (_req, res) => {
    if (!account || !account.status().signedIn) { res.json({ subscription: null, refundable: false, invoices: [] }); return }
    try { res.json(await account.billing()) } catch (err) { res.status(502).json({ error: (err as Error).message }) }
  })

  // Opens the account website signed in: billing, plan changes, team, devices. Only these pages are allowed.
  app.post('/api/account/portal', adminOnly, async (req, res) => {
    if (!account) { res.status(404).json({ error: 'Accounts are not available on this server.' }); return }
    const next = ['/account', '/account/upgrade', '/account/change', '/account/cancel', '/account/refund'].includes(req.body?.next) ? req.body.next : '/account'
    try { res.json({ url: await account.webLink(next) }) } catch (err) { res.status(502).json({ error: (err as Error).message }) }
  })

  // Hosted AI status and this month's credits (Pro and Team).
  app.get('/api/account/ai', async (_req, res) => {
    if (!account || !account.status().signedIn || !account.has('ai.hosted')) { res.json({ entitled: false }); return }
    try { res.json(await account.aiInfo()) } catch (err) { res.status(502).json({ error: (err as Error).message }) }
  })

  // ---------- connectors (Google Drive, OneDrive, SharePoint) ----------

  const connectors = opts?.connectors
  let connecting: { kind: string; error?: string; running: boolean } | null = null

  app.get('/api/connectors', (_req, res) => {
    if (!connectors) { res.json({ available: false, connectors: [] }); return }
    res.json({ available: true, ...connectors.available(), connectors: connectors.list(), connecting })
  })

  // Opens the provider's sign-in in the browser on this machine; the page polls GET /api/connectors.
  app.post('/api/connectors', adminOnly, (req, res) => {
    if (!connectors) { res.status(404).json({ error: 'Connectors aren’t available here.' }); return }
    const kind = req.body?.kind
    if (kind !== 'gdrive' && kind !== 'microsoft') { res.status(400).json({ error: 'kind must be gdrive or microsoft' }); return }
    if (!connectors.available().entitled) { res.status(403).json({ error: 'Connectors are part of the Team plan.' }); return }
    const siteUrl = typeof req.body?.siteUrl === 'string' && req.body.siteUrl.trim() ? req.body.siteUrl.trim() : undefined
    if (connecting?.running) { res.status(409).json({ error: 'Finish the sign-in that’s already open first.' }); return }
    connecting = { kind, running: true }
    connectors.add(kind, { siteUrl }).then(() => { connecting = null }, err => { connecting = { kind, running: false, error: (err as Error).message } })
    res.status(202).json({ started: true })
  })

  app.post('/api/connectors/:id/sync', adminOnly, (req, res) => {
    if (!connectors) { res.status(404).end(); return }
    connectors.sync(req.params['id'] as string).catch(() => {})
    res.status(202).json({ started: true })
  })

  app.delete('/api/connectors/:id', adminOnly, async (req, res) => {
    if (!connectors || !(await connectors.remove(req.params['id'] as string))) { res.status(404).json({ error: 'No such source' }); return }
    res.json({ ok: true })
  })

  app.get('/api/sync', (_req, res) => {
    res.json(opts?.sync ? opts.sync.status() : { available: false, enabled: false })
  })

  app.put('/api/sync', adminOnly, async (req, res) => {
    if (!opts?.sync) { res.status(404).json({ error: 'Sync isn’t available here.' }); return }
    if (typeof req.body?.enabled !== 'boolean') { res.status(400).json({ error: 'Send { "enabled": true | false }' }); return }
    if (req.body.enabled && !opts.sync.status().available) { res.status(403).json({ error: 'Sync is part of Pro and Team.' }); return }
    res.json({ ...(await opts.sync.enable(req.body.enabled)), available: opts.sync.status().available })
  })

  app.post('/api/account/signout', adminOnly, async (_req, res) => {
    if (account) await account.signOut()
    signIn = { running: false }
    res.json({ ok: true })
  })

  app.get('/api/telemetry', (_req, res) => {
    if (!telemetry) { res.json({ available: false }); return }
    res.json({ available: true, ...telemetry.status(), report: telemetry.report() })
  })

  app.put('/api/telemetry', adminOnly, (req, res) => {
    if (!telemetry) { res.status(404).json({ error: 'Usage counts are not available here.' }); return }
    if (typeof req.body?.enabled !== 'boolean') { res.status(400).json({ error: 'Send { "enabled": true | false }' }); return }
    telemetry.setEnabled(req.body.enabled)
    res.json({ available: true, ...telemetry.status() })
  })

  // ---------- diagnostics, crash records and feedback (never document content) ----------

  const channel = opts?.channel ?? 'server'
  const crashDir = opts?.crashDir

  app.get('/api/diagnostics', (_req, res) => {
    res.json(collectDiagnostics(duct, channel, crashDir))
  })

  app.get('/api/crashes', adminOnly, (_req, res) => {
    res.json({ crashes: crashDir ? listCrashes(crashDir) : [] })
  })

  app.delete('/api/crashes', adminOnly, (_req, res) => {
    if (crashDir) clearCrashes(crashDir)
    res.json({ ok: true })
  })

  // The page shows what will be sent before this is called; diagnostics and crash records are added here,
  // from the same functions, only when the person ticked them.
  app.post('/api/feedback', async (req, res) => {
    let input
    try { input = validateFeedback(req.body) } catch (err) { res.status(400).json({ error: (err as Error).message }); return }
    if (req.body?.includeDiagnostics === true) input.diagnostics = collectDiagnostics(duct, channel, crashDir)
    if (req.body?.includeCrashes === true && crashDir) input.crashes = listCrashes(crashDir).slice(0, 10)
    try {
      await sendFeedback(input, { url: opts?.feedbackUrl })
      res.json({ ok: true })
    } catch (err) {
      res.status(502).json({ error: (err as Error).message })
    }
  })

  app.get('/api/features', (_req, res) => {
    res.json({ features: duct.getFeatures(), names: FEATURE_NAMES, labels: FEATURE_LABELS, formatKinds: FORMAT_KINDS })
  })

  app.put('/api/features', adminOnly, (req, res) => {
    try {
      const features = duct.setFeatures(req.body)
      opts?.sync?.changed()
      res.json({ ok: true, features })
    } catch (err) {
      sendError(res, err, 400)
    }
  })

  app.post('/api/index', (req, res) => {
    const url = req.body?.url
    const bodyMeta = parseMetadata(req.body?.metadata)
    if (url !== undefined) {
      if (typeof url !== 'string' || !isUrl(url)) {
        res.status(400).json({ error: 'The "url" field must be an http(s) URL.' })
        return
      }
      duct.index(url, bodyMeta).then(r => res.json({ results: [{ file: url, ...r }] })).catch(e => sendError(res, e))
      return
    }
    if (!duct.getFeatures().uploads) { sendError(res, new FeatureDisabledError('uploads')); return }
    upload.array('files')(req, res, async (err) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ error: `File too large. Maximum size: ${maxMb} MB.` })
          return
        }
        res.status(400).json({ error: err.message })
        return
      }
      const files = req.files as Express.Multer.File[]
      if (!files || files.length === 0) {
        res.status(400).json({ error: 'No files uploaded.' })
        return
      }
      const formMeta = parseMetadata(typeof req.body?.metadata === 'string' ? req.body.metadata : undefined)
      const meta = { ...bodyMeta, ...formMeta }
      try {
        const results = []
        for (const file of files) {
          results.push(await addToLibrary(duct, libraryDir, file.path, { originalName: file.originalname, metadata: meta, move: true }))
        }
        res.json({ results })
      } catch (err) {
        for (const file of files) { try { if (existsSync(file.path)) unlinkSync(file.path) } catch {} }
        res.status(500).json({ error: (err as Error).message })
      }
    })
  })

  app.get('/api/search', async (req, res) => {
    const q = req.query.q as string
    if (!q) { res.status(400).json({ error: 'Query parameter "q" is required' }); return }
    const topK = Math.min(100, parseInt(req.query.topK as string) || 10)
    const filter = parseMetadata(req.query.filter as string)
    try {
      const results = await duct.search(q, topK, filter, scopeFrom(req.query))
      telemetry?.record('searches')
      res.json({ results })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.post('/api/ask', needs('ask'), async (req, res) => {
    const { question, topK = 5, agentic } = req.body
    if (!question) { res.status(400).json({ error: 'Question is required' }); return }
    try {
      const result = agentic ? await duct.agenticSearch(question) : await duct.ask(question, topK)
      telemetry?.record('ask')
      res.json(result)
    } catch (err) {
      sendError(res, err)
    }
  })

  app.get('/api/documents', (req, res) => {
    const path = req.query.path as string
    if (path) {
      const doc = duct.getDocument(path)
      if (!doc) { res.status(404).json({ error: 'Document not found' }); return }
      res.json({ document: doc })
      return
    }
    res.json({ documents: duct.getDocuments() })
  })

  app.delete('/api/documents', adminOnly, async (req, res) => {
    const path = req.query.path as string
    if (!path) { res.status(400).json({ error: 'Query parameter "path" is required' }); return }
    const doc = duct.getDocument(path)
    if (!doc) { res.status(404).json({ error: 'Document not found' }); return }
    try {
      await duct.removeDocument(doc.path)
      // Library copies belong to Duct and are deleted; anything else (watched folders) is only unindexed.
      const resolved = resolve(doc.path)
      if (doc.source === 'library' && isInside(resolved, libraryDir) && resolved !== libraryDir) {
        try { unlinkSync(resolved) } catch {}
      }
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Opens an indexed document: PDFs, images and plain text display in the browser, anything else downloads.
  // Only files that are in the index can be read, never arbitrary paths.
  // The optional :name only gives the browser's viewer a readable title; the path query decides the file.
  app.get(['/api/file', '/api/file/:name'], (req, res) => {
    const doc = typeof req.query.path === 'string' ? duct.getDocument(req.query.path) : undefined
    if (!doc || doc.source === 'url' || isUrl(doc.path) || !existsSync(doc.path)) {
      res.status(404).json({ error: 'Document not found' })
      return
    }
    const ext = extname(doc.path).toLowerCase()
    const name = encodeURIComponent(doc.displayName ?? doc.path.split(/[\\/]/).pop() ?? 'document')
    const textTypes = new Set(['.txt', '.md', '.markdown', '.csv', '.log', '.json'])
    const inlineTypes = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
    if (textTypes.has(ext)) res.type('text/plain; charset=utf-8')
    const inline = inlineTypes.has(ext) || textTypes.has(ext)
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`)
    // The browser's PDF viewer needs plugin/object access; nothing else on this response may run.
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; object-src 'self'; frame-ancestors 'none'")
    telemetry?.record('opens')
    res.sendFile(doc.path, { dotfiles: 'allow', headers: { 'Cache-Control': 'no-store' } })
  })

  // Runs OCR on one document now (OCR is otherwise off by default because it is slow).
  app.post('/api/ocr', needs('ocrOnDemand'), async (req, res) => {
    const doc = typeof req.body?.path === 'string' ? duct.getDocument(req.body.path) : undefined
    if (!doc || doc.source === 'url') { res.status(404).json({ error: 'Document not found' }); return }
    try {
      const result = await duct.index(doc.path, undefined, { ocr: true, force: true })
      telemetry?.record('ocr')
      res.json({ ...result, document: duct.getDocument(doc.path) })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.get('/api/activity', (_req, res) => {
    res.json(duct.activity())
  })

  app.get('/api/sources', (_req, res) => {
    res.json({ sources: duct.listSources(), canAdd: watchRoots.length > 0 })
  })

  app.delete('/api/sources', adminOnly, async (req, res) => {
    const path = req.query.path as string
    if (!path || !duct.listSources().some(s => s.path === path)) { res.status(404).json({ error: 'Not a watched folder' }); return }
    try {
      await duct.removeSource(path)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Settings without the API keys themselves; keysSet says which keys are present.
  function publicConfig() {
    const cfg = duct.getConfig()
    const keysSet = Object.fromEntries(API_KEY_FIELDS.map(k => [k, !!cfg[k]]))
    return { ...cfg, ...Object.fromEntries(API_KEY_FIELDS.map(k => [k, ''])), keysSet }
  }

  app.get('/api/config', (_req, res) => {
    res.json(publicConfig())
  })

  app.put('/api/config', adminOnly, (req, res) => {
    try {
      duct.configure(req.body)
      opts?.sync?.changed()
      const keys = Object.fromEntries(API_KEY_FIELDS.filter(k => typeof req.body?.[k] === 'string' && req.body[k]).map(k => [k, req.body[k] as string]))
      if (Object.keys(keys).length) opts?.onSecrets?.(keys)
      res.json({ ok: true, config: publicConfig() })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  app.get('/api/stats', (_req, res) => {
    res.json(duct.stats())
  })

  app.delete('/api/clear', adminOnly, async (_req, res) => {
    try {
      await duct.clear()
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // ---------- tags ----------

  app.get('/api/tags', (_req, res) => {
    res.json({ tags: duct.listTags() })
  })

  // Members may tag too: tags organise shared work (by tender, client, matter or outcome).
  app.put('/api/documents/tags', (req, res) => {
    const { path, tags } = req.body ?? {}
    if (typeof path !== 'string' || !Array.isArray(tags) || !tags.every(t => typeof t === 'string')) {
      res.status(400).json({ error: 'Send { "path": "…", "tags": ["…"] }' })
      return
    }
    try {
      res.json({ path, tags: duct.setTags(path, tags) })
    } catch (err) {
      sendError(res, err, 404)
    }
  })

  // ---------- export ----------

  const nameOf = (path: string) => duct.getDocument(path)?.displayName ?? path.split(/[\\/]/).pop() ?? path
  const exportItem = (r: SearchResult): ExportItem => ({
    name: nameOf(r.chunk.documentPath),
    path: r.chunk.documentPath,
    ...(r.chunk.page ? { location: `${pageLabel(r.chunk.documentFormat)} ${r.chunk.page}` } : {}),
    ...(r.chunk.heading ? { heading: r.chunk.heading } : {}),
    text: r.chunk.content.slice(0, 4000),
    score: r.score,
    tags: duct.getDocument(r.chunk.documentPath)?.tags ?? [],
  })
  const sendExport = async (res: express.Response, items: ExportItem[], format: string, title: string) => {
    if (!isExportFormat(format)) { res.status(400).json({ error: 'format must be csv, md, json or docx' }); return }
    const body = await renderExport(items, format, title)
    res.setHeader('Content-Type', EXPORT_TYPES[format].mime)
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(exportFileName(title, format))}`)
    res.send(body)
  }

  // Every result for a search (same scope parameters as /api/search), with sources.
  app.get('/api/export', needs('export'), async (req, res) => {
    const q = req.query.q as string
    if (!q) { res.status(400).json({ error: 'Query parameter "q" is required' }); return }
    try {
      const topK = Math.min(500, parseInt(req.query.topK as string) || 100)
      const results = await duct.search(q, topK, parseMetadata(req.query.filter as string), scopeFrom(req.query))
      await sendExport(res, results.map(exportItem), (req.query.format as string) || 'csv', `Search: ${q}`)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Passages picked by hand ("Collect"), in the order given. Only indexed documents can be named.
  app.post('/api/export', needs('export'), async (req, res) => {
    const { items, format, title } = req.body ?? {}
    if (!Array.isArray(items) || items.length === 0 || items.length > 500) { res.status(400).json({ error: 'Send 1 to 500 items' }); return }
    const out: ExportItem[] = []
    for (const it of items) {
      const doc = typeof it?.path === 'string' ? duct.getDocument(it.path) : undefined
      if (!doc || typeof it.text !== 'string') { res.status(400).json({ error: 'Each item needs the path of an indexed document and its text' }); return }
      out.push({
        name: doc.displayName ?? nameOf(doc.path),
        path: doc.path,
        ...(Number.isInteger(it.page) && it.page > 0 ? { location: `${pageLabel(doc.format)} ${it.page}` } : {}),
        ...(typeof it.heading === 'string' && it.heading ? { heading: it.heading.slice(0, 300) } : {}),
        text: it.text.slice(0, 20000),
        tags: doc.tags ?? [],
      })
    }
    try {
      await sendExport(res, out, typeof format === 'string' ? format : 'docx', typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : 'Collected passages')
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.get('/api/diff', needs('diff'), async (req, res) => {
    const path = req.query.path as string
    if (!path) { res.status(400).json({ error: 'Path is required' }); return }
    try {
      const d = await duct.diff(path)
      res.json({ diff: d })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.post('/api/extract', needs('schemaExtraction'), async (req, res) => {
    const { fields, paths } = req.body
    if (!fields || !Array.isArray(fields)) {
      res.status(400).json({ error: 'Fields array is required' })
      return
    }
    try {
      const results = await duct.extractSchema(fields, paths)
      res.json({ results })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.post('/api/watch', adminOnly, needs('watchedFolders'), (req, res) => {
    const { directories } = req.body
    if (!directories || !Array.isArray(directories)) {
      res.status(400).json({ error: 'Directories array is required' })
      return
    }
    if (watchRoots.length === 0) {
      res.status(403).json({ error: 'Watching folders through the API is disabled. Start the server with --watch-root <dir>.' })
      return
    }
    for (const dir of directories) {
      if (typeof dir !== 'string' || !existsSync(dir)) {
        res.status(400).json({ error: `Directory does not exist: ${dir}` })
        return
      }
      const real = realOrResolved(dir)
      // Roots are resolved per request so symlinks (e.g. macOS /var -> /private/var) and late-created roots match.
      if (!watchRoots.some(root => isInside(real, realOrResolved(root)))) {
        res.status(403).json({ error: `Not inside an allowed watch root: ${dir}` })
        return
      }
    }
    try {
      // Indexing the folder's existing files can take a while; progress is reported by /api/activity.
      duct.watch(directories).catch(err => console.error(`  Watch failed: ${(err as Error).message}`))
      res.json({ ok: true, watching: directories })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.post('/api/unwatch', adminOnly, (_req, res) => {
    try {
      duct.unwatch()
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.use('/mascot', express.static(mascotDir, { maxAge: '1d' }))
  for (const [route, dir] of [['build', 'legacy/build'], ['web', 'legacy/web'], ['cmaps', 'cmaps'], ['standard_fonts', 'standard_fonts'], ['wasm', 'wasm']]) {
    app.use(`/vendor/pdfjs/${route}`, express.static(join(pdfjsDir, dir), { maxAge: '1d', index: false }))
  }
  app.get('/viewer', (_req, res) => {
    res.setHeader('Content-Security-Policy', INLINE_SCRIPT_CSP)
    res.type('html').send(viewerHtml)
  })
  // The desktop app's notch companion (see electron/island.cjs).
  app.get('/island', (_req, res) => {
    res.setHeader('Content-Security-Policy', INLINE_SCRIPT_CSP)
    res.type('html').send(fillPage(islandHtml))
  })

  // The main UI: static files from assets/ui.
  app.use('/ui', express.static(uiDir, { index: false, maxAge: 0 }))

  app.get('/vendor/dotlottie/index.js', (_req, res) => res.sendFile(join(lottiePlayerDir, 'index.js')))
  app.get('/vendor/dotlottie/dotlottie-player.wasm', (_req, res) => res.sendFile(join(lottiePlayerDir, 'dotlottie-player.wasm')))

  app.get('*', (_req, res) => {
    res.sendFile(join(uiDir, 'index.html'))
  })

  return app
}

