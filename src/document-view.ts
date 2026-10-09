// How the workspace shows a document that isn't a PDF, as close to the original as this computer allows:
//
//   1. Documents and presentations (Word, OpenDocument, RTF, PowerPoint, Keynote) are turned into a PDF by LibreOffice,
//      when it's installed, and shown with the PDF viewer: the pages as they look, with find and highlights.
//   2. Otherwise each format is drawn from its own structure: Word with its headings, lists, tables and pictures;
//      spreadsheets as tables, a sheet at a time; Markdown formatted; emails with their headers and body.
//   3. Anything else is shown as the text Duct read (the workspace's text view).
//
// Everything happens on this computer. HTML that comes from a document is cleaned to an allowlist of tags and
// attributes before it reaches the page: no scripts, styles, event handlers, links that navigate, or images other
// than ones embedded in the file (an email's remote images are never fetched; they'd tell the sender it was opened).

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { basename, extname, join } from 'node:path'

export type DocumentView =
  | { kind: 'pdf'; via: 'libreoffice' }
  | { kind: 'html'; via: 'word' | 'sheet' | 'markdown' | 'email' | 'html'; html: string; sections?: { title: string; page: number }[] }
  | { kind: 'text' }

/** Formats LibreOffice turns into faithful pages. Spreadsheets aren't here: as PDFs they're cut into pages. */
export const LIBREOFFICE_FORMATS = new Set(['.doc', '.docx', '.docm', '.dot', '.dotx', '.odt', '.ott', '.rtf', '.wpd', '.ppt', '.pptx', '.pps', '.ppsx', '.odp', '.key', '.pages'])
const SHEET_FORMATS = new Set(['.xlsx', '.xlsm', '.xls', '.xlsb', '.ods', '.csv', '.tsv'])
const MAX_ROWS = 2000
const MAX_COLS = 60

// ---------------------------------------------------------------- LibreOffice

let sofficePath: string | null | undefined

/** Where LibreOffice is installed, if it is (looked up once). DUCT_SOFFICE overrides; DUCT_SOFFICE=off disables. */
export function findLibreOffice(): string | null {
  if (sofficePath !== undefined) return sofficePath
  const configured = process.env['DUCT_SOFFICE']
  if (configured === 'off') return (sofficePath = null)
  const candidates = [
    configured,
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    '/usr/bin/soffice', '/usr/bin/libreoffice', '/usr/local/bin/soffice', '/opt/homebrew/bin/soffice', '/snap/bin/libreoffice',
    '/usr/lib/libreoffice/program/soffice', '/opt/libreoffice/program/soffice',
  ]
  return (sofficePath = candidates.find((p): p is string => !!p && existsSync(p)) ?? null)
}

/** For tests. */
export function resetLibreOfficeLookup(): void { sofficePath = undefined }

const converting = new Map<string, Promise<string>>()

/**
 * The document as a PDF made by LibreOffice, cached by the file's path, size and modification time so it's converted
 * once. Each conversion uses its own LibreOffice profile, so it works while LibreOffice is open, and runs headless
 * with a time limit.
 */
export function convertToPdf(path: string, cacheDir: string, timeoutMs = 120_000): Promise<string> {
  const soffice = findLibreOffice()
  if (!soffice) return Promise.reject(new Error('LibreOffice isn’t installed'))
  const st = statSync(path)
  const key = createHash('sha256').update(`${path}\0${st.size}\0${st.mtimeMs}`).digest('hex').slice(0, 32)
  const out = join(cacheDir, `${key}.pdf`)
  if (existsSync(out)) return Promise.resolve(out)
  const running = converting.get(key)
  if (running) return running
  const job = new Promise<string>((resolve, reject) => {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
    const work = join(cacheDir, `${key}.work`)
    rmSync(work, { recursive: true, force: true })
    mkdirSync(work, { recursive: true, mode: 0o700 })
    const profile = 'file://' + join(work, 'profile').replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')
    execFile(soffice, [`-env:UserInstallation=${profile}`, '--headless', '--norestore', '--nologo', '--convert-to', 'pdf', '--outdir', work, path],
      { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
        const made = join(work, basename(path, extname(path)) + '.pdf')
        if (!err && existsSync(made)) { renameSync(made, out); rmSync(work, { recursive: true, force: true }); resolve(out); return }
        rmSync(work, { recursive: true, force: true })
        const said = `${stderr || ''} ${stdout || ''}`.replace(/\s+/g, ' ').trim().slice(0, 300)
        reject(new Error(err?.killed ? 'LibreOffice took too long to open this document' : `LibreOffice couldn’t open this document${said ? ` (${said})` : ''}`))
      })
  }).finally(() => converting.delete(key))
  converting.set(key, job)
  return job
}

/** A private cache folder for converted documents: in Duct's data folder, or a per-user temporary one. */
export function viewCacheDir(dataDir: string | undefined): string {
  return dataDir ? join(dataDir, 'view-cache') : join(tmpdir(), `duct-view-cache-${userInfo().uid >= 0 ? userInfo().uid : 'user'}`)
}

// ---------------------------------------------------------------- HTML, cleaned

const ALLOWED: Record<string, string[]> = {
  p: [], br: [], hr: [], div: [], span: [], blockquote: [], pre: [], code: [],
  h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
  strong: [], b: [], em: [], i: [], u: [], s: [], sub: [], sup: [], small: [], mark: [],
  ul: [], ol: ['start'], li: [], dl: [], dt: [], dd: [],
  table: [], thead: [], tbody: [], tfoot: [], tr: [], th: ['colspan', 'rowspan', 'scope'], td: ['colspan', 'rowspan'], caption: [],
  img: ['src', 'alt', 'width', 'height'], figure: [], figcaption: [], a: [], section: [], article: [], header: [], footer: [],
}
/** Removed with everything inside them; any other unknown tag is replaced by its contents. */
const DROP = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button', 'select', 'textarea', 'option', 'link', 'meta', 'base', 'title', 'head', 'svg', 'math', 'video', 'audio', 'source', 'track', 'canvas', 'dialog', 'portal'])
/** Duct's own markup: classes the workspace styles, and data-page on sheets (any element may carry these). */
const OWN_CLASSES = new Set(['sheet', 'sheet-name', 'note', 'mail-head', 'mail-body', 'img-missing', 'link'])
const SAFE_IMAGE = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]+$/i

/** Keeps only allowlisted tags and attributes. Images only if embedded; links become plain text in a link style. */
export async function cleanHtml(html: string): Promise<string> {
  const cheerio = await import('cheerio')
  const $ = cheerio.load(html, null, false)
  $('*').each((_, node) => {
    const el = node as unknown as { tagName?: string; attribs?: Record<string, string> }
    if (!el.tagName) return
    const tag = el.tagName.toLowerCase()
    const $el = $(node)
    if (DROP.has(tag)) { $el.remove(); return }
    const allowed = ALLOWED[tag]
    if (!allowed) { $el.replaceWith($el.contents()); return }
    for (const name of Object.keys(el.attribs ?? {})) {
      const value = el.attribs![name] ?? ''
      if (name === 'class') { const own = value.split(/\s+/).filter(c => OWN_CLASSES.has(c)); if (own.length) { $el.attr('class', own.join(' ')); continue } }
      if (name === 'data-page' && /^\d{1,5}$/.test(value)) continue
      const keep = allowed.includes(name) && (
        name === 'src' ? SAFE_IMAGE.test(value)
          : ['colspan', 'rowspan', 'start', 'width', 'height'].includes(name) ? /^\d{1,4}$/.test(value)
            : name === 'scope' ? /^(row|col|rowgroup|colgroup)$/.test(value) : true)
      if (!keep) $el.removeAttr(name)
    }
    if (tag === 'img' && !$el.attr('src')) { $el.replaceWith($el.attr('alt') ? `<span class="img-missing">[${escapeHtml($el.attr('alt')!)}]</span>` : ''); return }
    if (tag === 'a') $el.attr('class', 'link')
  })
  // Comments can hide conditional markup; nothing in them is needed.
  const dropComments = (nodes: { type: string; children?: unknown[] }[]) => {
    for (const n of [...nodes]) {
      if (n.type === 'comment') $(n as never).remove()
      else if (n.children) dropComments(n.children as never)
    }
  }
  dropComments($.root()[0]!.children as never)
  return $.html()
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------- each format, drawn from its structure

async function wordHtml(path: string): Promise<string> {
  const mammoth = await import('mammoth')
  const result = await mammoth.convertToHtml({ path }, {
    convertImage: mammoth.images.imgElement(async image => ({ src: `data:${image.contentType};base64,${await image.read('base64')}` })),
  })
  return result.value
}

async function sheetHtml(path: string): Promise<{ html: string; sections: { title: string; page: number }[] }> {
  const XLSX = await import('xlsx')
  const workbook = XLSX.read(readFileSync(path), { type: 'buffer', cellDates: true })
  const sections: { title: string; page: number }[] = []
  const parts: string[] = []
  workbook.SheetNames.forEach((name, i) => {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name]!, { header: 1, raw: false, blankrows: false })
    const shown = rows.slice(0, MAX_ROWS)
    const cols = Math.min(MAX_COLS, Math.max(0, ...shown.map(r => r.length)))
    const cell = (v: unknown) => escapeHtml(v == null ? '' : String(v))
    const body = shown.map((r, ri) => '<tr>' + Array.from({ length: cols }, (_, c) => (ri === 0 ? `<th scope="col">${cell(r[c])}</th>` : `<td>${cell(r[c])}</td>`)).join('') + '</tr>').join('')
    const more = rows.length > MAX_ROWS ? `<p class="note">Showing the first ${MAX_ROWS.toLocaleString('en')} of ${rows.length.toLocaleString('en')} rows. Open it in its app to see the rest.</p>` : ''
    sections.push({ title: name, page: i + 1 })
    parts.push(`<section data-page="${i + 1}"><h2 class="sheet-name">${escapeHtml(name)}</h2>${shown.length ? `<div class="sheet"><table>${body}</table></div>` : '<p class="note">This sheet is empty.</p>'}${more}</section>`)
  })
  return { html: parts.join(''), sections }
}

async function markdownHtml(path: string): Promise<string> {
  const { marked } = await import('marked')
  return marked.parse(readFileSync(path, 'utf8'), { async: false, gfm: true }) as string
}

async function emailHtml(path: string, ext: string): Promise<string> {
  const head = (rows: [string, string | undefined][]) => '<dl class="mail-head">' + rows.filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v!)}</dd>`).join('') + '</dl>'
  const textBody = (t: string) => t.split(/\n{2,}/).map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('')
  if (ext === '.eml') {
    const { default: PostalMime } = await import('postal-mime')
    const mail = await PostalMime.parse(readFileSync(path))
    const who = (a?: { name?: string; address?: string } | null) => !a ? undefined : a.name && a.address ? `${a.name} <${a.address}>` : a.name || a.address
    const list = (as?: { name?: string; address?: string }[]) => as?.map(who).filter(Boolean).join(', ')
    const files = (mail.attachments ?? []).map(a => a.filename).filter(Boolean).join(', ')
    return head([['Subject', mail.subject], ['From', who(mail.from as never)], ['To', list(mail.to as never)], ['Cc', list(mail.cc as never)], ['Date', readableDate(mail.date)], ['Attachments', files]]) +
      '<div class="mail-body">' + (mail.html ? mail.html : textBody(mail.text ?? '')) + '</div>'
  }
  const mod = await import('@kenjiuno/msgreader') as unknown as { default: { default?: unknown } }
  const MsgReader = ('default' in mod.default ? mod.default.default : mod.default) as new (b: ArrayBuffer) => { getFileData(): Record<string, unknown> }
  const buffer = readFileSync(path)
  const data = new MsgReader(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer).getFileData() as {
    subject?: string; senderName?: string; senderEmail?: string; body?: string; bodyHtml?: string; messageDeliveryTime?: string
    recipients?: { name?: string; email?: string }[]; attachments?: { fileName?: string }[]
  }
  const to = (data.recipients ?? []).map(r => [r.name, r.email ? `<${r.email}>` : ''].filter(Boolean).join(' ')).join(', ')
  return head([['Subject', data.subject], ['From', [data.senderName, data.senderEmail ? `<${data.senderEmail}>` : ''].filter(Boolean).join(' ')], ['To', to],
    ['Date', readableDate(data.messageDeliveryTime)], ['Attachments', (data.attachments ?? []).map(a => a.fileName).filter(Boolean).join(', ')]]) +
    '<div class="mail-body">' + (data.bodyHtml ? data.bodyHtml : textBody(data.body ?? '')) + '</div>'
}

/** "2 March 2026, 08:00 UTC" from an email's date, or the date as written if it can't be read. */
function readableDate(value: string | undefined): string | undefined {
  if (!value) return undefined
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'
}

/** How to show this file (path must be an indexed document; callers check). */
export async function documentView(path: string, options: { libreOffice?: boolean } = {}): Promise<DocumentView> {
  const ext = extname(path).toLowerCase()
  if (LIBREOFFICE_FORMATS.has(ext) && options.libreOffice !== false && findLibreOffice()) return { kind: 'pdf', via: 'libreoffice' }
  if (ext === '.docx' || ext === '.docm') return { kind: 'html', via: 'word', html: await cleanHtml(await wordHtml(path)) }
  if (SHEET_FORMATS.has(ext)) { const s = await sheetHtml(path); return { kind: 'html', via: 'sheet', html: await cleanHtml(s.html), sections: s.sections } }
  if (ext === '.md' || ext === '.markdown') return { kind: 'html', via: 'markdown', html: await cleanHtml(await markdownHtml(path)) }
  if (ext === '.eml' || ext === '.msg') return { kind: 'html', via: 'email', html: await cleanHtml(await emailHtml(path, ext)) }
  if (ext === '.html' || ext === '.htm') return { kind: 'html', via: 'html', html: await cleanHtml(readFileSync(path, 'utf8')) }
  return { kind: 'text' }
}
