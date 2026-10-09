// Duct's workspace: two documents side by side, with a notebook beside them.
// Opened as /workspace?left=<path>&right=<path>&notebook=<id>. Optional: lpage, lterms, rpage, rterms (terms is a JSON array
// of words to highlight in a PDF). `page` and `terms` are aliases for the left pane.
//
// PDFs are drawn with pdf.js (served locally, see the /vendor/pdfjs routes in server.ts). Every other format is shown as the
// text Duct extracted, in sections (a page, slide, sheet or chapter each), so text can be selected in any of them. Selecting
// text offers "Add to notes": the quote goes into the current notebook with its document and page, and the notebook exports
// to Word, Markdown, CSV or JSON.

export const workspaceHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Duct Workspace</title>
<link rel="stylesheet" href="/vendor/pdfjs/web/pdf_viewer.css">
<style>
:root {
  --black: #0C0C0B; --s1: #111110; --s2: #181816; --border: #252522; --border2: #333330;
  --muted: #555552; --subtle: #888883; --text: #F0EFE8; --lime: #A3E635; --lime-bg: #141A06; --red: #F87171;
  --mono: 'SF Mono','Fira Code','Cascadia Code','Consolas',monospace;
  --sans: -apple-system,BlinkMacSystemFont,'Inter',sans-serif;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.textLayer, .textLayer * { box-sizing: content-box; }
html, body { margin: 0; height: 100%; background: var(--black); color: var(--text); font-family: var(--sans); }
body { display: flex; flex-direction: column; overflow: hidden; }
button, select, input, textarea { font-family: var(--mono); font-size: 12px; color: var(--text); }
button { background: transparent; border: 1px solid var(--border2); border-radius: 6px; padding: 4px 9px; cursor: pointer; }
button:hover:not(:disabled) { border-color: var(--subtle); }
button:disabled { opacity: .4; cursor: default; }
button.primary { background: var(--lime); border-color: var(--lime); color: #0C0C0B; font-weight: 600; }
button.ghost { border-color: transparent; color: var(--subtle); padding: 4px 6px; }
button.ghost:hover:not(:disabled) { color: var(--text); border-color: transparent; }
select, input, textarea { background: var(--black); border: 1px solid var(--border2); border-radius: 6px; padding: 4px 8px; }
:focus-visible { outline: 2px solid var(--lime); outline-offset: 1px; }

.top { height: 44px; flex: none; display: flex; align-items: center; gap: 10px; padding: 0 14px; background: var(--s1); border-bottom: 1px solid var(--border); font-family: var(--mono); font-size: 12px; }
.top .brand { font-weight: 700; letter-spacing: .02em; }
.top .spacer { flex: 1; }
main { flex: 1; min-height: 0; display: flex; }
.panes { flex: 1; min-width: 0; min-height: 0; display: flex; }
.panes[data-layout="cols"] { flex-direction: row; }
.panes[data-layout="rows"] { flex-direction: column; }
.pane { flex: 1 1 0; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.divider { flex: none; position: relative; background: var(--border); touch-action: none; }
.panes[data-layout="cols"] > .divider { width: 7px; cursor: col-resize; }
.panes[data-layout="rows"] > .divider { height: 7px; cursor: row-resize; }
.divider::after { content: ''; position: absolute; inset: 0; margin: auto; background: var(--border2); border-radius: 2px; }
.panes[data-layout="cols"] > .divider::after { width: 3px; height: 36px; }
.panes[data-layout="rows"] > .divider::after { height: 3px; width: 36px; }
.divider:hover::after, .divider.dragging::after, .divider:focus-visible::after { background: var(--lime); }
.divider:focus-visible { outline: none; }
.panes.dragging { user-select: none; -webkit-user-select: none; }
.seg { display: inline-flex; }
.seg button { border-radius: 0; margin-left: -1px; }
.seg button:first-child { border-radius: 6px 0 0 6px; margin-left: 0; }
.seg button:last-child { border-radius: 0 6px 6px 0; }
.seg button[aria-pressed="true"] { background: var(--lime-bg); border-color: var(--lime); color: var(--lime); position: relative; z-index: 1; }
.pane-head { height: 38px; flex: none; display: flex; align-items: center; gap: 6px; padding: 0 8px; background: var(--s1); border-bottom: 1px solid var(--border); font-family: var(--mono); font-size: 12px; }
.pane-head .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; border-color: transparent; font-weight: 600; }
.pane-head .name:hover { border-color: var(--border2); }
.pane-head input.page { width: 42px; text-align: right; padding: 2px 5px; }
.pane-head .pages { color: var(--subtle); }
.pane-body { flex: 1; min-height: 0; position: relative; background: #2a2a28; }
.scroller { position: absolute; inset: 0; overflow: auto; }
.empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 30px; text-align: center; color: var(--subtle); font-family: var(--mono); font-size: 12px; background: var(--black); }
.error { color: var(--red); }

.picker { position: absolute; inset: 0; z-index: 5; background: var(--black); display: flex; flex-direction: column; padding: 12px; gap: 8px; }
.picker input { width: 100%; padding: 8px 10px; }
.picker ul { list-style: none; margin: 0; padding: 0; overflow: auto; flex: 1; }
.picker li button { width: 100%; text-align: left; border: 0; border-radius: 4px; padding: 7px 8px; display: flex; gap: 8px; align-items: baseline; }
.picker li button:hover { background: var(--s2); }
.picker li .fmt { color: var(--subtle); font-size: 10px; text-transform: uppercase; flex: none; width: 48px; }
.picker li .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.picker .hint { color: var(--subtle); font-family: var(--mono); font-size: 11px; }

.text-view { padding: 24px clamp(16px, 4vw, 48px) 60px; background: var(--black); min-height: 100%; }
.text-view .sec { max-width: 78ch; margin: 0 auto 26px; }
.text-view .sec-label { user-select: none; -webkit-user-select: none; font-family: var(--mono); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--lime); margin: 0 0 8px; padding-top: 8px; border-top: 1px solid var(--border); }
.text-view .sec-text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; font-size: 14px; }
.text-view.mono .sec-text { font-family: var(--mono); font-size: 12.5px; line-height: 1.5; }
.text-view .note-flash { background: rgba(163, 230, 53, .25); }
.image-view { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 16px; background: var(--black); min-height: 100%; }
.image-view img { max-width: 100%; height: auto; background: #fff; }
.image-view .hint { color: var(--subtle); font-family: var(--mono); font-size: 11px; }
::selection { background: rgba(163, 230, 53, .45); color: inherit; }
.textLayer .highlight { background-color: rgba(163, 230, 53, 0.35) !important; border-radius: 2px; }
.textLayer .highlight.selected { background-color: rgba(163, 230, 53, 0.75) !important; }

.notes { width: 340px; flex: none; display: flex; flex-direction: column; background: var(--s1); min-height: 0; }
.notes[hidden] { display: none; }
.notes-head { flex: none; padding: 10px; display: flex; flex-direction: column; gap: 8px; border-bottom: 1px solid var(--border); font-family: var(--mono); font-size: 12px; }
.notes-head .row { display: flex; gap: 6px; align-items: center; }
.notes-head select, .notes-head input { flex: 1; min-width: 0; }
.notes-list { flex: 1; overflow: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
.notes-empty { color: var(--subtle); font-size: 12px; line-height: 1.5; padding: 6px 2px; }
.note { background: var(--s2); border: 1px solid var(--border); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.note.new { border-color: var(--lime); }
.note blockquote { margin: 0; padding-left: 10px; border-left: 2px solid var(--lime); font-size: 13px; line-height: 1.5; max-height: 9.5em; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.note .src { font-family: var(--mono); font-size: 11px; color: var(--subtle); text-align: left; border: 0; padding: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.note .src:hover { color: var(--lime); }
.note textarea { width: 100%; min-height: 54px; resize: vertical; font-family: var(--sans); font-size: 13px; }
.note .tools { display: flex; gap: 2px; justify-content: flex-end; }
.menu { position: relative; }
.menu-pop { position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; background: var(--s2); border: 1px solid var(--border2); border-radius: 8px; padding: 4px; display: flex; flex-direction: column; min-width: 150px; }
.menu-pop[hidden] { display: none; }
.menu-pop button { border: 0; text-align: left; padding: 7px 10px; }
.menu-pop button:hover { background: var(--black); }

.nb-status { margin: 0; color: var(--subtle); font-size: 11px; line-height: 1.4; }
.nb-status b { color: var(--text); font-weight: 600; }
.share { border: 1px solid var(--border2); border-radius: 8px; background: var(--s2); padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.share h3 { margin: 0; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--subtle); font-weight: 600; }
.share .who { display: flex; align-items: center; gap: 6px; min-height: 26px; }
.share .who .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.share .who .tag { color: var(--subtle); }
.share .who select { flex: none; }
.share .add { display: flex; gap: 6px; }
.share .add input { flex: 1; min-width: 0; }
.share select { width: auto; flex: none; }
.share .hint { margin: 0; color: var(--subtle); font-family: var(--sans); font-size: 12px; line-height: 1.45; }
.share .sep { border: 0; border-top: 1px solid var(--border); margin: 2px 0; }
.share .actions { display: flex; gap: 6px; flex-wrap: wrap; }
.note .by { font-family: var(--mono); font-size: 10.5px; color: var(--muted); margin-top: -4px; }
.note textarea[readonly] { border-color: transparent; background: transparent; padding-left: 0; resize: none; min-height: 0; }
.add-pop { position: fixed; z-index: 50; display: none; }
.add-pop.show { display: block; }
.toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); background: var(--s2); border: 1px solid var(--border2); border-radius: 8px; padding: 8px 14px; font-family: var(--mono); font-size: 12px; z-index: 60; }
.toast.bad { border-color: var(--red); color: var(--red); }
.toast[hidden] { display: none; }
</style>
</head>
<body>
<div class="top">
  <span class="brand">Duct</span>
  <span style="color:var(--subtle)">Workspace</span>
  <span class="spacer"></span>
  <div class="seg" role="group" aria-label="Layout">
    <button id="layoutCols" aria-pressed="true" title="Documents side by side">Side by side</button>
    <button id="layoutRows" aria-pressed="false" title="One document above the other">Stacked</button>
  </div>
  <button id="toggleNotes" aria-expanded="true">Notes</button>
</div>
<main>
  <div class="panes" id="panes"></div>
  <aside class="notes" id="notes" aria-label="Notebook">
    <div class="notes-head">
      <div class="row"><select id="nbSelect" aria-label="Notebook"></select>
        <div class="menu"><button id="nbNew" aria-haspopup="true" title="Start or import a notebook">+ New ▾</button>
          <div class="menu-pop" id="newMenu" hidden><button data-new="new">New notebook</button><button data-new="import">Import a shared notebook…</button></div></div>
        <input type="file" id="nbImportFile" accept=".html,.htm,.json,text/html,application/json" hidden></div>
      <div class="row" id="nbForm" hidden><input id="nbName" maxlength="120" aria-label="Notebook name"><button id="nbSave" class="primary">Save</button><button id="nbCancel">Cancel</button></div>
      <div class="row">
        <button id="nbRename">Rename</button>
        <button id="nbDelete">Delete</button>
        <span style="flex:1"></span>
        <button id="nbShare" aria-expanded="false" aria-controls="sharePanel">Share</button>
        <div class="menu"><button id="nbExport" aria-haspopup="true">Export ▾</button>
          <div class="menu-pop" id="exportMenu" hidden>
            <button data-format="html">Page to send (.html)</button><button data-format="docx">Word (.docx)</button><button data-format="md">Markdown (.md)</button><button data-format="csv">Spreadsheet (.csv)</button><button data-format="json">JSON</button>
          </div></div>
      </div>
      <p class="nb-status" id="nbStatus" hidden></p>
      <div class="share" id="sharePanel" hidden></div>
    </div>
    <div class="notes-list" id="notesList"></div>
  </aside>
</main>
<button class="primary add-pop" id="addPop">Add to notes</button>
<div class="toast" id="toast" hidden></div>
<script type="module">
  const $ = id => document.getElementById(id)
  const params = new URLSearchParams(location.search)
  const TEXT_FORMATS = new Set(['md', 'code', 'txt'])
  const RASTER = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])
  const WS = new RegExp('\\\\s+', 'g')

  function h(tag, props, ...kids) {
    const el = document.createElement(tag)
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') el.className = v
      else if (k === 'text') el.textContent = v
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : String(v))
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid)
    return el
  }
  async function api(url, opts) {
    const res = await fetch(url, opts)
    if (!res.ok) {
      let msg = res.statusText
      try { msg = (await res.json()).error || msg } catch {}
      throw new Error(msg)
    }
    return res
  }
  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let toastTimer
  function toast(message, bad) {
    const el = $('toast')
    el.textContent = message
    el.className = 'toast' + (bad ? ' bad' : '')
    el.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { el.hidden = true }, bad ? 5000 : 2200)
  }
  const fileName = path => path.split('/').pop().split(String.fromCharCode(92)).pop() || path
  const store = {
    get(k) { try { return localStorage.getItem(k) } catch { return null } },
    set(k, v) { try { localStorage.setItem(k, v) } catch {} },
  }

  // ---------- documents ----------
  let docs = []
  let pageLabels = {}
  const docOf = path => docs.find(d => d.path === path)
  const labelFor = format => pageLabels[format] || 'p.'

  let pdfLibs
  function loadPdf() {
    pdfLibs ||= (async () => {
      const pdfjsLib = await import('/vendor/pdfjs/build/pdf.mjs')
      globalThis.pdfjsLib = pdfjsLib  // pdf_viewer.mjs reads the library from this global
      const viewer = await import('/vendor/pdfjs/web/pdf_viewer.mjs')
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.mjs'
      return { pdfjsLib, ...viewer }
    })()
    return pdfLibs
  }

  // ---------- panes ----------
  class Pane {
    constructor(side) {
      this.side = side
      this.path = ''
      this.format = ''
      this.mode = 'native'
      this.fit = true
      this.pdf = null
      this.pickerOpen = false
      this.nameBtn = h('button', { class: 'name', title: 'Choose a document', onclick: () => this.togglePicker(true) }, 'Choose a document ▾')
      this.pageInput = h('input', { class: 'page', type: 'text', inputmode: 'numeric', 'aria-label': 'Page', hidden: true, onchange: () => this.goto(parseInt(this.pageInput.value, 10)) })
      this.pageCount = h('span', { class: 'pages', hidden: true })
      this.zoomOut = h('button', { class: 'ghost', title: 'Zoom out', text: '−', hidden: true, onclick: () => this.zoom(1 / 1.2) })
      this.zoomIn = h('button', { class: 'ghost', title: 'Zoom in', text: '+', hidden: true, onclick: () => this.zoom(1.2) })
      this.modeBtn = h('button', { class: 'ghost', hidden: true, onclick: () => this.toggleMode() })
      this.closeBtn = h('button', { class: 'ghost', title: 'Close this document', text: '✕', hidden: true, onclick: () => this.clear() })
      this.body = h('div', { class: 'pane-body' })
      this.el = h('section', { class: 'pane', 'aria-label': side + ' document' },
        h('div', { class: 'pane-head' }, this.nameBtn, this.pageInput, this.pageCount, this.zoomOut, this.zoomIn, this.modeBtn, this.closeBtn),
        this.body)
      this.togglePicker(true)
    }

    reset() {
      if (this.pdf) { try { this.pdf.doc.destroy() } catch {} this.pdf = null }
      this.resizer?.disconnect()
      this.body.replaceChildren()
      this.pageInput.hidden = this.pageCount.hidden = this.zoomIn.hidden = this.zoomOut.hidden = this.modeBtn.hidden = true
    }

    clear() {
      this.reset()
      this.path = ''
      this.nameBtn.textContent = 'Choose a document ▾'
      this.closeBtn.hidden = true
      this.togglePicker(true)
      syncUrl()
    }

    togglePicker(open) {
      this.pickerOpen = open
      this.body.querySelector('.picker')?.remove()
      if (!open) return
      const list = h('ul')
      const filter = h('input', { type: 'search', placeholder: 'Find a document…', 'aria-label': 'Find a document', oninput: () => fill() })
      const fill = () => {
        const q = filter.value.trim().toLowerCase()
        const rows = docs.filter(d => d.status !== 'failed' && (!q || (d.displayName || fileName(d.path)).toLowerCase().includes(q)))
        list.replaceChildren(...rows.slice(0, 200).map(d => h('li', null, h('button', { onclick: () => this.open(d.path) },
          h('span', { class: 'fmt', text: d.format }), h('span', { class: 'nm', text: d.displayName || fileName(d.path) })))))
        if (!rows.length) list.append(h('li', { class: 'hint', text: docs.length ? 'No document matches.' : 'No documents are indexed yet.' }))
        else if (rows.length > 200) list.append(h('li', { class: 'hint', text: 'Showing 200 of ' + rows.length + '. Type to narrow it down.' }))
      }
      fill()
      const cancel = this.path ? h('button', { onclick: () => this.togglePicker(false), text: 'Cancel' }) : null
      this.body.append(h('div', { class: 'picker' }, filter, list, cancel))
      filter.focus()
    }

    async open(path, page, terms) {
      const doc = docOf(path)
      if (!doc) { this.fail('That document is not in the index.'); return }
      this.reset()
      this.path = path
      this.format = doc.format
      this.mode = 'native'
      this.page = page || 1
      this.terms = terms || []
      this.nameBtn.textContent = (doc.displayName || fileName(path)) + ' ▾'
      this.closeBtn.hidden = false
      this.pickerOpen = false
      syncUrl()
      await this.render()
    }

    async render() {
      this.reset()
      const doc = docOf(this.path)
      const ext = fileName(this.path).split('.').pop().toLowerCase()
      try {
        if (this.format === 'pdf' && this.mode === 'native') await this.renderPdf()
        else if (this.format === 'image' && RASTER.has(ext) && this.mode === 'native') this.renderImage(doc)
        else await this.renderText()
      } catch (err) {
        this.fail("Couldn't open this document: " + (err && err.message ? err.message : err))
      }
      if (this.format === 'image' || this.format === 'pdf') {
        this.modeBtn.hidden = false
        this.modeBtn.textContent = this.mode === 'native' ? 'Text' : (this.format === 'pdf' ? 'PDF' : 'Image')
        this.modeBtn.title = this.mode === 'native' ? 'Show the extracted text' : 'Show the original'
      }
    }

    toggleMode() {
      this.mode = this.mode === 'native' ? 'text' : 'native'
      this.render()
    }

    fail(message) {
      this.body.replaceChildren(h('div', { class: 'empty error', text: message }))
    }

    fileUrl() {
      return '/api/file/' + encodeURIComponent(fileName(this.path)) + '?path=' + encodeURIComponent(this.path)
    }

    async renderPdf() {
      const { pdfjsLib, EventBus, PDFLinkService, PDFFindController, PDFViewer } = await loadPdf()
      const scroller = h('div', { class: 'scroller' }, h('div', { class: 'pdfViewer' }))
      this.body.append(scroller)
      const eventBus = new EventBus()
      const linkService = new PDFLinkService({ eventBus })
      const findController = new PDFFindController({ eventBus, linkService })
      const viewer = new PDFViewer({ container: scroller, viewer: scroller.firstChild, eventBus, linkService, findController })
      linkService.setViewer(viewer)
      eventBus.on('pagechanging', e => { this.pageInput.value = e.pageNumber })
      eventBus.on('pagesinit', () => {
        viewer.currentScaleValue = 'page-width'
        viewer.currentPageNumber = Math.min(this.page, viewer.pagesCount)
        this.pageCount.textContent = '/ ' + viewer.pagesCount
        this.pageInput.value = viewer.currentPageNumber
        this.pageInput.hidden = this.pageCount.hidden = this.zoomIn.hidden = this.zoomOut.hidden = false
        if (this.terms.length) eventBus.dispatch('find', { source: null, type: '', query: this.terms, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: false, matchDiacritics: false })
      })
      this.resizer = new ResizeObserver(() => { if (this.fit && viewer.pagesCount) viewer.currentScaleValue = 'page-width' })
      this.resizer.observe(scroller)
      const doc = await pdfjsLib.getDocument({
        url: this.fileUrl(), cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
        wasmUrl: '/vendor/pdfjs/wasm/', isEvalSupported: false,
      }).promise
      this.pdf = { doc, viewer }
      viewer.setDocument(doc)
      linkService.setDocument(doc, null)
    }

    renderImage(doc) {
      const img = h('img', { alt: doc?.displayName || fileName(this.path), src: this.fileUrl() })
      img.addEventListener('error', () => { this.mode = 'text'; this.render() })
      this.body.append(h('div', { class: 'scroller' }, h('div', { class: 'image-view' }, img,
        h('div', { class: 'hint', text: 'Text can’t be selected in an image. Choose “Text” above to select from what Duct read in it.' }))))
    }

    async renderText() {
      const data = await (await api('/api/document-text?path=' + encodeURIComponent(this.path))).json()
      const view = h('div', { class: 'text-view' + (TEXT_FORMATS.has(this.format) ? ' mono' : '') })
      let shown = 0
      const MAX = 1500000
      for (const s of data.sections) {
        if (shown > MAX) { view.append(h('div', { class: 'sec' }, h('p', { class: 'sec-label', text: 'The rest of this document is not shown here.' }))); break }
        shown += s.text.length
        view.append(h('div', { class: 'sec', 'data-page': s.page || false },
          s.title ? h('p', { class: 'sec-label', text: s.title }) : null,
          h('div', { class: 'sec-text', text: s.text })))
      }
      if (!data.sections.length) view.append(h('div', { class: 'empty', text: 'Duct found no text in this document.' }))
      const scroller = h('div', { class: 'scroller' }, view)
      this.body.append(scroller)
      const paged = data.sections.filter(s => s.page)
      if (paged.length > 1) {
        this.pageInput.hidden = this.pageCount.hidden = false
        this.pageCount.textContent = '/ ' + paged.length
        this.pageInput.value = this.page
        scroller.addEventListener('scroll', () => {
          const top = scroller.getBoundingClientRect().top
          let cur = paged[0].page
          for (const el of view.querySelectorAll('[data-page]')) { if (el.getBoundingClientRect().top - top < 60) cur = el.dataset.page; else break }
          this.pageInput.value = cur
        }, { passive: true })
        const target = view.querySelector('[data-page="' + this.page + '"]')
        if (target && this.page > 1) target.scrollIntoView()
      }
    }

    zoom(factor) {
      if (!this.pdf) return
      this.fit = false
      const v = this.pdf.viewer
      v.currentScale = Math.max(0.3, Math.min(4, v.currentScale * factor))
    }

    goto(n) {
      if (!Number.isInteger(n) || n < 1) return
      if (this.pdf) {
        const v = this.pdf.viewer
        if (n <= v.pagesCount) v.currentPageNumber = n
        else this.pageInput.value = v.currentPageNumber
        return
      }
      this.page = n
      this.body.querySelector('[data-page="' + n + '"]')?.scrollIntoView()
    }

    /** The page a node in this pane sits on, if the format has pages. */
    pageOf(node) {
      const el = node.nodeType === 1 ? node : node.parentElement
      const pdfPage = el?.closest('.page')
      if (pdfPage) return parseInt(pdfPage.dataset.pageNumber, 10) || null
      const sec = el?.closest('[data-page]')
      return sec ? parseInt(sec.dataset.page, 10) || null : null
    }
  }

  const panes = [new Pane('Left'), new Pane('Right')]

  // ---------- layout: side by side or stacked, with a divider you can drag ----------
  const divider = h('div', { class: 'divider', role: 'separator', tabindex: 0, title: 'Drag to resize. Double-click to reset.' })
  $('panes').append(panes[0].el, divider, panes[1].el)
  let layout = ['cols', 'rows'].includes(params.get('layout')) ? params.get('layout') : (store.get('duct.layout') === 'rows' ? 'rows' : 'cols')
  let split = Math.min(0.85, Math.max(0.15, parseFloat(store.get('duct.split') || '0.5') || 0.5))

  function applyLayout() {
    $('panes').dataset.layout = layout
    panes[0].el.style.flex = split + ' 1 0'
    panes[1].el.style.flex = (1 - split) + ' 1 0'
    divider.setAttribute('aria-orientation', layout === 'cols' ? 'vertical' : 'horizontal')
    divider.setAttribute('aria-valuemin', '15'); divider.setAttribute('aria-valuemax', '85')
    divider.setAttribute('aria-valuenow', String(Math.round(split * 100)))
    divider.setAttribute('aria-label', 'Resize the two documents')
    $('layoutCols').setAttribute('aria-pressed', String(layout === 'cols'))
    $('layoutRows').setAttribute('aria-pressed', String(layout === 'rows'))
  }
  function setSplit(value, save) {
    split = Math.min(0.85, Math.max(0.15, value))
    applyLayout()
    if (save) store.set('duct.split', String(split))
  }
  function setLayout(next) {
    layout = next
    store.set('duct.layout', next)
    applyLayout()
    syncUrl()
  }
  $('layoutCols').addEventListener('click', () => setLayout('cols'))
  $('layoutRows').addEventListener('click', () => setLayout('rows'))
  divider.addEventListener('pointerdown', e => {
    e.preventDefault()
    divider.setPointerCapture(e.pointerId)
    divider.classList.add('dragging'); $('panes').classList.add('dragging')
  })
  divider.addEventListener('pointermove', e => {
    if (!divider.hasPointerCapture(e.pointerId)) return
    const r = $('panes').getBoundingClientRect()
    setSplit(layout === 'cols' ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height, false)
  })
  const endDrag = e => {
    if (!divider.hasPointerCapture(e.pointerId)) return
    divider.releasePointerCapture(e.pointerId)
    divider.classList.remove('dragging'); $('panes').classList.remove('dragging')
    store.set('duct.split', String(split))
  }
  divider.addEventListener('pointerup', endDrag)
  divider.addEventListener('pointercancel', endDrag)
  divider.addEventListener('dblclick', () => setSplit(0.5, true))
  divider.addEventListener('keydown', e => {
    const back = layout === 'cols' ? 'ArrowLeft' : 'ArrowUp', forward = layout === 'cols' ? 'ArrowRight' : 'ArrowDown'
    if (e.key === back) setSplit(split - 0.02, true)
    else if (e.key === forward) setSplit(split + 0.02, true)
    else if (e.key === 'Home') setSplit(0.15, true)
    else if (e.key === 'End') setSplit(0.85, true)
    else if (e.key === 'Enter') setSplit(0.5, true)
    else return
    e.preventDefault()
  })
  applyLayout()

  function syncUrl() {
    const u = new URL(location.href)
    for (const k of ['left', 'right', 'lpage', 'rpage', 'lterms', 'rterms', 'page', 'terms']) u.searchParams.delete(k)
    u.searchParams.set('layout', layout)
    if (panes[0].path) u.searchParams.set('left', panes[0].path)
    if (panes[1].path) u.searchParams.set('right', panes[1].path)
    if (nb) u.searchParams.set('notebook', nb)
    history.replaceState(null, '', u)
  }

  // ---------- notebooks ----------
  let notebooks = []
  let nb = ''
  let notes = []
  let sharingOn = false   // a server where people sign in: notebooks can be shared with them
  let publicLinksOn = false  // and links anyone can open are allowed there
  let hostedLinksOn = false  // the desktop app: links hosted by Tensflare
  let signedIn = false
  let me = null           // the signed-in person's email
  let seenAt = 0          // the open notebook's updatedAt when its notes were last loaded

  const current = () => notebooks.find(b => b.id === nb)
  const roleOf = () => current()?.role || 'owner'
  const canEdit = () => roleOf() !== 'view'
  const sharedWithMe = b => !!(b.owner && b.owner !== me)

  async function loadNotebooks() {
    const data = await (await api('/api/notebooks')).json()
    notebooks = data.notebooks
    sharingOn = !!data.sharing
    publicLinksOn = !!data.publicLinks
    hostedLinksOn = !!data.hostedLinks
    signedIn = !!data.signedIn
    me = data.me
    const wanted = params.get('notebook') || store.get('duct.notebook')
    nb = notebooks.some(b => b.id === wanted) ? wanted : (notebooks.find(b => !sharedWithMe(b))?.id || notebooks[0]?.id || '')
    drawNotebookSelect()
    await loadNotes()
  }

  function drawNotebookSelect() {
    const sel = $('nbSelect')
    const option = b => h('option', { value: b.id, text: b.name + ' (' + b.notes + ')', selected: b.id === nb })
    const mine = notebooks.filter(b => !sharedWithMe(b)), shared = notebooks.filter(sharedWithMe)
    if (shared.length) sel.replaceChildren(
      ...(mine.length ? [h('optgroup', { label: 'Your notebooks' }, mine.map(option))] : []),
      h('optgroup', { label: 'Shared with you' }, shared.map(option)))
    else sel.replaceChildren(...notebooks.map(option))
    if (!notebooks.length) sel.append(h('option', { value: '', text: 'No notebooks yet' }))
    const owner = !!nb && roleOf() === 'owner'
    $('nbRename').disabled = $('nbDelete').disabled = !owner
    $('nbRename').title = $('nbDelete').title = nb && !owner ? 'Only the notebook’s owner can do this' : ''
    $('nbExport').disabled = $('nbShare').disabled = !nb
    drawStatus()
    if (nb) store.set('duct.notebook', nb)
  }

  const who = to => to === 'anyone' ? 'Everyone on this Duct' : to.startsWith('domain:') ? 'Everyone at ' + to.slice(7) : to.replace('user:', '')

  /** One line under the controls: whose notebook this is and what you can do, or who it's shared with. */
  function drawStatus() {
    const el = $('nbStatus'), b = current()
    el.replaceChildren()
    el.hidden = true
    if (!b || !sharingOn) return
    if (sharedWithMe(b)) el.append('Shared with you by ', h('b', { text: b.owner }), b.role === 'view' ? ' · you can read it' : ' · you can add notes and comment')
    else if (!b.owner) el.append('Everyone on this Duct can see and add to this notebook')
    else if (b.sharing.length) el.append('Shared with ', h('b', { text: b.sharing.length === 1 ? who(b.sharing[0].to) : b.sharing.length + ' people and groups' }))
    else el.append('Only you can see this notebook')
    el.hidden = false
  }

  async function loadNotes() {
    if (!nb) { notes = []; seenAt = 0; drawNotes(); return }
    const data = await (await api('/api/notebooks/' + encodeURIComponent(nb) + '/notes')).json()
    notes = data.notes
    seenAt = data.notebook.updatedAt
    const i = notebooks.findIndex(b => b.id === nb)
    if (i >= 0) notebooks[i] = data.notebook
    drawNotes()
  }

  const saveTimers = new Map()
  function sourceText(n) {
    return n.docName + (n.page ? ', ' + labelFor(n.format) + ' ' + n.page : '')
  }

  function drawNotes(focusId) {
    const list = $('notesList')
    list.replaceChildren()
    if (!notes.length) {
      list.append(h('p', { class: 'notes-empty', text: nb
        ? 'Select text in either document, then choose “Add to notes”. Each note keeps its document and page.'
        : 'Select text in either document and choose “Add to notes”. Duct will start a notebook for you, or make one with “+ New”.' }))
      return
    }
    const editable = canEdit()
    // Who added each note, once more than one person is writing in the notebook.
    const authors = new Set(notes.map(n => n.author).filter(Boolean))
    const showAuthors = authors.size > 1 || (authors.size === 1 && !authors.has(me))
    notes.forEach((n, i) => {
      const area = h('textarea', { placeholder: editable ? 'Your comment (optional)' : '', 'aria-label': 'Comment', readonly: !editable })
      area.value = n.comment
      if (!editable && !n.comment) area.hidden = true
      const flush = async () => {
        clearTimeout(saveTimers.get(n.id))
        if (area.value === n.comment) return
        const value = area.value
        try { await api('/api/notes/' + encodeURIComponent(n.id), json('PATCH', { comment: value })); n.comment = value }
        catch (err) { toast("Couldn't save the comment: " + err.message, true) }
      }
      area.addEventListener('input', () => { clearTimeout(saveTimers.get(n.id)); saveTimers.set(n.id, setTimeout(flush, 700)) })
      area.addEventListener('blur', flush)
      const elsewhere = n.path.startsWith('shared:')
      const card = h('div', { class: 'note' + (n.id === focusId ? ' new' : ''), 'data-id': n.id },
        h('blockquote', { text: n.quote }),
        h('button', { class: 'src', title: elsewhere ? 'From a shared notebook: this document isn’t in your Duct' : 'Go to this passage', text: sourceText(n) + (elsewhere ? ' · not in your Duct' : ''), onclick: () => showNote(n) }),
        showAuthors && n.author ? h('div', { class: 'by', text: n.author === me ? 'Added by you' : 'Added by ' + n.author }) : null,
        area,
        !editable ? null : h('div', { class: 'tools' },
          h('button', { class: 'ghost', title: 'Move up', text: '↑', disabled: i === 0, onclick: () => move(i, -1) }),
          h('button', { class: 'ghost', title: 'Move down', text: '↓', disabled: i === notes.length - 1, onclick: () => move(i, 1) }),
          h('button', { class: 'ghost', title: 'Delete this note', text: '✕', onclick: () => removeNote(n) })))
      list.append(card)
      if (n.id === focusId) { card.scrollIntoView({ block: 'nearest' }); area.focus() }
    })
  }

  async function move(i, by) {
    const j = i + by
    if (j < 0 || j >= notes.length) return
    ;[notes[i], notes[j]] = [notes[j], notes[i]]
    drawNotes()
    try { await api('/api/notebooks/' + encodeURIComponent(nb) + '/order', json('PUT', { ids: notes.map(n => n.id) })) }
    catch (err) { toast("Couldn't reorder: " + err.message, true); loadNotes() }
  }

  async function removeNote(n) {
    try {
      await api('/api/notes/' + encodeURIComponent(n.id), { method: 'DELETE' })
      notes = notes.filter(x => x.id !== n.id)
      const b = notebooks.find(x => x.id === nb); if (b) b.notes = notes.length
      drawNotebookSelect(); drawNotes()
    } catch (err) { toast("Couldn't delete the note: " + err.message, true) }
  }

  /** Brings a note's document to a pane at the right page: the pane that already shows it, else an empty one, else the right. */
  async function showNote(n) {
    if (n.path.startsWith('shared:')) { toast('This quote came from a shared notebook. “' + n.docName + '” isn’t in your Duct, so add it to open the quote in place.'); return }
    if (!docOf(n.path)) { toast('That document is no longer in the index.', true); return }
    let pane = panes.find(p => p.path === n.path) || panes.find(p => !p.path) || panes[1]
    if (pane.path === n.path && pane.mode === 'native') pane.goto(n.page || 1)
    else await pane.open(n.path, n.page || 1)
    if (pane.path === n.path && !pane.pdf && n.page) pane.goto(n.page)
  }

  // Notebook controls
  let formMode = ''
  function showForm(mode) {
    formMode = mode
    $('nbForm').hidden = !mode
    if (mode) { $('nbName').value = mode === 'rename' ? (notebooks.find(b => b.id === nb)?.name || '') : ''; $('nbName').placeholder = mode === 'new' ? 'Notebook name' : ''; $('nbName').focus(); $('nbName').select() }
  }
  async function createNotebook(name) {
    const { notebook } = await (await api('/api/notebooks', json('POST', { name }))).json()
    notebooks.unshift(notebook)
    nb = notebook.id
    drawNotebookSelect()
    await loadNotes()
    syncUrl()
    return notebook
  }
  $('nbNew').addEventListener('click', e => { e.stopPropagation(); $('newMenu').hidden = !$('newMenu').hidden })
  document.addEventListener('click', () => { $('newMenu').hidden = true })
  $('newMenu').addEventListener('click', e => {
    const what = e.target.closest('[data-new]')?.dataset.new
    if (what === 'new') showForm('new')
    if (what === 'import') $('nbImportFile').click()
  })
  $('nbImportFile').addEventListener('change', async e => {
    const file = e.target.files[0]
    e.target.value = ''
    if (!file) return
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('That file is too big to be a shared notebook.')
      const { notebook } = await (await api('/api/notebooks/import', json('POST', { content: await file.text() }))).json()
      notebooks.unshift(notebook)
      nb = notebook.id
      drawNotebookSelect(); await loadNotes(); syncUrl()
      toast('Added “' + notebook.name + '”: ' + notebook.notes + (notebook.notes === 1 ? ' note' : ' notes'))
    } catch (err) { toast(err.message, true) }
  })
  $('nbRename').addEventListener('click', () => showForm('rename'))
  $('nbCancel').addEventListener('click', () => showForm(''))
  $('nbName').addEventListener('keydown', e => { if (e.key === 'Enter') $('nbSave').click(); if (e.key === 'Escape') showForm('') })
  $('nbSave').addEventListener('click', async () => {
    const name = $('nbName').value.trim()
    if (!name) { $('nbName').focus(); return }
    try {
      if (formMode === 'new') await createNotebook(name)
      else {
        await api('/api/notebooks/' + encodeURIComponent(nb), json('PATCH', { name }))
        const b = notebooks.find(x => x.id === nb); if (b) b.name = name
        drawNotebookSelect()
      }
      showForm('')
    } catch (err) { toast(err.message, true) }
  })
  let deleteArmed
  $('nbDelete').addEventListener('click', async () => {
    const btn = $('nbDelete')
    if (!deleteArmed) {
      deleteArmed = setTimeout(() => { deleteArmed = null; btn.textContent = 'Delete' }, 3500)
      btn.textContent = 'Delete? Click again'
      return
    }
    clearTimeout(deleteArmed); deleteArmed = null; btn.textContent = 'Delete'
    try {
      await api('/api/notebooks/' + encodeURIComponent(nb), { method: 'DELETE' })
      notebooks = notebooks.filter(b => b.id !== nb)
      nb = notebooks[0]?.id || ''
      drawNotebookSelect(); await loadNotes(); syncUrl()
    } catch (err) { toast(err.message, true) }
  })
  $('nbSelect').addEventListener('change', async e => { nb = e.target.value; showShare(false); drawNotebookSelect(); await loadNotes(); syncUrl() })

  // ---------- sharing ----------
  // With sign-in, the owner shares with people, domains or everyone, to read or to edit. Anywhere, a notebook can
  // go out as a page: one file anyone can open in a browser, which holds quotes, document names and comments only.
  function showShare(open) {
    $('sharePanel').hidden = !open
    $('nbShare').setAttribute('aria-expanded', String(open))
    if (open) drawShare()
  }
  $('nbShare').addEventListener('click', () => showShare($('sharePanel').hidden))

  async function saveSharing(sharing) {
    const b = current()
    try {
      const res = await (await api('/api/notebooks/' + encodeURIComponent(nb) + '/sharing', json('PUT', { sharing }))).json()
      b.sharing = res.sharing
      drawStatus(); drawShare()
      return true
    } catch (err) { toast(err.message, true); return false }
  }

  function roleSelect(value, onchange) {
    const sel = h('select', { 'aria-label': 'Access' }, h('option', { value: 'view', text: 'Can read' }), h('option', { value: 'edit', text: 'Can edit' }))
    sel.value = value
    if (onchange) sel.addEventListener('change', () => onchange(sel.value))
    return sel
  }

  function drawShare() {
    const panel = $('sharePanel'), b = current()
    panel.replaceChildren()
    if (!b) return
    if (sharingOn && b.role === 'owner' && b.owner) {
      panel.append(h('h3', { text: 'Who can see it' }), h('div', { class: 'who' }, h('span', { class: 'nm', text: b.owner }), h('span', { class: 'tag', text: 'Owner' })))
      for (const s of b.sharing) {
        panel.append(h('div', { class: 'who' },
          h('span', { class: 'nm', text: who(s.to), title: who(s.to) }),
          roleSelect(s.can, can => saveSharing(b.sharing.map(x => x.to === s.to ? { ...x, can } : x))),
          h('button', { class: 'ghost', title: 'Stop sharing with ' + who(s.to), text: '✕', onclick: () => saveSharing(b.sharing.filter(x => x.to !== s.to)) })))
      }
      const input = h('input', { placeholder: 'Email, domain, or “everyone”', 'aria-label': 'Share with', autocomplete: 'off' })
      const can = roleSelect('view')
      const add = async () => {
        const to = input.value.trim()
        if (!to) { input.focus(); return }
        if (await saveSharing([...b.sharing, { to, can: can.value }])) { panel.querySelector('input')?.focus() }
      }
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add() } })
      panel.append(h('div', { class: 'add' }, input, can, h('button', { class: 'primary', text: 'Share', onclick: add })),
        h('p', { class: 'hint', text: 'People only see notes from documents they can open themselves.' }),
        h('div', { class: 'actions' }, h('button', { text: 'Copy link', onclick: copyLink })),
        h('hr', { class: 'sep' }))
      if (publicLinksOn) drawPublicLink(panel, b)
    } else if (sharingOn && sharedWithMe(b)) {
      panel.append(h('p', { class: 'hint', text: b.owner + ' shared this notebook with you. Only they can change who can see it.' }), h('div', { class: 'actions' }, h('button', { text: 'Copy link', onclick: copyLink })), h('hr', { class: 'sep' }))
    }
    if (hostedLinksOn && b.role === 'owner') drawHostedLink(panel, b)
    panel.append(h('h3', { text: 'Send as a page' }),
      h('p', { class: 'hint', text: 'A single file anyone can open in a browser, even on a phone, without Duct. It holds the quotes, document names, pages and comments: never the documents themselves or where they’re kept.' }),
      h('div', { class: 'actions' }, h('button', { text: 'Save the page', onclick: () => exportAs('html') })))
    if (!sharingOn) panel.append(h('p', { class: 'hint', text: 'Working on it together? On a Duct team server, notebooks can be shared with people, who add to them as you do.' }))
  }

  /** A link anyone can open without signing in: create it, copy it, see how often it was opened, turn it off. */
  function drawPublicLink(panel, b) {
    panel.append(h('h3', { text: 'Public link' }))
    if (b.publicLink) {
      const url = new URL(b.publicLink, location.href).toString()
      const field = h('input', { value: url, readonly: true, 'aria-label': 'Public link', onfocus: e => e.target.select() })
      panel.append(h('div', { class: 'add' }, field, h('button', { text: 'Copy', onclick: async () => {
        try { await navigator.clipboard.writeText(url); toast('Public link copied') } catch { field.select() }
      } })),
      h('p', { class: 'hint', text: 'Anyone with this link can read the notebook. ' + (b.publicViews === 1 ? 'Opened once.' : 'Opened ' + (b.publicViews || 0) + ' times.') }),
      h('div', { class: 'actions' },
        h('button', { text: 'New link', title: 'Make a new link; the old one stops working', onclick: () => setPublic(true) }),
        h('button', { text: 'Turn off', onclick: () => setPublic(false) })))
    } else {
      panel.append(h('p', { class: 'hint', text: 'A link anyone can open without signing in, served by this server. It shows every note here, including quotes from documents only you can open, and leaves out who added them.' }),
        h('div', { class: 'actions' }, h('button', { text: 'Create a public link', onclick: () => setPublic(true) })))
    }
    panel.append(h('hr', { class: 'sep' }))
  }

  /** The desktop app: a link anyone can open, hosted by Tensflare for 7, 30 or 90 days. Says plainly what's uploaded. */
  function drawHostedLink(panel, b) {
    panel.append(h('h3', { text: 'Link anyone can open' }))
    if (b.hostedLink) {
      const until = new Date(b.hostedLink.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
      const field = h('input', { value: b.hostedLink.url, readonly: true, 'aria-label': 'Link', onfocus: e => e.target.select() })
      panel.append(h('div', { class: 'add' }, field, h('button', { text: 'Copy', onclick: async () => {
        try { await navigator.clipboard.writeText(b.hostedLink.url); toast('Link copied') } catch { field.select() }
      } })),
      h('p', { class: 'hint', text: 'Works until ' + until + ', then Tensflare deletes it. Changes you make here aren’t in the link until you make a new one.' }),
      h('div', { class: 'actions' },
        h('button', { text: 'New link', title: 'Upload the notebook as it is now; the old link stops working', onclick: () => setHosted(true) }),
        h('button', { text: 'Take down', onclick: () => setHosted(false) })))
    } else {
      const days = h('select', { 'aria-label': 'How long the link works' }, h('option', { value: '7', text: 'for 7 days' }), h('option', { value: '30', text: 'for 30 days' }), h('option', { value: '90', text: 'for 90 days' }))
      days.value = '30'
      panel.append(h('p', { class: 'hint', text: 'Uploads this notebook to Tensflare so anyone with the link can read it, on any device. Only the quotes, document names, pages and your comments go: never the documents, where they’re kept, or anything else on this computer. It’s deleted when the link expires or you take it down.' }))
      if (!signedIn) panel.append(h('p', { class: 'hint', text: 'You’ll need to sign in with a Tensflare account first, in Settings › Account. It’s free.' }))
      panel.append(h('div', { class: 'actions' }, days, h('button', { text: 'Upload and make a link', onclick: () => setHosted(true, days.value) })))
    }
    panel.append(h('hr', { class: 'sep' }))
  }

  async function setHosted(on, days) {
    const b = current()
    try {
      const url = '/api/notebooks/' + encodeURIComponent(nb) + '/hosted-link'
      const res = await (await api(url, on ? json('POST', { days: Number(days || 30) }) : { method: 'DELETE' })).json()
      b.hostedLink = res.hostedLink
      drawShare()
      toast(on ? 'Link ready. Anyone with it can read this notebook.' : 'Link taken down. Tensflare has deleted what was on it.')
    } catch (err) { toast(err.message, true) }
  }

  async function setPublic(on) {
    const b = current()
    try {
      const res = await (await api('/api/notebooks/' + encodeURIComponent(nb) + '/public-link', { method: on ? 'POST' : 'DELETE' })).json()
      b.publicLink = res.publicLink
      b.publicViews = res.publicViews || 0
      drawShare()
      toast(on ? 'Public link ready. Anyone with it can read this notebook.' : 'Public link turned off. It no longer opens.')
    } catch (err) { toast(err.message, true) }
  }

  async function copyLink() {
    const u = new URL('/workspace', location.href)
    u.searchParams.set('notebook', nb)
    try { await navigator.clipboard.writeText(u.toString()); toast('Link copied. It opens for people this notebook is shared with.') }
    catch { toast(u.toString()) }
  }

  // Others' changes: check every few seconds while the window is in view, and redraw unless you're mid-comment.
  async function refresh() {
    if (document.visibilityState !== 'visible') return
    try {
      const data = await (await fetch('/api/notebooks')).json()
      if (!Array.isArray(data.notebooks)) return
      const was = current()
      notebooks = data.notebooks
      if (nb && !current()) {
        toast('“' + (was?.name || 'That notebook') + '” isn’t shared with you any more.')
        nb = notebooks[0]?.id || ''
        drawNotebookSelect(); await loadNotes(); syncUrl()
        return
      }
      drawNotebookSelect()
      const typing = document.activeElement?.tagName === 'TEXTAREA' && $('notesList').contains(document.activeElement)
      if (nb && current().updatedAt !== seenAt && !typing) await loadNotes()
      if (!$('sharePanel').hidden && !$('sharePanel').contains(document.activeElement)) drawShare()
    } catch { /* offline for a moment; try again next time */ }
  }
  setInterval(refresh, 8000)
  document.addEventListener('visibilitychange', refresh)
  $('toggleNotes').addEventListener('click', () => {
    const aside = $('notes')
    aside.hidden = !aside.hidden
    $('toggleNotes').setAttribute('aria-expanded', String(!aside.hidden))
  })

  // Export: fetched rather than navigated to, so a refusal shows as a message instead of replacing this page.
  $('nbExport').addEventListener('click', e => { e.stopPropagation(); $('exportMenu').hidden = !$('exportMenu').hidden })
  document.addEventListener('click', () => { $('exportMenu').hidden = true })
  $('exportMenu').addEventListener('click', e => {
    const format = e.target.closest('[data-format]')?.dataset.format
    if (format) exportAs(format)
  })
  async function exportAs(format) {
    try {
      const res = await api('/api/notebooks/' + encodeURIComponent(nb) + '/export?format=' + format)
      const m = /filename\\*=UTF-8''([^;]+)/.exec(res.headers.get('Content-Disposition') || '')
      const url = URL.createObjectURL(await res.blob())
      const a = h('a', { href: url, download: m ? decodeURIComponent(m[1]) : 'duct-notes.' + format })
      document.body.append(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    } catch (err) { toast(err.message, true) }
  }

  // ---------- selecting text ----------
  const addPop = $('addPop')
  let pending = null
  function hidePop() { addPop.classList.remove('show'); pending = null }
  function checkSelection() {
    const sel = getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) { hidePop(); return }
    const range = sel.getRangeAt(0)
    const pane = panes.find(p => p.path && p.body.contains(range.commonAncestorContainer))
    const quote = sel.toString().replace(WS, ' ').trim()
    if (!pane || !quote) { hidePop(); return }
    const rects = range.getClientRects()
    const r = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect()
    pending = { pane, quote, page: pane.pageOf(range.startContainer) }
    addPop.style.left = Math.max(8, Math.min(innerWidth - 130, r.right - 20)) + 'px'
    addPop.style.top = Math.min(innerHeight - 40, r.bottom + 6) + 'px'
    addPop.classList.add('show')
  }
  document.addEventListener('mouseup', e => { if (!addPop.contains(e.target)) setTimeout(checkSelection, 0) })
  document.addEventListener('keyup', e => { if (e.key.startsWith('Arrow') && e.shiftKey) checkSelection(); if (e.key === 'Escape') hidePop() })
  addPop.addEventListener('mousedown', e => e.preventDefault())  // keep the selection while clicking
  addPop.addEventListener('click', async () => {
    const p = pending
    if (!p) return
    hidePop()
    if (nb && !canEdit()) { toast('You can read “' + current().name + '” but not add to it. Pick one of your notebooks, or start one with “+ New”.', true); return }
    try {
      if (!nb) await createNotebook('My notes')
      const { note } = await (await api('/api/notebooks/' + encodeURIComponent(nb) + '/notes', json('POST', { path: p.pane.path, quote: p.quote, page: p.page || undefined }))).json()
      notes.push(note)
      const b = notebooks.find(x => x.id === nb); if (b) b.notes = notes.length
      drawNotebookSelect()
      if ($('notes').hidden) $('toggleNotes').click()
      drawNotes(note.id)
      getSelection()?.removeAllRanges()
    } catch (err) { toast("Couldn't add the note: " + err.message, true) }
  })

  // ---------- start ----------
  try {
    const info = await (await api('/api/info')).json()
    pageLabels = Object.fromEntries((info.formats || []).map(f => [f.format, f.pageLabel]))
  } catch {}
  try { docs = (await (await api('/api/documents')).json()).documents } catch (err) { toast("Couldn't list documents: " + err.message, true) }
  for (const p of panes) if (!p.path) p.togglePicker(true)  // the pickers were drawn before the list arrived
  const terms = key => { try { return JSON.parse(params.get(key) || '[]').filter(t => typeof t === 'string' && t.trim()) } catch { return [] } }
  const startPage = key => Math.max(1, parseInt(params.get(key) || '1', 10) || 1)
  const left = params.get('left') || params.get('path'), right = params.get('right')
  if (left) panes[0].open(left, startPage(params.has('lpage') ? 'lpage' : 'page'), terms(params.has('lterms') ? 'lterms' : 'terms'))
  if (right) panes[1].open(right, startPage('rpage'), terms('rterms'))
  try { await loadNotebooks() } catch (err) { toast("Couldn't load notebooks: " + err.message, true) }
</script>
</body>
</html>`
