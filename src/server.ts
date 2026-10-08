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
import { isUrl } from './extract/web.js'
import { addToLibrary, defaultLibraryDir } from './library.js'
import { VERSION } from './version.js'

// Mascot art ships with the package; the dotLottie player and its wasm are served
// locally (never from a CDN) so the UI works offline.
const mascotDir = fileURLToPath(new URL('../assets/mascot', import.meta.url))
const lottiePlayerDir = dirname(createRequire(import.meta.url).resolve('@lottiefiles/dotlottie-web'))

const VALID_EXTS = new Set(['.pdf', '.docx', '.md', '.markdown', '.html', '.htm', '.txt', '.csv', '.json', '.log', '.xml', '.xlsx', '.pptx', '.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.gif', '.webp'])

function parseMetadata(raw: unknown): Record<string, unknown> | undefined {
  if (!raw) return undefined
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); if (typeof p === 'object' && p !== null && !Array.isArray(p)) return p } catch {}
  }
  return undefined
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1']
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

export interface ServerOptions {
  /** Require this token (Bearer header or login cookie) on every /api request. */
  authToken?: string
  uploadLimitMb?: number
  /** Directories POST /api/watch may watch (and their subfolders). Empty or unset disables watching through the API. */
  watchRoots?: string[]
  /** Hostnames accepted in the Host header. Defaults to loopback names; '*' accepts any (only with authToken). */
  allowedHosts?: string[] | '*'
  /** Where uploaded files are kept. Defaults to ~/Duct Library; created on first upload. */
  libraryDir?: string
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
      if (VALID_EXTS.has(ext)) return cb(null, true)
      cb(new Error(`Unsupported file type: ${ext}. Allowed: ${[...VALID_EXTS].join(', ')}`))
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

  function auth(req: express.Request, res: express.Response, next: express.NextFunction): void {
    if (!token) return next()
    const header = req.headers['authorization']
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined
    const cookie = readCookie(req.headers.cookie, 'duct_token')
    if ((bearer && sameToken(bearer, token)) || (cookie && sameToken(cookie, token))) return next()
    res.status(401).json({ error: 'Unauthorized. Provide a valid Bearer token.' })
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

  app.use(express.json({ limit: '10mb' }))
  app.use('/api/', apiLimiter)

  // Browser login: exchanges the token for an HttpOnly cookie so the UI works on a protected server.
  app.post('/api/login', (req, res) => {
    if (!token) { res.json({ ok: true }); return }
    const given = typeof req.body?.token === 'string' ? req.body.token : ''
    if (!given || !sameToken(given, token)) { res.status(401).json({ error: 'Invalid token.' }); return }
    const secure = req.secure ? '; Secure' : ''
    res.setHeader('Set-Cookie', `duct_token=${encodeURIComponent(given)}; HttpOnly; SameSite=Strict; Path=/${secure}`)
    res.json({ ok: true })
  })

  app.use('/api/', auth)

  app.post('/api/index', (req, res) => {
    const url = req.body?.url
    const bodyMeta = parseMetadata(req.body?.metadata)
    if (url !== undefined) {
      if (typeof url !== 'string' || !isUrl(url)) {
        res.status(400).json({ error: 'The "url" field must be an http(s) URL.' })
        return
      }
      duct.index(url, bodyMeta).then(r => res.json({ results: [{ file: url, ...r }] })).catch(e => res.status(500).json({ error: e.message }))
      return
    }
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
    const topK = parseInt(req.query.topK as string) || 10
    const filter = parseMetadata(req.query.filter as string)
    try {
      const results = await duct.search(q, topK, filter)
      res.json({ results })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.post('/api/ask', async (req, res) => {
    const { question, topK = 5, agentic } = req.body
    if (!question) { res.status(400).json({ error: 'Question is required' }); return }
    try {
      const result = agentic ? await duct.agenticSearch(question) : await duct.ask(question, topK)
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
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

  app.delete('/api/documents', async (req, res) => {
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
  app.post('/api/ocr', async (req, res) => {
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

  app.delete('/api/sources', async (req, res) => {
    const path = req.query.path as string
    if (!path || !duct.listSources().some(s => s.path === path)) { res.status(404).json({ error: 'Not a watched folder' }); return }
    try {
      await duct.removeSource(path)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.get('/api/config', (_req, res) => {
    const cfg = duct.getConfig()
    const sanitized = { ...cfg, openaiKey: '', geminiKey: '', cohereKey: '', voyageKey: '', mistralKey: '', jinaKey: '' }
    res.json(sanitized)
  })

  app.put('/api/config', (req, res) => {
    try {
      duct.configure(req.body)
      const cfg = duct.getConfig()
      const sanitized = { ...cfg, openaiKey: '', geminiKey: '', cohereKey: '', voyageKey: '', mistralKey: '', jinaKey: '' }
      res.json({ ok: true, config: sanitized })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  app.get('/api/stats', (_req, res) => {
    res.json(duct.stats())
  })

  app.delete('/api/clear', async (_req, res) => {
    try {
      await duct.clear()
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.get('/api/export', async (req, res) => {
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

  app.get('/api/diff', async (req, res) => {
    const path = req.query.path as string
    if (!path) { res.status(400).json({ error: 'Path is required' }); return }
    try {
      const d = await duct.diff(path)
      res.json({ diff: d })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.post('/api/extract', async (req, res) => {
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

  app.post('/api/watch', (req, res) => {
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

  app.post('/api/unwatch', (_req, res) => {
    try {
      duct.unwatch()
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.use('/mascot', express.static(mascotDir, { maxAge: '1d' }))
  app.get('/vendor/dotlottie/index.js', (_req, res) => res.sendFile(join(lottiePlayerDir, 'index.js')))
  app.get('/vendor/dotlottie/dotlottie-player.wasm', (_req, res) => res.sendFile(join(lottiePlayerDir, 'dotlottie-player.wasm')))

  app.get('*', (_req, res) => {
    res.type('html').send(html.replace('__DUCT_VERSION__', VERSION))
  })

  return app
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Duct — Local Search Engine</title>
  
  <!-- Open Graph Social Preview -->
  <meta property="og:title" content="Duct — Local Document Intelligence">
  <meta property="og:description" content="Extract, chunk, embed, search, and ask — document intelligence in one command.">
  <meta property="og:image" content="https://duct.docfide.com/assets/social-preview.png">
  <meta name="twitter:card" content="summary_large_image">

<style>
* { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --black:    #0C0C0B;
  --s1:       #111110;
  --s2:       #181816;
  --s3:       #202020;
  --border:   #252522;
  --border2:  #333330;
  --muted:    #555552;
  --subtle:   #888883;
  --body:     #C8C7C0;
  --text:     #F0EFE8;
  --lime:     #A3E635;
  --lime-d:   #6AAA10;
  --lime-bg:  #141A06;
  --lime-h:   #B8F040;
  --success:  #4ABA80;
  --warning:  #E8A020;
  --danger:   #E05555;
  --info:     #5090E0;
  --mono: 'SF Mono','Fira Code','Cascadia Code','Consolas',monospace;
  --sans: -apple-system,BlinkMacSystemFont,'Inter',sans-serif;
  --r: 6px;
  --rl: 10px;
}

body { background: var(--black); color: var(--text); font-family: var(--sans); min-height: 100vh; overflow-x: hidden; }

.root { display: flex; flex-direction: column; min-height: 100vh; }

.top-bar { background: var(--s1); border-bottom: 1px solid var(--border); padding: 16px 28px; display: flex; align-items: center; justify-content: space-between; }
.top-left { display: flex; align-items: center; gap: 14px; }
.mark-wrap { width: 36px; height: 36px; background: var(--black); border-radius: 8px; border: 1px solid var(--border2); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.wordmark { font-family: var(--mono); font-size: 20px; font-weight: 600; color: var(--text); letter-spacing: -0.5px; }
.wordmark span { color: var(--lime); }
.ds-tag { font-family: var(--mono); font-size: 9px; color: var(--muted); letter-spacing: 2.5px; }
.version { font-family: var(--mono); font-size: 10px; color: var(--muted); background: var(--s2); border: 1px solid var(--border); padding: 4px 10px; border-radius: 4px; }

.body { padding: 24px 28px; display: grid; grid-template-columns: 320px 1fr; gap: 32px; flex: 1; align-items: flex-start; }

.sec-label { font-family: var(--mono); font-size: 9px; letter-spacing: 2.5px; color: var(--muted); text-transform: uppercase; padding-bottom: 8px; border-bottom: 1px solid var(--border); margin-bottom: 16px; display: flex; justify-content: space-between; align-items: baseline; }

.sidebar { display: flex; flex-direction: column; gap: 24px; position: sticky; top: 24px; }
.main { display: flex; flex-direction: column; gap: 24px; }

/* COMPONENT: CLI-LIKE BLOCK */
.cli { background: var(--black); border: 1px solid var(--border); border-radius: var(--rl); overflow: hidden; }
.cli-bar { background: var(--s2); padding: 9px 14px; display: flex; align-items: center; gap: 6px; border-bottom: 1px solid var(--border); }
.cli-dot { width: 9px; height: 9px; border-radius: 50%; }
.cli-title { font-family: var(--mono); font-size: 10px; color: var(--muted); margin-left: 6px; }
.cli-body { padding: 16px; font-family: var(--mono); font-size: 12px; line-height: 2; }
.cp { color: var(--lime); }
.cc { color: var(--text); }
.cd { color: var(--muted); }
.cl { color: var(--lime); }

/* COMPONENT: CELL */
.cell { background: var(--s2); border: 1px solid var(--border); padding: 20px; border-radius: var(--rl); display: flex; flex-direction: column; gap: 12px; }

/* BADGES */
.badge { font-family: var(--mono); font-size: 9px; font-weight: 500; padding: 3px 7px; border-radius: 4px; display: inline-block; letter-spacing: 0.5px; border: 1px solid; }
.b-lime { background: var(--lime-bg); color: var(--lime); border-color: var(--lime-d); }
.b-ok   { background: #0A2018; color: var(--success); border-color: #1A4A30; }
.b-warn { background: #1E1408; color: var(--warning); border-color: #4A3008; }
.b-err  { background: #1E0808; color: var(--danger); border-color: #3A1818; }
.b-info { background: #0A1830; color: var(--info); border-color: #183060; }
.b-mute { background: var(--s3); color: var(--subtle); border-color: var(--border); }

/* BUTTONS */
.btn { font-family: var(--mono); font-size: 11px; font-weight: 500; padding: 7px 16px; border-radius: var(--r); border: 1px solid; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; transition: all .2s; }
.btn-p { background: var(--lime); color: #0C0C0B; border-color: var(--lime); }
.btn-p:hover { background: var(--lime-h); border-color: var(--lime-h); }
.btn-g { background: transparent; color: var(--body); border-color: var(--border2); }
.btn-g:hover { border-color: var(--subtle); color: var(--text); }
.btn-d { background: transparent; color: var(--danger); border-color: #3A1818; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* SEARCH BOX */
.search-box { background: var(--black); border: 1px solid var(--border2); border-radius: var(--r); padding: 12px 16px; display: flex; align-items: center; gap: 12px; transition: border-color .2s; }
.search-box:focus-within { border-color: var(--lime); }
.search-icon { color: var(--lime); font-size: 16px; font-family: var(--mono); }
.search-input { flex: 1; background: transparent; border: none; color: var(--text); font-family: var(--mono); font-size: 14px; outline: none; }
.search-input::placeholder { color: var(--muted); }

/* RESULTS */
.result { background: var(--s1); border: 1px solid var(--border); border-radius: var(--r); padding: 16px; cursor: pointer; transition: border-color .2s; margin-bottom: 8px; }
.result:hover { border-color: var(--border2); }
.r-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.r-score { font-family: var(--mono); font-size: 12px; color: var(--lime); font-weight: 600; min-width: 36px; }
.r-file { font-family: var(--mono); font-size: 12px; color: var(--text); font-weight: 500; word-break: break-all; }
.r-section { font-family: var(--mono); font-size: 11px; color: var(--muted); }
.r-ext { margin-left: auto; }
.r-snippet { font-size: 13px; color: var(--body); line-height: 1.7; }
.r-snippet mark { background: #1E2A06; color: var(--lime); border-radius: 2px; padding: 0 2px; font-style: normal; }
.r-full { display: none; padding-top: 12px; border-top: 1px solid var(--border); margin-top: 12px; white-space: pre-wrap; font-size: 12px; color: var(--subtle); font-family: var(--mono); line-height: 1.6; }
.result.expanded .r-snippet { display: none; }
.result.expanded .r-full { display: block; }

/* CHAT */
.chat-panel { background: var(--s1); border: 1px solid var(--border); border-radius: var(--rl); display: flex; flex-direction: column; overflow: hidden; }
.chat-msgs { padding: 20px; display: flex; flex-direction: column; gap: 16px; max-height: 400px; overflow-y: auto; }
.msg { padding: 12px 16px; border-radius: var(--r); font-size: 13px; line-height: 1.6; max-width: 85%; }
.msg.q { background: var(--s2); border: 1px solid var(--border); color: var(--text); align-self: flex-end; }
.msg.a { background: transparent; color: var(--body); align-self: flex-start; max-width: 100%; border-left: 2px solid var(--lime); border-radius: 0; padding-left: 14px; }
.msg .source { font-size: 11px; color: var(--subtle); margin-top: 10px; border-top: 1px dotted var(--border); padding-top: 8px; font-family: var(--mono); }
.msg .source a { color: var(--lime); text-decoration: none; }
.chat-input-area { border-top: 1px solid var(--border); padding: 12px 20px; display: flex; gap: 10px; align-items: center; background: var(--black); }
.chat-input-area input { flex: 1; background: transparent; border: none; color: var(--text); font-family: var(--mono); font-size: 13px; outline: none; }

/* FORMS / UPLOAD */
.drop-zone { border: 1px dashed var(--border2); border-radius: var(--r); padding: 24px; text-align: center; cursor: pointer; transition: border-color .2s; }
.drop-zone:hover, .drop-zone.dragover { border-color: var(--lime); }
.drop-zone .t-ui { margin-top: 8px; }
.upload-file { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-family: var(--mono); font-size: 10px; color: var(--muted); }
.upload-file .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.inline-form { display: flex; gap: 8px; }
.inline-form input { flex: 1; background: var(--black); border: 1px solid var(--border); border-radius: var(--r); padding: 8px 12px; color: var(--text); font-family: var(--mono); font-size: 11px; outline: none; }
.inline-form input:focus { border-color: var(--border2); }

.field-group { display: flex; flex-direction: column; gap: 6px; }
.field-group label { font-family: var(--mono); font-size: 10px; color: var(--subtle); text-transform: uppercase; letter-spacing: 1px; }
.field-group select, .field-group input { background: var(--black); border: 1px solid var(--border); border-radius: var(--r); padding: 8px 10px; color: var(--text); font-family: var(--mono); font-size: 12px; outline: none; }
.field-group input[type="checkbox"] { width: auto; accent-color: var(--lime); }

.doc-item { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--border); font-family: var(--mono); font-size: 10px; }
.doc-item:last-child { border-bottom: none; }
.doc-item .name { flex: 1; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.doc-item .meta { color: var(--muted); }

.toast { position: fixed; bottom: 24px; right: 24px; background: var(--lime); color: var(--black); padding: 12px 20px; border-radius: var(--r); font-family: var(--mono); font-size: 11px; font-weight: 500; opacity: 0; transition: opacity .3s; pointer-events: none; z-index: 100; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
.toast.show { opacity: 1; }
.toast.error { background: var(--danger); color: #fff; }

.t-ui { font-family: var(--mono); font-size: 12px; color: var(--body); }

/* RESULT ACTIONS */
.r-actions { display: flex; gap: 8px; margin-top: 10px; }
.r-actions .btn { padding: 3px 10px; font-size: 10px; }
.r-page { margin-left: 4px; }

/* MASCOT */
.mascot { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 24px 16px 32px; text-align: center; }
.mascot canvas, .mascot img { width: 180px; height: 180px; }
.mascot-caption { font-family: var(--mono); font-size: 12px; color: var(--subtle); max-width: 360px; line-height: 1.6; }
</style>
</head>
<body>
<div class="root">
  <div class="top-bar">
    <div class="top-left">
      <div class="mark-wrap">
        <svg width="20" height="20" viewBox="0 0 30 30" fill="none">
          <line x1="4" y1="9"  x2="16" y2="9"  stroke="#333330" stroke-width="2" stroke-linecap="round"/>
          <line x1="4" y1="15" x2="22" y2="15" stroke="#A3E635" stroke-width="2.2" stroke-linecap="round"/>
          <line x1="4" y1="21" x2="12" y2="21" stroke="#333330" stroke-width="2" stroke-linecap="round"/>
          <path d="M24 12 L28 15 L24 18" stroke="#A3E635" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        </svg>
      </div>
      <div>
        <div class="wordmark">d<span>u</span>ct</div>
        <div class="ds-tag">LOCAL SEARCH ENGINE</div>
      </div>
    </div>
    <div class="version">v__DUCT_VERSION__</div>
  </div>

  <div class="body">
    <!-- LEFT SIDEBAR -->
    <aside class="sidebar">
      
      <div class="cli">
        <div class="cli-bar">
          <div class="cli-dot" style="background:#E05555;"></div>
          <div class="cli-dot" style="background:#E8A020;"></div>
          <div class="cli-dot" style="background:#4ABA80;"></div>
          <div class="cli-title">duct — dashboard</div>
        </div>
        <div class="cli-body">
          <div><span class="cl">✓</span> <span class="cd">indexed</span>  <span class="cc" id="docCount">0</span> <span class="cd">files,</span> <span class="cc" id="chunkCount">0</span> <span class="cd">chunks</span></div>
          <div><span class="cl">✓</span> <span class="cd">engine</span>   <span class="cl" id="engineMode">bm25</span></div>
          <div id="activityLine" class="cd" style="display:none;"></div>
        </div>
      </div>

      <div class="cell">
        <div class="sec-label">Ingest</div>
        
        <div class="drop-zone" id="dropZone">
          <div style="font-size:20px;margin-bottom:8px">📄</div>
          <div class="t-ui">Drop files here</div>
          <div style="font-size:10px;color:var(--muted);margin-top:4px;font-family:var(--mono);">pdf, docx, xlsx, pptx, md, csv, json, txt, images</div>
        </div>
        <input type="file" id="fileInput" multiple accept=".pdf,.docx,.md,.markdown,.html,.htm,.txt,.csv,.json,.log,.xml,.xlsx,.pptx,.png,.jpg,.jpeg,.tiff,.tif,.bmp,.gif,.webp" style="display:none;" />
        <div id="uploadProgress" style="margin-top:8px;"></div>

        <div class="inline-form" style="margin-top:8px;">
          <input type="text" id="urlInput" placeholder="https://docs.example.com" />
          <button class="btn btn-g" onclick="indexUrl()">Index URL</button>
        </div>

        <div class="inline-form" style="margin-top:8px;">
          <input type="text" id="watchInput" placeholder="/absolute/path/to/dir" />
          <button class="btn btn-g" id="watchBtn" onclick="watchDir()">Watch</button>
        </div>
        <div id="watchHint" style="display:none;margin-top:6px;font-family:var(--mono);font-size:10px;color:var(--muted);">Start the server with --watch-root &lt;dir&gt; to watch folders.</div>
        <div id="watchList" style="margin-top:8px;"></div>
      </div>

      <div class="cell">
        <div class="sec-label">
          <span>Documents</span>
          <span style="color:var(--lime);cursor:pointer;" onclick="toggleDocs()">[show]</span>
        </div>
        <div id="docList" style="display:none; max-height:200px; overflow-y:auto;">
          <div id="docEmpty" style="font-family:var(--mono);font-size:10px;color:var(--muted);">No documents indexed.</div>
          <div id="docItems"></div>
        </div>
      </div>

      <div class="cell">
        <div class="sec-label" id="settings">Search Settings</div>
        
        <div class="field-group">
          <label>Search Engine</label>
          <select id="cfgSearchMode" onchange="saveSearchConfig()">
            <option value="bm25">BM25 (Keyword)</option>
            <option value="vector">Vector (Semantic)</option>
            <option value="hybrid">Hybrid (BM25 + Vector)</option>
          </select>
        </div>
        <div class="field-group">
          <label style="display:flex;align-items:center;gap:8px;text-transform:none;letter-spacing:0;"><input type="checkbox" id="cfgMascot" onchange="setMascotEnabled(this.checked)" /> Show mascot</label>
        </div>
      </div>

      <div class="cell">
        <div class="sec-label">Embed Provider</div>

        <div class="field-group">
          <label>Provider</label>
          <select id="cfgEmbedProvider" onchange="toggleEmbedFields(); saveEmbedConfig()">
            <option value="">Auto (from API keys)</option>
            <option value="openai">OpenAI</option>
            <option value="gemini">Gemini</option>
            <option value="cohere">Cohere</option>
            <option value="voyage">Voyage AI</option>
            <option value="mistral">Mistral</option>
            <option value="jina">Jina AI</option>
            <option value="ollama">Ollama (Local)</option>
            <option value="openai-compatible">OpenAI-Compatible</option>
          </select>
        </div>
        <div class="field-group">
          <label>Model</label>
          <input type="text" id="cfgEmbedModel" placeholder="text-embedding-3-small" onchange="saveEmbedConfig()" />
        </div>
        <div class="field-group" id="embedBaseUrlGroup" style="display:none;">
          <label>Base URL</label>
          <input type="text" id="cfgEmbedBaseUrl" placeholder="http://localhost:11434" onchange="saveEmbedConfig()" />
        </div>
      </div>

      <div class="cell">
        <div class="sec-label">LLM Settings</div>
        
        <div class="field-group">
          <label>Provider</label>
          <select id="cfgLLMProvider" onchange="saveLLMConfig()">
            <option value="none">None</option>
            <option value="ollama">Ollama (Local)</option>
            <option value="openai">OpenAI</option>
            <option value="gemini">Gemini</option>
          </select>
        </div>
        <div class="field-group">
          <label>Model</label>
          <input type="text" id="cfgLLMModel" placeholder="llama3.2" onchange="saveLLMConfig()" />
        </div>
        <div class="field-group">
          <label>Base URL</label>
          <input type="text" id="cfgLLMBaseUrl" placeholder="http://localhost:11434 (Ollama)" onchange="saveLLMConfig()" />
        </div>
        <div class="field-group">
          <label>API Key</label>
          <input type="password" id="cfgLLMKey" placeholder="For OpenAI or Gemini. Not saved to disk" autocomplete="off" onchange="saveLLMConfig()" />
        </div>
      </div>

    </aside>

    <!-- MAIN CONTENT -->
    <main class="main" style="display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 24px; align-items: start;">
      
      <div class="main-col">
        <!-- SEARCH PANEL -->
        <div>
          <div class="sec-label">
            <span>Search Engine</span>
            <div style="display:flex;gap:8px;">
              <button class="btn btn-g" style="padding:2px 8px;font-size:9px;" onclick="exportResults()">EXPORT CSV</button>
              <button class="btn btn-d" style="padding:2px 8px;font-size:9px;" onclick="clearAll()">CLEAR INDEX</button>
            </div>
          </div>
          
          <div class="search-box">
            <span class="search-icon">⌕</span>
            <input type="text" class="search-input" id="searchInput" placeholder="Query indexed documents (e.g., 'termination clause')" />
            <button class="btn btn-p" id="searchBtn">Search</button>
          </div>

          <div id="mascot" class="mascot" style="margin-top:16px;">
            <canvas id="mascotCanvas" width="360" height="360" aria-hidden="true"></canvas>
            <img id="mascotImg" alt="" style="display:none;" />
            <div id="mascotCaption" class="mascot-caption" role="status"></div>
          </div>
          <div id="results" style="margin-top:16px;"></div>
        </div>

        <!-- ASK PANEL -->
        <div style="margin-top:32px;">
          <div class="sec-label">Agentic QA</div>
          <div class="chat-panel">
            <div class="chat-msgs" id="chatMessages">
              <div class="msg a">
                Ask questions about your documents. Make sure you configure an LLM provider in the settings.
              </div>
            </div>
            <div class="chat-input-area">
              <span style="color:var(--lime);font-family:var(--mono);">></span>
              <input type="text" id="chatInput" placeholder="What is the termination policy?" />
              <button class="btn btn-p" id="askBtn">Ask</button>
            </div>
          </div>
        </div>
      </div>

      <!-- READER PANEL -->
      <aside class="reader-panel cell" style="position: sticky; top: 24px; height: calc(100vh - 120px); overflow-y: auto;">
        <div class="sec-label">Document Reader</div>
        <div id="docViewer" style="display:none;">
          <div class="r-head" style="margin-bottom:16px;">
             <span class="r-file" id="viewerTitle" style="font-size:14px;"></span>
             <span class="badge b-mute r-ext" id="viewerExt"></span>
          </div>
          <div id="viewerContent" class="t-ui" style="line-height:1.7; white-space:pre-wrap;"></div>
        </div>
        <div id="viewerEmpty" style="text-align:center;padding:40px;font-family:var(--mono);font-size:10px;color:var(--muted);">
          Click a result to read it here.
        </div>
      </aside>

    </main>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
  let indexing = false
  let searchMode = 'bm25'

  // On a token-protected server, ask for the token once, exchange it for a login cookie, and retry.
  const rawFetch = window.fetch.bind(window)
  let loginPromise = null
  async function login() {
    const given = window.prompt('This Duct server needs an access token:')
    if (!given) throw new Error('Access token required')
    const res = await rawFetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: given }) })
    if (!res.ok) throw new Error('Invalid access token')
  }
  window.fetch = async (input, init) => {
    const res = await rawFetch(input, init)
    if (res.status !== 401 || String(input).startsWith('/api/login')) return res
    loginPromise = loginPromise || login().finally(() => { loginPromise = null })
    await loginPromise
    return rawFetch(input, init)
  }

  // Mascot: animation ids inside /mascot/mascot.lottie, and the static SVG used if the player can't load.
  const MASCOT_POSES = {
    welcome: ['Pose - Welcome', 'pose-welcome.svg'],
    working: ['Pose - Working', 'pose-working.svg'],
    done: ['Pose - Done', 'pose-done.svg'],
    nothingFound: ['Pose - Nothing Found', 'pose-nothing-found.svg'],
    needsHand: ['Pose - Needs a Hand', 'pose-needs-a-hand.svg'],
    resting: ['Pose - Resting', 'pose-resting.svg'],
  }
  let mascotPlayer = null
  let mascotPose = 'welcome'
  let mascotFallback = false

  function showMascot(pose, caption) {
    document.getElementById('results').innerHTML = ''
    document.getElementById('mascot').style.display = 'flex'
    document.getElementById('mascotCaption').textContent = caption
    if (pose === mascotPose && (mascotPlayer || mascotFallback)) { if (mascotPlayer && mascotPlayer.autoplay) mascotPlayer.play(); return }
    mascotPose = pose
    if (mascotPlayer) mascotPlayer.loadAnimation(MASCOT_POSES[pose][0])
    else if (mascotFallback) document.getElementById('mascotImg').src = '/mascot/' + MASCOT_POSES[pose][1]
  }

  function hideMascot() {
    document.getElementById('mascot').style.display = 'none'
    if (mascotPlayer) mascotPlayer.pause()
  }

  function mascotReady(player) {
    mascotPlayer = player
    if (player.activeAnimationId !== MASCOT_POSES[mascotPose][0]) player.loadAnimation(MASCOT_POSES[mascotPose][0])
  }

  function useMascotFallback() {
    if (mascotFallback) return
    mascotFallback = true
    mascotPlayer = null
    document.getElementById('mascotCanvas').style.display = 'none'
    const img = document.getElementById('mascotImg')
    img.src = '/mascot/' + MASCOT_POSES[mascotPose][1]
    img.style.display = 'block'
  }

  async function showIdleMascot() {
    const stats = await refreshStats()
    if (!stats || stats.documents === 0) showMascot('welcome', 'Drop files or watch a folder to start searching.')
    else showMascot('resting', 'Ready to search ' + stats.documents + ' document' + (stats.documents === 1 ? '' : 's') + '.')
  }

  document.getElementById('fileInput').addEventListener('change', handleFiles)
  document.getElementById('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') search() })
  document.getElementById('searchBtn').addEventListener('click', search)
  document.getElementById('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendQuestion() })
  document.getElementById('askBtn').addEventListener('click', sendQuestion)

  const dropZone = document.getElementById('dropZone')
  dropZone.addEventListener('dragenter', e => { e.preventDefault(); dropZone.classList.add('dragover') })
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover') })
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'))
  dropZone.addEventListener('drop', async e => {
    e.preventDefault(); e.stopPropagation()
    dropZone.classList.remove('dragover')
    const files = e.dataTransfer?.files
    if (files && files.length > 0) await handleFilesDrop(files)
  })
  dropZone.addEventListener('click', () => document.getElementById('fileInput').click())

  function toggleDocs() {
    const dl = document.getElementById('docList')
    dl.style.display = dl.style.display === 'none' ? 'block' : 'none'
  }

  async function handleFiles(e) { const files = e.target.files; if (files) await uploadFiles(files); e.target.value = ''; }
  async function handleFilesDrop(files) { await uploadFiles(files) }

  async function uploadFiles(files) {
    if (!files.length || indexing) return
    indexing = true
    const progress = document.getElementById('uploadProgress')
    progress.innerHTML = ''
    const errors = []
    const list = Array.from(files)
    showMascot('working', 'Indexing ' + list.length + ' file' + (list.length === 1 ? '' : 's') + '…')

    const showFile = (f, status, cls) => {
      const div = document.createElement('div')
      div.className = 'upload-file'
      div.innerHTML = '<span class="name">' + esc(f.name) + '</span><span class="status ' + cls + '">' + status + '</span>'
      progress.appendChild(div)
    }

    for (const f of list) showFile(f, 'Uploading...', '')

    const setStatus = (i, text, color) => {
      const status = progress.children[i].querySelector('.status')
      status.textContent = text
      if (color) status.style.color = color
    }

    // Several files per request keeps large drops well under the API rate limit.
    const BATCH = 10
    for (let start = 0; start < list.length; start += BATCH) {
      const batch = list.slice(start, start + BATCH)
      const formData = new FormData()
      batch.forEach((f, j) => { formData.append('files', f); setStatus(start + j, 'Indexing...') })
      try {
        const res = await fetch('/api/index', { method: 'POST', body: formData })
        const data = await res.json()
        if (data.error) throw new Error(data.error)
        batch.forEach((f, j) => {
          const r = (data.results || [])[j] || {}
          if (r.duplicateOf) setStatus(start + j, 'Already indexed as ' + r.duplicateOf, 'var(--subtle)')
          else if (r.failed) { setStatus(start + j, "Couldn't read", 'var(--danger)'); errors.push(f.name) }
          else if (r.documents && !r.chunks) setStatus(start + j, 'No text found (OCR?)', 'var(--warning)')
          else setStatus(start + j, 'OK', 'var(--success)')
        })
      } catch (err) {
        batch.forEach((f, j) => { setStatus(start + j, 'Err: ' + err.message, 'var(--danger)'); errors.push(f.name + ': ' + err.message) })
      }
    }

    indexing = false
    refreshStats()
    refreshDocs()
    if (errors.length === 0) {
      toast('All files indexed')
      showMascot('done', 'All ' + list.length + ' file' + (list.length === 1 ? '' : 's') + ' indexed. Try a search.')
    } else {
      toast(errors.length + ' file(s) failed', true)
      showMascot('needsHand', errors.length + ' of ' + list.length + ' file' + (list.length === 1 ? '' : 's') + " couldn't be read. Details are listed under Ingest.")
    }
  }

  async function indexUrl() {
    const url = document.getElementById('urlInput').value.trim()
    if (!url) return
    try {
      const res = await fetch('/api/index', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })
      const data = await res.json()
      if (data.error) { toast('Error: ' + data.error, true); return }
      document.getElementById('urlInput').value = ''
      toast('Indexed: ' + url)
      refreshStats()
      refreshDocs()
    } catch (err) { toast('Error: ' + err.message, true) }
  }

  // Desktop app: folders are chosen with the native picker and watched by the main process.
  if (window.electronAPI && window.electronAPI.watchDirectory) {
    document.getElementById('watchInput').style.display = 'none'
    document.getElementById('watchBtn').textContent = 'Watch a folder…'
  }

  async function watchDir() {
    if (window.electronAPI && window.electronAPI.watchDirectory) {
      try {
        const dir = await window.electronAPI.watchDirectory()
        if (dir) { toast('Now watching ' + dir); refreshSources(); showIdleMascot(); refreshDocs() }
      } catch (e) { toast('Error: ' + e.message, true) }
      return
    }
    const dir = document.getElementById('watchInput').value.trim()
    if (!dir) return
    try {
      const res = await fetch('/api/watch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directories: [dir] })
      })
      const data = await res.json()
      if (data.ok) {
        toast('Now watching ' + dir)
        document.getElementById('watchInput').value = ''
        refreshSources()
        watchActivity()
      } else {
        toast('Error: ' + data.error, true)
      }
    } catch (e) { toast('Error: ' + e.message, true) }
  }

  async function search() {
    const q = document.getElementById('searchInput').value.trim()
    if (!q) return
    const btn = document.getElementById('searchBtn')
    btn.disabled = true; btn.textContent = '...'

    try {
      const res = await fetch('/api/search?q=' + encodeURIComponent(q) + '&topK=10')
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      if (!data.results || data.results.length === 0) {
        showMascot('nothingFound', 'No matches for "' + q + '". Try different or fewer words.')
        btn.disabled = false; btn.textContent = 'Search'; return
      }
      hideMascot()
      const div = document.getElementById('results')
      lastResults = data.results
      lastQuery = q
      div.innerHTML = data.results.map((r, i) => {
        const c = r.chunk
        const isLink = /^https?:/i.test(c.documentPath)
        const heading = c.heading ? ' <span class="r-section">› ' + esc(c.heading) + '</span>' : ''
        const page = c.page ? '<span class="badge b-lime r-page">p. ' + c.page + '</span>' : ''
        const ext = isLink ? 'url' : c.documentPath.split('.').pop()
        const snippet = r.snippet ? markSnippet(r.snippet) : highlight(c.content.slice(0, 300), q) + (c.content.length > 300 ? '…' : '')
        const reveal = !isLink && window.electronAPI && window.electronAPI.revealDocument
        return '<div class="result" data-i="' + i + '">' +
          '<div class="r-head"><span class="r-score">' + r.score.toFixed(2) + '</span><span class="r-file">' + esc(fileName(c.documentPath)) + '</span>' + page + heading + '<span class="badge b-mute r-ext">' + esc(ext) + '</span></div>' +
          '<div class="r-snippet">' + snippet + '</div>' +
          '<div class="r-actions"><button class="btn btn-g r-open" data-i="' + i + '">' + (isLink ? 'Open link' : c.page ? 'Open at p. ' + c.page : 'Open') + '</button>' +
          (reveal ? '<button class="btn btn-g r-reveal" data-i="' + i + '">Show in folder</button>' : '') + '</div>' +
          '<div class="r-full" style="display:none;">' + highlight(c.content, q) + '</div>' +
          '</div>'
      }).join('')
    } catch (err) {
      showMascot('needsHand', 'Search failed: ' + err.message)
    }
    btn.disabled = false; btn.textContent = 'Search'
  }

  async function sendQuestion() {
    const input = document.getElementById('chatInput')
    const q = input.value.trim()
    if (!q) return
    const btn = document.getElementById('askBtn')
    const msgs = document.getElementById('chatMessages')
    input.value = ''

    msgs.appendChild(el('div', 'msg q', q))
    const thinking = el('div', 'msg a', '<span style="color:var(--muted)">Thinking...</span>')
    msgs.appendChild(thinking)
    msgs.scrollTop = msgs.scrollHeight
    btn.disabled = true; btn.textContent = '...'

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, agentic: false }),
      })
      const data = await res.json()
      thinking.remove()

      if (data.error) {
        msgs.appendChild(el('div', 'msg a', '<span style="color:var(--danger)">Error:</span> ' + esc(data.error)))
      } else {
        const answerDiv = el('div', 'msg a', '')
        // LLM output can echo document text, so it is always escaped before display.
        const answerText = esc(data.answer || '').replace(/\\n/g, '<br>')
        let sourcesHtml = '<div class="source"><strong>SOURCES</strong><br>'
        for (const s of (data.sources || []).slice(0, 5)) {
          sourcesHtml += '<a href="#" class="source-link" data-path="' + esc(s.documentPath) + '">' + esc(s.documentPath.split('/').pop() || s.documentPath) + '</a> <span style="color:var(--muted)">[' + s.score.toFixed(2) + ']</span><br>'
        }
        sourcesHtml += '</div>'
        answerDiv.innerHTML = answerText + sourcesHtml
        msgs.appendChild(answerDiv)
      }
    } catch (err) {
      thinking.remove()
      msgs.appendChild(el('div', 'msg a', '<span style="color:var(--danger)">Error:</span> ' + esc(err.message)))
    }

    msgs.scrollTop = msgs.scrollHeight
    btn.disabled = false; btn.textContent = 'Ask'
  }

  document.getElementById('chatMessages').addEventListener('click', e => {
    const link = e.target.closest('.source-link')
    if (link) {
      e.preventDefault()
      document.getElementById('searchInput').value = link.getAttribute('data-path') || ''
      search()
    }
  })

  let lastResults = []
  let lastQuery = ''

  function fileName(p) { return p.split('/').pop().split(String.fromCharCode(92)).pop() || p }

  // Snippets come from the server with matches wrapped in \u0002 … \u0003; escape first, then mark.
  function markSnippet(s) { return esc(s).replace(/\u0002/g, '<mark>').replace(/\u0003/g, '</mark>') }

  document.getElementById('results').addEventListener('click', e => {
    const open = e.target.closest('.r-open')
    const reveal = e.target.closest('.r-reveal')
    if (open) { e.stopPropagation(); openResult(lastResults[Number(open.dataset.i)]); return }
    if (reveal) { e.stopPropagation(); window.electronAPI.revealDocument(lastResults[Number(reveal.dataset.i)].chunk.documentPath); return }
    const card = e.target.closest('.result')
    if (card) viewResult(card)
  })

  async function openResult(r) {
    if (!r) return
    const path = r.chunk.documentPath
    const page = r.chunk.page
    if (/^https?:/i.test(path)) { window.open(path, '_blank', 'noopener'); return }
    if (window.electronAPI && window.electronAPI.openDocument) {
      if (!(await window.electronAPI.openDocument(path, page))) toast("Couldn't open " + fileName(path), true)
      return
    }
    window.open('/api/file/' + encodeURIComponent(fileName(path)) + '?path=' + encodeURIComponent(path) + (page ? '#page=' + page : ''), '_blank', 'noopener')
  }

  function viewResult(el) {
    document.querySelectorAll('.result').forEach(r => r.style.borderColor = 'var(--border)');
    el.style.borderColor = 'var(--lime)';
    const r = lastResults[Number(el.dataset.i)];
    const file = el.querySelector('.r-file').textContent + (r && r.chunk.page ? ' · p. ' + r.chunk.page : '');
    const ext = el.querySelector('.r-ext') ? el.querySelector('.r-ext').textContent : '';
    const content = el.querySelector('.r-full').innerHTML;
    document.getElementById('viewerEmpty').style.display = 'none';
    document.getElementById('docViewer').style.display = 'block';
    document.getElementById('viewerTitle').textContent = file;
    document.getElementById('viewerExt').textContent = ext;
    document.getElementById('viewerContent').innerHTML = content;
  }

  async function clearAll() {
    if(!confirm('Clear all indexed documents?')) return
    await fetch('/api/clear', { method: 'DELETE' })
    showIdleMascot()
    refreshDocs()
    toast('Index cleared')
  }

  function exportResults() {
    const q = document.getElementById('searchInput').value.trim()
    if(!q) { toast('Run a search first', true); return }
    window.location.href = '/api/export?format=csv&q=' + encodeURIComponent(q)
  }

  async function refreshStats() {
    const res = await fetch('/api/stats'); const data = await res.json()
    document.getElementById('docCount').textContent = data.documents
    document.getElementById('chunkCount').textContent = data.chunks
    return data
  }

  async function refreshDocs() {
    const res = await fetch('/api/documents'); const data = await res.json()
    const docs = data.documents || []
    const empty = document.getElementById('docEmpty')
    const items = document.getElementById('docItems')
    if (docs.length === 0) {
      empty.style.display = 'block'; items.innerHTML = ''
    } else {
      empty.style.display = 'none'
      items.innerHTML = docs.map(d => {
        const name = d.displayName || d.path.split('/').pop() || d.path
        const meta = d.status === 'failed' ? '<span class="badge b-err" title="' + esc(d.error || '') + '">failed</span>'
          : d.status === 'no-text' ? (d.source === 'url' ? '<span class="badge b-warn">no text</span>'
            : '<button class="btn btn-g doc-ocr" style="padding:1px 7px;font-size:9px;" data-path="' + esc(d.path) + '" title="No text found. It may be a scan.">Run OCR</button>')
          : d.chunkCount + ' ch'
        return '<div class="doc-item"><span class="name" title="' + esc(d.path) + '">' + esc(name) + '</span><span class="meta">' + meta + '</span></div>'
      }).join('')
    }
  }

  function toggleEmbedFields() {
    const val = document.getElementById('cfgEmbedProvider').value
    const grp = document.getElementById('embedBaseUrlGroup')
    grp.style.display = (val === 'ollama' || val === 'openai-compatible') ? 'block' : 'none'
  }

  async function loadConfig() {
    try {
      const res = await fetch('/api/config'); const c = await res.json()
      document.getElementById('cfgSearchMode').value = c.searchMode || 'bm25'
      document.getElementById('engineMode').textContent = c.searchMode || 'bm25'
      
      if (c.embedProvider) document.getElementById('cfgEmbedProvider').value = c.embedProvider
      if (c.embedModel) document.getElementById('cfgEmbedModel').value = c.embedModel
      if (c.embedBaseUrl) document.getElementById('cfgEmbedBaseUrl').value = c.embedBaseUrl
      toggleEmbedFields()

      if (c.llmProvider && c.llmProvider !== 'none') {
        document.getElementById('cfgLLMProvider').value = c.llmProvider
      }
      if (c.llmModel) document.getElementById('cfgLLMModel').value = c.llmModel
      if (c.llmBaseUrl) document.getElementById('cfgLLMBaseUrl').value = c.llmBaseUrl
    } catch(e){}
  }

  async function putConfig(body, label) {
    try {
      const res = await fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status)
      toast(label + ' saved')
      return true
    } catch (err) {
      toast(label + ' not saved: ' + err.message, true)
      return false
    }
  }

  async function saveEmbedConfig() {
    const embedProvider = document.getElementById('cfgEmbedProvider').value
    const embedModel = document.getElementById('cfgEmbedModel').value
    const embedBaseUrl = document.getElementById('cfgEmbedBaseUrl').value
    await putConfig({ embedProvider, embedModel, embedBaseUrl }, 'Embedding settings')
  }

  async function saveSearchConfig() {
    const mode = document.getElementById('cfgSearchMode').value
    if (await putConfig({ searchMode: mode }, 'Search settings')) document.getElementById('engineMode').textContent = mode
  }

  async function saveLLMConfig() {
    const provider = document.getElementById('cfgLLMProvider').value
    const body = {
      llmProvider: provider,
      llmModel: document.getElementById('cfgLLMModel').value,
      llmBaseUrl: document.getElementById('cfgLLMBaseUrl').value,
    }
    // API keys are kept in memory by the server and never written to disk.
    const key = document.getElementById('cfgLLMKey').value.trim()
    if (key && provider === 'openai') body.openaiKey = key
    if (key && provider === 'gemini') body.geminiKey = key
    if (await putConfig(body, 'LLM settings')) document.getElementById('cfgLLMKey').value = ''
  }

  function toast(msg, isError) { const t = document.getElementById('toast'); t.textContent = msg; t.className = 'toast' + (isError ? ' error' : ''); t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 3000) }
  // Escapes text for HTML content and attribute values (filenames can contain quotes).
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;') }
  function el(tag, cls, html) { const d = document.createElement(tag); d.className = cls; d.innerHTML = html; return d }
  // Highlights query words in raw text and returns escaped HTML (matching before escaping keeps entities intact).
  function highlight(text, query) {
    const words = query.toLowerCase().replace(/["']/g, ' ').split(/\\s+/).filter(w => w.length > 2)
    if (!words.length) return esc(text)
    const lower = text.toLowerCase()
    const marked = new Array(text.length).fill(false)
    for (const word of words) {
      let idx = 0
      while ((idx = lower.indexOf(word, idx)) !== -1) {
        for (let i = idx; i < idx + word.length; i++) marked[i] = true
        idx++
      }
    }
    let out = ''
    let start = 0
    for (let i = 1; i <= text.length; i++) {
      if (i === text.length || marked[i] !== marked[start]) {
        const seg = esc(text.slice(start, i))
        out += marked[start] ? '<mark>' + seg + '</mark>' : seg
        start = i
      }
    }
    return out
  }

  // ---------- indexing progress ----------
  let activityTimer = null
  let wasBusy = false
  async function pollActivity() {
    try {
      const a = await (await fetch('/api/activity')).json()
      const line = document.getElementById('activityLine')
      if (a.indexing || a.embedding) {
        line.style.display = 'block'
        line.textContent = a.indexing
          ? '⟳ indexing ' + a.done + '/' + a.total + (a.current ? ' · ' + a.current : '')
          : '⟳ preparing semantic search…'
        if (!indexing && document.getElementById('mascot').style.display !== 'none') {
          showMascot('working', a.indexing ? 'Indexing ' + a.done + ' of ' + a.total + (a.current ? ': ' + a.current : '') : 'Preparing semantic search…')
        }
        wasBusy = true
        activityTimer = setTimeout(pollActivity, 1000)
        return
      }
      line.style.display = 'none'
      if (wasBusy) {
        wasBusy = false
        refreshDocs()
        if (!indexing && document.getElementById('mascot').style.display !== 'none') showIdleMascot()
        else refreshStats()
      }
    } catch {}
    activityTimer = null
  }
  function watchActivity() { if (!activityTimer) pollActivity() }
  setInterval(watchActivity, 5000)

  // ---------- watched folders ----------
  async function refreshSources() {
    try {
      const data = await (await fetch('/api/sources')).json()
      const desktop = window.electronAPI && window.electronAPI.watchDirectory
      if (!desktop && !data.canAdd) {
        document.getElementById('watchInput').parentElement.style.display = 'none'
        document.getElementById('watchHint').style.display = 'block'
      }
      document.getElementById('watchList').innerHTML = (data.sources || []).map(src =>
        '<div class="doc-item"><span class="name" title="' + esc(src.path) + '">&#128065; ' + esc(src.path) + '</span>' +
        '<button class="btn btn-d src-remove" style="padding:1px 7px;font-size:10px;" data-path="' + esc(src.path) + '" title="Stop watching and remove its documents">×</button></div>'
      ).join('')
    } catch {}
  }
  document.getElementById('watchList').addEventListener('click', async e => {
    const btn = e.target.closest('.src-remove')
    if (!btn) return
    const path = btn.dataset.path
    if (!confirm('Stop watching ' + path + ' and remove its documents from the index? Files on disk are not touched.')) return
    const res = await fetch('/api/sources?path=' + encodeURIComponent(path), { method: 'DELETE' })
    if (res.ok) { toast('Stopped watching ' + path); refreshSources(); refreshDocs(); showIdleMascot() }
    else toast('Could not remove ' + path, true)
  })

  // ---------- OCR on demand ----------
  document.getElementById('docItems').addEventListener('click', async e => {
    const btn = e.target.closest('.doc-ocr')
    if (!btn) return
    btn.disabled = true; btn.textContent = 'Reading…'
    watchActivity()
    try {
      const res = await fetch('/api/ocr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: btn.dataset.path }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status)
      toast(data.chunks > 0 ? 'Text found and indexed' : 'OCR found no readable text', data.chunks === 0)
    } catch (err) { toast('OCR failed: ' + err.message, true) }
    refreshDocs(); refreshStats()
  })

  // ---------- mascot on/off (per viewer) ----------
  function mascotEnabled() { try { return localStorage.getItem('duct.mascot') !== 'off' } catch { return true } }
  function setMascotEnabled(on) {
    try { localStorage.setItem('duct.mascot', on ? 'on' : 'off') } catch {}
    applyMascotVisibility()
  }
  function applyMascotVisibility() {
    const on = mascotEnabled()
    document.getElementById('cfgMascot').checked = on
    document.getElementById('mascotCanvas').style.visibility = on ? 'visible' : 'hidden'
    document.getElementById('mascotCanvas').style.height = on ? '' : '0'
    document.getElementById('mascotImg').style.height = on ? '' : '0'
    document.getElementById('mascotImg').style.visibility = on ? 'visible' : 'hidden'
  }
  applyMascotVisibility()

  showIdleMascot()
  refreshDocs()
  refreshSources()
  loadConfig()
  watchActivity()
</script>
<script type="module">
  try {
    const { DotLottie } = await import('/vendor/dotlottie/index.js')
    DotLottie.setWasmUrl('/vendor/dotlottie/dotlottie-player.wasm')
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const player = new DotLottie({
      canvas: document.getElementById('mascotCanvas'),
      src: '/mascot/mascot.lottie',
      animationId: MASCOT_POSES[mascotPose][0],
      autoplay: !reduceMotion,
      loop: true,
    })
    let ready = false
    player.addEventListener('load', () => {
      if (!ready) { ready = true; mascotReady(player) }
      // With reduced motion, hold a frame from the middle: some poses start empty.
      if (reduceMotion) player.setFrame(Math.floor(player.totalFrames / 2))
      else player.play()
    })
    player.addEventListener('loadError', useMascotFallback)
  } catch {
    useMascotFallback()
  }
</script>
</body>
</html>`
