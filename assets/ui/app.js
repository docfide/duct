// Duct's main window. A plain ES module with no build step. The page allows no inline scripts, so every
// handler is attached here. The desktop app adds window.electronAPI (electron/preload.cjs) and calls
// window.duct.* (bottom of this file).

const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]
const MARK_START = String.fromCharCode(2)   // search snippets wrap matched words in these two characters
const MARK_END = String.fromCharCode(3)
const desktop = window.electronAPI || null

const state = {
  info: null,
  config: {},
  docs: [],
  sources: [],
  activity: {},
  query: '',
  mode: 'search',
  view: 'home',
  results: [],
  selected: -1,
  group: null,        // file-type filter id
  source: null,       // { label, under }
  docFilter: 'all',
  wasBusy: false,
  tags: [],           // tag filters (all must match)
  allTags: [],        // [{ tag, count }]
  date: null,         // DATE_RANGES id
  collected: loadCollected(),
}

// ---------- collected passages (kept on this device) ----------

function loadCollected() {
  try { const v = JSON.parse(localStorage.getItem('duct.collected') || '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
}
function saveCollected() {
  try { localStorage.setItem('duct.collected', JSON.stringify(state.collected)) } catch {}
}

// ---------- server access (asks for the access token on a protected server) ----------

const rawFetch = window.fetch.bind(window)
let loginPromise = null

async function login() {
  // A server with organisation sign-in sends people to their identity provider instead of asking for a token.
  const mode = await rawFetch('/auth/mode').then(r => r.json()).catch(() => ({}))
  if (mode.oidc) {
    window.location.href = '/auth/login?next=' + encodeURIComponent(window.location.pathname + window.location.search)
    return new Promise(() => {})
  }
  const token = window.prompt('This Duct server needs an access token:')
  if (!token) throw new Error('Access token required')
  const res = await rawFetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
  if (!res.ok) throw new Error('Invalid access token')
}

async function api(path, options = {}) {
  let res = await rawFetch(path, options)
  // A team server whose plan lapsed turns signed-in people away with what to do: say it once, plainly.
  if (res.status === 402) res.clone().json().then(b => { if (b && b.code === 'licence') showLicenceBanner(b.error, false) }, () => {})
  if (res.status === 401 && path !== '/api/login') {
    loginPromise = loginPromise || login().finally(() => { loginPromise = null })
    await loginPromise
    res = await rawFetch(path, options)
  }
  return res
}

async function json(path, options) {
  let res
  try { res = await api(path, options) } catch (err) { throw new Error(plainError(0, err && err.message)) }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(plainError(res.status, data.error))
  return data
}

/**
 * What went wrong, in words people can act on. Duct's own messages are already written that way and pass through;
 * what comes from the system (no connection, a full disk, a file that moved) is put plainly instead of shown raw.
 */
function plainError(status, message) {
  const m = String(message || '')
  if (status === 0 || /failed to fetch|networkerror|load failed|econnrefused|fetch failed/i.test(m)) return desktop ? 'Duct’s search engine isn’t answering. Quit Duct and open it again; your index is safe.' : 'Duct isn’t answering. Check that it’s still running, then try again.'
  if (/enospc|no space left/i.test(m)) return 'Your disk is full, so Duct can’t save that. Free up some space and try again.'
  if (/eacces|eperm|permission denied|operation not permitted/i.test(m)) return 'Duct isn’t allowed to read that. On a Mac, check System Settings › Privacy & Security › Files and Folders.'
  if (/enoent|no such file/i.test(m)) return 'That file isn’t where it was. It may have been moved, renamed or deleted.'
  if (/^document not found$/i.test(m)) return 'That document isn’t in Duct any more. It may have been moved or removed since Duct read it.'
  if (/^only an admin can do this/i.test(m)) return 'Only an admin can change this. Ask whoever set up Duct here.'
  if (/sqlite_busy|database is locked/i.test(m)) return 'Duct is busy saving. Try again in a moment.'
  if (/sqlite|sql logic|malformed/i.test(m)) return 'Something went wrong inside Duct’s index. Try again; if it keeps happening, send us a note from Settings › Help.'
  if (status === 413 || /too large|entity too large/i.test(m)) return 'That’s too big to add in one go. Try fewer or smaller files.'
  if (status === 429) return 'That was a lot at once. Wait a minute and try again.'
  if (status === 401) return 'You’ve been signed out. Sign in again to carry on.'
  if (m && !/^HTTP \d+$/.test(m) && !/^(internal server error|bad request|error)$/i.test(m)) return m
  return status >= 500 ? 'Something went wrong on Duct’s side. Try again; if it keeps happening, send us a note from Settings › Help.' : 'That didn’t work. Try again?'
}

const send = (method, path, body) => json(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

// ---------- small helpers ----------

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** Escapes a snippet, then turns the server's match markers into <mark>. */
function markSnippet(snippet) {
  return esc(snippet).split(MARK_START).join('<mark>').split(MARK_END).join('</mark>')
}

const WORD_CHAR = /[\p{L}\p{N}]/u

/** Highlights words in raw text and returns escaped HTML. */
function highlight(text, terms) {
  const words = terms.map(t => t.toLowerCase()).filter(t => t.length > 1)
  if (!words.length) return esc(text)
  const lower = text.toLowerCase()
  const marked = new Array(text.length).fill(false)
  for (const word of words) {
    for (let i = lower.indexOf(word); i !== -1; i = lower.indexOf(word, i + 1)) {
      // Whole words, or a word with a short ending ("terminates" for "terminate"), never inside another word:
      // "tax" shouldn't light up in "taxation".
      if (i > 0 && WORD_CHAR.test(lower[i - 1])) continue
      let end = i + word.length
      while (end < lower.length && WORD_CHAR.test(lower[end])) end++
      if (end - (i + word.length) > 3) continue
      for (let j = i; j < i + word.length; j++) marked[j] = true
    }
  }
  let out = ''
  let start = 0
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || marked[i] !== marked[start]) {
      const part = esc(text.slice(start, i))
      out += marked[start] ? '<mark>' + part + '</mark>' : part
      start = i
    }
  }
  return out
}

function fileName(path) { return path.split('/').pop().split(String.fromCharCode(92)).pop() || path }
function folderOf(path) {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf(String.fromCharCode(92)))
  return cut > 0 ? path.slice(0, cut) : ''
}
const isLink = path => /^https?:/i.test(path)
const fmt = n => Number(n || 0).toLocaleString()
const plural = (n, word) => fmt(n) + ' ' + word + (n === 1 ? '' : 's')

function timeAgo(ms) {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return m + ' min ago'
  const h = Math.round(m / 60)
  if (h < 24) return h + ' h ago'
  const d = Math.round(h / 24)
  return d < 30 ? d + ' d ago' : new Date(ms).toLocaleDateString()
}

function toast(message, error = false) {
  const el = $('#toast')
  el.textContent = message
  el.className = 'toast show' + (error ? ' error' : '')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => { el.className = 'toast' }, 3200)
}

// ---------- formats ----------

const BADGES = {
  pdf: ['PDF', 'pdf'], docx: ['DOC', 'doc'], doc: ['DOC', 'doc'], odt: ['ODT', 'doc'], rtf: ['RTF', 'doc'], pages: ['PAGES', 'doc'],
  md: ['MD', 'doc'], html: ['HTML', 'doc'], epub: ['EPUB', 'doc'], xlsx: ['XLS', 'sheet'], ods: ['ODS', 'sheet'], numbers: ['NUM', 'sheet'],
  pptx: ['PPT', 'slide'], odp: ['ODP', 'slide'], key: ['KEY', 'slide'], eml: ['EML', 'mail'], msg: ['MSG', 'mail'], txt: ['TXT', ''],
  code: ['CODE', ''], svg: ['SVG', 'img'], image: ['IMG', 'img'], zip: ['ZIP', 'zip'], url: ['WEB', 'doc'], audio: ['AUDIO', 'audio'],
}
const badge = format => { const [label, cls] = BADGES[format] || ['FILE', '']; return '<span class="type ' + cls + '">' + label + '</span>' }

const GROUPS = [
  { id: 'pdf', label: 'PDFs', test: f => f.format === 'pdf' },
  { id: 'docs', label: 'Documents', test: f => (f.kind === 'document' && f.format !== 'pdf') || f.kind === 'ebook' },
  { id: 'sheets', label: 'Spreadsheets', test: f => f.kind === 'spreadsheet' },
  { id: 'slides', label: 'Presentations', test: f => f.kind === 'presentation' },
  { id: 'audio', label: 'Audio', test: f => f.kind === 'audio' },
  { id: 'email', label: 'Email', test: f => f.kind === 'email' },
  { id: 'images', label: 'Images', test: f => f.kind === 'image' },
  { id: 'text', label: 'Text & code', test: f => f.kind === 'text' || f.kind === 'code' },
  { id: 'archives', label: 'Archives', test: f => f.kind === 'archive' },
  { id: 'web', label: 'Web pages', test: f => f.format === 'url' },
]

function groupFormats(id) {
  const group = GROUPS.find(g => g.id === id)
  if (!group) return []
  const formats = state.info.formats.filter(group.test).map(f => f.format)
  return id === 'web' ? ['url'] : formats
}

// What each switch in Settings > Features does. Names match src/features.ts.
const FEATURE_GROUPS = [
  { title: 'Search and AI', items: [
    ['ask', 'Ask (Labs)', 'Answers written by an AI model from your documents, with sources.'],
    ['semanticSearch', 'Search by meaning', 'Uses an embedding model. Off: no passages are sent to an embedding provider.'],
    ['fileNameSearch', 'Match file names', 'Find documents by their name as well as their text.'],
    ['schemaExtraction', 'Field extraction', 'Pull fields such as dates and amounts out of documents with an AI model (API and command line).'],
  ] },
  { title: 'Adding documents', items: [
    ['uploads', 'Add files', 'Copy files into your Duct Library, from the app or the API.'],
    ['watchedFolders', 'Watched folders', 'Index folders where they are and keep them in sync. Off: watching pauses; folders are remembered.'],
    ['webPages', 'Web pages', 'Index the text of a page by its address.'],
    ['ocrOnDemand', 'Read a scan on request', 'The “Read with OCR” button for documents with no text.'],
  ] },
  { title: 'Results', items: [
    ['export', 'Export results', 'Download search results as CSV or JSON.'],
    ['diff', 'Compare versions', 'Show what changed between the last two versions of a document.'],
    ['deadlines', 'Deadlines radar', 'Expiry, due and renewal dates from your documents on the home screen, worked out on this computer.'],
  ] },
  { title: 'Sharing', items: [
    ['publicLinks', 'Public notebook links', 'On a server where people sign in, a notebook’s owner can make a link anyone can open without signing in.'],
  ] },
  { title: 'Developers', items: [
    ['developerApi', 'Developer API', 'The /v1 API for apps: collections, API keys, and indexing your own text by id.'],
  ] },
]
const KIND_LABELS = { document: 'Documents (PDF, Word, Pages, Markdown, HTML…)', spreadsheet: 'Spreadsheets', presentation: 'Presentations', ebook: 'E-books', email: 'Email', text: 'Text, CSV, JSON and subtitles', code: 'Source code', image: 'Images and SVG', audio: 'Audio and voice notes: what’s said, transcribed on this computer (downloads a 77 MB speech model the first time; songs are skipped)', archive: 'ZIP archives' }
const DESKTOP_PREFS = [
  ['openAtLogin', 'Open at login', 'Start Duct when you sign in to this computer, so quick search and watched folders are always ready.'],
  ['island', 'Notch companion', 'Duct at the top of the screen: progress, quick search and a drop zone.'],
  ['sounds', 'Sounds', 'Short sounds when a job finishes or needs you.'],
  ['shortcut', 'Quick search shortcut', 'Search from any app, without switching to Duct.'],
]

const feature = name => !state.info || !state.info.features || state.info.features[name] !== false
const kindOn = kind => !state.info || !state.info.features || state.info.features.formats[kind] !== false

/** Hides every control for a switched-off feature. */
function applyFeatures() {
  const modeAsk = $('.mode[data-mode="ask"]')
  modeAsk.hidden = !feature('ask')
  if (!feature('ask') && state.mode === 'ask') setMode('search')
  $$('[data-action="export"], [data-action="toggle-export"]').forEach(el => { el.hidden = !feature('export') })
  renderCollectedButton()
  $$('[data-action="add-url"]').forEach(el => { el.hidden = !feature('webPages') })
  $$('[data-action="add-files"]').forEach(el => { el.hidden = !feature('uploads') })
  $('#welcome .hint').hidden = !feature('uploads')
}

/** The quick-search shortcut: which keys, and a warning when another app already uses them. */
function shortcutRow(s) {
  if (!s) return ''
  return '<div class="shortcut-row"><label for="shortcutKey">Keys</label><select id="shortcutKey" data-shortcut' + (s.on ? '' : ' disabled') + '>' +
    s.choices.map(c => '<option value="' + esc(c.key) + '"' + (c.key === s.key ? ' selected' : '') + '>' + esc(c.label) + '</option>').join('') + '</select>' +
    (s.on && s.taken ? '<p class="shortcut-warn">Another app is using ' + esc(s.label) + ', so it doesn’t reach Duct. Pick different keys.</p>' : '') + '</div>'
}

function renderFeatureList(prefs, shortcut) {
  const admin = isAdmin()
  const check = (attr, on, label, help, disabled) =>
    '<label class="check"><input type="checkbox" ' + attr + (on ? ' checked' : '') + (disabled ? ' disabled' : '') + '> <span><strong>' + esc(label) + '</strong><small>' + esc(help) + '</small></span></label>'
  let html = FEATURE_GROUPS.map(g => '<h3>' + esc(g.title) + '</h3>' + g.items.map(([name, label, help]) => check('data-feature="' + name + '"', feature(name), label, help, !admin)).join('')).join('')
  html += '<h3>File types Duct reads</h3><p class="hint">Switched-off types are skipped when indexing and hidden from search. Turning one back on rescans watched folders.</p>'
  html += Object.keys(KIND_LABELS).map(kind => check('data-format-kind="' + kind + '"', kindOn(kind), KIND_LABELS[kind], '', !admin)).join('')
  // Single-key shortcuts can be turned off (WCAG 2.1.4): speech input can type "/" by accident.
  html += '<h3>Keyboard</h3>' + check('data-local="slashKey"', slashKeyOn(), 'Press / to search', 'Typing / anywhere outside a text box jumps to the search box. ⌘K or Ctrl+K always works.', false)
  if (prefs) html += '<h3>This computer</h3>' + DESKTOP_PREFS.map(([name, label, help]) => check('data-pref="' + name + '"', prefs[name] !== false, label, help, false) + (name === 'shortcut' ? shortcutRow(shortcut) : '')).join('')
  $('#featureList').innerHTML = html
  $('#featuresHint').textContent = admin ? 'Turn off anything you don’t use. Switched-off features disappear from Duct and its API.' : 'Only an admin can change these.'
}

function slashKeyOn() {
  try { return localStorage.getItem('duct.slashKey') !== 'off' } catch { return true }
}

const DAY = 86400000
const DATE_RANGES = [
  { id: 'week', label: 'Past week', after: () => Date.now() - 7 * DAY },
  { id: 'month', label: 'Past month', after: () => Date.now() - 31 * DAY },
  { id: 'year', label: 'Past year', after: () => Date.now() - 366 * DAY },
  { id: 'older', label: 'Older than a year', before: () => Date.now() - 366 * DAY },
]
const docDate = d => d.modifiedAt || d.indexedAt

/** Adds the sidebar's tag and date filters to search or export parameters. */
function addScopeParams(params) {
  if (state.group) params.set('formats', groupFormats(state.group).join(','))
  if (state.source) params.set('under', state.source.under)
  for (const t of state.tags) params.append('tag', t)
  const range = DATE_RANGES.find(r => r.id === state.date)
  if (range && range.after) params.set('after', String(Math.round(range.after())))
  if (range && range.before) params.set('before', String(Math.round(range.before())))
  return params
}

/** "Contract.pdf, p. 12 › Termination" */
function sourceLine(c) {
  const doc = state.docs.find(d => d.path === c.documentPath)
  return (doc && doc.displayName ? doc.displayName : fileName(c.documentPath)) + (c.page ? ', ' + pageRef(c) : '') + (c.heading ? ' › ' + c.heading : '')
}

/** A reference for a result, from the document's own title, author and year where it has them. */
function citation(c, style) {
  const m = c.metadata || {}
  const doc = state.docs.find(d => d.path === c.documentPath)
  const title = m.title || (doc && doc.displayName ? doc.displayName : fileName(c.documentPath)).replace(/\.[^.]+$/, '')
  const author = m.author || ''
  const year = m.year || ''
  const page = c.page ? pageRef(c) : ''
  if (style === 'bibtex') {
    const key = ((author.split(/[ ,]+/).filter(Boolean).pop() || title.split(/\s+/)[0] || 'doc') + (year || '')).toLowerCase().replace(/[^a-z0-9]/g, '')
    const field = (k, v) => v ? '  ' + k + ' = {' + String(v).replace(/[{}]/g, '') + '},\n' : ''
    return '@misc{' + key + ',\n' + field('title', title) + field('author', author) + field('year', year) + field('note', page) + '}'
  }
  return (author ? author + ' ' : '') + '(' + (year || 'n.d.') + '). ' + title + '.' + (page ? ' ' + page + '.' : '')
}

async function copyText(text, done) {
  try { await navigator.clipboard.writeText(text); toast(done) } catch { toast('Couldn’t copy that. Select it and copy it yourself?', true) }
}

function collect(r) {
  const c = r.chunk
  if (state.collected.some(x => x.path === c.documentPath && x.text === c.content)) { toast('Already collected'); return }
  state.collected.push({ path: c.documentPath, page: c.page || null, heading: c.heading || null, text: c.content, source: sourceLine(c) })
  saveCollected()
  renderCollectedButton()
  toast('Collected (' + state.collected.length + ')')
}

function renderCollectedButton() {
  const btn = $('#collectedBtn')
  btn.hidden = !state.collected.length || !feature('export')
  $$('[data-bind="collectedCount"]').forEach(el => { el.textContent = String(state.collected.length) })
}

function renderCollected() {
  $('#collectList').innerHTML = state.collected.map((x, i) =>
    '<li><div class="text">' + esc(x.text) + '</div><div class="src">' + esc(x.source) + '</div>' +
    '<button class="icon-btn remove" data-remove-collected="' + i + '" aria-label="Remove">✕</button></li>').join('') || '<li class="hint">Nothing collected yet. Use “Collect” on a search result.</li>'
}

async function downloadExport(res, fallbackName) {
  if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.error || 'HTTP ' + res.status) }
  const blob = await res.blob()
  const disposition = res.headers.get('content-disposition') || ''
  const m = /filename\*=UTF-8''([^;]+)/.exec(disposition)
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = m ? decodeURIComponent(m[1]) : fallbackName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 10000)
}

async function exportCollected(format) {
  if (!state.collected.length) return
  const title = $('#collectName').value.trim() || 'Collected passages'
  try {
    const res = await api('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format, title, items: state.collected }) })
    await downloadExport(res, 'duct-collected.' + format)
  } catch (err) { toast('Couldn’t export. ' + err.message, true) }
}

function renderTagEditor(path) {
  const doc = state.docs.find(d => d.path === path)
  const tags = (doc && doc.tags) || []
  return '<div class="tag-editor" data-tag-path="' + esc(path) + '">' +
    tags.map(t => '<span class="tag">' + esc(t) + '<button data-remove-tag="' + esc(t) + '" aria-label="Remove tag ' + esc(t) + '">✕</button></span>').join('') +
    '<input type="text" data-add-tag placeholder="+ Add tag" aria-label="Add a tag" maxlength="60"></div>'
}

async function saveTags(path, tags) {
  try {
    const data = await send('PUT', '/api/documents/tags', { path, tags })
    const doc = state.docs.find(d => d.path === path)
    if (doc) doc.tags = data.tags
    state.allTags = (await json('/api/tags')).tags || []
    renderSidebar()
    return data.tags
  } catch (err) { toast('Couldn’t save the tags. ' + err.message, true); return null }
}

function pageRef(chunk) {
  // Audio is transcribed a page per minute: page 3 starts at 2:00.
  if (chunk.documentFormat === 'audio') return 'at ' + (chunk.page - 1) + ':00'
  const label = state.info.formats.find(f => f.format === chunk.documentFormat)?.pageLabel || 'p.'
  return label + ' ' + chunk.page
}

// ---------- mascot ----------

const POSES = { welcome: 'Pose - Welcome', working: 'Pose - Working', done: 'Pose - Done', nothingFound: 'Pose - Nothing Found', needsHand: 'Pose - Needs a Hand', resting: 'Pose - Resting' }
const POSE_FILES = { welcome: 'pose-welcome.svg', working: 'pose-working.svg', done: 'pose-done.svg', nothingFound: 'pose-nothing-found.svg', needsHand: 'pose-needs-a-hand.svg', resting: 'pose-resting.svg' }
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
let DotLottie = null
let lottieFailed = false

function mascotEnabled() { try { return localStorage.getItem('duct.mascot') !== 'off' } catch { return true } }

function poseFor(slot) {
  const wanted = slot.dataset.mascot
  if (wanted !== 'idle') return wanted
  if (state.activity.indexing) return 'working'
  return state.sources.length ? 'resting' : 'welcome'
}

async function renderMascots() {
  document.body.classList.toggle('no-mascot', !mascotEnabled())
  if (!mascotEnabled()) return
  if (!DotLottie && !lottieFailed) {
    try {
      DotLottie = (await import('/vendor/dotlottie/index.js')).DotLottie
      DotLottie.setWasmUrl('/vendor/dotlottie/dotlottie-player.wasm')
    } catch { lottieFailed = true }
  }
  for (const slot of $$('[data-mascot]')) {
    const visible = slot.offsetParent !== null
    const pose = poseFor(slot)
    if (lottieFailed) {
      if (visible && slot.dataset.pose !== pose) { slot.innerHTML = '<img alt="" src="/mascot/' + POSE_FILES[pose] + '">'; slot.dataset.pose = pose }
      continue
    }
    if (!slot.player) {
      if (!visible) continue
      const canvas = document.createElement('canvas')
      canvas.width = slot.clientWidth * 2
      canvas.height = slot.clientHeight * 2
      slot.appendChild(canvas)
      slot.player = new DotLottie({ canvas, src: '/mascot/mascot.lottie', animationId: POSES[pose], autoplay: !reduceMotion, loop: true })
      // Movement stops by itself within 5 seconds (WCAG 2.2.2): it finishes the loop it's in and rests.
      const player = slot.player
      setTimeout(() => { try { player.setLoop(false) } catch {} }, 5000)
      slot.dataset.pose = pose
      slot.player.addEventListener('load', () => {
        if (reduceMotion) slot.player.setFrame(Math.floor(slot.player.totalFrames / 2))
        else if (slot.offsetParent !== null) slot.player.play()
      })
      slot.player.addEventListener('loadError', () => { lottieFailed = true; renderMascots() })
      continue
    }
    if (slot.dataset.pose !== pose) { slot.dataset.pose = pose; slot.player.loadAnimation(POSES[pose]) }
    // Animations off screen are paused.
    if (!reduceMotion && slot.player.isLoaded) {
      if (visible && !slot.player.isPlaying) slot.player.play()
      if (!visible && slot.player.isPlaying) slot.player.pause()
    }
  }
}

// ---------- data ----------

async function loadData() {
  const [docs, sources, activity, tags, connectors] = await Promise.all([
    json('/api/documents'),
    json('/api/sources'),
    json('/api/activity'),
    json('/api/tags').catch(() => ({ tags: [] })),
    json('/api/connectors').catch(() => ({ connectors: [] })),
  ])
  state.connectors = connectors.connectors || []
  state.docs = docs.documents || []
  state.allTags = tags.tags || []
  state.tags = state.tags.filter(t => state.allTags.some(x => x.tag === t))
  state.sources = sources.sources || []
  state.canWatch = !!sources.canAdd || !!(desktop && desktop.watchDirectory)
  state.activity = activity
}

const readyDocs = () => state.docs.filter(d => d.status !== 'failed')
const attentionDocs = () => state.docs.filter(d => d.status === 'failed' || d.status === 'no-text')

function inScope(doc) {
  if (state.group && !groupFormats(state.group).includes(doc.format)) return false
  if (state.source) {
    const under = state.source.under
    if (doc.path !== under && !doc.path.startsWith(under.endsWith('/') ? under : under + '/') && !doc.path.startsWith(under + String.fromCharCode(92))) return false
  }
  if (state.tags.length && !state.tags.every(t => (doc.tags || []).includes(t))) return false
  const range = DATE_RANGES.find(r => r.id === state.date)
  if (range && range.after && docDate(doc) < range.after()) return false
  if (range && range.before && docDate(doc) >= range.before()) return false
  return true
}

// ---------- sidebar ----------

function renderSidebar() {
  const ready = readyDocs()
  $$('[data-bind="docCount"]').forEach(el => { el.textContent = fmt(state.docs.length) })
  const attention = attentionDocs().length
  $$('[data-bind="attentionCount"]').forEach(el => { el.textContent = fmt(attention) })
  $('[data-view="attention"]').hidden = attention === 0

  const formatOn = format => { const f = state.info.formats.find(x => x.format === format); return !f || kindOn(f.kind) }
  const kinds = GROUPS.map(g => ({ ...g, count: ready.filter(d => groupFormats(g.id).includes(d.format) && formatOn(d.format)).length })).filter(g => g.count > 0)
  $('#kindList').innerHTML = kinds.map(g =>
    '<button class="side-item' + (state.group === g.id ? ' active' : '') + '" data-group="' + g.id + '"><span class="name">' + esc(g.label) + '</span><span class="count">' + fmt(g.count) + '</span></button>').join('')
    || '<p class="hint side-empty">Nothing indexed yet</p>'

  const libraryCount = ready.filter(d => d.source === 'library').length
  const sources = []
  if (libraryCount) sources.push({ label: 'Duct Library', under: state.info.libraryDir, count: libraryCount })
  for (const s of state.sources) {
    sources.push({ label: fileName(s.path), title: s.path, under: s.path, count: ready.filter(d => d.path.startsWith(s.path)).length, watched: true })
  }
  for (const c of state.connectors || []) {
    sources.push({ label: (c.kind === 'gdrive' ? 'Google Drive' : c.drive ? 'SharePoint' : 'OneDrive'), title: c.label, under: c.filesDir, count: ready.filter(d => d.path.startsWith(c.filesDir)).length })
  }
  $('#sourceList').innerHTML = sources.map(s =>
    '<div class="source-row"><button class="side-item' + (state.source && state.source.under === s.under ? ' active' : '') + '" data-under="' + esc(s.under) + '" data-label="' + esc(s.label) + '" title="' + esc(s.title || s.under) + '">' +
    '<span class="name">' + (s.watched ? '◉ ' : '▤ ') + esc(s.label) + '</span><span class="count">' + fmt(s.count) + '</span></button>' +
    (s.watched && isAdmin() ? '<button class="remove" data-remove-source="' + esc(s.under) + '" aria-label="Stop watching ' + esc(s.label) + '" title="Stop watching">✕</button>' : '') + '</div>').join('')
    || '<p class="hint side-empty">No sources yet</p>'

  $('#dateList').innerHTML = DATE_RANGES.map(r =>
    '<button class="side-item' + (state.date === r.id ? ' active' : '') + '" data-date="' + r.id + '"><span class="name">' + esc(r.label) + '</span></button>').join('')
  $('#tagSection').hidden = state.allTags.length === 0
  $('#tagList').innerHTML = state.allTags.map(t =>
    '<button class="side-item' + (state.tags.includes(t.tag) ? ' active' : '') + '" data-tag="' + esc(t.tag) + '"><span class="name"># ' + esc(t.tag) + '</span><span class="count">' + fmt(t.count) + '</span></button>').join('')

  for (const el of $$('[data-requires="watch"]')) el.hidden = !state.canWatch || !isAdmin() || !feature('watchedFolders')
  $$('.side-item[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === (state.view === 'documents' ? (state.docFilter === 'attention' ? 'attention' : 'documents') : state.view === 'home' || state.view === 'results' ? 'search' : state.view)))
}

$('#sidebar').addEventListener('click', async e => {
  const group = e.target.closest('[data-group]')
  const source = e.target.closest('[data-under]')
  const remove = e.target.closest('[data-remove-source]')
  const view = e.target.closest('[data-view]')
  const tag = e.target.closest('[data-tag]')
  const date = e.target.closest('[data-date]')
  if (tag) state.tags = state.tags.includes(tag.dataset.tag) ? state.tags.filter(t => t !== tag.dataset.tag) : [...state.tags, tag.dataset.tag]
  if (date) state.date = state.date === date.dataset.date ? null : date.dataset.date
  if (tag || date) {
    renderSidebar()
    if (state.view === 'documents') renderDocuments()
    else if (state.query) runSearch()
    else renderScopeChips()
    return
  }
  if (remove) {
    const path = remove.dataset.removeSource
    if (!confirm('Stop watching ' + path + '?\n\nIts documents leave the index. The files themselves are not touched.')) return
    try { await json('/api/sources?path=' + encodeURIComponent(path), { method: 'DELETE' }); toast('Stopped watching ' + fileName(path)) } catch (err) { toast(err.message, true) }
    if (state.source && state.source.under === path) state.source = null
    return refreshAll()
  }
  if (group) state.group = state.group === group.dataset.group ? null : group.dataset.group
  else if (source) state.source = state.source && state.source.under === source.dataset.under ? null : { under: source.dataset.under, label: source.dataset.label }
  else if (view) {
    if (view.dataset.view === 'search') { state.group = null; state.source = null; setView(state.query ? 'results' : 'home') }
    else if (view.dataset.view === 'notebooks') setView('notebooks')
    else { state.docFilter = view.dataset.view === 'attention' ? 'attention' : 'all'; setView('documents') }
    $('#sidebar').classList.remove('open')
    return
  }
  $('#sidebar').classList.remove('open')
  renderSidebar()
  if (state.view === 'documents') renderDocuments()
  else if (state.query) runSearch()
  else renderScopeChips()
})

// ---------- views ----------

function setView(view) {
  state.view = view
  $('#viewHome').hidden = view !== 'home'
  $('#viewResults').hidden = view !== 'results'
  $('#viewAsk').hidden = view !== 'ask'
  $('#viewDocuments').hidden = view !== 'documents'
  $('#viewNotebooks').hidden = view !== 'notebooks'
  if (view !== 'results') closePreview()
  if (view === 'home') renderHome()
  if (view === 'documents') renderDocuments()
  if (view === 'notebooks') renderNotebooks()
  renderSidebar()
  renderMascots()
}

function renderHome() {
  const ready = readyDocs()
  const a = state.activity
  $('#homeTitle').textContent = ready.length ? 'Search ' + plural(ready.length, 'document') : 'Nothing indexed yet'
  $('#homeSub').textContent = a.indexing
    ? 'Reading ' + fmt(a.done) + ' of ' + fmt(a.total) + (a.current ? ': ' + a.current : '') + '. You can search already.'
    : ready.length ? (state.sources.length ? 'Watching ' + plural(state.sources.length, 'folder') + '. New and changed files are added automatically.' : 'Type above, or press / to start.') : 'Add files or watch a folder to begin.'
  const attention = attentionDocs()
  const banner = $('#homeAttention')
  banner.hidden = attention.length === 0
  banner.innerHTML = attention.length ? '<span>' + plural(attention.length, 'file') + ' need' + (attention.length === 1 ? 's' : '') + ' attention</span><button class="btn btn-sm" data-action="show-attention">Review</button>' : ''
  // Searches to try, drawn from these documents; worked out again only when the library changes.
  if (ready.length && !a.indexing) {
    if (discoveryFor !== ready.length) { discoveryFor = ready.length; loadDiscovery(true).then(d => renderTry('#homeTry', d)) }
    else renderTry('#homeTry', discovery)
  } else renderTry('#homeTry', null)
  renderRadar(ready.length)
  const recent = ready.slice().sort((x, y) => y.indexedAt - x.indexedAt).slice(0, 8)
  $('#recent').innerHTML = recent.length ? '<h2>Recently added</h2>' + recent.map(d =>
    '<button class="recent-item" data-open-doc="' + esc(d.path) + '">' + badge(d.format) + '<span class="name">' + esc(d.displayName || fileName(d.path)) + '</span><span class="when">' + timeAgo(d.indexedAt) + '</span></button>').join('') : ''
}

// ---------- search ----------

function renderScopeChips(target = '#scopeChips') {
  const box = $(target)
  if (!box) return
  const chips = []
  if (state.group) chips.push(['group', GROUPS.find(g => g.id === state.group).label])
  if (state.source) chips.push(['source', state.source.label])
  if (state.date) chips.push(['date', DATE_RANGES.find(r => r.id === state.date).label])
  for (const t of state.tags) chips.push(['tag:' + t, '# ' + t])
  box.innerHTML = chips.map(([kind, label]) => '<span class="chip">' + esc(label) + '<button data-clear-scope="' + esc(kind) + '" aria-label="Remove filter ' + esc(label) + '">✕</button></span>').join('')
}

for (const box of ['#scopeChips', '#docScopeChips']) {
  $(box).addEventListener('click', e => {
    const btn = e.target.closest('[data-clear-scope]')
    if (!btn) return
    const kind = btn.dataset.clearScope
    if (kind === 'group') state.group = null
    else if (kind === 'source') state.source = null
    else if (kind === 'date') state.date = null
    else if (kind.startsWith('tag:')) state.tags = state.tags.filter(t => t !== kind.slice(4))
    renderSidebar()
    if (state.view === 'documents') renderDocuments()
    else runSearch()
  })
}

let searchSeq = 0
async function runSearch() {
  const q = state.query
  if (!q) { setView('home'); return }
  if (state.view !== 'results') setView('results')
  renderScopeChips()
  const params = addScopeParams(new URLSearchParams({ q, topK: '40' }))
  const seq = ++searchSeq
  let data
  try { data = await json('/api/search?' + params) } catch (err) { if (seq === searchSeq) toast('Couldn’t search just now. ' + err.message, true); return }
  if (seq !== searchSeq) return
  state.results = data.results || []
  state.help = data.help || null
  renderResults()
}

/** "Why this result": the words that matched as written in the passage, the file name, or meaning. */
function whyText(r) {
  const why = r.why
  if (!why) return ''
  const typed = state.query.toLowerCase().replace(/"/g, '').split(/\s+/).filter(Boolean)
  const parts = []
  if (why.words && why.words.length) {
    parts.push('Matched ' + why.words.slice(0, 5).map(w => {
      const other = !typed.includes(w.toLowerCase())
      return '“' + esc(w) + '”' + (other && typed.length === 1 ? ' (a form of “' + esc(typed[0]) + '”)' : '')
    }).join(', '))
  }
  if (why.fileName) parts.push('the file name contains your words')
  if (why.meaning) parts.push(why.words && why.words.length ? 'close in meaning too' : 'close in meaning, though the words differ')
  return parts.join(' · ')
}

/** Never a dead end: say what was searched, what couldn't be, and what to try. */
function renderSearchHelp() {
  const h = state.help
  const filtered = !!(state.group || state.source || state.tags.length || state.date)
  const lines = []
  if (h && h.didYouMean) lines.push('<p class="help-lead">Did you mean <button class="link-btn" data-action="search-for" data-q="' + esc(h.didYouMean) + '">' + esc(h.didYouMean) + '</button>?</p>')
  if (h && h.outsideFilters > 0) lines.push('<p>' + (h.outsideFilters >= 100 ? '100+ results' : esc(plural(h.outsideFilters, 'result'))) + ' outside your filters. <button class="link-btn" data-action="clear-filters">Search everything</button></p>')
  if (h) {
    const notes = []
    notes.push('Duct searched ' + esc(plural(h.documents, 'document')) + '.')
    if (h.indexing) notes.push('It’s still reading files (' + fmt(h.indexing.done) + ' of ' + fmt(h.indexing.total) + '), so some aren’t searchable yet.')
    const unread = h.needsOcr + h.failed
    if (unread > 0) {
      const bits = []
      if (h.needsOcr) bits.push(plural(h.needsOcr, 'scan') + ' with no text yet')
      if (h.passwordProtected) bits.push(h.passwordProtected + ' locked with a password')
      if (h.failed - h.passwordProtected > 0) bits.push((h.failed - h.passwordProtected) + ' that couldn’t be read')
      notes.push('It couldn’t look inside ' + esc(bits.join(', ')) + '. <button class="link-btn" data-action="show-attention">See which</button>')
    }
    lines.push('<p class="help-coverage">' + notes.join(' ') + '</p>')
  }
  const tips = ['Try fewer words, or a word you’d expect in the document.']
  if (/"/.test(state.query)) tips.push('Quoted “exact phrases” must match word for word.')
  if (feature('ask') && !(h && h.didYouMean)) tips.push('<button class="link-btn" data-action="ask-instead">Ask it as a question</button> instead.')
  lines.push('<p class="hint">' + tips.join(' ') + '</p>')
  $('#resultsEmptyText').innerHTML = lines.join('')
  if (!h && filtered) $('#resultsEmptyText').insertAdjacentHTML('afterbegin', '<p>Nothing matched within the current filters. <button class="link-btn" data-action="clear-filters">Search everything</button></p>')
}

function terms(result) {
  const marked = []
  const snippet = result && result.snippet ? result.snippet : ''
  for (let i = snippet.indexOf(MARK_START); i !== -1; i = snippet.indexOf(MARK_START, i + 1)) {
    const end = snippet.indexOf(MARK_END, i)
    if (end > i) marked.push(snippet.slice(i + 1, end).toLowerCase())
  }
  const phrases = [...state.query.matchAll(/"([^"]+)"/g)].map(m => m[1].toLowerCase())
  const words = state.query.replace(/"[^"]*"/g, ' ').toLowerCase().split(/\s+/).filter(w => w.length > 1)
  return [...new Set([...phrases, ...marked, ...words])].slice(0, 12)
}

/**
 * Results are grouped by document: a PDF that matches on five pages is one card, with its best passage, links to the
 * other pages and the other passages a click away. state.results stays the flat, ranked list of passages; state.cards
 * holds, for each card in order, the indexes of its passages (best first), and state.selected is a card index.
 */
function groupResults(results) {
  const byDoc = new Map()
  results.forEach((r, i) => {
    const key = r.chunk.documentPath
    if (!byDoc.has(key)) byDoc.set(key, [])
    byDoc.get(key).push(i)
  })
  return [...byDoc.values()]
}
const cardResult = i => state.cards && state.cards[i] ? state.results[state.cards[i][0]] : undefined

function resultLabel(c, link) {
  if (c.documentFormat === 'audio') return c.page ? 'Play from ' + (c.page - 1) + ':00' : 'Play'
  return link ? 'Open link' : c.page ? 'Open at ' + pageRef(c) : 'Open'
}

function renderResults() {
  const results = state.results
  state.cards = groupResults(results)
  const docs = state.cards.length
  $('#resultsTitle').textContent = !results.length ? 'No results for “' + state.query + '”'
    : plural(docs, 'document') + (results.length > docs ? ' · ' + plural(results.length, 'passage') : '') + ' for “' + state.query + '”'
  // Screen readers hear the count when a search finishes (WCAG 4.1.3).
  $('#resultsStatus').textContent = $('#resultsTitle').textContent
  $('#results').innerHTML = state.cards.map((idx, card) => {
    const r = results[idx[0]]
    const c = r.chunk
    const link = isLink(c.documentPath)
    const folder = link ? new URL(c.documentPath).host : folderOf(c.documentPath).startsWith(state.info.libraryDir) ? 'Duct Library' : folderOf(c.documentPath)
    const others = idx.slice(1)
    // Other pages, in page order, each opening the document there.
    const pages = [...new Map(others.filter(j => results[j].chunk.page && results[j].chunk.page !== c.page).map(j => [results[j].chunk.page, j])).entries()].sort((a, b) => a[0] - b[0])
    const alsoOn = pages.length ? '<div class="also-on">Also on ' + pages.slice(0, 12).map(([, j]) =>
      '<button class="link-btn" data-act="open-at" data-ri="' + j + '">' + esc(pageRef(results[j].chunk)) + '</button>').join(', ') +
      (pages.length > 12 ? ' and ' + (pages.length - 12) + ' more' : '') + '</div>' : ''
    const more = others.length ? '<button class="more-btn" data-act="more" aria-expanded="false">' + plural(others.length, 'more passage') + ' in this document</button>' +
      '<ol class="more-passages" hidden>' + others.map(j => {
        const o = results[j]
        return '<li data-ri="' + j + '">' + (o.chunk.page ? '<span class="where">' + esc(pageRef(o.chunk)) + '</span>' : '') +
          '<div class="snippet">' + (o.snippet ? markSnippet(o.snippet) : highlight(o.chunk.content.slice(0, 260), terms(o))) + '</div>' +
          '<button class="btn btn-sm" data-act="open-at" data-ri="' + j + '">' + esc(resultLabel(o.chunk, link)) + '</button></li>'
      }).join('') + '</ol>' : ''
    return '<li class="result" data-i="' + idx[0] + '" data-card="' + card + '" tabindex="-1">' + badge(c.documentFormat) +
      '<div class="result-main"><div class="result-title"><span class="name">' + esc(fileName(c.documentPath)) + '</span>' +
      (c.page ? '<span class="where">' + esc(pageRef(c)) + '</span>' : '') +
      (c.heading ? '<span class="section">› ' + esc(c.heading) + '</span>' : '') + '</div>' +
      (c.metadata && c.metadata.whatsappChat ? whatsappLine(c.metadata) : '<div class="folder">' + esc(folder) + '</div>') +
      (r.why ? '<div class="why" hidden>' + whyText(r) + '</div>' : '') +
      '<div class="snippet">' + (r.snippet ? markSnippet(r.snippet) : highlight(c.content.slice(0, 260), terms(r))) + '</div>' +
      alsoOn +
      '<div class="result-actions"><button class="btn btn-sm btn-primary" data-act="open">' + esc(resultLabel(c, link)) + '</button>' +
      (link ? '' : '<button class="btn btn-sm" data-act="workspace" title="Open beside another document, with notes">Side by side</button>') +
      '<button class="btn btn-sm" data-act="copy-passage" title="Copy the passage with its source">Copy</button>' +
      (feature('export') ? '<button class="btn btn-sm" data-act="collect" title="Collect this passage to export later">Collect</button>' : '') +
      (desktop && desktop.revealDocument && !link ? '<button class="btn btn-sm" data-act="reveal">Show in folder</button>' : '') +
      (r.why ? '<button class="why-btn" data-act="why" aria-expanded="false">Why this result?</button>' : '') + '</div>' + more + '</div></li>'
  }).join('')
  const empty = $('#resultsEmpty')
  empty.hidden = results.length > 0
  if (!results.length) renderSearchHelp()
  select(results.length ? 0 : -1, false)
  renderMascots()
}

function select(i, scroll = true) {
  state.selected = i
  $$('.result').forEach((el, j) => el.classList.toggle('selected', j === i))
  if (i < 0) { closePreview(); return }
  const el = $$('.result')[i]
  if (scroll && el) el.scrollIntoView({ block: 'nearest' })
  if (window.innerWidth > 1180) renderPreview(cardResult(i))
}

$('#results').addEventListener('click', e => {
  const item = e.target.closest('.result')
  if (!item) return
  const r = state.results[Number(item.dataset.i)]
  const act = e.target.closest('[data-act]')
  if (act && act.dataset.act === 'open') return openResult(r)
  if (act && act.dataset.act === 'open-at') return openResult(state.results[Number(act.dataset.ri)])
  if (act && act.dataset.act === 'more') {
    const list = item.querySelector('.more-passages')
    list.hidden = !list.hidden
    act.setAttribute('aria-expanded', String(!list.hidden))
    return
  }
  // A passage from the expanded list: show it in the preview.
  const other = e.target.closest('.more-passages li')
  if (other) { renderPreview(state.results[Number(other.dataset.ri)]); return }
  if (act && act.dataset.act === 'workspace') return openWorkspace(r.chunk.documentPath, '', r.chunk.page, terms(r))
  if (act && act.dataset.act === 'reveal') return desktop.revealDocument(r.chunk.documentPath)
  if (act && act.dataset.act === 'copy-passage') return copyText('“' + r.chunk.content.trim() + '”\n— ' + sourceLine(r.chunk), 'Passage copied with its source')
  if (act && act.dataset.act === 'collect') return collect(r)
  if (act && act.dataset.act === 'why') {
    const box = item.querySelector('.why')
    box.hidden = !box.hidden
    act.setAttribute('aria-expanded', String(!box.hidden))
    return
  }
  select(Number(item.dataset.card), false)
  if (window.innerWidth <= 1180) renderPreview(r)
})
$('#results').addEventListener('dblclick', e => {
  const item = e.target.closest('.result')
  if (item) openResult(state.results[Number(item.dataset.i)])
})

// ---------- preview ----------

function renderPreview(r) {
  if (!r) return closePreview()
  const c = r.chunk
  const link = isLink(c.documentPath)
  const label = state.info.formats.find(f => f.format === c.documentFormat)?.label || c.documentFormat
  $('#previewBody').innerHTML =
    '<h2>' + esc(fileName(c.documentPath)) + '</h2>' +
    '<div class="meta">' + esc(label) + (c.page ? ' · ' + esc(pageRef(c)) : '') + (c.heading ? ' · ' + esc(c.heading) : '') + '<br>' + esc(link ? c.documentPath : folderOf(c.documentPath)) +
    (c.metadata && (c.metadata.author || c.metadata.year) ? '<br>' + esc([c.metadata.author, c.metadata.year].filter(Boolean).join(', ')) : '') + '</div>' +
    renderTagEditor(c.documentPath) +
    '<div class="actions"><button class="btn btn-primary" data-act="open">' + esc(resultLabel(c, link)) + '</button>' +
    (desktop && desktop.revealDocument && !link ? '<button class="btn" data-act="reveal">Show in folder</button>' : '') +
    (c.metadata && typeof c.metadata.webUrl === 'string' && /^https:\/\//.test(c.metadata.webUrl) ? '<a class="btn" href="' + esc(c.metadata.webUrl) + '" target="_blank" rel="noopener">Open in ' + (c.metadata.connector === 'gdrive' ? 'Google Drive' : 'Microsoft 365') + '</a>' : '') +
    (link ? '' : '<button class="btn" data-act="workspace" title="Open beside another document, with notes">Side by side</button>') +
    '<button class="btn" data-act="copy-passage">Copy passage</button>' +
    (feature('export') ? '<button class="btn" data-act="collect">Collect</button>' : '') + '</div>' +
    '<p class="passage-label">Matching passage</p><div class="passage">' + highlight(c.content, terms(r)) + '</div>' +
    '<div class="cite-row"><button class="btn btn-sm" data-act="cite-apa">Copy citation</button><button class="btn btn-sm" data-act="cite-bibtex">BibTeX</button><button class="btn btn-sm" data-act="copy">Copy path</button></div>'
  $('#preview').hidden = false
  $('.layout').classList.remove('no-preview')
  $('#preview').dataset.i = String(state.results.indexOf(r))
}

function closePreview() {
  $('#preview').hidden = true
  $('.layout').classList.add('no-preview')
}

$('#preview').addEventListener('click', async e => {
  const act = e.target.closest('[data-act]')
  if (!act) return
  const r = state.results[Number($('#preview').dataset.i)]
  if (!r) return
  if (act.dataset.act === 'open') openResult(r)
  if (act.dataset.act === 'workspace') openWorkspace(r.chunk.documentPath, '', r.chunk.page, terms(r))
  if (act.dataset.act === 'reveal') desktop.revealDocument(r.chunk.documentPath)
  if (act.dataset.act === 'copy') copyText(r.chunk.documentPath, 'Path copied')
  if (act.dataset.act === 'copy-passage') copyText('“' + r.chunk.content.trim() + '”\n— ' + sourceLine(r.chunk), 'Passage copied with its source')
  if (act.dataset.act === 'collect') collect(r)
  if (act.dataset.act === 'cite-apa') copyText(citation(r.chunk, 'apa'), 'Citation copied')
  if (act.dataset.act === 'cite-bibtex') copyText(citation(r.chunk, 'bibtex'), 'BibTeX copied')
})

// Tag editing (preview pane and anywhere else a .tag-editor is shown).
document.addEventListener('click', async e => {
  const remove = e.target.closest('[data-remove-tag]')
  const editor = remove && remove.closest('[data-tag-path]')
  if (!editor) return
  const path = editor.dataset.tagPath
  const doc = state.docs.find(d => d.path === path)
  const tags = await saveTags(path, ((doc && doc.tags) || []).filter(t => t !== remove.dataset.removeTag))
  if (tags) editor.outerHTML = renderTagEditor(path)
})
document.addEventListener('keydown', async e => {
  const input = e.target.closest && e.target.closest('[data-add-tag]')
  if (!input || (e.key !== 'Enter' && e.key !== ',')) return
  e.preventDefault()
  const value = input.value.replace(/,/g, ' ').trim()
  if (!value) return
  const editor = input.closest('[data-tag-path]')
  const path = editor.dataset.tagPath
  const doc = state.docs.find(d => d.path === path)
  const tags = await saveTags(path, [...((doc && doc.tags) || []), value])
  if (tags) {
    editor.outerHTML = renderTagEditor(path)
    const again = $('[data-tag-path="' + CSS.escape(path) + '"] [data-add-tag]')
    if (again) again.focus()
  }
})

// ---------- opening documents ----------

/** Opens the workspace: documents side by side with a notebook for notes. */
async function openWorkspace(left, right, page, highlightTerms = [], notebook = '') {
  if (desktop && desktop.openWorkspace) {
    if (!(await desktop.openWorkspace(left, right, page, highlightTerms, notebook))) toast('Couldn’t open the workspace. Try again?', true)
    return
  }
  const q = new URLSearchParams()
  if (left) q.set('left', left)
  if (right) q.set('right', right)
  if (left && page) q.set('lpage', String(page))
  if (left && highlightTerms.length) q.set('lterms', JSON.stringify(highlightTerms))
  if (notebook) q.set('notebook', notebook)
  window.open('/workspace?' + q, '_blank', 'noopener')
}

// ---------- notebooks ----------
// Quotes picked from documents side by side, with comments (the workspace). With sign-in, notebooks can be shared
// with people; the list keeps yours apart from the ones shared with you.

async function renderNotebooks() {
  const box = $('#notebookList')
  let data
  try { data = await json('/api/notebooks') } catch (err) { box.innerHTML = '<p class="empty">' + esc(err.message) + '</p>'; return }
  const list = data.notebooks
  $$('[data-bind="notebookCount"]').forEach(el => { el.textContent = list.length ? fmt(list.length) : '' })
  if (!list.length) {
    box.innerHTML = '<div class="empty"><div class="mascot-slot mascot-md" data-mascot="idle" aria-hidden="true"></div>' +
      '<p><strong>Keep what matters from your documents in one place.</strong></p>' +
      '<p>Open any document with <strong>Side by side</strong>, select a sentence and choose <strong>Add to notes</strong>. Each quote keeps its document and page, and you can add your own comment. Export to Word, or send it as a page anyone can open.</p></div>'
    renderMascots()
    return
  }
  const shared = b => b.owner && b.owner !== data.me
  const access = b => {
    if (!data.sharing) return ''
    if (shared(b)) return '<span class="nb-share">' + (b.role === 'view' ? 'Can read' : 'Can edit') + ' · from ' + esc(b.owner) + '</span>'
    if (!b.owner) return '<span class="nb-share">Everyone</span>'
    const pub = b.publicLink ? '<span class="nb-share nb-public">Public link</span>' : ''
    return pub + (b.sharing.length ? '<span class="nb-share">Shared with ' + (b.sharing.length === 1 ? esc(b.sharing[0].to.replace(/^(user|domain):/, '').replace(/^anyone$/, 'everyone')) : b.sharing.length) + '</span>' : (pub ? '' : '<span class="nb-share">Only you</span>'))
  }
  const row = b => '<button class="nb-row" data-notebook="' + esc(b.id) + '"><span class="nb-name">' + esc(b.name) + '</span>' + access(b) +
    '<span class="nb-meta">' + plural(b.notes, 'note') + ' · ' + timeAgo(b.updatedAt) + '</span></button>'
  const mine = list.filter(b => !shared(b)), theirs = list.filter(shared)
  box.innerHTML = (theirs.length ? (mine.length ? '<h3 class="nb-group">Yours</h3>' : '') : '') + mine.map(row).join('') +
    (theirs.length ? '<h3 class="nb-group">Shared with you</h3>' + theirs.map(row).join('') : '')
}

$('#notebookList').addEventListener('click', e => {
  const row = e.target.closest('[data-notebook]')
  if (row) openWorkspace('', '', undefined, [], row.dataset.notebook)
})
$('#viewNotebooks').addEventListener('click', e => {
  const act = e.target.closest('[data-action]')?.dataset.action
  if (act === 'new-notebook') { $('#nbNewForm').hidden = false; $('#nbNewName').focus() }
  if (act === 'cancel-notebook') { $('#nbNewForm').hidden = true; $('#nbNewName').value = '' }
  if (act === 'import-notebook') $('#nbImportInput').click()
})
$('#nbNewForm').addEventListener('submit', async e => {
  e.preventDefault()
  const name = $('#nbNewName').value.trim()
  if (!name) { $('#nbNewName').focus(); return }
  try {
    const { notebook } = await json('/api/notebooks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
    $('#nbNewForm').hidden = true; $('#nbNewName').value = ''
    renderNotebooks()
    openWorkspace('', '', undefined, [], notebook.id)
  } catch (err) { toast(err.message, true) }
})
$('#nbImportInput').addEventListener('change', async e => {
  const file = e.target.files[0]
  e.target.value = ''
  if (!file) return
  try {
    if (file.size > 8 * 1024 * 1024) throw new Error('That file is too big to be a shared notebook.')
    const { notebook } = await json('/api/notebooks/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: await file.text() }) })
    toast('Added “' + notebook.name + '”: ' + plural(notebook.notes, 'note'))
    renderNotebooks()
  } catch (err) { toast(err.message, true) }
})

async function openDocument(path, page, highlightTerms = []) {
  if (isLink(path)) { window.open(path, '_blank', 'noopener'); return }
  if (desktop && desktop.openDocument) {
    if (!(await desktop.openDocument(path, page, highlightTerms))) toast("Couldn't open " + fileName(path), true)
    return
  }
  // The workspace with this one document: pages as they look, and text you can add to any notebook.
  const q = new URLSearchParams({ left: path, layout: 'one', lpage: String(page || 1), lterms: JSON.stringify(highlightTerms || []) })
  window.open('/workspace?' + q, '_blank', 'noopener')
}

const openResult = r => r && openDocument(r.chunk.documentPath, r.chunk.page, terms(r))

// ---------- ask (Labs) ----------

async function ask(question) {
  setView('ask')
  const log = $('#askLog')
  const block = document.createElement('div')
  block.className = 'qa'
  block.innerHTML = '<div class="question"></div><div class="answer thinking">Reading the most relevant passages…</div>'
  block.querySelector('.question').textContent = question
  log.appendChild(block)
  block.scrollIntoView({ block: 'end', behavior: 'smooth' })
  try {
    const data = await send('POST', '/api/ask', { question, topK: 6 })
    const answer = block.querySelector('.answer')
    answer.classList.remove('thinking')
    answer.textContent = data.answer   // model output is shown as plain text, never as HTML
    const sources = document.createElement('div')
    sources.className = 'sources'
    ;(data.sources || []).slice(0, 6).forEach((s, i) => {
      const b = document.createElement('button')
      b.className = 'source'
      b.textContent = '[' + (i + 1) + '] ' + fileName(s.documentPath) + (s.heading ? ' › ' + s.heading : '')
      b.addEventListener('click', () => openDocument(s.documentPath))
      sources.appendChild(b)
    })
    block.appendChild(sources)
  } catch (err) {
    const answer = block.querySelector('.answer')
    answer.classList.remove('thinking')
    answer.textContent = 'Could not answer: ' + err.message
  }
}

function setMode(mode) {
  state.mode = mode
  $$('.mode').forEach(b => { b.classList.toggle('active', b.dataset.mode === mode); b.setAttribute('aria-selected', String(b.dataset.mode === mode)) })
  const q = $('#q')
  q.placeholder = mode === 'ask' ? 'Ask a question about your documents' : 'Search your documents'
  $('#askSetup').hidden = state.config.llmProvider !== 'none'
  if (mode === 'ask') setView('ask')
  else setView(state.query ? 'results' : 'home')
  q.focus()
}

$$('.mode').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)))

// ---------- search box ----------

let typingTimer = null
$('#q').addEventListener('input', e => {
  if (state.mode !== 'search') return
  clearTimeout(typingTimer)
  typingTimer = setTimeout(() => { state.query = e.target.value.trim(); runSearch() }, 120)
})

$('#searchForm').addEventListener('submit', e => {
  e.preventDefault()
  const value = $('#q').value.trim()
  if (!value) return
  if (state.mode === 'ask') { ask(value); $('#q').value = ''; return }
  state.query = value
  if (state.selected >= 0 && state.results.length) openResult(cardResult(state.selected))
  else runSearch()
})

$('#q').addEventListener('keydown', e => {
  if (state.mode !== 'search') return
  if (e.key === 'ArrowDown') { e.preventDefault(); select(Math.min((state.cards || []).length - 1, state.selected + 1)) }
  if (e.key === 'ArrowUp') { e.preventDefault(); select(Math.max(0, state.selected - 1)) }
  if (e.key === 'Escape') { $('#q').value = ''; state.query = ''; setView('home') }
})

document.addEventListener('keydown', e => {
  const typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')
  if ((e.key === '/' && !typing && slashKeyOn()) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) { e.preventDefault(); focusSearch() }
})

function focusSearch() {
  const q = $('#q')
  q.focus()
  q.select()
}

// ---------- documents ----------

function renderDocuments() {
  $$('.seg-item').forEach(b => b.classList.toggle('active', b.dataset.docFilter === state.docFilter))
  // "Needs attention" always lists every problem; the type and source filters only narrow "All documents".
  const attention = state.docFilter === 'attention'
  const docs = (attention ? attentionDocs() : state.docs.filter(inScope)).slice().sort((a, b) => b.indexedAt - a.indexedAt)
  $('#documentsTitle').textContent = attention ? 'Needs attention' : 'All documents'
  if (attention) $('#docScopeChips').innerHTML = ''
  else renderScopeChips('#docScopeChips')
  if (!docs.length) {
    $('#docTable').innerHTML = state.docFilter === 'attention'
      ? '<div class="empty"><div class="mascot-slot mascot-md" data-mascot="done" aria-hidden="true"></div><p>Every file was read. Nothing needs you.</p></div>'
      : '<div class="empty"><div class="mascot-slot mascot-md" data-mascot="idle" aria-hidden="true"></div><p>Nothing here yet. Add files or watch a folder, and they’ll show up here as Duct reads them.</p></div>'
    renderMascots()
    return
  }
  // Files Duct couldn't read: say so kindly, and what can be done, above the list.
  const attentionNote = attention ? '<div class="attention-note"><div class="mascot-slot mascot-sm" data-mascot="needsHand" aria-hidden="true"></div><p><strong>' +
    (docs.length === 1 ? 'Duct couldn’t read this file.' : 'Duct couldn’t read these ' + fmt(docs.length) + ' files.') + '</strong> ' +
    'Under each one is why, and what usually fixes it. Everything else is searchable meanwhile.</p></div>' : ''
  const statusOf = d => d.status === 'failed' ? '<span class="status bad">Couldn’t read</span>' : d.status === 'no-text' ? '<span class="status warn">No text (scan?)</span>' : '<span class="status ok">Indexed</span>'
  $('#docTable').innerHTML = attentionNote + '<div class="doc-row head" role="row"><span role="columnheader"><span class="sr-only">Type</span></span><span role="columnheader">Name</span><span class="folder-col" role="columnheader">Folder</span><span role="columnheader">Status</span><span role="columnheader"><span class="sr-only">Actions</span></span></div>' +
    docs.slice(0, 2000).map(d => {
      const link = isLink(d.path)
      const actions = []
      if (d.status !== 'failed') actions.push('<button class="btn btn-sm" data-doc-act="open">Open</button>')
      if (d.status !== 'failed' && !link) actions.push('<button class="btn btn-sm" data-doc-act="workspace" title="Open beside another document, with notes">Side by side</button>')
      if (d.status === 'no-text' && !link && isAdmin() && feature('ocrOnDemand')) actions.push('<button class="btn btn-sm" data-doc-act="ocr">Read with OCR</button>')
      if (desktop && desktop.revealDocument && !link) actions.push('<button class="btn btn-sm" data-doc-act="reveal">Show</button>')
      if (isAdmin()) actions.push('<button class="btn btn-sm btn-danger" data-doc-act="remove" title="Remove from Duct">✕</button>')
      return '<div class="doc-row" role="row" data-path="' + esc(d.path) + '"><span role="cell">' + badge(d.format) + '</span>' +
        '<span class="name-cell" role="cell"><span class="name" title="' + esc((d.displayName || fileName(d.path)) + '\n' + d.path) + '">' + esc(d.displayName || fileName(d.path)) + '</span>' +
        ((d.tags || []).length ? '<span class="tags">' + d.tags.map(t => '<span class="tag">' + esc(t) + '</span>').join('') + '</span>' : '') + '</span>' +
        '<span class="folder" role="cell">' + esc(link ? d.path : d.source === 'library' ? 'Duct Library' : folderOf(d.path)) + '</span>' +
        '<span role="cell">' + statusOf(d) + '</span><span class="row-actions" role="cell">' + actions.join('') + '</span>' +
        (d.status === 'failed' && d.error ? '<span class="err" role="cell" title="' + esc(d.error) + '">' + esc(fileProblem(d.error)) + '</span>' : '') + '</div>'
    }).join('')
  if (attention) renderMascots()
}

/** Why a file couldn't be read, in plain words (the original message stays in the tooltip). */
function fileProblem(error) {
  const e = String(error || '')
  if (/password|encrypt/i.test(e)) return 'Locked with a password. Remove the password, or save an unlocked copy, and Duct will read it.'
  if (/eacces|eperm|permission/i.test(e)) return 'Duct isn’t allowed to open it. Check the file’s permissions, or the folder access Duct has.'
  if (/enoent|no such file/i.test(e)) return 'It was moved or deleted after Duct found it.'
  if (/too large|exceeds|size limit/i.test(e)) return 'It’s larger than Duct reads.'
  if (/invalid|corrupt|malformed|unexpected end|bad xref|not a valid|zip/i.test(e)) return 'The file looks damaged. Opening it and saving it again from the app that made it often fixes this.'
  if (/timeout|timed out/i.test(e)) return 'It took too long to read. Duct will try again when the file changes.'
  return e
}

$$('.seg-item').forEach(b => b.addEventListener('click', () => { state.docFilter = b.dataset.docFilter; renderDocuments(); renderSidebar() }))

$('#docTable').addEventListener('click', async e => {
  const act = e.target.closest('[data-doc-act]')
  const row = e.target.closest('[data-path]')
  if (!act || !row) return
  const path = row.dataset.path
  const doc = state.docs.find(d => d.path === path)
  if (act.dataset.docAct === 'open') openDocument(path)
  if (act.dataset.docAct === 'workspace') openWorkspace(path)
  if (act.dataset.docAct === 'reveal') desktop.revealDocument(path)
  if (act.dataset.docAct === 'ocr') {
    act.disabled = true
    act.textContent = 'Reading…'
    try {
      const data = await send('POST', '/api/ocr', { path })
      toast(data.chunks > 0 ? 'Read it. Its words are searchable now.' : 'I looked, but found no words I could read in that scan. A clearer copy may work.', data.chunks === 0)
    } catch (err) { toast('Couldn’t read the text in that scan. ' + err.message, true) }
    refreshAll()
  }
  if (act.dataset.docAct === 'remove') {
    const fromLibrary = doc && doc.source === 'library'
    if (!confirm(fromLibrary ? 'Remove ' + fileName(path) + ' from your Duct Library?\n\nThe copy in the Library is deleted.' : 'Remove ' + fileName(path) + ' from Duct?\n\nThe file itself is not touched.')) return
    try { await json('/api/documents?path=' + encodeURIComponent(path), { method: 'DELETE' }); toast('Removed ' + fileName(path)) } catch (err) { toast(err.message, true) }
    refreshAll()
  }
})

document.addEventListener('click', e => {
  const open = e.target.closest('[data-open-doc]')
  if (open) openDocument(open.dataset.openDoc)
})

// ---------- adding things ----------

async function uploadFiles(files) {
  const list = [...files]
  if (!list.length) return
  let added = 0, duplicates = 0, failed = 0, unsupported = 0
  showProgress('Adding ' + plural(list.length, 'file') + '…')
  for (let start = 0; start < list.length; start += 10) {
    const form = new FormData()
    list.slice(start, start + 10).forEach(f => form.append('files', f))
    setProgress(start, list.length, list[start].name)
    try {
      const res = await api('/api/index', { method: 'POST', body: form })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { if (/Unsupported/.test(data.error || '')) unsupported += Math.min(10, list.length - start); else throw new Error(data.error || 'HTTP ' + res.status); continue }
      for (const r of data.results || []) { if (r.duplicateOf) duplicates++; else if (r.failed) failed++; else added += r.documents || 0 }
    } catch (err) { toast('Couldn’t add those files. ' + err.message, true); failed += Math.min(10, list.length - start) }
  }
  setProgress(list.length, list.length, '')
  const parts = [plural(added, 'file') + ' added']
  if (duplicates) parts.push(duplicates + ' already there')
  if (failed) parts.push(failed + " couldn't be read")
  if (unsupported) parts.push(unsupported + ' not supported')
  toast(parts.join(', '), failed > 0 && added === 0)
  await refreshAll()
  finishWelcomeIfReady()
}

$('#fileInput').addEventListener('change', e => { uploadFiles(e.target.files); e.target.value = '' })

$('#whatsappInput').addEventListener('change', async e => {
  const file = e.target.files[0]
  e.target.value = ''
  if (!file) return
  toast('Reading the WhatsApp chat…')
  const form = new FormData()
  form.append('file', file)
  try {
    const res = await api('/api/whatsapp', { method: 'POST', body: form })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status)
    toast('Added “' + data.chat + '”: ' + plural(data.messages, 'message') + ' and ' + plural(data.attachments, 'file') + (data.skipped ? ' (' + data.skipped + ' voice notes, stickers or other files left out)' : ''))
    refreshAll()
  } catch (err) { toast(err.message, true) }
})

/** "WhatsApp · from Chidi Okafor in Okafor Holdings · 8 Mar 2026" */
function whatsappLine(meta) {
  if (!meta || !meta.whatsappChat) return ''
  const when = meta.whatsappSentAt ? new Date(meta.whatsappSentAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''
  return '<div class="wa-line">WhatsApp' + (meta.whatsappSender ? ' · from ' + esc(meta.whatsappSender) + ' in ' + esc(meta.whatsappChat) : ' · ' + esc(meta.whatsappChat)) + (when ? ' · ' + esc(when) : '') + '</div>'
}

async function watchFolder() {
  if (desktop && desktop.watchDirectory) {
    const dir = await desktop.watchDirectory()
    if (!dir) return
    toast('Watching ' + fileName(dir))
    showProgress('Reading ' + fileName(dir) + '…')
    await refreshAll()
    return
  }
  // A server started with --watch-root: ask for a folder on the server.
  const form = $('#welcome').hidden ? null : $('#welcomeWatchForm')
  if (form) { form.hidden = false; form.querySelector('input').focus(); return }
  const dir = window.prompt('Folder on the server to watch (inside a --watch-root):')
  if (dir) await watchServerFolder(dir)
}

async function watchServerFolder(dir) {
  try {
    await send('POST', '/api/watch', { directories: [dir] })
    toast('Watching ' + dir)
    showProgress('Reading ' + fileName(dir) + '…')
    await refreshAll()
  } catch (err) { toast(err.message, true) }
}

$('#welcomeWatchForm').addEventListener('submit', e => {
  e.preventDefault()
  const dir = e.target.dir.value.trim()
  if (dir) watchServerFolder(dir)
})

$('#urlForm').addEventListener('submit', async e => {
  if (e.submitter && e.submitter.value === 'cancel') return
  const url = e.target.url.value.trim()
  e.target.url.value = ''
  if (!url) return
  try {
    const data = await send('POST', '/api/index', { url })
    const r = (data.results || [])[0] || {}
    toast(r.failed ? 'Couldn’t read that page. It may need a sign-in, or block apps like Duct.' : 'Added ' + url, !!r.failed)
  } catch (err) { toast(err.message, true) }
  refreshAll()
})

// Drag and drop anywhere adds files to the Library.
let dragDepth = 0
window.addEventListener('dragenter', e => { if (feature('uploads') && e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); dragDepth++; $('#dropOverlay').hidden = false } })
window.addEventListener('dragover', e => { if (dragDepth) e.preventDefault() })
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true } })
window.addEventListener('drop', e => {
  if (!dragDepth) return
  e.preventDefault()
  dragDepth = 0
  $('#dropOverlay').hidden = true
  uploadFiles(e.dataTransfer.files)
})

// ---------- first run ----------

function skippedWelcome() { try { return localStorage.getItem('duct.welcomed') === '1' } catch { return false } }
function rememberWelcome() { try { localStorage.setItem('duct.welcomed', '1') } catch {} }

function showWelcome() {
  $('#welcome').hidden = false
  $('#app').hidden = true
  $('#welcomeStart').hidden = false
  $('#welcomeProgress').hidden = true
  $('#welcomeReady').hidden = true
  $('#welcome [data-mascot]').dataset.mascot = 'welcome'
  $('[data-action="watch-folder"]', $('#welcome')).hidden = !state.canWatch || !feature('watchedFolders')
  renderMascots()
}

function showApp() {
  $('#welcome').hidden = true
  $('#app').hidden = false
  setView(state.query ? 'results' : 'home')
}

function showProgress(text) {
  if ($('#welcome').hidden) return
  $('#welcomeStart').hidden = true
  $('#welcomeProgress').hidden = false
  $('#welcomeProgressText').textContent = text
  $('#welcome [data-mascot]').dataset.mascot = 'working'
  renderMascots()
}

function setProgress(done, total, current) {
  if ($('#welcome').hidden) return
  const bar = $('#welcomeBar')
  bar.classList.toggle('indeterminate', !total)
  bar.style.width = total ? Math.round((done / total) * 100) + '%' : ''
  $('#welcomeProgressText').textContent = total ? 'Read ' + fmt(done) + ' of ' + plural(total, 'file') : 'Getting started…'
  $('#welcomeCurrent').textContent = current || ' '
}

// ---------- the deadlines radar ----------

let radar = null
let radarFor = -1          // the document count the radar was read for
let radarAt = 0
let radarAll = false
const RADAR_KIND = { expires: 'Expires', due: 'Due', renews: 'Renews' }
const RADAR_PASSED = { expires: 'Expired', due: 'Due date passed', renews: 'Renewed' }

function dayDiff(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  const today = new Date()
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000)
}
function whenText(iso) {
  const n = dayDiff(iso)
  return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? 'yesterday' : n > 0 ? 'in ' + n + ' days' : -n + ' days ago'
}

async function renderRadar(docCount) {
  const box = $('#homeRadar')
  if (!feature('deadlines') || !docCount || state.activity.indexing) { box.hidden = true; return }
  // Read again when the library changes, and at most every 10 minutes otherwise (dates move on).
  if (radarFor !== docCount || Date.now() - radarAt > 600000) {
    radarFor = docCount
    radarAt = Date.now()
    try { radar = await json('/api/deadlines') } catch { radar = null }
  }
  const r = radar
  if (!r || !(r.passed.length + r.soon.length + r.later.length)) { box.hidden = true; return }
  const items = radarAll ? [...r.passed, ...r.soon, ...r.later] : [...r.passed.slice(0, 2), ...r.soon.slice(0, 5)]
  const shown = items.length ? items : r.later.slice(0, 3)
  const summary = []
  if (r.soon.length) summary.push(plural(r.soon.length, 'date') + ' in the next 30 days')
  if (r.passed.length) summary.push(r.passed.length + ' passed recently')
  if (!summary.length) summary.push('Nothing in the next 30 days')
  state.radarItems = shown
  box.hidden = false
  box.innerHTML = '<div class="radar-head"><h2>Coming up</h2><span class="hint">' + esc(summary.join(' · ')) + '</span></div>' +
    '<ol class="radar-list">' + shown.map((d, i) => {
      const n = dayDiff(d.date)
      const date = new Date(d.date + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: n > 300 || n < -300 ? 'numeric' : undefined })
      return '<li><button class="radar-item' + (n < 0 ? ' passed' : n <= 7 ? ' near' : '') + '" data-radar="' + i + '">' +
        '<span class="radar-date"><strong>' + esc(date) + '</strong><small>' + esc(whenText(d.date)) + '</small></span>' +
        '<span class="radar-body"><span class="radar-title"><span class="radar-kind">' + esc((n < 0 ? RADAR_PASSED : RADAR_KIND)[d.kind]) + '</span> ' + esc(d.name) + (d.page ? ' <span class="hint">' + esc(pageRef({ page: d.page, documentFormat: d.format })) + '</span>' : '') + '</span>' +
        '<span class="radar-text">' + markSnippet(d.text) + '</span></span></button></li>'
    }).join('') + '</ol>' +
    (r.passed.length + r.soon.length + r.later.length > shown.length || radarAll ? '<button class="link-btn" data-action="radar-toggle">' + (radarAll ? 'Show less' : 'Show all ' + (r.passed.length + r.soon.length + r.later.length) + ', up to a year ahead') + '</button>' : '') +
    '<p class="hint radar-foot">Read from the words next to each date, on this computer. Duct can’t tell whether an invoice was paid; check the document.</p>'
}

document.addEventListener('click', e => {
  const item = e.target.closest('[data-radar]')
  if (!item) return
  const d = state.radarItems[Number(item.dataset.radar)]
  const dateWords = (d.text.match(/\u0002([^\u0003]*)\u0003/) || [])[1]
  openDocument(d.path, d.page, dateWords ? [dateWords] : [])
})

// ---------- the first minute: what Duct found, and a first search ----------

let discovery = null
let discoveryFor = -1   // the document count the suggestions were made for
let discoverAt = 0
async function loadDiscovery(force = false) {
  if (!force && discovery && Date.now() - discoverAt < 2500) return discovery
  discoverAt = Date.now()
  try { discovery = await json('/api/discover') } catch {}
  return discovery
}

/** "38 invoices, 12 contracts and 4 CVs" */
function foundText(d) {
  if (!d || !d.kinds.length) return ''
  const parts = d.kinds.slice(0, 4).map(k => fmt(k.count) + ' ' + (k.count === 1 ? k.one : k.label))
  return parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0]
}

function renderTry(target, d) {
  const box = $(target)
  if (!box) return
  box.innerHTML = d && d.suggestions.length ? '<span class="try-label">Try</span>' + d.suggestions.map(q => '<button class="try-chip" data-action="search-for" data-q="' + esc(q) + '">' + esc(q) + '</button>').join('') : ''
}

async function updateFoundSoFar() {
  if ($('#welcome').hidden || $('#welcomeProgress').hidden) return
  const d = await loadDiscovery()
  const text = foundText(d)
  $('#welcomeFound').textContent = text ? 'Found so far: ' + text : ''
}

async function showReady() {
  const d = await loadDiscovery(true)
  $('#welcomeStart').hidden = true
  $('#welcomeProgress').hidden = true
  $('#welcomeReady').hidden = false
  $('#welcome [data-mascot]').dataset.mascot = 'done'
  renderMascots()
  const n = d ? d.documents : readyDocs().length
  const found = foundText(d)
  $('#welcomeReadyFound').textContent = 'Duct read ' + plural(n, 'document') + (found ? ' and found ' + found + '.' : '.') + ' All of it stayed on this computer.'
  renderTry('#welcomeTry', d)
  $('#welcome [data-mascot]').dataset.mascot = 'done'
  renderMascots()
  $('#welcomeQ').focus()
}

$('#welcomeSearch').addEventListener('submit', e => {
  e.preventDefault()
  const q = $('#welcomeQ').value.trim()
  if (!q) return
  rememberWelcome()
  showApp()
  $('#q').value = q
  state.query = q
  runSearch()
})

function finishWelcomeIfReady() {
  if ($('#welcome').hidden || state.activity.indexing || !$('#welcomeReady').hidden) return
  if (readyDocs().length) showReady()
  else if (attentionDocs().length) {
    $('#welcome [data-mascot]').dataset.mascot = 'done'
    renderMascots()
    setTimeout(() => { rememberWelcome(); showApp() }, 900)
  }
}

// ---------- settings ----------

const KEY_FIELDS = [['openaiKey', 'OpenAI'], ['geminiKey', 'Gemini'], ['cohereKey', 'Cohere'], ['voyageKey', 'Voyage'], ['mistralKey', 'Mistral'], ['jinaKey', 'Jina']]
const isAdmin = () => !state.info || state.info.role === 'admin'

async function openSettings(tab = 'general') {
  try { state.config = await json('/api/config') } catch {}
  const dialog = $('#settings')
  for (const el of $$('[data-setting]', dialog)) {
    const value = state.config[el.dataset.setting]
    if (el.type === 'checkbox') el.checked = !!value
    else el.value = value ?? ''
  }
  $('#mascotToggle').checked = mascotEnabled()
  try { state.info.features = (await json('/api/features')).features } catch {}
  renderFeatureList(desktop && desktop.getPrefs ? await desktop.getPrefs().catch(() => null) : null, desktop && desktop.getShortcut ? await desktop.getShortcut().catch(() => null) : null)
  renderTelemetry()
  $('#libraryDir').textContent = state.info.libraryDir
  $('#keyStorage').textContent = desktop ? 'Keys are stored in your system keychain and never written to disk in plain text.' : 'Keys are kept in memory until the server restarts. They are never written to disk.'
  $('#keys').innerHTML = KEY_FIELDS.map(([field, label]) =>
    '<div class="key-row"><label for="key-' + field + '">' + label + '</label><input id="key-' + field + '" type="password" autocomplete="off" data-key="' + field + '" placeholder="' + (state.config.keysSet && state.config.keysSet[field] ? 'Saved' : 'Not set') + '">' +
    '<span class="set">' + (state.config.keysSet && state.config.keysSet[field] ? '✓ set' : '') + '</span></div>').join('')
  const notice = $('#embedNotice')
  notice.hidden = !state.activity.embeddingError
  notice.textContent = state.activity.embeddingError ? 'Search by meaning is paused: ' + state.activity.embeddingError + '. Keyword search still works.' : ''
  renderConnectors()
  $('#settingsSources').innerHTML = state.sources.length ? state.sources.map(s => '<div class="kv"><code>' + esc(s.path) + '</code></div>').join('') : '<p class="hint">None yet.</p>'
  $$('[data-desktop]', dialog).forEach(el => { el.hidden = !desktop })
  updateUrlFields()
  showTab(isAdmin() || !['search', 'ai'].includes(tab) ? tab : 'general')
  if (!dialog.open) dialog.showModal()
}

// ---------- feedback, diagnostics and crash reports ----------

async function copyDiagnostics() {
  try {
    const d = await json('/api/diagnostics')
    await navigator.clipboard.writeText('Duct diagnostics\n' + JSON.stringify(d, null, 2))
    toast('Diagnostics copied: no documents, file names or searches')
  } catch (err) { toast('Couldn’t copy diagnostics: ' + err.message, true) }
}

async function openFeedback() {
  if ($('#settings').open) $('#settings').close()
  const [diag, crashes, account] = await Promise.all([
    json('/api/diagnostics').catch(() => null),
    isAdmin() ? json('/api/crashes').catch(() => ({ crashes: [] })) : Promise.resolve({ crashes: [] }),
    json('/api/account').catch(() => ({})),
  ])
  $('#feedbackDiagPreview').textContent = diag ? JSON.stringify(diag, null, 2) : 'Diagnostics are unavailable.'
  const list = crashes.crashes || []
  $('#feedbackCrashRow').hidden = $('#feedbackCrashDetails').hidden = list.length === 0
  $('#feedbackCrashCount').textContent = String(list.length)
  $('#feedbackCrashes').checked = list.length > 0
  $('#feedbackCrashPreview').textContent = JSON.stringify(list.slice(0, 10), null, 2)
  if (account.email && !$('#feedbackEmail').value) $('#feedbackEmail').value = account.email
  updateFeedbackMailto()
  $('#feedbackDialog').showModal()
  $('#feedbackMessage').focus()
}

function updateFeedbackMailto() {
  const body = $('#feedbackMessage').value + ($('#feedbackDiag').checked ? '\n\n---\n' + $('#feedbackDiagPreview').textContent : '')
  $('#feedbackEmailLink').href = 'mailto:duct@tensflare.com?subject=' + encodeURIComponent('Duct feedback') + '&body=' + encodeURIComponent(body.slice(0, 1800))
}
$('#feedbackMessage').addEventListener('input', updateFeedbackMailto)
$('#feedbackDiag').addEventListener('change', updateFeedbackMailto)

async function sendFeedbackNow() {
  const message = $('#feedbackMessage').value.trim()
  if (!message) { toast('Write a message first', true); $('#feedbackMessage').focus(); return }
  const btn = $('[data-action="send-feedback"]')
  btn.disabled = true
  btn.textContent = 'Sending…'
  try {
    await send('POST', '/api/feedback', { message, email: $('#feedbackEmail').value.trim() || undefined, includeDiagnostics: $('#feedbackDiag').checked, includeCrashes: $('#feedbackCrashes').checked })
    $('#feedbackMessage').value = ''
    $('#feedbackDialog').close()
    toast('Thanks! Your feedback was sent.')
  } catch (err) {
    toast(err.message + ' You can use “Email instead”.', true)
  } finally {
    btn.disabled = false
    btn.textContent = 'Send'
  }
}

async function renderCrashSummary() {
  if (!isAdmin()) return
  const list = (await json('/api/crashes').catch(() => ({ crashes: [] }))).crashes || []
  const el = $('#crashSummary')
  el.hidden = list.length === 0
  el.innerHTML = list.length ? esc(plural(list.length, 'crash report')) + ' saved on this device. They’re only sent if you include them with feedback. <button class="link" data-action="clear-crashes">Delete them</button>' : ''
}

// ---------- account (Sign in with Tensflare) and usage counts ----------

const ENTITLEMENT_LABELS = { 'ai.hosted': 'Search by meaning and AI answers without your own API key', 'sync.devices': 'Sync settings and sources across devices', 'team.workspace': 'Shared team search', 'team.connectors': 'Connectors (Drive, SharePoint, S3…)', 'team.sso': 'Google and Microsoft sign-in for your team', 'enterprise.byoc': 'Deployment in your own cloud', 'enterprise.offline_licence': 'Offline licence', 'enterprise.scim': 'User provisioning' }
let accountPoll = null

async function renderAccount() {
  const box = $('#accountBody')
  let a
  try { a = await json('/api/account') } catch { a = { available: false } }
  clearTimeout(accountPoll)
  if (!a.available) { box.innerHTML = '<p class="hint">Accounts aren’t available on this server.</p>'; return }
  if (a.signingIn) {
    box.innerHTML = '<div class="account-card"><strong>Finish signing in in your browser…</strong><p class="hint">A Tensflare page opened in your browser. Come back here when it says you’re signed in.</p></div>'
    accountPoll = setTimeout(() => { if ($('#settings').open) renderAccount() }, 2000)
    return
  }
  if (!a.signedIn) {
    box.innerHTML = '<div class="account-card"><strong>You don’t need an account to use Duct</strong>' +
      '<p class="hint">Everything on this computer works signed out: every file type, OCR, search, the viewer, watched folders and local AI models. Sign in with Tensflare only for paid features such as AI without your own API key, sync and team search.</p>' +
      (a.signInError ? '<p class="notice">Sign-in didn’t finish: ' + esc(a.signInError) + '</p>' : '') +
      '<div><button class="btn btn-primary" data-action="account-signin">Sign in with Tensflare</button></div></div>'
    return
  }
  const until = a.expiresAt ? new Date(a.expiresAt).toLocaleDateString() : ''
  let bill = null
  try { bill = await json('/api/account/billing') } catch {}
  const sub = bill && bill.subscription
  const day = iso => iso ? new Date(iso).toLocaleDateString() : ''
  const billingHtml = sub
    ? '<p class="hint">' + (sub.status === 'past_due' ? '<strong>Your last payment didn’t go through.</strong> Update your payment method to keep your plan.'
      : sub.renews ? 'Renews on ' + esc(day(sub.period_end)) + ' for ' + esc(sub.price) + (sub.interval === 'year' ? ' a year' : ' a month') + '.'
      : 'Ends on ' + esc(day(sub.period_end)) + '. It won’t renew.') + (sub.plan === 'team' ? ' ' + esc(String(sub.seats)) + ' seats.' : '') + '</p>' +
      (bill.invoices.length ? '<p class="hint">Last payment: ' + esc(bill.invoices[0].amount) + ' on ' + esc(day(bill.invoices[0].date)) + (bill.invoices[0].status !== 'paid' ? ' (' + esc(bill.invoices[0].status) + ')' : '') + '</p>' : '')
    : ''
  box.innerHTML = '<div class="account-card"><span class="plan">' + esc(a.plan) + '</span><strong>' + esc(a.email || 'Signed in') + '</strong>' +
    (a.needsReconnect ? '<p class="notice">Connect to the internet to keep paid features working. Everything local still works.</p>' : '') +
    (a.entitlements.length ? '<ul>' + a.entitlements.map(e => '<li>' + esc(ENTITLEMENT_LABELS[e] || e) + '</li>').join('') + '</ul>' : '<p class="hint">Your plan is Free. Everything local is included.</p>') +
    (until && !a.needsReconnect ? '<p class="hint">Paid features keep working offline until ' + esc(until) + '.</p>' : '') + billingHtml +
    (await aiAndSyncHtml()) +
    '<div class="about-actions">' + (sub ? '<button class="btn btn-primary" data-action="account-portal" data-next="/account">Manage plan and billing</button>' : '<button class="btn btn-primary" data-action="account-portal" data-next="/account/upgrade">Upgrade</button><button class="btn" data-action="account-portal" data-next="/account">Account settings</button>') +
    '<button class="btn" data-action="account-signout">Sign out</button></div></div>'
}

/** Hosted AI credits and the sync switch, for the Account tab. */
async function aiAndSyncHtml() {
  const [ai, sync] = await Promise.all([json('/api/account/ai').catch(() => ({})), json('/api/sync').catch(() => ({}))])
  let html = ''
  if (ai.entitled) {
    html += '<p class="hint">Hosted AI: ' + esc(String(ai.credits.used)) + ' of ' + esc(String(ai.credits.limit)) + ' credits used this month. Choose “Tensflare” in Settings › AI to use it.</p>'
  }
  if (sync.available) {
    html += '<label class="check"><input type="checkbox" id="syncToggle"' + (sync.enabled ? ' checked' : '') + '> <span><strong>Sync settings across my devices</strong><small>Search and AI settings and feature switches. Never your documents, file names, folders or API keys.' +
      (sync.enabled && sync.lastSync ? ' Last synced ' + esc(new Date(sync.lastSync).toLocaleString()) + '.' : '') + (sync.error ? ' <span class="warn">' + esc(sync.error) + '</span>' : '') + '</small></span></label>'
  }
  return html
}

// ---------- cloud sources (connectors) ----------

let connectorPoll = null
let connectorsBusy = false
async function renderConnectors() {
  clearTimeout(connectorPoll)
  let c
  try { c = await json('/api/connectors') } catch { c = { available: false } }
  state.connectors = c.connectors || []
  $('#cloudSources').hidden = !c.available
  if (!c.available) return
  $('#connectorsUpsell').hidden = c.entitled
  $('#connectGoogle').hidden = !c.google || !c.entitled
  $('#connectMicrosoft').hidden = !c.microsoft || !c.entitled
  $('#sharepointForm').hidden = !c.microsoft || !c.entitled
  $('#s3Connect').hidden = !c.entitled
  const busy = (c.connecting && c.connecting.running) || state.connectors.some(x => x.syncing)
  $('#connectorList').innerHTML =
    (c.connecting ? '<p class="' + (c.connecting.error ? 'notice' : 'hint') + '">' + (c.connecting.error ? 'Couldn’t connect: ' + esc(c.connecting.error) : 'Finish signing in in your browser…') + '</p>' : '') +
    state.connectors.map(x => '<div class="kv connector-row"><span><strong>' + esc(x.label) + '</strong><br><small class="hint">' +
      (x.syncing ? 'Reading…' : esc(plural(x.fileCount, 'file')) + (x.lastSync ? ' · updated ' + esc(timeAgo(Date.parse(x.lastSync))) : '')) +
      (x.error ? ' · <span class="warn">' + esc(x.error) + '</span>' : '') + '</small></span>' +
      (isAdmin() ? '<span class="row-actions"><button class="btn btn-sm" data-action="sync-source" data-id="' + esc(x.id) + '">Sync now</button><button class="btn btn-sm btn-danger" data-action="disconnect-source" data-id="' + esc(x.id) + '">Disconnect</button></span>' : '') + '</div>' +
      (isAdmin() && state.shared ? visibilityRow(x) : '')).join('')
  if (busy && $('#settings').open) connectorPoll = setTimeout(renderConnectors, 2000)
  if (connectorsBusy && !busy) refreshAll()   // a sync just finished: new documents to show
  connectorsBusy = busy
}

// Who sees a source's results on a shared server.
const SOURCE_NAME = { gdrive: 'Google Drive', microsoft: 'Microsoft 365', s3: 'S3' }
function visibilityRow(x) {
  const opt = (v, label) => '<option value="' + v + '"' + (x.visibility === v ? ' selected' : '') + '>' + esc(label) + '</option>'
  const allow = (x.allow || []).map(p => p.replace(/^(user|domain):/, '')).join(', ')
  return '<form class="visibility-row" data-visibility="' + esc(x.id) + '"><label>Who sees these results <select name="visibility">' +
    (x.kind === 's3' ? '' : opt('source', 'Whoever it’s shared with in ' + SOURCE_NAME[x.kind])) + opt('everyone', 'Everyone on this server') + opt('custom', 'Only these people and domains') + '</select></label>' +
    '<input name="allow" placeholder="ada@okafor.ng, okafor.ng" value="' + esc(allow) + '"' + (x.visibility === 'custom' ? '' : ' hidden') + ' aria-label="Email addresses and domains">' +
    '<button class="btn btn-sm" type="submit">Save</button>' +
    (x.visibility === 'source' ? '<small class="hint">Files shared only by link, or through SharePoint site groups, stay visible to ' + esc(x.owner || 'the person who connected it') + ' alone.</small>' : '') + '</form>'
}

document.addEventListener('change', e => {
  const sel = e.target.closest('.visibility-row select')
  if (sel) sel.form.allow.hidden = sel.value !== 'custom'
})
document.addEventListener('submit', async e => {
  const form = e.target.closest('.visibility-row')
  if (!form) return
  e.preventDefault()
  const visibility = form.visibility.value
  const allow = visibility === 'custom' ? form.allow.value.split(/[,\s]+/).filter(Boolean) : []
  try { await send('PUT', '/api/connectors/' + encodeURIComponent(form.dataset.visibility) + '/visibility', { visibility, allow }); toast('Saved: results follow the new setting') } catch (err) { toast(err.message, true) }
  renderConnectors()
})

$('#sharepointForm').addEventListener('submit', async e => {
  e.preventDefault()
  const site = e.target.site.value.trim()
  if (!site) return
  try { const r = await send('POST', '/api/connectors', { kind: 'microsoft', siteUrl: site }); if (r && r.url) { location.assign(r.url); return } e.target.site.value = '' } catch (err) { toast(err.message, true) }
  renderConnectors()
})

$('#s3Form').addEventListener('submit', async e => {
  e.preventDefault()
  const f = e.target
  const btn = f.querySelector('button[type=submit]')
  btn.disabled = true
  btn.textContent = 'Checking the bucket…'
  try {
    await send('POST', '/api/connectors', { kind: 's3', ...Object.fromEntries(new FormData(f)) })
    f.reset()
    $('#s3Connect').open = false
    toast('Bucket connected; reading it now')
  } catch (err) { toast(err.message, true) }
  btn.disabled = false
  btn.textContent = 'Connect bucket'
  renderConnectors()
})

// ---------- audit log (shared servers, admins) ----------

const AUDIT_LABELS = { signin: 'Signed in', search: 'Searched', ask: 'Asked', open: 'Opened', upload: 'Added', delete: 'Removed', ocr: 'Read with OCR', export: 'Exported', notes: 'Edited notes', tags: 'Tagged', settings: 'Changed settings', features: 'Changed features', 'clear-index': 'Cleared the index', watch: 'Watched a folder', unwatch: 'Stopped watching', 'connector-add': 'Connected a source', 'connector-remove': 'Disconnected a source' }
async function renderAudit() {
  const box = $('#auditList')
  let a
  try { a = await json('/api/audit?limit=100') } catch (err) { box.innerHTML = '<p class="hint">' + esc(err.message) + '</p>'; return }
  if (!a.enabled) { box.innerHTML = '<p class="hint">The audit log is kept on shared servers (with an access token or sign-in).</p>'; return }
  box.innerHTML = '<p class="hint">Who did what on this server, newest first. ' + (a.queries ? 'Search terms are recorded.' : 'Search terms aren’t recorded.') + ' <a href="/api/audit?format=csv">Download CSV</a></p>' +
    (a.entries.length ? '<div class="audit-table">' + a.entries.map(e => '<div class="audit-row"><span class="when">' + esc(new Date(e.at).toLocaleString()) + '</span><span class="who">' + esc(e.actor) + '</span><span>' + esc(AUDIT_LABELS[e.action] || e.action) + (e.target ? ' <code>' + esc(fileName(e.target)) + '</code>' : '') + (e.detail ? ' <span class="hint">' + esc(e.detail) + '</span>' : '') + '</span></div>').join('') + '</div>' : '<p class="hint">Nothing yet.</p>')
}

async function renderTelemetry() {
  let t
  try { t = await json('/api/telemetry') } catch { t = { available: false } }
  $('#telemetryBox').hidden = !t.available
  if (!t.available) return
  const toggle = $('#telemetryToggle')
  toggle.checked = !!t.enabled
  toggle.disabled = !!t.blockedBy || !isAdmin()
  $('#telemetryHelp').textContent = t.blockedBy
    ? 'Off: ' + t.blockedBy + '.'
    : 'A daily count of versions, features and library size (in ranges) so Tensflare knows what to improve. Never your documents, file names or searches.'
  $('#telemetryReport').textContent = t.report ? JSON.stringify(t.report, null, 2) : ''
}

// ---------- privacy ledger ----------

const LEDGER_WHAT = {
  tensflare: 'Sign-in checks, the anonymous usage count if it’s on, feedback you chose to send, hosted AI questions, and notebooks you chose to share as a link. Never your files.',
  ai: 'The question and the passages needed to answer it, or text to index for search by meaning: only because you chose this provider.',
  cloud: 'Requests to read the sources you connected. Files come in; nothing of yours goes out.',
  signin: 'Signing in to a service you connected.',
  models: 'Downloading the speech model for audio search, once. Your recordings are transcribed on this computer and never sent.',
  web: 'Fetching web pages you added to Duct.',
}
let ledgerDays = 1

const kb = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'

async function renderLedger() {
  const box = $('#ledgerBody')
  $$('[data-ledger-days]').forEach(b => b.classList.toggle('active', Number(b.dataset.ledgerDays) === ledgerDays))
  let l
  try { l = await json('/api/ledger?days=' + ledgerDays) } catch (err) { box.innerHTML = '<p class="hint">' + esc(err.message) + '</p>'; return }
  if (!l.recording) { box.innerHTML = '<p class="hint">This server doesn’t keep a ledger.</p>'; return }
  const period = ledgerDays === 1 ? 'today' : 'in the last ' + ledgerDays + ' days'
  const byCat = {}
  for (const d of l.days) for (const h of d.hosts) {
    const c = byCat[h.category] ||= {}
    const e = c[h.host] ||= { host: h.host, requests: 0, bytesOut: 0 }
    e.requests += h.requests
    e.bytesOut += h.bytesOut
  }
  const cats = Object.keys(byCat)
  const body = cats.length === 0
    ? '<div class="ledger-nothing"><strong>Nothing.</strong><p>Duct made no connections to other computers ' + period + '. Your documents, searches and settings stayed here.</p></div>'
    : '<p class="hint">Every connection Duct made ' + period + ', by what it was for. Anything not listed didn’t happen.</p>' +
      ['tensflare', 'ai', 'cloud', 'signin', 'web'].filter(c => byCat[c]).map(c =>
        '<div class="ledger-cat"><div class="ledger-cat-head"><strong>' + esc(l.labels[c]) + '</strong></div><p class="hint">' + esc(LEDGER_WHAT[c]) + '</p>' +
        Object.values(byCat[c]).sort((a, b) => b.requests - a.requests).map(h =>
          '<div class="ledger-host"><code>' + esc(h.host) + '</code><span>' + esc(plural(h.requests, 'request')) + (h.bytesOut ? ' · ' + kb(h.bytesOut) + ' sent' : '') + '</span></div>').join('') + '</div>').join('')
  const recent = l.recent.length
    ? '<details class="ledger-recent"><summary>Latest connections</summary>' + l.recent.map(e =>
        '<div class="ledger-entry"><span class="when">' + esc(new Date(e.at).toLocaleString()) + '</span><code>' + esc(e.method) + ' ' + esc(e.host) + esc(e.path || '') + '</code>' + (e.bytesOut ? '<span class="hint">' + kb(e.bytesOut) + '</span>' : '') + '</div>').join('') + '</details>'
    : ''
  box.innerHTML = body + recent +
    '<p class="hint ledger-foot">Duct keeps this record itself, on this device, from every connection it makes. Tensflare never sees it. Recording since ' + esc(new Date(l.since).toLocaleString()) + '; kept 30 days. <button class="link-btn" data-action="clear-ledger">Clear</button></p>'
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-ledger-days]')
  if (b) { ledgerDays = Number(b.dataset.ledgerDays); renderLedger() }
})

// Offline: say so, and that nothing is lost.
const updateOnline = () => { $('#offlineNote').hidden = navigator.onLine }
window.addEventListener('online', updateOnline)
window.addEventListener('offline', updateOnline)
updateOnline()

function showTab(tab) {
  if (tab === 'privacy') renderLedger()
  if (tab === 'account') renderAccount()
  if (tab === 'about') renderCrashSummary()
  if (tab === 'audit') renderAudit()
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab))
  $$('.panel').forEach(p => { p.hidden = p.dataset.panel !== tab })
}

function updateUrlFields() {
  const embed = $('[data-setting="embedProvider"]').value
  const llm = $('[data-setting="llmProvider"]').value
  $('[data-show-for="embed-url"]').hidden = embed !== 'ollama' && embed !== 'openai-compatible'
  $('[data-show-for="llm-url"]').hidden = llm !== 'ollama' && llm !== 'openai'
}

$$('.tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)))

$('#settings').addEventListener('change', async e => {
  const el = e.target
  if (el.id === 'mascotToggle') {
    try { localStorage.setItem('duct.mascot', el.checked ? 'on' : 'off') } catch {}
    renderMascots()
    return
  }
  if (el.id === 'syncToggle') {
    try { await send('PUT', '/api/sync', { enabled: el.checked }); toast(el.checked ? 'Sync on' : 'Sync off') } catch (err) { el.checked = !el.checked; toast(err.message, true) }
    renderAccount()
    return
  }
  if (el.id === 'telemetryToggle') {
    try { await send('PUT', '/api/telemetry', { enabled: el.checked }); toast(el.checked ? 'Usage counts on' : 'Usage counts off: nothing is sent') } catch (err) { el.checked = !el.checked; toast(err.message, true) }
    renderTelemetry()
    return
  }
  if (el.dataset.feature || el.dataset.formatKind) {
    const body = el.dataset.feature ? { [el.dataset.feature]: el.checked } : { formats: { [el.dataset.formatKind]: el.checked } }
    try {
      const data = await send('PUT', '/api/features', body)
      state.info.features = data.features
      applyFeatures()
      renderSidebar()
      if (state.query && state.view === 'results') runSearch()
      toast('Saved')
    } catch (err) { el.checked = !el.checked; toast('Couldn’t save that. ' + err.message, true) }
    return
  }
  if (el.dataset.local === 'slashKey') { try { localStorage.setItem('duct.slashKey', el.checked ? 'on' : 'off') } catch {} return }
  if (el.dataset.pref) {
    const ok = await desktop.setPref(el.dataset.pref, el.checked).catch(() => false)
    if (!ok) { el.checked = !el.checked; toast('Couldn’t save that. Try again?', true); return }
    if (el.dataset.pref === 'shortcut' && desktop.getShortcut) {
      const s = await desktop.getShortcut().catch(() => null)
      $('.shortcut-row')?.replaceWith(...(s ? [document.createRange().createContextualFragment(shortcutRow(s))] : []))
      if (s && s.on && s.taken) { toast('Another app is using ' + s.label + '. Pick different keys below.', true); return }
    }
    toast('Saved')
    return
  }
  if (el.dataset.shortcut !== undefined && desktop && desktop.setShortcut) {
    const s = await desktop.setShortcut(el.value).catch(() => null)
    if (!s) { toast('Couldn’t save that. Try again?', true); return }
    $('.shortcut-row').replaceWith(document.createRange().createContextualFragment(shortcutRow(s)))
    if (s.taken) toast('Another app is using ' + s.label + ' too. Try other keys.', true)
    else toast('Quick search is now ' + s.label)
    return
  }
  const body = {}
  if (el.dataset.setting) body[el.dataset.setting] = el.type === 'checkbox' ? el.checked : el.value
  else if (el.dataset.key && el.value.trim()) body[el.dataset.key] = el.value.trim()
  else return
  updateUrlFields()
  try {
    const data = await send('PUT', '/api/config', body)
    state.config = data.config || state.config
    if (el.dataset.key) { el.value = ''; el.placeholder = 'Saved'; el.nextElementSibling.textContent = '✓ set' }
    toast('Saved')
  } catch (err) { toast('Couldn’t save that. ' + err.message, true) }
})

// ---------- status ----------

function renderStatus() {
  const pill = $('#statusPill')
  const a = state.activity
  pill.className = 'status-pill'
  if (a.indexing) {
    pill.classList.add('busy')
    pill.innerHTML = '<span class="dot"></span>Indexing ' + fmt(a.done) + ' / ' + fmt(a.total)
    pill.title = a.current || ''
  } else if (a.embedding) {
    pill.classList.add('busy')
    pill.innerHTML = '<span class="dot"></span>Preparing search by meaning'
    pill.title = ''
  } else if (a.embeddingError) {
    pill.classList.add('warn')
    pill.textContent = 'Search by meaning paused'
    pill.title = a.embeddingError + '. Click for settings.'
  } else {
    pill.textContent = plural(readyDocs().length, 'document')
    pill.title = state.sources.length ? 'Watching ' + plural(state.sources.length, 'folder') : ''
  }
}

let pollTimer = null
async function poll() {
  clearTimeout(pollTimer)
  try {
    state.activity = await json('/api/activity')
    const busy = state.activity.indexing || state.activity.embedding
    if (busy && !$('#welcome').hidden) { setProgress(state.activity.done, state.activity.total, state.activity.current); updateFoundSoFar() }
    if (state.wasBusy && !busy) await refreshAll()   // a run finished: new documents, counts and statuses
    state.wasBusy = busy
    renderStatus()
    if (state.view === 'home') renderHome()
    renderMascots()
  } catch {}
  pollTimer = setTimeout(poll, state.activity.indexing || state.activity.embedding ? 900 : 3000)
}

async function refreshAll() {
  try { await loadData() } catch (err) { toast(err.message, true) }
  renderSidebar()
  renderStatus()
  if (state.view === 'home') renderHome()
  if (state.view === 'documents') renderDocuments()
  if (state.view === 'results' && state.query) runSearch()
  if (state.view === 'notebooks') renderNotebooks()
  else json('/api/notebooks').then(d => { $$('[data-bind="notebookCount"]').forEach(el => { el.textContent = d.notebooks.length ? fmt(d.notebooks.length) : '' }) }, () => {})
  renderMascots()
  finishWelcomeIfReady()
  if (!state.wasBusy && (state.activity.indexing || state.activity.embedding)) { state.wasBusy = true; poll() }
}

// ---------- actions ----------

const ACTIONS = {
  'add-files': () => { closeAddMenu(); $('#fileInput').click() },
  'watch-folder': () => { closeAddMenu(); watchFolder() },
  'add-url': () => { closeAddMenu(); $('#urlDialog').showModal() },
  'add-whatsapp': () => { closeAddMenu(); $('#whatsappDialog').showModal() },
  'pick-whatsapp': () => { $('#whatsappDialog').close(); $('#whatsappInput').click() },
  'toggle-add': () => { const menu = $('#addMenu'); menu.hidden = !menu.hidden; $('[data-action="toggle-add"]').setAttribute('aria-expanded', String(!menu.hidden)) },
  'open-settings': el => openSettings(el.dataset.tab || 'general'),
  'skip-welcome': () => { rememberWelcome(); showApp() },
  'finish-welcome': () => { rememberWelcome(); showApp() },
  'show-attention': () => { state.docFilter = 'attention'; setView('documents') },
  'search-for': el => {
    if (!$('#welcome').hidden) { rememberWelcome(); showApp() }
    $('#q').value = el.dataset.q; state.query = el.dataset.q; runSearch()
  },
  'radar-toggle': () => { radarAll = !radarAll; renderRadar(radarFor) },
  'clear-ledger': async () => { try { await json('/api/ledger', { method: 'DELETE' }) } catch (err) { toast(err.message, true) }; renderLedger() },
  'clear-filters': () => { state.group = null; state.source = null; state.tags = []; state.date = null; renderSidebar(); runSearch() },
  'ask-instead': () => { const q = state.query; setMode('ask'); ask(q) },
  'close-preview': () => closePreview(),
  'toggle-sidebar': () => $('#sidebar').classList.toggle('open'),
  'export': () => exportResults('csv'),
  'toggle-export': () => { const menu = $('#exportMenu'); menu.hidden = !menu.hidden; $('[data-action="toggle-export"]').setAttribute('aria-expanded', String(!menu.hidden)) },
  'connect-source': async el => {
    try { const r = await send('POST', '/api/connectors', { kind: el.dataset.kind }); if (r && r.url) { location.assign(r.url); return } } catch (err) { toast(err.message, true) }
    renderConnectors()
  },
  'sync-source': async el => { try { await send('POST', '/api/connectors/' + encodeURIComponent(el.dataset.id) + '/sync', {}) } catch (err) { toast(err.message, true) }; renderConnectors() },
  'disconnect-source': async el => {
    if (!confirm('Disconnect this source?\n\nIts documents leave Duct and the local copies are deleted. Nothing changes in the cloud.')) return
    try { await json('/api/connectors/' + encodeURIComponent(el.dataset.id), { method: 'DELETE' }); toast('Disconnected') } catch (err) { toast(err.message, true) }
    renderConnectors()
  },
  'sign-out': async () => {
    await rawFetch('/auth/logout', { method: 'POST' }).catch(() => {})
    window.location.href = '/auth/login'
  },
  'open-feedback': () => openFeedback(),
  'copy-diagnostics': () => copyDiagnostics(),
  'send-feedback': () => sendFeedbackNow(),
  'clear-crashes': async () => {
    try { await json('/api/crashes', { method: 'DELETE' }); toast('Crash reports deleted') } catch (err) { toast(err.message, true) }
    renderCrashSummary()
  },
  'account-signin': async () => {
    try { await send('POST', '/api/account/signin', {}); renderAccount() } catch (err) { toast(err.message, true) }
  },
  'account-portal': async el => {
    try {
      const { url } = await send('POST', '/api/account/portal', { next: el.dataset.next || '/account' })
      window.open(url, '_blank', 'noopener')
    } catch (err) { toast(err.message, true) }
  },
  'account-signout': async () => {
    if (!confirm('Sign out of Tensflare on this device?\n\nEverything local keeps working.')) return
    try { await send('POST', '/api/account/signout', {}); toast('Signed out') } catch (err) { toast(err.message, true) }
    renderAccount()
  },
  'show-collected': () => { renderCollected(); $('#collectDialog').showModal() },
  'clear-collected': () => {
    if (!confirm('Clear all collected passages?')) return
    state.collected = []
    saveCollected()
    renderCollected()
    renderCollectedButton()
  },
  'clear-index': async () => {
    if (!confirm('Clear the whole index?\n\nDocuments can be indexed again later. Files on disk are not touched, and watched folders stay watched.')) return
    try { await json('/api/clear', { method: 'DELETE' }); toast('Index cleared') } catch (err) { toast(err.message, true) }
    refreshAll()
  },
  'status': () => {
    if (state.activity.embeddingError) openSettings('ai')
    else if (!state.activity.indexing) { state.docFilter = 'all'; setView('documents') }
  },
}

function closeAddMenu() { $('#addMenu').hidden = true; $('[data-action="toggle-add"]').setAttribute('aria-expanded', 'false') }

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]')
  if (el && ACTIONS[el.dataset.action]) { e.preventDefault(); ACTIONS[el.dataset.action](el); return }
  if (!e.target.closest('.menu-wrap')) { closeAddMenu(); $('#exportMenu').hidden = true }
  const fmtBtn = e.target.closest('[data-export]')
  if (fmtBtn) { $('#exportMenu').hidden = true; exportResults(fmtBtn.dataset.export) }
  const collectBtn = e.target.closest('[data-collect-export]')
  if (collectBtn) exportCollected(collectBtn.dataset.collectExport)
  const removeCollected = e.target.closest('[data-remove-collected]')
  if (removeCollected) {
    state.collected.splice(Number(removeCollected.dataset.removeCollected), 1)
    saveCollected()
    renderCollected()
    renderCollectedButton()
  }
})

async function exportResults(format = 'csv') {
  if (!feature('export')) return
  if (!state.query) { toast('Search for something first, then export what it finds.', true); return }
  try {
    await downloadExport(await api('/api/export?' + addScopeParams(new URLSearchParams({ q: state.query, format, topK: '200' }))), 'duct-export.' + format)
  } catch (err) { toast('Couldn’t export. ' + err.message, true) }
}

// ---------- start ----------

/** The team licence: days left in the evaluation (admins), or why sign-in and sharing have stopped. */
function showLicenceBanner(message, admin) {
  const el = $('#licenceBanner')
  el.innerHTML = '<span>' + esc(message) + '</span>' + (admin ? '<button class="btn btn-sm" data-action="open-settings" data-tab="account">Open Account settings</button>' : '')
  el.classList.toggle('lapsed', !admin || /ended|isn’t active/.test(message))
  el.hidden = false
}
function renderLicence() {
  const t = state.info && state.info.team
  if (!t || t.state === 'plan') return
  const days = Math.max(0, Math.ceil((t.evaluationEndsAt - Date.now()) / 86400000))
  const until = new Date(t.evaluationEndsAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })
  if (t.state === 'evaluation') showLicenceBanner('Team evaluation: ' + plural(days, 'day') + ' left. To keep sign-in, sharing and the audit log after ' + until + ', sign this server in to a Tensflare account with a Team plan.', true)
  else showLicenceBanner(t.message || 'This server’s Team plan isn’t active.', true)
}

async function start() {
  try {
    state.info = await json('/api/info')
    renderLicence()
    state.config = await json('/api/config').catch(() => ({}))
    await loadData()
  } catch (err) {
    document.body.textContent = "Duct couldn't start: " + err.message
    return
  }
  $('#fileInput').accept = state.info.accept
  $$('[data-bind="supported"]').forEach(el => { el.textContent = state.info.supported })
  $$('[data-bind="version"]').forEach(el => { el.textContent = 'v' + state.info.version })
  if (!isAdmin()) $$('[data-admin]').forEach(el => { el.hidden = true })
  $('#askSetup').hidden = state.config.llmProvider !== 'none'
  json('/api/me').then(me => {
    state.shared = !!me.auth   // a server other people use: who sees what matters
    if (!me.user) return
    $('#signedInAs').hidden = false
    $('#signedInEmail').textContent = me.user
  }).catch(() => {})
  applyFeatures()
  renderSidebar()
  renderStatus()
  const empty = state.docs.length === 0 && state.sources.length === 0
  if (empty && !skippedWelcome() && isAdmin()) showWelcome()
  else showApp()
  poll()
}

// Called by the desktop app (electron/main.cjs).
window.duct = {
  refresh: () => refreshAll(),
  showFailed: () => { showApp(); state.docFilter = 'attention'; setView('documents') },
  focusSearch: () => { showApp(); setMode('search'); focusSearch() },
  /** Runs a search here (quick search's "all results"). */
  search: q => { showApp(); setMode('search'); $('#q').value = String(q || ''); state.query = $('#q').value.trim(); if (state.query) runSearch(); else focusSearch() },
  openSettings: () => openSettings(),
  exportResults,
  openFeedback: () => { showApp(); openFeedback() },
  copyDiagnostics: () => copyDiagnostics(),
}

start()
