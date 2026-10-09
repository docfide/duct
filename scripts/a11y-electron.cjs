// Accessibility check: starts Duct with a small sample library, opens every main screen in Chromium and runs axe-core
// with the WCAG 2.2 A and AA rules. Exits 1 if any screen has a violation. Runs inside Electron, as the desktop app
// does, so the pages are checked in the browser that shows them.
//
//   npm run build && npm run a11y            # also writes a11y-report.json
//
// What it can't check (the screen reader experience, whether the wording makes sense, keyboard flows end to end) is
// in docs/accessibility.md, with how we test those by hand.
const { app, BrowserWindow } = require('electron')
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const root = join(__dirname, '..')
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa']
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const { Duct } = await import(join(root, 'dist/index.js'))
  const { createServer } = await import(join(root, 'dist/server.js'))
  const { default: JSZip } = await import('jszip')
  const work = mkdtempSync(join(tmpdir(), 'duct-a11y-'))
  const lib = join(work, 'Contracts')
  mkdirSync(lib, { recursive: true })
  writeFileSync(join(lib, 'Lease renewal.md'), '# Lease renewal\n\nThe tenant may terminate the lease on 90 days notice.\n\nRent is reviewed every two years.\n')
  writeFileSync(join(lib, 'Board minutes.txt'), 'The board approved the lease renewal and the tax holiday application.')
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Supply agreement. The supplier may terminate on 30 days notice.</w:t></w:r></w:p></w:body></w:document>')
  writeFileSync(join(lib, 'Supply agreement.docx'), await zip.generateAsync({ type: 'nodebuffer' }))

  const duct = new Duct({ embed: false, persistPath: join(work, 'index') })
  await duct.index(lib)
  const server = createServer(duct, { libraryDir: join(work, 'library') }).listen(0, '127.0.0.1')
  await new Promise(r => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json())
  const { notebook } = await post('/api/notebooks', { name: 'Lease review' })
  await post(`/api/notebooks/${notebook.id}/notes`, { path: join(lib, 'Lease renewal.md'), quote: 'The tenant may terminate the lease on 90 days notice.' })
  const page = await (await fetch(`${base}/api/notebooks/${notebook.id}/export?format=html`)).text()
  writeFileSync(join(work, 'notebook.html'), page)

  const enc = encodeURIComponent
  const screens = [
    { name: 'Home', url: base + '/' },
    { name: 'Search results with preview', url: base + '/', js: "const q=document.querySelector('#q'); q.value='terminate'; q.dispatchEvent(new Event('input'))" },
    { name: 'Search that finds nothing', url: base + '/', js: "const q=document.querySelector('#q'); q.value='zebracorn'; q.dispatchEvent(new Event('input'))" },
    { name: 'All documents', url: base + '/', js: "document.querySelector('[data-view=documents]').click()" },
    { name: 'Notebooks', url: base + '/', js: "document.querySelector('[data-view=notebooks]').click()" },
    { name: 'Settings', url: base + '/', js: 'window.duct.openSettings()' },
    { name: 'Workspace, one document', url: `${base}/workspace?layout=one&left=${enc(join(lib, 'Supply agreement.docx'))}&lterms=${enc('["terminate"]')}` },
    { name: 'Workspace, side by side with notes', url: `${base}/workspace?layout=cols&left=${enc(join(lib, 'Lease renewal.md'))}&right=${enc(join(lib, 'Board minutes.txt'))}&notebook=${notebook.id}` },
    { name: 'Shared notebook page', url: 'file://' + join(work, 'notebook.html') },
  ]

  const axe = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8')
  const report = []
  // One window for every screen: creating and destroying offscreen windows in a row can crash Electron.
  const win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { offscreen: true } })
  for (const screen of screens) {
    try {
      await win.loadURL(screen.url)
      await sleep(1500)
      if (screen.js) { await win.webContents.executeJavaScript(`{ ${screen.js} }`); await sleep(1200) }
      await win.webContents.executeJavaScript(axe)
      const result = await win.webContents.executeJavaScript(`axe.run(document, { runOnly: { type: 'tag', values: ${JSON.stringify(TAGS)} }, resultTypes: ['violations'] })
        .then(r => ({ passes: r.passes.length, violations: r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) })) }))`)
      report.push({ name: screen.name, ...result })
    } catch (err) {
      report.push({ name: screen.name, passes: 0, violations: [{ id: 'page-failed', impact: 'critical', help: String((err && err.message) || err), nodes: [] }] })
    }
  }
  win.destroy()
  writeFileSync(join(root, 'a11y-report.json'), JSON.stringify(report, null, 2))
  let total = 0
  for (const s of report) {
    total += s.violations.length
    console.log(`${s.violations.length ? '✗' : '✓'} ${s.name}: ${s.violations.length ? s.violations.length + ' problem(s)' : `no problems (${s.passes} checks passed)`}`)
    for (const v of s.violations) {
      console.log(`    [${v.impact}] ${v.id}: ${v.help}`)
      for (const n of v.nodes.slice(0, 4)) console.log(`        ${n.target.join(' ')}  ${n.summary ? '— ' + n.summary.split('\n').slice(0, 2).join(' ') : ''}`)
    }
  }

  server.close()
  duct.close()
  rmSync(work, { recursive: true, force: true })
  return total
}

app.whenReady().then(main).then(total => app.exit(total ? 1 : 0), err => { console.error(err); app.exit(2) })
