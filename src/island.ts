// The Duct "island": a small companion that lives in the MacBook notch (or at the top of the screen),
// shows indexing progress, and opens into a quick search. Loaded by the desktop app at
// /island?notch=<notch width px>&bar=<menu bar height px>; window behaviour lives in electron/island.cjs.

export const islandHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Duct Island</title>
<style>
:root {
  --black: #000000; --s1: #111110; --s2: #181816; --border: #252522; --border2: #333330;
  --muted: #6b6b67; --subtle: #9a9a95; --body: #C8C7C0; --text: #F0EFE8; --lime: #A3E635;
  --mono: 'SF Mono','Fira Code','Cascadia Code','Consolas',monospace;
  --sans: -apple-system,BlinkMacSystemFont,'Inter',sans-serif;
  --ease: cubic-bezier(.2, .9, .25, 1.1);
}
html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; font-family: var(--sans); color: var(--text); user-select: none; -webkit-user-select: none; }
#island {
  position: absolute; top: 0; left: 50%; transform: translateX(-50%);
  background: var(--black); overflow: hidden;
  border-radius: 0 0 14px 14px;
  transition: width .24s var(--ease), height .24s var(--ease), border-radius .24s var(--ease), opacity .2s;
  box-shadow: 0 6px 24px rgba(0,0,0,.35);
}
#island.hidden-notch { box-shadow: none; }
#island.handle { border-radius: 0 0 8px 8px; }
#island.large { border-radius: 0 0 26px 26px; }
.section { position: absolute; left: 0; right: 0; opacity: 0; pointer-events: none; transition: opacity .16s; }
.section.on { opacity: 1; pointer-events: auto; transition-delay: .08s; }

/* compact pill (no notch) and live wings */
#pill { top: 0; height: 100%; display: flex; align-items: center; justify-content: space-between; padding: 0 12px; }
#pill .mini { width: 22px; height: 22px; flex-shrink: 0; }
#pill .live-text { font-family: var(--mono); font-size: 11px; color: var(--lime); white-space: nowrap; }
#pill .live-text.done { color: var(--text); }
#pill.compact { justify-content: center; }

/* peek and drop */
#peek { display: flex; align-items: center; gap: 12px; padding: 0 18px; }
#peek canvas, #peek img { width: 76px; height: 76px; flex-shrink: 0; }
.peek-title { font-size: 13px; font-weight: 600; color: var(--text); }
.peek-sub { font-family: var(--mono); font-size: 10.5px; color: var(--subtle); margin-top: 4px; line-height: 1.5; }
kbd { font-family: var(--mono); font-size: 10px; background: var(--s2); border: 1px solid var(--border2); border-radius: 4px; padding: 0 4px; color: var(--body); }

/* expanded search */
#search { padding: 0 16px; display: flex; flex-direction: column; }
.search-row { display: flex; align-items: center; gap: 10px; }
.search-row canvas, .search-row img { width: 44px; height: 44px; flex-shrink: 0; cursor: pointer; }
#q { flex: 1; background: var(--s1); border: 1px solid var(--border2); border-radius: 10px; padding: 10px 12px; color: var(--text); font-size: 14px; outline: none; font-family: var(--sans); }
#q:focus { border-color: var(--lime); }
#results { margin-top: 10px; overflow-y: auto; flex: 1; }
.r { padding: 8px 10px; border-radius: 8px; cursor: pointer; }
.r.sel, .r:hover { background: var(--s2); }
.r-name { font-size: 12.5px; font-weight: 600; color: var(--text); display: flex; gap: 6px; align-items: baseline; }
.r-page { font-family: var(--mono); font-size: 10px; color: var(--lime); }
.r-snip { font-size: 11.5px; color: var(--body); margin-top: 3px; line-height: 1.45; max-height: 3em; overflow: hidden; }
.r-snip mark { background: #1E2A06; color: var(--lime); border-radius: 2px; padding: 0 1px; }
.empty { font-family: var(--mono); font-size: 11px; color: var(--muted); padding: 16px 10px; text-align: center; }
.foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 2px 12px; border-top: 1px solid var(--border); font-family: var(--mono); font-size: 10.5px; color: var(--subtle); }
.foot button { font-family: var(--mono); font-size: 10.5px; background: transparent; color: var(--text); border: 1px solid var(--border2); border-radius: 6px; padding: 3px 9px; cursor: pointer; }
.foot button:hover { border-color: var(--lime); }
</style>
</head>
<body>
<div id="island">
  <div class="section" id="pill">
    <canvas class="mini" id="miniCanvas" width="66" height="66"></canvas>
    <span class="live-text" id="liveText"></span>
  </div>
  <div class="section" id="peek">
    <canvas id="bigCanvas" width="228" height="228"></canvas>
    <div>
      <div class="peek-title" id="peekTitle"></div>
      <div class="peek-sub" id="peekSub"></div>
    </div>
  </div>
  <div class="section" id="search">
    <div class="search-row">
      <canvas id="searchCanvas" width="132" height="132" title="Hi!"></canvas>
      <input id="q" type="text" placeholder="Search your documents" autocomplete="off" spellcheck="false">
    </div>
    <div id="results"></div>
    <div class="foot"><span id="footStatus"></span><button id="openMain">Open Duct</button></div>
  </div>
</div>
<script>
  const api = window.ductIsland
  const params = new URLSearchParams(location.search)
  const NOTCH = Math.max(0, parseInt(params.get('notch') || '0', 10) || 0)
  const BAR = Math.max(0, parseInt(params.get('bar') || '0', 10) || 0)
  const isMac = params.get('platform') === 'darwin'
  const COMPACT = 104   // compact pill width when there is no notch
  const WING = 84       // live wings on each side of the notch or pill
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const POSES = {
    head: 'View - Three-Quarter', welcome: 'Pose - Welcome', working: 'Pose - Working', done: 'Pose - Done',
    nothingFound: 'Pose - Nothing Found', needsHand: 'Pose - Needs a Hand', resting: 'Pose - Resting',
  }

  let state = 'hidden'       // hidden | live | peek | search | drop
  let liveKind = null        // working | done
  let pointerInside = false
  let leaveTimer = null
  let liveTimer = null
  let stats = { documents: 0 }
  let sources = []
  let activity = { indexing: false }
  let results = []
  let selected = 0
  let lastQuery = ''

  // ---------- shape ----------
  function sizeFor(s) {
    const top = BAR
    if (s === 'hidden') {
      if (NOTCH) return { w: NOTCH, h: top, cls: 'hidden-notch' }
      if (isMac) return { w: COMPACT, h: top, cls: '' }
      return { w: COMPACT, h: 6, cls: 'handle' }
    }
    if (s === 'live') return { w: (NOTCH || COMPACT) + WING * 2, h: Math.max(top, 30), cls: '' }
    if (s === 'peek' || s === 'drop') return { w: Math.max((NOTCH || COMPACT) + WING * 2, 380), h: top + 100, cls: 'large' }
    // Search grows with its results: search row, one row per result (at least one line of text), footer.
    const rows = lastQuery ? Math.max(1, results.length) : 1
    return { w: 520, h: Math.min(top + 420, top + 8 + 52 + 12 + rows * 62 + 48), cls: 'large' }
  }

  function setState(next) {
    state = next
    const { w, h, cls } = sizeFor(next)
    const island = document.getElementById('island')
    island.className = cls
    island.style.width = w + 'px'
    island.style.height = h + 'px'
    // Sections sit below the menu bar / notch band.
    const pillOn = next === 'live' || (next === 'hidden' && !NOTCH && isMac)
    document.getElementById('pill').classList.toggle('on', pillOn)
    document.getElementById('pill').classList.toggle('compact', next === 'hidden')
    const peek = document.getElementById('peek')
    peek.style.top = BAR + 'px'; peek.style.height = (h - BAR) + 'px'
    peek.classList.toggle('on', next === 'peek' || next === 'drop')
    const search = document.getElementById('search')
    search.style.top = (BAR + 8) + 'px'; search.style.height = (h - BAR - 8) + 'px'
    search.classList.toggle('on', next === 'search')
    // The main process only lets clicks through where the island is drawn (plus a small margin).
    api.setShape({ x: (window.innerWidth - w) / 2 - 6, y: 0, w: w + 12, h: h + 6 }, next === 'search')
    refreshMascots()
  }

  // ---------- mascot ----------
  const players = {}
  let poseOverride = null
  function idlePose() { return sources.length > 0 ? 'resting' : 'head' }
  function posesFor() {
    if (poseOverride) return { mini: poseOverride, big: poseOverride }
    if (state === 'drop') return { mini: 'welcome', big: 'welcome' }
    if (activity.indexing) return { mini: 'working', big: 'working' }
    if (liveKind === 'done') return { mini: 'done', big: 'done' }
    if (state === 'peek' && greeting) return { mini: 'welcome', big: 'welcome' }
    return { mini: idlePose(), big: state === 'search' ? 'head' : (sources.length ? 'resting' : 'welcome') }
  }
  function setPose(key, pose) {
    const p = players[key]
    if (!p || !p.ready || p.pose === pose) return
    p.pose = pose
    p.player.loadAnimation(POSES[pose])
  }
  // Only the mascot that is on screen animates; hidden ones are paused to keep the GPU idle.
  function visibleMascots() {
    return {
      mini: state === 'live' || (state === 'hidden' && !NOTCH && isMac),
      big: state === 'peek' || state === 'drop',
      search: state === 'search',
    }
  }
  function refreshMascots() {
    const { mini, big } = posesFor()
    setPose('mini', mini)
    setPose('big', big)
    setPose('search', big)
    const visible = visibleMascots()
    for (const [key, p] of Object.entries(players)) {
      if (!p.ready || reduceMotion) continue
      if (visible[key] && !p.player.isPlaying) p.player.play()
      if (!visible[key] && p.player.isPlaying) p.player.pause()
    }
  }
  async function startMascots() {
    try {
      const { DotLottie } = await import('/vendor/dotlottie/index.js')
      DotLottie.setWasmUrl('/vendor/dotlottie/dotlottie-player.wasm')
      for (const [key, id] of [['mini', 'miniCanvas'], ['big', 'bigCanvas'], ['search', 'searchCanvas']]) {
        const player = new DotLottie({ canvas: document.getElementById(id), src: '/mascot/mascot.lottie', animationId: POSES.head, autoplay: !reduceMotion, loop: true })
        players[key] = { player, ready: false, pose: 'head' }
        player.addEventListener('load', () => {
          players[key].ready = true
          if (reduceMotion) player.setFrame(Math.floor(player.totalFrames / 2))
          else if (visibleMascots()[key]) player.play()
          else player.pause()
        })
      }
      setTimeout(refreshMascots, 300)
    } catch {}
  }

  // Click the mascot: a happy hop. Click it three times quickly and it gets dizzy.
  let clicks = []
  function poke() {
    const now = Date.now()
    clicks = clicks.filter(t => now - t < 900).concat(now)
    poseOverride = clicks.length >= 3 ? 'nothingFound' : 'done'
    refreshMascots()
    clearTimeout(poke.timer)
    poke.timer = setTimeout(() => { poseOverride = null; refreshMascots() }, clicks.length >= 3 ? 2600 : 1300)
  }
  document.getElementById('bigCanvas').addEventListener('click', e => { e.stopPropagation(); poke() })
  document.getElementById('searchCanvas').addEventListener('click', e => { e.stopPropagation(); poke() })

  // ---------- status ----------
  function fmt(n) { return Number(n || 0).toLocaleString() }
  function statusLine() {
    if (activity.indexing) return 'Indexing ' + fmt(activity.done) + ' of ' + fmt(activity.total) + (activity.current ? ' · ' + activity.current : '')
    const docs = fmt(stats.documents) + ' document' + (stats.documents === 1 ? '' : 's')
    return sources.length ? 'Watching ' + sources.length + ' folder' + (sources.length === 1 ? '' : 's') + ' · ' + docs : docs
  }
  let greeting = false
  function renderText() {
    const title = document.getElementById('peekTitle')
    const sub = document.getElementById('peekSub')
    if (state === 'drop') {
      title.textContent = 'Drop to add to your Library'
      sub.textContent = 'Files are copied to ~/Duct Library and indexed.'
    } else if (greeting) {
      title.textContent = 'Hi! I can find anything in your documents.'
      sub.innerHTML = 'Hover here anytime, or press <kbd>' + (isMac ? '⌘⇧Space' : 'Ctrl+Shift+Space') + '</kbd>'
    } else {
      title.textContent = activity.indexing ? 'Reading your documents…' : (sources.length ? 'Keeping an eye on your folders' : 'Ready when you are')
      sub.innerHTML = esc(statusLine()) + '<br>Click to search · <kbd>' + (isMac ? '⌘⇧Space' : 'Ctrl+Shift+Space') + '</kbd>'
    }
    document.getElementById('footStatus').textContent = statusLine()
    const live = document.getElementById('liveText')
    if (activity.indexing) { live.className = 'live-text'; live.textContent = fmt(activity.done) + '/' + fmt(activity.total) }
    else if (liveKind === 'done') { live.className = 'live-text done'; live.textContent = '✓ ' + fmt(stats.documents) }
    else live.textContent = ''
  }

  async function poll() {
    try {
      const [a, s, src] = await Promise.all([
        fetch('/api/activity').then(r => r.json()),
        fetch('/api/stats').then(r => r.json()),
        fetch('/api/sources').then(r => r.json()),
      ])
      const wasIndexing = activity.indexing
      activity = a; stats = s; sources = src.sources || []
      if (a.indexing && state === 'hidden') { liveKind = 'working'; setState('live') }
      if (!a.indexing && wasIndexing) {
        // Finished: a short celebration in the wings, then tuck away again.
        liveKind = 'done'
        if (state === 'hidden' || state === 'live') setState('live')
        clearTimeout(liveTimer)
        liveTimer = setTimeout(() => { liveKind = null; if (state === 'live') setState('hidden'); else refreshMascots(); renderText() }, 3500)
      }
      refreshMascots()
      renderText()
    } catch {}
    setTimeout(poll, activity.indexing ? 800 : 2000)
  }

  // ---------- pointer (reported by the main process, which also handles click-through) ----------
  api.onPointer(inside => {
    pointerInside = inside
    clearTimeout(leaveTimer)
    if (inside) {
      if (state === 'hidden' || state === 'live') { setState('peek'); renderText() }
      return
    }
    const delay = state === 'search' ? 1400 : 450
    leaveTimer = setTimeout(() => {
      if (state === 'search' && (document.getElementById('q').value || document.activeElement === document.getElementById('q'))) return
      collapse()
    }, delay)
  })

  function collapse() {
    greeting = false
    setState(activity.indexing || liveKind === 'done' ? 'live' : 'hidden')
    renderText()
  }

  document.getElementById('island').addEventListener('click', () => {
    if (state !== 'search') openSearch()
  })

  function openSearch() {
    greeting = false
    setState('search')
    renderText()
    api.focus()
    const q = document.getElementById('q')
    setTimeout(() => { q.focus(); q.select() }, 60)
    if (!q.value) showResults([])
  }
  api.onOpenSearch(openSearch)

  window.addEventListener('blur', () => { if (state === 'search' && !pointerInside) collapse() })
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') { document.getElementById('q').blur(); collapse(); api.blur() }
  })

  // ---------- search ----------
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;') }
  function fileName(p) { return p.split('/').pop().split(String.fromCharCode(92)).pop() || p }
  function markSnippet(s) { return esc(s).replace(/\\u0002/g, '<mark>').replace(/\\u0003/g, '</mark>') }
  function highlightTerms(r) {
    const marked = [...(r.snippet || '').matchAll(/\\u0002([^\\u0003]+)\\u0003/g)].map(m => m[1].toLowerCase())
    const phrases = [...lastQuery.matchAll(/"([^"]+)"/g)].map(m => m[1].toLowerCase())
    const words = lastQuery.replace(/"[^"]*"/g, ' ').toLowerCase().split(/\\s+/).filter(w => w.length > 1)
    return [...new Set([...phrases, ...marked, ...words])].slice(0, 12)
  }

  function showResults(list) {
    results = list
    selected = 0
    if (state === 'search') setState('search')
    const box = document.getElementById('results')
    if (!lastQuery) { box.innerHTML = '<div class="empty">Type to search ' + fmt(stats.documents) + ' documents</div>'; return }
    if (!list.length) { box.innerHTML = '<div class="empty">No matches. Try fewer or different words.</div>'; return }
    box.innerHTML = list.map((r, i) =>
      '<div class="r' + (i === 0 ? ' sel' : '') + '" data-i="' + i + '">' +
        '<div class="r-name">' + esc(fileName(r.chunk.documentPath)) + (r.chunk.page ? '<span class="r-page">p. ' + r.chunk.page + '</span>' : '') + '</div>' +
        '<div class="r-snip">' + (r.snippet ? markSnippet(r.snippet) : esc(r.chunk.content.slice(0, 160))) + '</div>' +
      '</div>').join('')
  }
  function select(i) {
    selected = Math.max(0, Math.min(results.length - 1, i))
    document.querySelectorAll('.r').forEach((el, j) => el.classList.toggle('sel', j === selected))
    const el = document.querySelector('.r.sel')
    if (el) el.scrollIntoView({ block: 'nearest' })
  }
  async function open(i) {
    const r = results[i]
    if (!r) return
    await api.openDocument(r.chunk.documentPath, r.chunk.page, highlightTerms(r))
    collapse()
  }

  let searchTimer = null
  document.getElementById('q').addEventListener('input', e => {
    clearTimeout(searchTimer)
    const q = e.target.value.trim()
    searchTimer = setTimeout(async () => {
      lastQuery = q
      if (!q) { showResults([]); return }
      try {
        const data = await (await fetch('/api/search?q=' + encodeURIComponent(q) + '&topK=8')).json()
        if (q === lastQuery) showResults(data.results || [])
      } catch { showResults([]) }
    }, 140)
  })
  document.getElementById('q').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); select(selected + 1) }
    if (e.key === 'ArrowUp') { e.preventDefault(); select(selected - 1) }
    if (e.key === 'Enter') { e.preventDefault(); open(selected) }
  })
  document.getElementById('results').addEventListener('click', e => {
    const row = e.target.closest('.r')
    if (row) { e.stopPropagation(); open(Number(row.dataset.i)) }
  })
  document.getElementById('openMain').addEventListener('click', e => { e.stopPropagation(); api.showMain(); collapse() })

  // ---------- drop files to add them to the Library ----------
  let dragDepth = 0
  window.addEventListener('dragenter', e => { e.preventDefault(); if (dragDepth++ === 0) { setState('drop'); renderText() } })
  window.addEventListener('dragover', e => e.preventDefault())
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; collapse() } })
  window.addEventListener('drop', async e => {
    e.preventDefault()
    dragDepth = 0
    const files = Array.from(e.dataTransfer ? e.dataTransfer.files : [])
    collapse()
    if (files.length) await api.addFiles(files)
  })

  // ---------- start: a short wake-and-wave greeting ----------
  setState('hidden')
  startMascots()
  poll()
  setTimeout(() => {
    greeting = true
    setState('peek')
    renderText()
    setTimeout(() => { if (greeting && !pointerInside) collapse() }, 3800)
  }, 700)
</script>
</body>
</html>`
