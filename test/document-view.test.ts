import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { cleanHtml, convertToPdf, documentView, findLibreOffice, resetLibreOfficeLookup } from '../src/document-view.js'
import { Duct } from '../src/index.js'
import { createServer } from '../src/server.js'
import { makeDocx, makePptx } from './helpers.js'

const dir = mkdtempSync(join(tmpdir(), 'duct-view-'))
// Looked up before the tests below switch LibreOffice off for themselves.
const hasLibreOffice = !!findLibreOffice()
resetLibreOfficeLookup()
afterAll(() => rmSync(dir, { recursive: true, force: true }))
// These tests are about the views drawn without LibreOffice, whether or not this machine has it.
beforeAll(() => { process.env['DUCT_SOFFICE'] = 'off'; resetLibreOfficeLookup() })
afterAll(() => { delete process.env['DUCT_SOFFICE']; resetLibreOfficeLookup() })

describe('cleaning HTML from documents', () => {
  it('removes scripts, handlers, styles, frames and links that navigate', async () => {
    const html = await cleanHtml(`
      <p onclick="alert(1)" style="color:red" class="x" id="y">Hello <a href="javascript:alert(2)">there</a></p>
      <script>alert(3)</script><style>body{}</style><iframe src="https://evil.example"></iframe>
      <img src="x" onerror="alert(4)"><img src="https://tracker.example/pixel.gif" alt="logo">
      <svg><script>alert(5)</script></svg><form action="https://evil.example"><input name="pw"></form>
      <!--[if IE]><script>alert(6)</script><![endif]--><table><tr><td colspan="2" onmouseover="x()">cell</td></tr></table>
      <marquee>old</marquee>`)
    expect(html).not.toMatch(/script|onclick|onerror|onmouseover|style|iframe|javascript:|svg|form|input|tracker|class="x"|id=|href/i)
    expect(html).toContain('Hello')
    expect(html).toContain('<a class="link">there</a>')
    expect(html).toContain('[logo]')          // a remote image is never fetched; its description stays
    expect(html).toContain('colspan="2"')
    expect(html).toContain('old')             // unknown tags keep their text
  })

  it('keeps embedded images and harmless structure', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgo='
    const html = await cleanHtml(`<h2>Title</h2><ul><li><strong>One</strong></li></ul><img src="${png}" alt="chart"><img src="data:image/svg+xml;base64,PHN2Zz4=">`)
    expect(html).toContain('<h2>Title</h2>')
    expect(html).toContain('<strong>One</strong>')
    expect(html).toContain(`src="${png}"`)
    expect(html).not.toContain('svg+xml')
  })
})

describe('views of each format', () => {
  it('draws Word documents from their structure', async () => {
    const path = join(dir, 'Lease.docx')
    writeFileSync(path, await makeDocx(['The tenant may terminate on 30 days notice.', 'Rent is due monthly.']))
    const view = await documentView(path)
    expect(view).toMatchObject({ kind: 'html', via: 'word' })
    expect((view as { html: string }).html).toMatch(/<p>The tenant may terminate on 30 days notice\.<\/p>/)
  })

  it('shows spreadsheets as tables, a sheet at a time', async () => {
    const XLSX = await import('xlsx')
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Item', 'Amount'], ['Rent', 1200], ['<b>Bonus</b>', 50]]), 'Budget')
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Name'], ['Ada']]), 'People')
    const path = join(dir, 'Budget.xlsx')
    writeFileSync(path, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))
    const view = await documentView(path) as { kind: string; html: string; sections: { title: string; page: number }[] }
    expect(view.kind).toBe('html')
    expect(view.sections).toEqual([{ title: 'Budget', page: 1 }, { title: 'People', page: 2 }])
    expect(view.html).toContain('<th scope="col">Amount</th>')
    expect(view.html).toContain('<td>1200</td>')
    expect(view.html).toContain('&lt;b&gt;Bonus&lt;/b&gt;')   // cell text is text, never markup
    expect(view.html).toContain('data-page="2"')
  })

  it('formats Markdown, and cleans HTML written inside it', async () => {
    const path = join(dir, 'Notes.md')
    writeFileSync(path, '# Notes\n\n- **Bold** point\n\n<img src=x onerror=alert(1)>\n')
    const view = await documentView(path) as { kind: string; html: string }
    expect(view.html).toContain('<h1>Notes</h1>')
    expect(view.html).toContain('<strong>Bold</strong>')
    expect(view.html).not.toMatch(/onerror|<img/)
  })

  it('shows emails with their headers, without fetching remote images', async () => {
    const path = join(dir, 'Offer.eml')
    writeFileSync(path, [
      'From: Ada Okafor <ada@okafor.ng>', 'To: chidi@okafor.ng', 'Subject: The offer', 'Date: Mon, 5 Oct 2026 09:00:00 +0100',
      'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '',
      '<p>Please see the <b>attached</b> offer.</p><img src="https://track.example/open.gif"><script>alert(1)</script>',
    ].join('\r\n'))
    const view = await documentView(path) as { kind: string; via: string; html: string }
    expect(view.via).toBe('email')
    expect(view.html).toContain('<dt>From</dt><dd>Ada Okafor &lt;ada@okafor.ng&gt;</dd>')
    expect(view.html).toContain('<b>attached</b>')
    expect(view.html).not.toMatch(/track\.example|script/)
  })

  it('falls back to the text for other formats', async () => {
    const path = join(dir, 'notes.txt')
    writeFileSync(path, 'plain')
    expect(await documentView(path)).toEqual({ kind: 'text' })
  })
})

describe('the view routes', () => {
  let server: Server
  let base: string
  const docx = join(dir, 'Indexed.docx')
  beforeAll(async () => {
    writeFileSync(docx, await makeDocx(['Indexed text.']))
    const duct = new Duct({ embed: false })
    await duct.index(docx)
    server = createServer(duct, { libraryDir: join(dir, 'lib') }).listen(0, '127.0.0.1')
    await new Promise(r => server.once('listening', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => server.close())

  it('only show indexed documents', async () => {
    const ok = await (await fetch(`${base}/api/document-view?path=${encodeURIComponent(docx)}`)).json()
    expect(ok.kind).toBe('html')
    const other = join(dir, 'Notes.md')   // on disk, but not indexed
    expect((await fetch(`${base}/api/document-view?path=${encodeURIComponent(other)}`)).status).toBe(404)
    expect((await fetch(`${base}/api/document-pdf?path=${encodeURIComponent('/etc/passwd')}`)).status).toBe(404)
    // Without LibreOffice, asking for pages says so instead of failing silently.
    const pdf = await fetch(`${base}/api/document-pdf?path=${encodeURIComponent(docx)}`)
    expect(pdf.status).toBe(422)
  })
})

// Runs where LibreOffice is installed (CI installs it on Linux).
describe('pages from LibreOffice', () => {
  const soffice = () => { delete process.env['DUCT_SOFFICE']; resetLibreOfficeLookup(); return findLibreOffice() }
  afterAll(() => { process.env['DUCT_SOFFICE'] = 'off'; resetLibreOfficeLookup() })

  it.skipIf(!hasLibreOffice)(
    'turns Word and PowerPoint files into PDF pages, converting each version once', async () => {
      expect(soffice()).toBeTruthy()
      const cache = join(dir, 'cache')
      const docx = join(dir, 'Contract.docx')
      writeFileSync(docx, await makeDocx(['Clause 1. The tenant may terminate on 30 days notice.']))
      expect(await documentView(docx)).toEqual({ kind: 'pdf', via: 'libreoffice' })
      const pdf = await convertToPdf(docx, cache)
      expect(readFileSync(pdf).subarray(0, 5).toString()).toBe('%PDF-')
      const again = statSync(pdf).mtimeMs
      expect(await convertToPdf(docx, cache)).toBe(pdf)   // cached
      expect(statSync(pdf).mtimeMs).toBe(again)
      const pptx = join(dir, 'Deck.pptx')
      writeFileSync(pptx, await makePptx([['Quarterly results'], ['Revenue grew']]))
      expect(readFileSync(await convertToPdf(pptx, cache)).subarray(0, 5).toString()).toBe('%PDF-')
    }, 180_000)
})
