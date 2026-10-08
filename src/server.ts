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
import type { DocumentFormat } from './types.js'
import { isUrl } from './extract/web.js'
import { addToLibrary, defaultLibraryDir } from './library.js'
import { VERSION } from './version.js'
import { viewerHtml } from './viewer.js'
import { ACCEPT_ATTRIBUTE, FORMATS, SUPPORTED_SUMMARY, isSupportedFile } from './formats.js'
import { islandHtml } from './island.js'
import { createApiRouter } from './api/v1.js'
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
}

/** 403 for a switched-off feature, otherwise `status` with the error's message. */
function sendError(res: express.Response, err: unknown, status = 500): void {
  if (err instanceof FeatureDisabledError) {
    res.status(403).json({ error: err.message, feature: err.feature })
    return
  }
  res.status(status).json({ error: (err as Error).message })
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

  app.get('/api/features', (_req, res) => {
    res.json({ features: duct.getFeatures(), names: FEATURE_NAMES, labels: FEATURE_LABELS, formatKinds: FORMAT_KINDS })
  })

  app.put('/api/features', adminOnly, (req, res) => {
    try {
      res.json({ ok: true, features: duct.setFeatures(req.body) })
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
    // Optional scope: ?formats=pdf,docx and/or ?under=/path/to/folder
    const formats = typeof req.query.formats === 'string' && req.query.formats ? req.query.formats.split(',') as DocumentFormat[] : undefined
    const under = typeof req.query.under === 'string' && req.query.under ? req.query.under : undefined
    try {
      const results = await duct.search(q, topK, filter, formats || under ? { formats, under } : undefined)
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
    res.sendFile(doc.path, { dotfiles: 'allow', headers: { 'Cache-Control': 'no-store' } })
  })

  // Runs OCR on one document now (OCR is otherwise off by default because it is slow).
  app.post('/api/ocr', needs('ocrOnDemand'), async (req, res) => {
    const doc = typeof req.body?.path === 'string' ? duct.getDocument(req.body.path) : undefined
    if (!doc || doc.source === 'url') { res.status(404).json({ error: 'Document not found' }); return }
    try {
      const result = await duct.index(doc.path, undefined, { ocr: true, force: true })
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

  app.get('/api/export', needs('export'), async (req, res) => {
    const q = req.query.q as string
    const format = req.query.format as string || 'json'
    if (!q) { res.status(400).json({ error: 'Query parameter "q" is required' }); return }
    try {
      const results = await duct.search(q, 100)
      const mapped = results.map(r => ({
        score: r.score,
        document: r.chunk.documentPath,
        heading: r.chunk.heading || null,
        content: r.chunk.content.slice(0, 2000),
      }))
      if (format === 'csv') {
        const header = 'score,document,heading,content\n'
        const rows = mapped.map(r =>
          `"${r.score}","${(r.document || '').replace(/"/g, '""')}","${(r.heading || '').replace(/"/g, '""')}","${r.content.replace(/"/g, '""').replace(/\n/g, '\\n')}"`
        ).join('\n')
        res.type('text/csv').send(header + rows)
      } else {
        res.json({ results: mapped })
      }
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

