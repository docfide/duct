import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import XLSX from 'xlsx'
import { Duct } from '../src/index.js'
import { extract } from '../src/extract/index.js'
import { rtfToText } from '../src/extract/office.js'
import { snappyDecompress } from '../src/extract/packages.js'
import { FORMATS, SUPPORTED_EXTENSIONS, formatForPath, isSupportedFile, pageLabel } from '../src/formats.js'
import { terminateOcr } from '../src/ocr/index.js'
import { makeDocx, makeEpub, makeIwa, makeOdf, makePptx, makeTextPdf, makeZip } from './helpers.js'

const work = mkdtempSync(join(tmpdir(), 'duct-formats-'))
const fixtures = join(import.meta.dirname, 'fixtures')
const file = (name: string, data: string | Buffer) => { const p = join(work, name); writeFileSync(p, data); return p }
afterAll(async () => {
  await terminateOcr()
  rmSync(work, { recursive: true, force: true })
})

describe('format registry', () => {
  it('knows every format once', () => {
    const all = FORMATS.flatMap(f => f.extensions)
    expect(new Set(all).size).toBe(all.length)
    expect(SUPPORTED_EXTENSIONS.size).toBeGreaterThan(80)
  })

  it('skips lock files, hidden files and secrets', () => {
    expect(isSupportedFile('/a/report.docx')).toBe(true)
    expect(isSupportedFile('/a/~$report.docx')).toBe(false)
    expect(isSupportedFile('/a/.hidden.md')).toBe(false)
    expect(isSupportedFile('/a/.env')).toBe(false)
    expect(isSupportedFile('/a/id_rsa')).toBe(false)
  })

  it('labels pages by format', () => {
    expect(pageLabel('pptx')).toBe('slide')
    expect(pageLabel('xlsx')).toBe('sheet')
    expect(pageLabel('epub')).toBe('ch.')
    expect(pageLabel('pdf')).toBe('p.')
    expect(formatForPath('deck.KEY')?.label).toBe('Apple Keynote')
  })
})

describe('spreadsheets', () => {
  const book = () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Region', 'Revenue'], ['North', 1200]]), 'Summary')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Invoice', 'Customer'], ['INV-77', 'Quokka Ltd']]), 'Invoices')
    return wb
  }
  for (const [ext, bookType] of [['xls', 'biff8'], ['xlsb', 'xlsb'], ['ods', 'ods'], ['xlsx', 'xlsx']] as const) {
    it(`reads .${ext} with one page per sheet`, async () => {
      const path = file(`book.${ext}`, XLSX.write(book(), { type: 'buffer', bookType }))
      const doc = await extract(path)
      expect(doc.pages).toHaveLength(2)
      expect(doc.pages![1]).toContain('Quokka Ltd')
      expect(doc.pages![1]).toContain('Sheet: Invoices')
    })
  }
})

describe('documents', () => {
  it('reads legacy Word (.doc), including non-Latin text', async () => {
    const doc = await extract(join(fixtures, 'sample.doc'))
    expect(doc.content).toContain('This is a test for parsing the Word file')
    expect(doc.content).toContain('这是一个用来测试')
  })

  it('reads a .doc that is really a .docx, and a .docx that is really a .doc', async () => {
    const docx = await makeDocx(['Renamed files are common'])
    expect((await extract(file('renamed.doc', docx))).content).toContain('Renamed files are common')
    const { readFileSync } = await import('node:fs')
    expect((await extract(file('old-binary.docx', readFileSync(join(fixtures, 'sample.doc'))))).content).toContain('parsing the Word file')
  })

  it('reads OpenDocument text with spacing, tabs and footnotes', async () => {
    const path = file('memo.odt', await makeOdf('application/vnd.oasis.opendocument.text',
      '<office:text><text:h>Board Memo</text:h><text:p>Budget<text:s text:c="3"/>approved<text:tab/>Q3<text:note><text:note-citation>1</text:note-citation><text:note-body><text:p>Subject to audit</text:p></text:note-body></text:note></text:p></office:text>', 'Memo title'))
    const doc = await extract(path)
    expect(doc.content.split('\n')).toEqual(['Board Memo', 'Budget   approved\tQ3Subject to audit'])
    expect(doc.metadata.title).toBe('Memo title')
  })

  it('reads OpenDocument slides as pages', async () => {
    const path = file('deck.odp', await makeOdf('application/vnd.oasis.opendocument.presentation',
      '<office:presentation><draw:page><text:p>Welcome</text:p></draw:page><draw:page><text:p>Roadmap for wombats</text:p></draw:page></office:presentation>'))
    const doc = await extract(path)
    expect(doc.pages).toEqual(['Welcome', 'Roadmap for wombats'])
  })

  it('converts RTF: code pages, Unicode escapes, skipped tables and pictures', () => {
    const rtf = String.raw`{\rtf1\ansi\ansicpg1252\uc1{\fonttbl{\f0 Arial;}}{\colortbl;\red0\green0\blue0;}{\*\generator Riched20;}\f0 Caf\'e9 contract\par Unicode: \u8364?uro and \u20013?\u25991?\par {\pict\wmetafile8 0102abcdef}Line\line two\tab tabbed\par End.}`
    expect(rtfToText(rtf)).toBe('Café contract\nUnicode: €uro and 中文\nLine\ntwo\ttabbed\nEnd.')
  })

  it('reads RTF in other code pages', () => {
    expect(rtfToText(String.raw`{\rtf1\ansi\ansicpg1251 \'cf\'f0\'e8\'e2\'e5\'f2\par}`)).toBe('Привет')
    expect(rtfToText(String.raw`{\rtf1\ansi\ansicpg936 \'d6\'d0\'ce\'c4\par}`)).toBe('中文')
  })

  it('reads EPUB chapters in reading order', async () => {
    const path = file('book.epub', await makeEpub('The Burrow', ['<h1>Chapter One</h1><p>Ferrets love tunnels.</p>', '<h1>Chapter Two</h1><p>They hoard socks.</p>']))
    const doc = await extract(path)
    expect(doc.pages).toEqual(['Chapter One\nFerrets love tunnels.', 'Chapter Two\nThey hoard socks.'])
    expect(doc.metadata.title).toBe('The Burrow')
  })

  it('refuses DRM-protected EPUBs with a clear reason', async () => {
    const zip = await makeZip({ 'META-INF/encryption.xml': '<encryption><EncryptedData/></encryption>', 'META-INF/container.xml': '<container/>' })
    await expect(extract(file('drm.epub', zip))).rejects.toThrow(/DRM/)
  })

  it('includes PowerPoint speaker notes with their slide', async () => {
    const pptx = await makePptx([['Quarterly review'], ['Next steps']])
    const { default: JSZip } = await import('jszip')
    const zip = await JSZip.loadAsync(pptx)
    zip.file('ppt/notesSlides/notesSlide2.xml', '<p:notes xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Remember the otters</a:t></a:r></a:p><a:p><a:r><a:t>2</a:t></a:r></a:p></p:notes>')
    const doc = await extract(file('notes.pptx', await zip.generateAsync({ type: 'nodebuffer' })))
    expect(doc.pages![1]).toContain('Remember the otters')
    expect(doc.pages![1]).not.toMatch(/\n2$/)
  })
})

describe('Apple iWork', () => {
  it('decompresses snappy blocks with back-references', () => {
    const block = new Uint8Array([9, 2 << 2, 97, 98, 99, (2 << 2) | 1, 3])
    expect(new TextDecoder().decode(snappyDecompress(block))).toBe('abcabcabc')
  })

  it('reads text from modern .pages files', async () => {
    const pages = await makeZip({ 'Index/Document.iwa': makeIwa(['Lease agreement for the burrow\u2029Rent is due monthly\ufffc']), 'Index/DocumentStylesheet.iwa': makeIwa(['Placeholder style text']) })
    const doc = await extract(file('lease.pages', pages))
    expect(doc.content).toBe('Lease agreement for the burrow\nRent is due monthly')
  })

  it('reads documents saved as package folders', async () => {
    const parent = join(work, 'packages')
    const dir = join(parent, 'old.pages')
    mkdirSync(join(dir, 'Index'), { recursive: true })
    writeFileSync(join(dir, 'Index', 'Document.iwa'), makeIwa(['Package folder text']))
    expect((await extract(dir)).content).toBe('Package folder text')
    const duct = new Duct()
    const result = await duct.index(parent)   // the walker treats the package as one document
    expect(result).toMatchObject({ documents: 1 })
    expect((await duct.search('package folder')).map(r => r.chunk.documentPath)).toEqual([dir])
  })

  it('falls back to the QuickLook preview PDF (iWork \'09)', async () => {
    const numbers = await makeZip({ 'QuickLook/Preview.pdf': makeTextPdf([[[12, 700, 'Expense report']], [[12, 700, 'Total travel spend']]]) })
    const doc = await extract(file('expenses.numbers', numbers))
    expect(doc.pages).toEqual(['Expense report', 'Total travel spend'])
  })

  it('skips files named .key that are not Keynote decks (e.g. TLS keys) without reporting a failure', async () => {
    const dir = join(work, 'keys')
    mkdirSync(dir)
    writeFileSync(join(dir, 'server.key'), '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n')
    const duct = new Duct()
    const result = await duct.index(dir)
    expect(result.failed ?? 0).toBe(0)
    expect(duct.getDocuments()).toHaveLength(0)
  })
})

describe('email', () => {
  it('reads .eml with headers, an HTML-only body and attachments', async () => {
    const eml = [
      'From: Ada Lovelace <ada@example.com>', 'To: Charles <charles@example.com>', 'Subject: Engine notes', 'Date: Tue, 1 Oct 2024 10:00:00 +0000',
      'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b1"', '',
      '--b1', 'Content-Type: text/html; charset=utf-8', '', '<p>The <b>analytical</b> engine</p><p>can weave patterns</p>',
      '--b1', 'Content-Type: text/plain; name="notes.txt"', 'Content-Disposition: attachment; filename="notes.txt"', 'Content-Transfer-Encoding: base64', '',
      Buffer.from('Punch cards for the loom').toString('base64'),
      '--b1', 'Content-Type: application/octet-stream', 'Content-Disposition: attachment; filename="firmware.bin"', 'Content-Transfer-Encoding: base64', '',
      Buffer.from([1, 2, 3]).toString('base64'), '--b1--', '',
    ].join('\r\n')
    const doc = await extract(file('notes.eml', eml))
    expect(doc.sections!.map(s => s.title)).toEqual(['Engine notes', 'Attachment: notes.txt'])
    expect(doc.sections![0].text).toContain('From: Ada Lovelace <ada@example.com>')
    expect(doc.sections![0].text).toContain('The analytical engine\ncan weave patterns')
    expect(doc.sections![1].text).toBe('Punch cards for the loom')
    expect(doc.metadata.unreadAttachments).toEqual(['firmware.bin'])

    const duct = new Duct()
    await duct.index(join(work, 'notes.eml'))
    const [hit] = await duct.search('punch cards')
    expect(hit.chunk.heading).toBe('Attachment: notes.txt')
  })

  it('reads Outlook .msg with sender, recipients and attachment names', async () => {
    const doc = await extract(join(fixtures, 'sample.msg'))
    expect(doc.sections![0].text).toContain('Subject: attachmentFiles')
    expect(doc.sections![0].text).toContain('hmailuser@hmailserver.test')
    expect(doc.metadata.attachments).toEqual(['jpg.jpg', 'png.png', 'tif.tif'])
  })
})

describe('archives', () => {
  it('indexes supported files inside a ZIP, each under its own name', async () => {
    const zip = await makeZip({
      'contracts/nda.docx': await makeDocx(['Mutual confidentiality for marmots']),
      'contracts/terms.pdf': makeTextPdf([[[12, 700, 'Termination after ninety days']]]),
      'readme.txt': 'Archive of signed documents',
      '__MACOSX/contracts/._nda.docx': 'junk',
      'tool.exe': 'MZ',
    })
    const doc = await extract(file('signed.zip', zip))
    expect(doc.sections!.map(s => s.title).sort()).toEqual(['contracts/nda.docx', 'contracts/terms.pdf', 'readme.txt'])
    const duct = new Duct()
    await duct.index(join(work, 'signed.zip'))
    const [hit] = await duct.search('marmots')
    expect(hit.chunk.heading).toBe('contracts/nda.docx')
  })

  it('stops at the nesting limit', async () => {
    const inner = await makeZip({ 'deep.txt': 'very deep text' })
    const middle = await makeZip({ 'inner.zip': inner })
    const outer = await makeZip({ 'middle.zip': middle })
    expect((await extract(file('outer.zip', outer))).content).not.toContain('very deep text')
  })
})

describe('text, code and images', () => {
  it('decodes UTF-16 and Windows-1252 text', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Résumé in UTF-16', 'utf16le')])
    expect((await extract(file('u16.txt', utf16))).content).toBe('Résumé in UTF-16')
    expect((await extract(file('cp1252.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x35]))))).toMatchObject({ content: 'café €5' })
  })

  it('keeps only the spoken lines of subtitles', async () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\n<i>Hello there</i>\n\n2\n00:00:03,000 --> 00:00:04,000\nGeneral Kenobi\n'
    expect((await extract(file('movie.srt', srt))).content).toBe('Hello there\nGeneral Kenobi')
  })

  it('reads source code and SVG labels', async () => {
    expect((await extract(file('app.py', 'def lease_total():\n    return 42\n'))).format).toBe('code')
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><title>Org chart</title><text x="1" y="2">Head of Burrows</text></svg>'
    expect((await extract(file('chart.svg', svg))).content).toBe('Org chart\nHead of Burrows')
  })

  it.runIf(process.platform === 'darwin')('reads iPhone HEIC photos with OCR', async () => {
    const png = join(work, 'photo.png')
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="200"><rect width="100%" height="100%" fill="white"/><text x="40" y="120" font-family="Helvetica" font-size="64">Receipt for hedgehogs</text></svg>'
    await sharp(Buffer.from(svg)).png().toFile(png)
    execFileSync('sips', ['-s', 'format', 'heic', png, '--out', join(work, 'photo.heic')])
    expect((await extract(join(work, 'photo.heic'), { ocr: true })).content.toLowerCase()).toContain('hedgehogs')
  }, 60_000)
})

describe('folder scanning', () => {
  let duct: Duct
  beforeAll(async () => {
    const root = join(work, 'scan')
    for (const dir of ['node_modules/lib', '.git', 'docs', '.hidden']) mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, 'node_modules/lib/README.md'), 'dependency readme about pangolins')
    writeFileSync(join(root, '.git/description.txt'), 'git internals about pangolins')
    writeFileSync(join(root, '.hidden/secret.txt'), 'hidden pangolins')
    writeFileSync(join(root, 'docs/~$draft.docx'), 'lock file')
    writeFileSync(join(root, 'docs/guide.md'), '# Guide\n\nAll about pangolins')
    duct = new Duct()
    await duct.index(root)
  })

  it('skips dependencies, version control, hidden folders and lock files', async () => {
    expect(duct.getDocuments().map(d => d.displayName)).toEqual(['guide.md'])
    expect(await duct.search('pangolins')).toHaveLength(1)
  })
})
