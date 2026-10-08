import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, posix } from 'node:path'
import type { DocumentFormat, ExtractedDocument } from '../types.js'
import { isSupportedFile } from '../formats.js'
import { MAX_DEPTH, UnsupportedFileError, isZip, readPdf, type ExtractOptions } from './common.js'

export type ExtractFile = (path: string, options: ExtractOptions) => Promise<ExtractedDocument>

const MAX_ENTRY_BYTES = 100 * 1024 * 1024
const MAX_TOTAL_BYTES = 300 * 1024 * 1024
const MAX_ENTRIES = 500

/**
 * Extracts a file held in memory (an attachment, a ZIP entry) by writing it to a temporary folder and
 * running the normal extractor on it. Returns null when it can't be read.
 */
export async function extractEmbedded(name: string, bytes: Uint8Array, options: ExtractOptions, extractFile: ExtractFile): Promise<string | null> {
  if ((options.depth ?? 0) >= MAX_DEPTH || !isSupportedFile(name) || bytes.length > MAX_ENTRY_BYTES) return null
  const dir = mkdtempSync(join(tmpdir(), 'duct-embedded-'))
  try {
    const file = join(dir, basename(name).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_') || 'file')
    writeFileSync(file, bytes)
    const doc = await extractFile(file, { ...options, depth: (options.depth ?? 0) + 1 })
    return doc.content.trim() || null
  } catch {
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------- ZIP archives ----------

export async function extractZip(path: string, options: ExtractOptions, extractFile: ExtractFile): Promise<ExtractedDocument> {
  const buffer = readFileSync(path)
  if (!isZip(buffer)) throw new UnsupportedFileError('Not a ZIP archive')
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(buffer)
  const entries = Object.values(zip.files)
    .filter(e => !e.dir && !e.name.startsWith('__MACOSX/') && isSupportedFile(e.name))
    .slice(0, MAX_ENTRIES)
  const sections: { title: string; text: string }[] = []
  const skipped: string[] = []
  let total = 0
  for (const entry of entries) {
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
    // Guard against "zip bombs": stop reading once the archive expands past the limit.
    if (size > MAX_ENTRY_BYTES || total + size > MAX_TOTAL_BYTES) { skipped.push(entry.name); continue }
    const bytes = await entry.async('uint8array')
    total += bytes.length
    const text = await extractEmbedded(entry.name, bytes, options, extractFile)
    if (text) sections.push({ title: entry.name, text })
    else skipped.push(entry.name)
  }
  return {
    path,
    format: 'zip',
    content: sections.map(s => `${s.title}\n${s.text}`).join('\n\n'),
    sections,
    metadata: { size: buffer.length, files: sections.map(s => s.title), skipped },
  }
}

// ---------- EPUB e-books ----------

export async function extractEpub(path: string): Promise<ExtractedDocument> {
  const buffer = readFileSync(path)
  if (!isZip(buffer)) throw new UnsupportedFileError('Not an EPUB book')
  const { default: JSZip } = await import('jszip')
  const cheerio = await import('cheerio')
  const zip = await JSZip.loadAsync(buffer)
  const encryption = zip.file('META-INF/encryption.xml')
  if (encryption && /EncryptedData/.test(await encryption.async('text'))) throw new Error('This EPUB is DRM-protected')

  const container = zip.file('META-INF/container.xml')
  if (!container) throw new Error('META-INF/container.xml is missing')
  const opfPath = cheerio.load(await container.async('text'), { xmlMode: true })('rootfile').attr('full-path')
  const opfFile = opfPath ? zip.file(opfPath) : null
  if (!opfPath || !opfFile) throw new Error('The book has no package file')
  const opf = cheerio.load(await opfFile.async('text'), { xmlMode: true })
  const base = posix.dirname(opfPath)
  const hrefs = new Map<string, string>()
  opf('manifest > item').each((_, el) => { hrefs.set(opf(el).attr('id') ?? '', opf(el).attr('href') ?? '') })
  const title = opf('dc\\:title, title').first().text().trim()

  // Chapters in reading order (the spine), each one a "page".
  const chapters: string[] = []
  for (const ref of opf('spine > itemref').map((_, el) => opf(el).attr('idref')).get()) {
    const href = hrefs.get(ref)
    const file = href ? zip.file(posix.normalize(posix.join(base, decodeURIComponent(href)))) : null
    if (!file) continue
    const $ = cheerio.load(await file.async('text'))
    $('script, style').remove()
    $('br').replaceWith('\n')
    $('p, div, h1, h2, h3, h4, h5, h6, li, tr, blockquote, section, pre').append('\n')
    const text = $('body').text().split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')
    if (text) chapters.push(text)
  }
  return { path, format: 'epub', content: chapters.join('\n\n'), pages: chapters, metadata: { size: buffer.length, chapters: chapters.length, ...(title ? { title } : {}) } }
}

// ---------- Apple iWork (.pages, .numbers, .key) ----------

/** Snappy (raw block format) decompression, as used inside iWork's .iwa files. */
export function snappyDecompress(src: Uint8Array): Uint8Array {
  let pos = 0
  let length = 0
  for (let shift = 0; ; shift += 7) {
    const b = src[pos++]
    length += (b & 0x7f) * 2 ** shift
    if (!(b & 0x80)) break
  }
  const out = new Uint8Array(length)
  let op = 0
  while (pos < src.length && op < length) {
    const tag = src[pos++]
    const type = tag & 3
    if (type === 0) {
      let len = tag >> 2
      if (len >= 60) {
        const n = len - 59
        len = 0
        for (let i = 0; i < n; i++) len |= src[pos++] << (8 * i)
      }
      len += 1
      out.set(src.subarray(pos, pos + len), op)
      pos += len
      op += len
      continue
    }
    let len: number
    let offset: number
    if (type === 1) { len = ((tag >> 2) & 7) + 4; offset = ((tag >> 5) << 8) | src[pos++] }
    else if (type === 2) { len = (tag >> 2) + 1; offset = src[pos] | (src[pos + 1] << 8); pos += 2 }
    else { len = (tag >> 2) + 1; offset = (src[pos] | (src[pos + 1] << 8) | (src[pos + 2] << 16) | (src[pos + 3] << 24)) >>> 0; pos += 4 }
    if (offset === 0 || offset > op) throw new Error('Corrupt snappy data')
    for (let i = 0; i < len && op < length; i++, op++) out[op] = out[op - offset]
  }
  return out
}

function varint(buf: Uint8Array, pos: number): [number, number] {
  let value = 0
  for (let shift = 0; pos < buf.length; shift += 7) {
    const b = buf[pos++]
    value += (b & 0x7f) * 2 ** shift
    if (!(b & 0x80)) break
  }
  return [value, pos]
}

type ProtoField = { field: number; wire: number; value: number; bytes?: Uint8Array }

/** Reads the fields of one protobuf message (no schema needed). */
function* protoFields(buf: Uint8Array): Generator<ProtoField> {
  let pos = 0
  while (pos < buf.length) {
    const [key, p1] = varint(buf, pos)
    const field = Math.floor(key / 8)
    const wire = key & 7
    if (wire === 0) { const [v, p2] = varint(buf, p1); pos = p2; yield { field, wire, value: v } }
    else if (wire === 2) { const [len, p2] = varint(buf, p1); pos = p2 + len; yield { field, wire, value: len, bytes: buf.subarray(p2, p2 + len) } }
    else if (wire === 1) pos = p1 + 8
    else if (wire === 5) pos = p1 + 4
    else return
  }
}

/** The (type, payload) messages stored in one .iwa file. */
export function iwaMessages(file: Uint8Array): { type: number; payload: Uint8Array }[] {
  // An .iwa file is a series of chunks: 0x00, a 3-byte little-endian length, then a snappy block.
  const parts: Uint8Array[] = []
  for (let pos = 0; pos + 4 <= file.length;) {
    const length = file[pos + 1] | (file[pos + 2] << 8) | (file[pos + 3] << 16)
    parts.push(snappyDecompress(file.subarray(pos + 4, pos + 4 + length)))
    pos += 4 + length
  }
  const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { data.set(p, o); o += p.length }

  const messages: { type: number; payload: Uint8Array }[] = []
  for (let pos = 0; pos < data.length;) {
    const [infoLength, p1] = varint(data, pos)
    const info = data.subarray(p1, p1 + infoLength)
    pos = p1 + infoLength
    for (const f of protoFields(info)) {
      if (f.field !== 2 || !f.bytes) continue   // ArchiveInfo.message_infos
      let type = 0
      let length = 0
      for (const g of protoFields(f.bytes)) {
        if (g.field === 1) type = g.value       // MessageInfo.type
        if (g.field === 3) length = g.value     // MessageInfo.length
      }
      messages.push({ type, payload: data.subarray(pos, pos + length) })
      pos += length
    }
  }
  return messages
}

const utf8 = new TextDecoder('utf-8')
const TEXT_STORAGE_TYPES = new Set([2001, 2005])   // TSWP.StorageArchive: body text, text boxes, notes
const TABLE_STRINGS_TYPE = 6005                    // TST.TableDataList: Numbers cell strings

/** Text from the messages of an .iwa file: text storages, plus table cell strings. */
export function iwaText(file: Uint8Array): string[] {
  const out: string[] = []
  for (const { type, payload } of iwaMessages(file)) {
    if (TEXT_STORAGE_TYPES.has(type)) {
      const text = [...protoFields(payload)].filter(f => f.field === 3 && f.bytes).map(f => utf8.decode(f.bytes!)).join('')
      if (text.trim()) out.push(text)
    } else if (type === TABLE_STRINGS_TYPE) {
      for (const entry of protoFields(payload)) {
        if (entry.field !== 3 || !entry.bytes) continue
        for (const g of protoFields(entry.bytes)) if (g.field === 3 && g.bytes) out.push(utf8.decode(g.bytes))
      }
    }
  }
  // Object placeholders and Apple's paragraph/line separators.
  return out.map(t => t.replace(/\ufffc/g, '').replace(/[\u2028\u2029\u000b]/g, '\n').replace(/[\u0000-\u0008\u000e-\u001f]/g, '').trim()).filter(Boolean)
}

// Template and style parts hold placeholder text ("Title Text"), not the document's content.
const IWA_SKIP = /Stylesheet|TemplateSlide|ViewState|Metadata|AnnotationAuthor|CalculationEngine/i

/** A package's files, whether it is a .zip (modern iWork) or a folder on disk (older versions). */
async function readPackage(path: string): Promise<Map<string, () => Promise<Uint8Array>>> {
  const files = new Map<string, () => Promise<Uint8Array>>()
  if (statSync(path).isDirectory()) {
    const { readdirSync } = await import('node:fs')
    for (const entry of readdirSync(path, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const full = join(entry.parentPath, entry.name)
      files.set(full.slice(path.length + 1).split('\\').join('/'), async () => readFileSync(full))
    }
    return files
  }
  const buffer = readFileSync(path)
  if (!isZip(buffer)) throw new UnsupportedFileError('Not an iWork document')
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(buffer)
  for (const entry of Object.values(zip.files)) if (!entry.dir) files.set(entry.name, () => entry.async('uint8array'))
  return files
}

export async function extractIwork(path: string, format: DocumentFormat, options: ExtractOptions): Promise<ExtractedDocument> {
  const files = await readPackage(path)
  const size = statSync(path).isDirectory() ? 0 : statSync(path).size

  // 1. Modern format (2013+): text from the .iwa archives.
  const iwa = [...files.keys()].filter(n => n.startsWith('Index/') && n.endsWith('.iwa') && !IWA_SKIP.test(n)).sort()
  const texts: string[] = []
  for (const name of iwa) {
    try { texts.push(...iwaText(await files.get(name)!())) } catch {}
  }
  if (texts.length) {
    return { path, format, content: texts.join('\n\n'), metadata: { size, source: 'iwa' } }
  }

  // 2. iWork '09 and documents saved with a preview: the QuickLook PDF.
  const preview = files.get('QuickLook/Preview.pdf')
  if (preview) {
    const pages = await readPdf(Buffer.from(await preview()))
    return { path, format, content: pages.join('\n\n'), pages, metadata: { size, source: 'preview' } }
  }

  // 3. Only a thumbnail image: read it with OCR when that's on, otherwise flag it.
  const thumb = files.get('preview.jpg') ?? files.get('QuickLook/Thumbnail.jpg')
  if (thumb && options.ocr) {
    const { ocrBuffer } = await import('../ocr/index.js')
    return { path, format, content: await ocrBuffer(Buffer.from(await thumb())), metadata: { size, source: 'thumbnail', ocr: true } }
  }
  return { path, format, content: '', metadata: { size, needsOcr: !!thumb } }
}

/** True for iWork packages saved as folders (they should be indexed as one document, not walked into). */
export function isPackageFolder(path: string): boolean {
  return ['Index', 'Index.zip', 'QuickLook', 'index.xml.gz', 'index.apxl.gz'].some(name => existsSync(join(path, name)))
}
