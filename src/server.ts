import express from 'express'
import multer from 'multer'
import { existsSync, mkdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { Duct } from './index.js'

const uploadDir = join(process.cwd(), '.duct-uploads')
if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true })

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase()
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + ext)
  },
})
const upload = multer({ storage })

const originalNames = new Map<string, string>()

export function createServer(duct: Duct) {
  const app = express()

  app.post('/api/index', upload.array('files'), async (req, res) => {
    const files = req.files as Express.Multer.File[]
    if (!files || files.length === 0) {
      res.status(400).json({ error: 'No files uploaded' })
      return
    }
    try {
      const results = []
      for (const file of files) {
        originalNames.set(file.path, file.originalname)
        const result = await duct.index(file.path)
        results.push({ file: file.originalname, ...result })
      }
      res.json({ results })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.get('/api/search', async (req, res) => {
    const q = req.query.q as string
    if (!q) {
      res.status(400).json({ error: 'Query parameter "q" is required' })
      return
    }
    const topK = parseInt(req.query.topK as string) || 10
    try {
      const results = await duct.search(q, topK)
      const mapped = results.map(r => ({
        ...r,
        chunk: {
          ...r.chunk,
          documentPath: originalNames.get(r.chunk.documentPath) || r.chunk.documentPath,
        },
      }))
      res.json({ results: mapped })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.get('/api/stats', (_req, res) => {
    res.json(duct.stats())
  })

  app.delete('/api/clear', async (_req, res) => {
    await duct.clear()
    res.json({ ok: true })
  })

  app.get('*', (_req, res) => {
    res.type('html').send(html)
  })

  return app
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Duct — Document Intelligence Pipeline</title>
<style>
  :root { --bg: #0a0a0b; --surface: #141416; --border: #232326; --text: #e4e4e7; --muted: #a1a1aa; --accent: #6366f1; --accent-hover: #818cf8; --radius: 8px; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
  .container { max-width: 800px; margin: 0 auto; padding: 40px 24px; }
  header { margin-bottom: 48px; text-align: center; }
  header h1 { font-size: 2.5rem; font-weight: 700; letter-spacing: -0.02em; }
  header h1 span { color: var(--accent); }
  header p { color: var(--muted); margin-top: 8px; font-size: 1.05rem; }
  section { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; margin-bottom: 24px; }
  section h2 { font-size: 1.1rem; font-weight: 600; margin-bottom: 16px; color: var(--text); }
  .drop-zone { border: 2px dashed var(--border); border-radius: var(--radius); padding: 40px; text-align: center; cursor: pointer; transition: border-color .2s; }
  .drop-zone:hover, .drop-zone.dragover { border-color: var(--accent); }
  .drop-zone p { color: var(--muted); }
  .drop-zone .icon { font-size: 2rem; margin-bottom: 8px; }
  input[type="file"] { display: none; }
  button { background: var(--accent); color: #fff; border: none; padding: 8px 20px; border-radius: var(--radius); font-size: .9rem; cursor: pointer; font-weight: 500; transition: background .2s; }
  button:hover { background: var(--accent-hover); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .search-row { display: flex; gap: 8px; }
  .search-row input { flex: 1; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 14px; color: var(--text); font-size: .95rem; outline: none; transition: border-color .2s; }
  .search-row input:focus { border-color: var(--accent); }
  .stats { display: flex; gap: 24px; justify-content: center; margin-bottom: 24px; }
  .stat { text-align: center; }
  .stat-value { font-size: 1.8rem; font-weight: 700; color: var(--accent); }
  .stat-label { font-size: .8rem; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
  .result { padding: 16px 0; border-bottom: 1px solid var(--border); }
  .result:last-child { border-bottom: none; }
  .result-meta { font-size: .8rem; color: var(--muted); margin-bottom: 6px; word-break: break-all; }
  .result-meta .heading { color: var(--accent); }
  .result-score { display: inline-block; background: var(--accent); color: #fff; font-size: .75rem; padding: 2px 8px; border-radius: 4px; margin-right: 8px; }
  .result-text { font-size: .9rem; line-height: 1.6; color: var(--text); }
  .result-text b, .result-text strong { color: var(--accent-hover); }
  .status { text-align: center; padding: 20px; color: var(--muted); font-size: .9rem; }
  .toast { position: fixed; bottom: 24px; right: 24px; background: var(--accent); color: #fff; padding: 12px 20px; border-radius: var(--radius); font-size: .9rem; opacity: 0; transition: opacity .3s; pointer-events: none; }
  .toast.show { opacity: 1; }
  .clear-btn { background: transparent; border: 1px solid var(--border); color: var(--muted); float: right; font-size: .8rem; padding: 4px 12px; }
  .clear-btn:hover { border-color: #ef4444; color: #ef4444; }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1><span>D</span>uct</h1>
    <p>Extract &middot; Chunk &middot; Embed &middot; Search</p>
  </header>

    <div class="stats">
    <div class="stat"><div class="stat-value" id="docCount">0</div><div class="stat-label">Documents</div></div>
    <div class="stat"><div class="stat-value" id="chunkCount">0</div><div class="stat-label">Chunks</div></div>
  </div>

  <section>
    <h2>Upload</h2>
    <div class="drop-zone" id="dropZone">
      <div class="icon">&#128196;</div>
      <p>Drop PDF, DOCX, Markdown, HTML, or TXT files here</p>
      <p style="margin-top:8px;font-size:.85rem;color:var(--muted)">or <a href="#" onclick="document.getElementById('fileInput').click();return false" style="color:var(--accent);text-decoration:none">browse files</a></p>
    </div>
    <input type="file" id="fileInput" multiple accept=".pdf,.docx,.md,.markdown,.html,.htm,.txt" />
    <div id="uploadStatus" class="status" style="display:none"></div>
  </section>

  <section>
    <h2>Search</h2>
    <div style="display:flex;gap:8px;margin-bottom:8px">
      <input type="text" id="searchInput" placeholder='e.g. "termination" or "payment terms"' />
      <button id="searchBtn">Search</button>
      <button class="clear-btn" onclick="clearAll()" title="Remove all indexed documents">&#128465;</button>
    </div>
    <div id="results" style="margin-top:16px;min-height:60px"></div>
    <div id="emptyState" class="status" style="display:block;color:var(--muted)">
      <p id="emptyMsg">Upload documents above to start searching.</p>
    </div>
  </section>
</div>

<div class="toast" id="toast"></div>

<script>
  let indexing = false

  document.getElementById('fileInput').addEventListener('change', handleFiles)
  document.getElementById('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') search() })
  document.getElementById('searchBtn').addEventListener('click', search)

  const dropZone = document.getElementById('dropZone')
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover') })
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'))
  dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('dragover'); handleFilesDrop(e.dataTransfer.files) })
  dropZone.addEventListener('click', () => document.getElementById('fileInput').click())

  async function handleFiles(e) { await uploadFiles(e.target.files) }
  async function handleFilesDrop(files) { await uploadFiles(files) }

  async function uploadFiles(files) {
    if (!files.length || indexing) return
    indexing = true
    const status = document.getElementById('uploadStatus')
    status.style.display = 'block'
    status.textContent = 'Indexing...'

    const formData = new FormData()
    for (const f of files) formData.append('files', f)

    try {
      const res = await fetch('/api/index', { method: 'POST', body: formData })
      const data = await res.json()
      if (data.error) { status.textContent = 'Error: ' + data.error; return }
      const totalDocs = data.results.reduce((s, r) => s + r.documents, 0)
      const totalChunks = data.results.reduce((s, r) => s + r.chunks, 0)
      toast('Indexed ' + totalDocs + ' document' + (totalDocs !== 1 ? 's' : '') + ' (' + totalChunks + ' chunk' + (totalChunks !== 1 ? 's' : '') + ')')
      status.style.display = 'none'
      refreshStats()
    } catch (err) {
      status.textContent = 'Error: ' + err.message
    }
    indexing = false
  }

  async function search() {
    const q = document.getElementById('searchInput').value.trim()
    if (!q) return
    const btn = document.getElementById('searchBtn')
    btn.disabled = true
    btn.textContent = 'Searching...'
    hideEmpty()

    try {
      const res = await fetch('/api/search?q=' + encodeURIComponent(q) + '&topK=10')
      const data = await res.json()
      const div = document.getElementById('results')
      if (!data.results || data.results.length === 0) {
        div.innerHTML = '<div class="status">No results found for "<b>' + esc(q) + '</b>"</div>'
        btn.disabled = false
        btn.textContent = 'Search'
        return
      }
      div.innerHTML = data.results.map(r => {
        const heading = r.chunk.heading ? ' <span class="heading">' + esc(r.chunk.heading) + '</span>' : ''
        const snippet = r.chunk.content.slice(0, 500)
        return '<div class="result">' +
          '<div class="result-meta"><span class="result-score">' + r.score.toFixed(2) + '</span>' + esc(r.chunk.documentPath) + heading + '</div>' +
          '<div class="result-text">' + highlight(esc(snippet), q) + '</div>' +
          '</div>'
      }).join('')
    } catch (err) {
      document.getElementById('results').innerHTML = '<div class="status">Error: ' + esc(err.message) + '</div>'
    }
    btn.disabled = false
    btn.textContent = 'Search'
  }

  function hideEmpty() {
    document.getElementById('emptyState').style.display = 'none'
  }

  function showEmpty(docs) {
    const el = document.getElementById('emptyState')
    el.style.display = 'block'
    document.getElementById('emptyMsg').textContent = docs > 0 ? 'Type a query above to search your documents.' : 'Upload documents above to start searching.'
  }

  async function refreshStats() {
    const res = await fetch('/api/stats')
    const data = await res.json()
    document.getElementById('docCount').textContent = data.documents
    document.getElementById('chunkCount').textContent = data.chunks
    if (data.documents === 0) showEmpty(0); else showEmpty(1)
  }

  async function clearAll() {
    if (!confirm('Remove all indexed documents?')) return
    await fetch('/api/clear', { method: 'DELETE' })
    document.getElementById('results').innerHTML = ''
    document.getElementById('searchInput').value = ''
    refreshStats()
    toast('Cleared')
  }

  function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2500) }
  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML }
  function highlight(text, query) {
    const words = query.toLowerCase().split(/\\s+/).filter(w => w.length > 2)
    if (!words.length) return text
    const lower = text.toLowerCase()
    const highlighted = new Array(text.length).fill(false)
    for (const word of words) {
      let idx = 0
      while ((idx = lower.indexOf(word, idx)) !== -1) {
        for (let i = idx; i < idx + word.length; i++) highlighted[i] = true
        idx++
      }
    }
    let result = ''
    let inTag = false
    for (let i = 0; i < text.length; i++) {
      if (highlighted[i] && !inTag) { result += '<b>'; inTag = true }
      if (!highlighted[i] && inTag) { result += '</b>'; inTag = false }
      result += text[i]
    }
    if (inTag) result += '</b>'
    return result
  }

  refreshStats()
</script>
</body>
</html>`
