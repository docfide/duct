// Duct's PDF viewer: pdf.js's viewer components with the search terms highlighted.
// Opened as /viewer?path=<indexed pdf>&page=<n>&terms=<JSON array of words or phrases>.
// Everything is served locally from node_modules/pdfjs-dist (see the /vendor/pdfjs routes in server.ts).

export const viewerHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Duct Viewer</title>
<link rel="stylesheet" href="/vendor/pdfjs/web/pdf_viewer.css">
<style>
:root {
  --black: #0C0C0B; --s1: #111110; --s2: #181816; --border: #252522; --border2: #333330;
  --muted: #555552; --subtle: #888883; --text: #F0EFE8; --lime: #A3E635; --lime-bg: #141A06;
  --mono: 'SF Mono','Fira Code','Cascadia Code','Consolas',monospace;
  --sans: -apple-system,BlinkMacSystemFont,'Inter',sans-serif;
}
.bar, .bar * { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--black); color: var(--text); font-family: var(--sans); }
.bar { position: absolute; top: 0; left: 0; right: 0; height: 48px; display: flex; align-items: center; gap: 10px; padding: 0 14px; background: var(--s1); border-bottom: 1px solid var(--border); font-family: var(--mono); font-size: 12px; }
.title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-weight: 600; }
.group { display: flex; align-items: center; gap: 6px; color: var(--subtle); }
button { font-family: var(--mono); font-size: 12px; background: transparent; color: var(--text); border: 1px solid var(--border2); border-radius: 6px; padding: 4px 9px; cursor: pointer; }
button:hover { border-color: var(--subtle); }
button:disabled { opacity: .4; cursor: default; }
input { width: 44px; background: var(--black); color: var(--text); border: 1px solid var(--border2); border-radius: 6px; padding: 4px 6px; font-family: var(--mono); font-size: 12px; text-align: right; }
.matches { color: var(--lime); }
#viewerContainer { position: absolute; top: 48px; bottom: 0; left: 0; right: 0; overflow: auto; background: #2a2a28; }
#message { position: absolute; top: 48px; left: 0; right: 0; padding: 40px; text-align: center; font-family: var(--mono); font-size: 12px; color: var(--subtle); }
/* Search matches in Duct's lime instead of pdf.js's purple. */
.textLayer .highlight { background-color: rgba(163, 230, 53, 0.35) !important; border-radius: 2px; }
.textLayer .highlight.selected { background-color: rgba(163, 230, 53, 0.75) !important; }
</style>
</head>
<body>
<div class="bar">
  <div class="title" id="title">Loading…</div>
  <div class="group" id="findGroup" style="display:none;">
    <button id="prevMatch" title="Previous match (Shift+Enter)">◀</button>
    <span class="matches" id="matchCount"></span>
    <button id="nextMatch" title="Next match (Enter)">▶</button>
  </div>
  <div class="group">
    <input id="pageInput" type="text" inputmode="numeric" aria-label="Page"> <span id="pageCount"></span>
  </div>
  <div class="group">
    <button id="zoomOut" title="Zoom out">−</button>
    <button id="zoomIn" title="Zoom in">+</button>
  </div>
  <button id="download" title="Download the original">Download</button>
</div>
<div id="viewerContainer"><div id="viewer" class="pdfViewer"></div></div>
<div id="message" style="display:none;"></div>
<script type="module">
  const params = new URLSearchParams(location.search)
  const path = params.get('path') || ''
  const startPage = Math.max(1, parseInt(params.get('page') || '1', 10) || 1)
  let terms = []
  try { terms = JSON.parse(params.get('terms') || '[]').filter(t => typeof t === 'string' && t.trim()) } catch {}
  const name = path.split('/').pop().split(String.fromCharCode(92)).pop() || 'document.pdf'
  const fileUrl = '/api/file/' + encodeURIComponent(name) + '?path=' + encodeURIComponent(path)
  document.title = name + ' · Duct'
  document.getElementById('title').textContent = name
  document.getElementById('download').addEventListener('click', () => { location.href = fileUrl })

  function fail(message) {
    const el = document.getElementById('message')
    el.textContent = message
    el.style.display = 'block'
  }

  try {
    const pdfjsLib = await import('/vendor/pdfjs/build/pdf.mjs')
    globalThis.pdfjsLib = pdfjsLib  // pdf_viewer.mjs reads the library from this global
    const { EventBus, PDFLinkService, PDFFindController, PDFViewer } = await import('/vendor/pdfjs/web/pdf_viewer.mjs')
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.mjs'

    const eventBus = new EventBus()
    const linkService = new PDFLinkService({ eventBus })
    const findController = new PDFFindController({ eventBus, linkService })
    const container = document.getElementById('viewerContainer')
    const pdfViewer = new PDFViewer({ container, eventBus, linkService, findController })
    linkService.setViewer(pdfViewer)

    const pageInput = document.getElementById('pageInput')
    eventBus.on('pagechanging', e => { pageInput.value = e.pageNumber })
    pageInput.addEventListener('change', () => {
      const n = parseInt(pageInput.value, 10)
      if (n >= 1 && n <= pdfViewer.pagesCount) pdfViewer.currentPageNumber = n
      else pageInput.value = pdfViewer.currentPageNumber
    })
    document.getElementById('zoomIn').addEventListener('click', () => { pdfViewer.currentScale = Math.min(4, pdfViewer.currentScale * 1.2) })
    document.getElementById('zoomOut').addEventListener('click', () => { pdfViewer.currentScale = Math.max(0.3, pdfViewer.currentScale / 1.2) })

    const find = (again, previous) => eventBus.dispatch('find', {
      source: null, type: again ? 'again' : '', query: terms, caseSensitive: false, entireWord: false,
      highlightAll: true, findPrevious: !!previous, matchDiacritics: false,
    })
    eventBus.on('updatefindmatchescount', ({ matchesCount }) => {
      document.getElementById('matchCount').textContent = matchesCount.total ? matchesCount.current + ' of ' + matchesCount.total : 'no matches'
    })
    document.getElementById('nextMatch').addEventListener('click', () => find(true, false))
    document.getElementById('prevMatch').addEventListener('click', () => find(true, true))
    window.addEventListener('keydown', e => {
      if (e.key === 'Enter' && terms.length && document.activeElement !== pageInput) find(true, e.shiftKey)
    })

    eventBus.on('pagesinit', () => {
      pdfViewer.currentScaleValue = 'page-width'
      pdfViewer.currentPageNumber = Math.min(startPage, pdfViewer.pagesCount)
      document.getElementById('pageCount').textContent = '/ ' + pdfViewer.pagesCount
      pageInput.value = pdfViewer.currentPageNumber
      // Searching starts from the current page, so the first highlight is the match on the result's page.
      if (terms.length) {
        document.getElementById('findGroup').style.display = 'flex'
        find(false, false)
      }
    })

    const pdfDocument = await pdfjsLib.getDocument({
      url: fileUrl,
      cMapUrl: '/vendor/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
      wasmUrl: '/vendor/pdfjs/wasm/',
      isEvalSupported: false,
    }).promise
    pdfViewer.setDocument(pdfDocument)
    linkService.setDocument(pdfDocument, null)
  } catch (err) {
    fail("Couldn't open this PDF: " + (err && err.message ? err.message : err))
  }
</script>
</body>
</html>`
