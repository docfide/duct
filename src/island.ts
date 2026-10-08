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
#pill .live-text.warn { color: #E8A020; }
.live-head { display: none; flex-shrink: 0; overflow: visible; cursor: pointer; }
#pill .live-head { width: 22px; height: 22px; }
#peek .live-head { width: 76px; height: 76px; }
.search-row .live-head { width: 44px; height: 44px; }

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

  const PAGE_LABELS = __PAGE_LABELS__
  const POSES = {
    head: 'View - Three-Quarter', welcome: 'Pose - Welcome', working: 'Pose - Working', done: 'Pose - Done',
    nothingFound: 'Pose - Nothing Found', needsHand: 'Pose - Needs a Hand', resting: 'Pose - Resting',
  }

  // ---------- the live head ----------
  // The three-quarter head drawn as SVG so it can react: pupils follow the cursor, the head tilts toward
  // it, and it blinks now and then. Animated poses (working, resting, …) still come from the Lottie file.
  const SLOTS = { mini: 'miniCanvas', big: 'bigCanvas', search: 'searchCanvas' }
  const HEAD_SVG = '<svg class="live-head" viewBox="100 130 340 300" aria-hidden="true"><g class="lh-tilt">' +
    '<ellipse cx="376" cy="192" rx="30" ry="32" fill="#e9d8b4"/><ellipse cx="160" cy="188" rx="40" ry="40" fill="#e9d8b4"/>' +
    '<ellipse cx="268" cy="275" rx="150" ry="130" fill="#e9d8b4"/><ellipse cx="288" cy="258" rx="110" ry="48" fill="#b08a5c"/>' +
    '<ellipse cx="318" cy="338" rx="62" ry="44" fill="#f0efe8"/><ellipse cx="330" cy="318" rx="15" ry="11" fill="#0c0c0b"/>' +
    '<g class="lh-eyes"><ellipse cx="238" cy="258" rx="21" ry="24" fill="#0c0c0b"/><ellipse cx="330" cy="258" rx="17" ry="23" fill="#0c0c0b"/>' +
    '<ellipse cx="244" cy="248" rx="7" ry="7" fill="#f0efe8"/><ellipse cx="335" cy="248" rx="6" ry="6" fill="#f0efe8"/></g>' +
    '<ellipse cx="238" cy="258" rx="39" ry="39" fill="none" stroke="#a3e635" stroke-width="8"/>' +
    '<ellipse cx="330" cy="258" rx="33" ry="37" fill="none" stroke="#a3e635" stroke-width="8"/>' +
    '<rect x="275" y="252" width="18" height="8" fill="#a3e635"/></g></svg>'
  const heads = []
  for (const id of Object.values(SLOTS)) {
    const canvas = document.getElementById(id)
    canvas.insertAdjacentHTML('afterend', HEAD_SVG)
    const svg = canvas.nextElementSibling
    heads.push({ svg, tilt: svg.querySelector('.lh-tilt'), eyes: svg.querySelector('.lh-eyes'), ex: 0, ey: 0, rot: 0, last: '' })
  }
  let nextBlink = Date.now() + 2500
  let blinkUntil = 0
  function trackHeads() {
    const now = Date.now()
    if (now > nextBlink) { blinkUntil = now + 140; nextBlink = now + 2500 + Math.random() * 3500 }
    const blink = now < blinkUntil && !reduceMotion
    for (const h of heads) {
      if (h.svg.style.display !== 'block') continue
      const r = h.svg.getBoundingClientRect()
      if (!r.width) continue
      let tx = 0, ty = 0, trot = 0
      if (pointer.x >= 0 && !reduceMotion) {
        const dx = pointer.x - (r.left + r.width / 2)
        const dy = pointer.y - (r.top + r.height / 2)
        const dist = Math.hypot(dx, dy) || 1
        const reach = Math.min(1, dist / 160)
        tx = dx / dist * reach * 11
        ty = dy / dist * reach * 9
        trot = Math.max(-1, Math.min(1, dx / 420)) * 9
      }
      // Ease toward the target so the head moves smoothly instead of snapping.
      h.ex += (tx - h.ex) * 0.22
      h.ey += (ty - h.ey) * 0.22
      h.rot += (trot - h.rot) * 0.12
      const tilt = 'rotate(' + h.rot.toFixed(1) + ' 268 400) translate(' + (h.ex * 0.4).toFixed(1) + ' ' + (h.ey * 0.3).toFixed(1) + ')'
      const eyes = 'translate(' + h.ex.toFixed(1) + ' ' + h.ey.toFixed(1) + ')' + (blink ? ' translate(0 258) scale(1 0.12) translate(0 -258)' : '')
      if (tilt + eyes !== h.last) {
        h.tilt.setAttribute('transform', tilt)
        h.eyes.setAttribute('transform', eyes)
        h.last = tilt + eyes
      }
    }
    requestAnimationFrame(trackHeads)
  }
  requestAnimationFrame(trackHeads)

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
  let indexingSince = 0
  let lastRunSeen = 0
  let failures = null        // { count, names } from the latest run that had unreadable files
  let notice = null          // a short message in the peek, e.g. after dropping files
  let noticeTimer = null
  let pointer = { x: -1, y: -1 }

  // ---------- shape ----------
  function sizeFor(s) {
    const top = BAR
    if (s === 'hidden') {
      if (NOTCH) return { w: NOTCH, h: top, cls: 'hidden-notch' }
      if (isMac) return { w: COMPACT, h: top, cls: '' }
      return { w: COMPACT, h: 6, cls: 'handle' }
    }
    if (s === 'live') return { w: (NOTCH || COMPACT) + (liveKind === 'needsHand' ? WING + 70 : WING) * 2, h: Math.max(top, 30), cls: '' }
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
    if (notice) return { mini: notice.pose, big: notice.pose }
    if (state === 'drop') return { mini: 'welcome', big: 'welcome' }
    if (activity.indexing) return { mini: 'working', big: 'working' }
    if (liveKind === 'needsHand') return { mini: 'needsHand', big: 'needsHand' }
    if (liveKind === 'done') return { mini: 'done', big: 'done' }
    if (state === 'peek' && greeting) return { mini: 'welcome', big: 'welcome' }
    // When you come close it wakes up and looks at you ('head' is the live head that follows the cursor).
    return { mini: idlePose(), big: 'head' }
  }
  function setPose(key, pose) {
    const p = players[key]
    const live = pose === 'head'
    const canvas = document.getElementById(SLOTS[key])
    canvas.style.display = live ? 'none' : ''
    canvas.nextElementSibling.style.display = live ? 'block' : 'none'
    if (p) p.live = live
    if (!p || !p.ready || live || p.pose === pose) return
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
      const show = visible[key] && !p.live
      if (show && !p.player.isPlaying) p.player.play()
      if (!show && p.player.isPlaying) p.player.pause()
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
          const first = !players[key].ready
          players[key].ready = true
          if (first) { players[key].pose = 'head'; refreshMascots() }
          if (reduceMotion) player.setFrame(Math.floor(player.totalFrames / 2))
          else if (visibleMascots()[key] && !players[key].live) player.play()
          else player.pause()
        })
      }
      setTimeout(refreshMascots, 300)
    } catch {}
  }

  // ---------- sounds ----------
  // Short synthesized sounds (no audio files): only for things the user did or is waiting on, never per file.
  // Off with View > Play Sounds; the page is told through api.onSettings.
  let soundOn = params.get('sound') !== '0'
  const VOLUME = 0.22
  let audio = null
  function tone(freq, dur, opts) {
    const o = opts || {}
    if (!audio) audio = new AudioContext()
    const t = audio.currentTime + (o.delay || 0)
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.type = o.type || 'sine'
    osc.frequency.setValueAtTime(freq, t)
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + dur)
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime((o.gain || 1) * VOLUME, t + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    osc.connect(gain).connect(audio.destination)
    osc.start(t)
    osc.stop(t + dur + 0.03)
  }
  const SOUNDS = {
    hello: () => { tone(660, 0.12, { to: 880 }); tone(880, 0.16, { to: 1175, delay: 0.11 }) },
    open: () => tone(1250, 0.05, { gain: 0.35 }),
    boop: () => tone(460, 0.13, { to: 300, type: 'triangle' }),
    dizzy: () => { for (let i = 0; i < 6; i++) tone(i % 2 ? 620 : 500, 0.09, { delay: i * 0.075, type: 'triangle', gain: 0.6 }) },
    done: () => { tone(784, 0.16); tone(1047, 0.3, { delay: 0.12 }) },
    gulp: () => { tone(340, 0.16, { to: 150 }); tone(900, 0.06, { delay: 0.17, gain: 0.4 }) },
    oops: () => { tone(392, 0.15, { type: 'triangle' }); tone(330, 0.22, { delay: 0.14, type: 'triangle' }) },
  }
  function sound(name) {
    if (!soundOn) return
    try { SOUNDS[name]() } catch {}
  }
  api.onSettings(settings => { soundOn = !!settings.sound })

  // Click the mascot: a happy hop. Click it three times quickly and it gets dizzy.
  let clicks = []
  function poke() {
    const now = Date.now()
    clicks = clicks.filter(t => now - t < 900).concat(now)
    poseOverride = clicks.length >= 3 ? 'nothingFound' : 'done'
    sound(clicks.length >= 3 ? 'dizzy' : 'boop')
    refreshMascots()
    clearTimeout(poke.timer)
    poke.timer = setTimeout(() => { poseOverride = null; refreshMascots() }, clicks.length >= 3 ? 2600 : 1300)
  }
  document.getElementById('bigCanvas').addEventListener('click', e => { e.stopPropagation(); poke() })
  document.getElementById('searchCanvas').addEventListener('click', e => { e.stopPropagation(); poke() })
  for (const h of heads.slice(1)) h.svg.addEventListener('click', e => { e.stopPropagation(); poke() })
  api.onCursor(p => { pointer = p })

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
    if (notice) {
      title.textContent = notice.title
      sub.textContent = notice.sub
    } else if (state === 'drop') {
      title.textContent = 'Drop to add to your Library'
      sub.textContent = 'Copied to ~/Duct Library and indexed. Drop a folder to watch it.'
    } else if (liveKind === 'needsHand' && failures) {
      title.textContent = "I couldn't read " + failures.count + ' file' + (failures.count === 1 ? '' : 's')
      sub.textContent = failures.names.slice(0, 2).join(', ') + (failures.count > 2 ? ' and ' + (failures.count - 2) + ' more' : '') + '. Click to see them.'
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
    else if (liveKind === 'needsHand' && failures) { live.className = 'live-text warn'; live.textContent = failures.count + " couldn't be read" }
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
      if (a.indexing && !wasIndexing) indexingSince = Date.now()
      if (a.indexing && state === 'hidden') { liveKind = 'working'; setState('live') }
      if (!a.indexing && wasIndexing) {
        // Finished: a short celebration in the wings, then tuck away again. Only long jobs get a chime.
        liveKind = a.lastRun && a.lastRun.failed > 0 ? liveKind : 'done'
        if (liveKind === 'done' && Date.now() - indexingSince >= 8000) sound('done')
        if (state === 'hidden' || state === 'live') setState('live')
        clearTimeout(liveTimer)
        if (liveKind === 'done') liveTimer = setTimeout(() => { liveKind = null; if (state === 'live') setState('hidden'); else refreshMascots(); renderText() }, 3500)
      }
      const run = a.lastRun
      if (run && run.id !== lastRunSeen) {
        lastRunSeen = run.id
        if (run.failed > 0) {
          // Unreadable files: the head-tilting "needs a hand" pose stays in the wings until you look.
          failures = { count: run.failed, names: run.failures.map(f => f.name) }
          liveKind = 'needsHand'
          clearTimeout(liveTimer)
          if (state === 'hidden' || state === 'live') setState('live')
          sound('oops')
        }
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
    setState(activity.indexing || liveKind ? 'live' : 'hidden')
    renderText()
  }

  document.getElementById('island').addEventListener('click', () => {
    if (liveKind === 'needsHand' && state !== 'search') {
      liveKind = null
      failures = null
      api.showMain('failed')
      collapse()
      return
    }
    if (state !== 'search') openSearch()
  })

  function showNotice(n) {
    notice = n
    clearTimeout(noticeTimer)
    setState('peek')
    renderText()
    noticeTimer = setTimeout(() => { notice = null; if (!pointerInside) collapse(); else { refreshMascots(); renderText() } }, 5000)
  }

  function openSearch() {
    if (state !== 'search') sound('open')
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
        '<div class="r-name">' + esc(fileName(r.chunk.documentPath)) + (r.chunk.page ? '<span class="r-page">' + esc((PAGE_LABELS[r.chunk.documentFormat] || 'p.') + ' ' + r.chunk.page) + '</span>' : '') + '</div>' +
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
    if (!files.length) return
    const r = (await api.addFiles(files)) || {}
    const unsupported = r.unsupported || []
    if (unsupported.length || r.failed) {
      sound('oops')
      const exts = [...new Set(unsupported.map(n => (n.match(/\.[^.]+$/) || ['these'])[0].toLowerCase()))]
      showNotice(unsupported.length
        ? { pose: 'needsHand', title: "I can't read " + exts.slice(0, 3).join(', ') + ' files', sub: 'I read __SUPPORTED__.' + (r.added ? ' Added ' + r.added + ' other file' + (r.added === 1 ? '' : 's') + '.' : '') }
        : { pose: 'needsHand', title: "I couldn't read " + r.failed + ' file' + (r.failed === 1 ? '' : 's'), sub: 'They are in your Library but have no text I can use.' })
    } else if ((r.watched || []).length) {
      sound('gulp')
      showNotice({ pose: 'done', title: 'Watching ' + fileName(r.watched[0]), sub: 'New and changed files there are indexed automatically.' })
    } else if (r.added > 0) {
      sound('gulp')
    } else if (r.duplicates > 0) {
      sound('boop')
      showNotice({ pose: 'head', title: 'Already in your Library', sub: 'Those files were indexed before.' })
    }
  })

  // ---------- start: a short wake-and-wave greeting ----------
  setState('hidden')
  startMascots()
  poll()
  setTimeout(() => {
    greeting = true
    setState('peek')
    renderText()
    if (params.get('hello') === '1') sound('hello')   // only on the very first launch
    setTimeout(() => { if (greeting && !pointerInside) collapse() }, 3800)
  }, 700)
</script>
</body>
</html>`
