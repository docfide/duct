import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import type { ExtractedDocument, DocumentFormat } from '../types.js'
import { formatForPath } from '../formats.js'
import { ocrPdf } from '../ocr/index.js'
import { extractImage } from './image.js'
import { extractUrl } from './web.js'
import { UnsupportedFileError, decodeText, decodeXml, isZip, readPdf, type ExtractOptions } from './common.js'
import { extractDoc, extractOdp, extractOdt, extractRtf, isOle } from './office.js'
import { extractEpub, extractIwork, extractZip } from './packages.js'
import { extractEml, extractMsg } from './email.js'

export { UnsupportedFileError } from './common.js'
export type { ExtractOptions } from './common.js'

/** The document format for a path, from the registry in src/formats.ts ('txt' for anything unknown). */
export function detectFormat(path: string): DocumentFormat {
  return formatForPath(path)?.format ?? 'txt'
}

async function extractPdf(path: string): Promise<ExtractedDocument> {
  const buffer = readFileSync(path)
  const pages = await readPdf(buffer)
  return { path, format: 'pdf', content: pages.join('\n\n'), pages, metadata: { pages: pages.length, size: buffer.length } }
}

async function extractDocx(path: string): Promise<ExtractedDocument> {
  const buffer = readFileSync(path)
  // Renamed files are common: an old binary .doc or an RTF file saved with a .docx name.
  if (isOle(buffer) || buffer.subarray(0, 5).toString('latin1') === '{\\rtf') return { ...(await extractDoc(path)), format: 'docx' }
  if (!isZip(buffer)) throw new UnsupportedFileError('Not a Word document')
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ buffer })
  return { path, format: 'docx', content: result.value, metadata: { size: buffer.length, warnings: result.messages } }
}

async function extractMarkdown(path: string): Promise<ExtractedDocument> {
  const { marked } = await import('marked')
  const content = decodeText(readFileSync(path))
  const headings: { level: number; text: string }[] = []
  for (const token of marked.lexer(content)) {
    if (token.type === 'heading') {
      const t = token as { depth: number; text: string }
      headings.push({ level: t.depth, text: t.text })
    }
  }
  return { path, format: 'md', content, metadata: { headings, size: content.length } }
}

async function extractHtml(path: string): Promise<ExtractedDocument> {
  const cheerio = await import('cheerio')
  const content = decodeText(readFileSync(path))
  const $ = cheerio.load(content)
  $('script, style, nav, footer, header, noscript').remove()
  $('br').replaceWith('\n')
  $('p, div, h1, h2, h3, h4, h5, h6, li, tr, blockquote, section, article, pre').append('\n')
  const text = $('body').text().split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')
  return { path, format: 'html', content: text, metadata: { title: $('title').text() || null, size: content.length } }
}

/** Subtitles: keep the spoken lines, drop cue numbers and timestamps. */
function subtitleText(raw: string): string {
  return raw.split(/\r?\n/)
    .filter(line => !/^\d+$/.test(line.trim()) && !/-->/.test(line) && !/^WEBVTT/.test(line) && !/^(NOTE|STYLE|REGION)\b/.test(line))
    .map(line => line.replace(/<[^>]+>/g, '').trim())
    .filter(Boolean)
    .join('\n')
}

async function extractText(path: string): Promise<ExtractedDocument> {
  const raw = decodeText(readFileSync(path))
  const ext = extname(path).toLowerCase()
  const content = ext === '.srt' || ext === '.vtt' ? subtitleText(raw) : raw
  return { path, format: 'txt', content, metadata: { size: raw.length } }
}

async function extractCode(path: string): Promise<ExtractedDocument> {
  const content = decodeText(readFileSync(path))
  return { path, format: 'code', content, metadata: { size: content.length, language: extname(path).slice(1).toLowerCase() } }
}

/** Text drawn in an SVG (labels in diagrams and charts). */
async function extractSvg(path: string): Promise<ExtractedDocument> {
  const cheerio = await import('cheerio')
  const raw = decodeText(readFileSync(path))
  const $ = cheerio.load(raw, { xmlMode: true })
  const lines = $('text, title, desc').map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean)
  return { path, format: 'svg', content: lines.join('\n'), metadata: { size: raw.length } }
}

/** Excel (.xlsx, .xlsm, .xls, .xlsb) and OpenDocument spreadsheets; each sheet is a "page". */
async function extractSpreadsheet(path: string, format: DocumentFormat): Promise<ExtractedDocument> {
  const XLSX = (await import('xlsx')).default
  const workbook = XLSX.readFile(path, { cellDates: true })
  const sheets: string[] = []
  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, raw: false })
    const lines = rows.map(row => row.map(c => c == null ? '' : String(c)).join('\t')).filter(l => l.trim())
    sheets.push(lines.length ? [`Sheet: ${sheetName}`, ...lines].join('\n') : '')
  }
  return { path, format, content: sheets.filter(Boolean).join('\n\n'), pages: sheets, metadata: { sheets: workbook.SheetNames, size: statSync(path).size } }
}

function slideXmlText(xml: string): string {
  // Each <a:p> is a paragraph; text runs inside it are joined directly.
  return decodeXml(xml.replace(/<\/a:p>/g, '\n').replace(/<[^>]*>/g, ''))
    .split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')
}

async function extractPptx(path: string): Promise<ExtractedDocument> {
  const buffer = readFileSync(path)
  if (!isZip(buffer)) throw new UnsupportedFileError('Not a PowerPoint file')
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(buffer)
  const slideNumber = (f: string) => Number(f.match(/slide(\d+)\.xml$/)![1])
  const slideFiles = Object.keys(zip.files)
    .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => slideNumber(a) - slideNumber(b))
  const slides: string[] = []
  for (const file of slideFiles) {
    let text = slideXmlText(await zip.files[file].async('text'))
    // Speaker notes belong to their slide (the lone number is the slide-number placeholder).
    const notes = zip.file(`ppt/notesSlides/notesSlide${slideNumber(file)}.xml`)
    if (notes) {
      const noteText = slideXmlText(await notes.async('text')).split('\n').filter(l => !/^\d+$/.test(l)).join('\n')
      if (noteText) text += (text ? '\n' : '') + noteText
    }
    slides.push(text)
  }
  return { path, format: 'pptx', content: slides.filter(Boolean).join('\n\n'), pages: slides, metadata: { slides: slideFiles.length, size: buffer.length } }
}

async function extractPdfWithOcr(path: string, options: ExtractOptions): Promise<ExtractedDocument> {
  const doc = await extractPdf(path)
  const text = doc.content.trim()
  const pages = (doc.metadata.pages as number) || 1
  // Under ~25 characters per page means the PDF is mostly scanned images.
  if (text.length < 25 * pages) {
    if (!options.ocr) return { ...doc, metadata: { ...doc.metadata, needsOcr: true } }
    const ocrPages = await ocrPdf(path)
    const ocrText = ocrPages?.join('\n\n') ?? ''
    if (ocrPages && ocrText.length > text.length) {
      return { ...doc, content: ocrText, pages: ocrPages, metadata: { ...doc.metadata, ocr: true } }
    }
  }
  return doc
}

/**
 * Extracts the text of a file. Formats come from src/formats.ts; OCR (images, scans) only runs when
 * `options.ocr` is set, otherwise image-only files come back empty with `metadata.needsOcr`.
 */
export async function extract(path: string, options: ExtractOptions = {}): Promise<ExtractedDocument> {
  const format = detectFormat(path)
  switch (format) {
    case 'pdf': return extractPdfWithOcr(path, options)
    case 'docx': return extractDocx(path)
    case 'doc': return extractDoc(path)
    case 'odt': return extractOdt(path)
    case 'rtf': return extractRtf(path)
    case 'pages':
    case 'numbers':
    case 'key': return extractIwork(path, format, options)
    case 'md': return extractMarkdown(path)
    case 'html': return extractHtml(path)
    case 'epub': return extractEpub(path)
    case 'xlsx':
    case 'ods': return extractSpreadsheet(path, format)
    case 'pptx': return extractPptx(path)
    case 'odp': return extractOdp(path)
    case 'eml': return extractEml(path, options, extract)
    case 'msg': return extractMsg(path, options, extract)
    case 'code': return extractCode(path)
    case 'svg': return extractSvg(path)
    case 'zip': return extractZip(path, options, extract)
    case 'image':
      if (options.ocr) return extractImage(path)
      return { path, format: 'image', content: '', metadata: { size: statSync(path).size, needsOcr: true } }
    case 'url': return extractUrl(path)
    default: return extractText(path)
  }
}
