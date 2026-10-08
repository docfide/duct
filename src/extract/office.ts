import { readFileSync } from 'node:fs'
import type { ExtractedDocument } from '../types.js'
import { UnsupportedFileError, decodeText, isZip } from './common.js'

// ---------- Word 97-2003 (.doc) ----------

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0]

export function isOle(buffer: Buffer): boolean {
  return OLE_MAGIC.every((b, i) => buffer[i] === b)
}

export async function extractDoc(path: string): Promise<ExtractedDocument> {
  const buffer = readFileSync(path)
  // Files are often misnamed: Word can save RTF with a .doc name, and .docx files get renamed to .doc.
  if (buffer.subarray(0, 5).toString('latin1') === '{\\rtf') return { ...(await extractRtf(path)), format: 'doc' }
  if (!isOle(buffer) && !isZip(buffer)) throw new UnsupportedFileError('Not a Word document')
  const { default: WordExtractor } = await import('word-extractor')
  const document = await new WordExtractor().extract(buffer)
  const parts = [
    document.getBody(),
    document.getTextboxes({ includeHeadersAndFooters: false, includeBody: true }),
    document.getFootnotes(),
    document.getEndnotes(),
    document.getAnnotations(),
  ].map(p => (p ?? '').trim()).filter(Boolean)
  return { path, format: 'doc', content: parts.join('\n\n'), metadata: { size: buffer.length } }
}

// ---------- OpenDocument (.odt, .odp) ----------

type CheerioRoot = ReturnType<typeof import('cheerio').load>

/** Text of an ODF element: spans flattened, <text:s> as spaces, tabs and line breaks kept. */
function odfText($: CheerioRoot, element: unknown): string {
  let out = ''
  $(element as never).contents().each((_, node) => {
    const n = node as { type: string; data?: string; name?: string; attribs?: Record<string, string> }
    if (n.type === 'text') out += n.data ?? ''
    else if (n.name === 'text:s') out += ' '.repeat(Number(n.attribs?.['text:c'] ?? 1) || 1)
    else if (n.name === 'text:tab') out += '\t'
    else if (n.name === 'text:line-break') out += '\n'
    else if (n.name === 'text:note-citation') return
    else out += odfText($, node)
  })
  return out
}

async function loadOdf(path: string): Promise<{ $: CheerioRoot; title?: string; size: number }> {
  const buffer = readFileSync(path)
  if (!isZip(buffer)) throw new UnsupportedFileError('Not an OpenDocument file')
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(buffer)
  const content = zip.file('content.xml')
  if (!content) throw new Error('content.xml is missing')
  const cheerio = await import('cheerio')
  const $ = cheerio.load(await content.async('text'), { xmlMode: true })
  const meta = zip.file('meta.xml')
  const title = meta ? cheerio.load(await meta.async('text'), { xmlMode: true })('dc\\:title').first().text().trim() : ''
  return { $, title: title || undefined, size: buffer.length }
}

/** Top-level paragraphs and headings inside `scope` (paragraphs nested in footnotes are part of their parent). */
function paragraphs($: CheerioRoot, scope: unknown): string[] {
  return $(scope as never).find('text\\:h, text\\:p')
    .filter((_, el) => $(el).parents('text\\:h, text\\:p').length === 0)
    .map((_, el) => odfText($, el).replace(/[ \t]+$/g, ''))
    .get()
    .filter(line => line.trim())
}

export async function extractOdt(path: string): Promise<ExtractedDocument> {
  const { $, title, size } = await loadOdf(path)
  const lines = paragraphs($, $('office\\:body'))
  return { path, format: 'odt', content: lines.join('\n'), metadata: { size, ...(title ? { title } : {}) } }
}

export async function extractOdp(path: string): Promise<ExtractedDocument> {
  const { $, title, size } = await loadOdf(path)
  // Each <draw:page> is a slide; its speaker notes are included with it.
  const slides = $('draw\\:page').map((_, page) => paragraphs($, page).join('\n')).get()
  return { path, format: 'odp', content: slides.filter(Boolean).join('\n\n'), pages: slides, metadata: { size, slides: slides.length, ...(title ? { title } : {}) } }
}

// ---------- Rich Text Format (.rtf) ----------

const CODEPAGES: Record<number, string> = {
  437: 'ibm866', 850: 'ibm866', 874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5',
  1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254',
  1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258', 10000: 'macintosh',
}

// Groups whose content is formatting data, not text.
const SKIP_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'listtable', 'listoverridetable', 'rsidtbl', 'generator',
  'xmlnstbl', 'themedata', 'colorschememapping', 'datastore', 'latentstyles', 'mmathPr', 'pgdsctbl', 'fldinst', 'filetbl',
  'revtbl', 'bkmkstart', 'bkmkend', 'shpinst', 'nonshppict', 'blipuid', 'xe', 'tc', 'private',
])

const SYMBOLS: Record<string, string> = {
  par: '\n', line: '\n', sect: '\n\n', page: '\n\n', row: '\n', tab: '\t', cell: '\t',
  emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', emspace: ' ', enspace: ' ',
}

/** Converts RTF to plain text: Unicode and code-page escapes decoded, formatting tables and pictures skipped. */
export function rtfToText(rtf: string): string {
  let out = ''
  let bytes: number[] = []
  let codepage = 'windows-1252'
  let state = { skip: false, uc: 1 }
  const stack: (typeof state)[] = []
  let pendingSkip = 0   // fallback characters to drop after a \uN escape

  const flushBytes = () => {
    if (!bytes.length) return
    if (!state.skip) {
      try { out += new TextDecoder(codepage).decode(new Uint8Array(bytes)) } catch { out += String.fromCharCode(...bytes) }
    }
    bytes = []
  }
  const emit = (text: string) => {
    flushBytes()
    if (!state.skip) out += text
  }

  let i = 0
  while (i < rtf.length) {
    const ch = rtf[i]
    if (ch === '{') {
      flushBytes(); stack.push(state); state = { ...state }; i++
      continue
    }
    if (ch === '}') {
      flushBytes(); state = stack.pop() ?? state; i++
      continue
    }
    if (ch === '\r' || ch === '\n') { i++; continue }
    if (ch !== '\\') {
      if (pendingSkip > 0) { pendingSkip--; i++; continue }
      emit(ch); i++
      continue
    }

    const next = rtf[i + 1]
    if (next === "'") {
      const byte = parseInt(rtf.substr(i + 2, 2), 16)
      i += 4
      if (pendingSkip > 0) { pendingSkip--; continue }
      if (!Number.isNaN(byte)) bytes.push(byte)
      continue
    }
    if (next === '\\' || next === '{' || next === '}') { emit(next); i += 2; continue }
    if (next === '~') { emit('\u00a0'); i += 2; continue }
    if (next === '_') { emit('-'); i += 2; continue }
    if (next === '-') { i += 2; continue }
    if (next === '*') { flushBytes(); state.skip = true; i += 2; continue }
    if (next === '\n' || next === '\r') { emit('\n'); i += 2; continue }

    const match = /^([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i + 1, i + 40))
    if (!match) { i += 2; continue }
    const [whole, word, param] = match
    i += 1 + whole.length
    const value = param === undefined ? undefined : Number(param)

    if (word === 'u' && value !== undefined) {
      emit(String.fromCharCode(value < 0 ? value + 65536 : value))
      pendingSkip = state.uc
    } else if (word === 'uc' && value !== undefined) {
      state.uc = value
    } else if (word === 'ansicpg' && value !== undefined) {
      codepage = CODEPAGES[value] ?? codepage
    } else if (SKIP_DESTINATIONS.has(word)) {
      flushBytes()
      state.skip = true
    } else if (word === 'bin' && value !== undefined) {
      i += value   // raw binary data
    } else if (SYMBOLS[word] !== undefined) {
      emit(SYMBOLS[word])
    }
  }
  flushBytes()
  return out.replace(/[ \t\u00a0]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export async function extractRtf(path: string): Promise<ExtractedDocument> {
  const buffer = readFileSync(path)
  const raw = decodeText(buffer)
  if (!raw.startsWith('{\\rtf')) throw new UnsupportedFileError('Not an RTF document')
  return { path, format: 'rtf', content: rtfToText(raw), metadata: { size: buffer.length } }
}
