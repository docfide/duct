import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import type { ExtractedDocument, DocumentFormat, Extractor } from '../types.js'
import { IMAGE_EXTS, ocrPdf, isImageFile } from '../ocr/index.js'
import { extractImage } from './image.js'
import { extractUrl } from './web.js'
import { ensureDOMMatrix } from '../dommatrix.js'

export function detectFormat(path: string): DocumentFormat {
  if (isImageFile(path)) return 'image'
  const ext = extname(path).toLowerCase()
  switch (ext) {
    case '.pdf':
      return 'pdf'
    case '.docx':
      return 'docx'
    case '.md':
    case '.markdown':
      return 'md'
    case '.html':
    case '.htm':
      return 'html'
    case '.txt':
    case '.csv':
    case '.json':
    case '.log':
      return 'txt'
    case '.xml':
      return 'txt'
    case '.xlsx':
      return 'xlsx'
    case '.pptx':
      return 'pptx'
    default:
      return 'txt'
  }
}

interface PdfTextItem { str?: string; hasEOL?: boolean; transform?: number[]; width?: number }

/**
 * Rebuilds a page's text from pdf.js items: a change in baseline starts a new line (so headings and
 * paragraphs survive), and a space is only added where there is a visible gap between items.
 */
function pageText(items: PdfTextItem[]): string {
  let text = ''
  let lastY: number | undefined
  let lastEndX: number | undefined
  for (const item of items) {
    if (item.str === undefined) continue
    const [, , c = 0, d = 0, x, y] = item.transform ?? []
    const fontSize = Math.hypot(c, d) || 10
    const newLine = lastY !== undefined && y !== undefined && Math.abs(y - lastY) > fontSize * 0.5
    if (text && !text.endsWith('\n')) {
      if (newLine) text += '\n'
      else if (lastEndX !== undefined && x !== undefined && x - lastEndX > fontSize * 0.15 && !text.endsWith(' ') && !item.str.startsWith(' ')) text += ' '
    }
    text += item.str
    if (item.hasEOL) text += '\n'
    if (y !== undefined) lastY = y
    if (x !== undefined && item.width !== undefined) lastEndX = x + item.width
  }
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

async function extractPdf(path: string): Promise<ExtractedDocument> {
  await ensureDOMMatrix()
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const buffer = readFileSync(path)
  const data: Uint8Array = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const pdf = await getDocument({ data }).promise
  const textParts: string[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    textParts.push(pageText(content.items as PdfTextItem[]))
  }
  return {
    path,
    format: 'pdf',
    content: textParts.join('\n\n'),
    pages: textParts,
    metadata: { pages: pdf.numPages, size: buffer.length },
  }
}

async function extractDocx(path: string): Promise<ExtractedDocument> {
  const mammoth = await import('mammoth')
  const buffer = readFileSync(path)
  const result = await mammoth.extractRawText({ buffer })
  return {
    path,
    format: 'docx',
    content: result.value,
    metadata: { size: buffer.length, warnings: result.messages },
  }
}

async function extractMarkdown(path: string): Promise<ExtractedDocument> {
  const { marked } = await import('marked')
  const content = readFileSync(path, 'utf-8')
  const tokens = marked.lexer(content)
  const headings: { level: number; text: string }[] = []
  for (const token of tokens) {
    if (token.type === 'heading') {
      const t = token as { depth: number; text: string }
      headings.push({ level: t.depth, text: t.text })
    }
  }
  return {
    path,
    format: 'md',
    content,
    metadata: { headings, size: content.length },
  }
}

async function extractHtml(path: string): Promise<ExtractedDocument> {
  const cheerio = await import('cheerio')
  const content = readFileSync(path, 'utf-8')
  const $ = cheerio.load(content)
  $('script, style, nav, footer, header').remove()
  const text = $('body').text().replace(/\s+/g, ' ').trim()
  return {
    path,
    format: 'html',
    content: text,
    metadata: { title: $('title').text() || null, size: content.length },
  }
}

async function extractText(path: string): Promise<ExtractedDocument> {
  const content = readFileSync(path, 'utf-8')
  return {
    path,
    format: 'txt',
    content,
    metadata: { size: content.length },
  }
}

async function extractExcel(path: string): Promise<ExtractedDocument> {
  const XLSX = (await import('xlsx')).default
  const workbook = XLSX.readFile(path)
  const parts: string[] = []
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 })
    if (rows.length === 0) continue
    parts.push(`--- Sheet: ${sheetName} ---`)
    for (const row of rows) {
      const cells = row.map(c => c == null ? '' : String(c)).join('\t')
      if (cells.trim()) parts.push(cells)
    }
  }
  const content = parts.join('\n')
  return {
    path,
    format: 'xlsx',
    content,
    metadata: { sheets: workbook.SheetNames, size: content.length },
  }
}

function decodeXml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

async function extractPptx(path: string): Promise<ExtractedDocument> {
  const { default: JSZip } = await import('jszip')
  const buffer = readFileSync(path)
  const zip = await JSZip.loadAsync(buffer)
  const slideNumber = (f: string) => Number(f.match(/slide(\d+)\.xml$/)![1])
  const slideFiles = Object.keys(zip.files)
    .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => slideNumber(a) - slideNumber(b))
  const slides: string[] = []
  for (const file of slideFiles) {
    const xml = await zip.files[file].async('text')
    // Each <a:p> is a paragraph; text runs inside it are joined directly.
    const text = decodeXml(xml.replace(/<\/a:p>/g, '\n').replace(/<[^>]*>/g, ''))
      .split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')
    slides.push(text)
  }
  return {
    path,
    format: 'pptx',
    content: slides.filter(Boolean).join('\n\n'),
    pages: slides,
    metadata: { slides: slideFiles.length, size: buffer.length },
  }
}

const extractors: Record<DocumentFormat, Extractor> = {
  pdf: { extract: extractPdf },
  docx: { extract: extractDocx },
  md: { extract: extractMarkdown },
  html: { extract: extractHtml },
  txt: { extract: extractText },
  image: { extract: extractImage },
  url: { extract: extractUrl },
  xlsx: { extract: extractExcel },
  pptx: { extract: extractPptx },
}

export async function extract(path: string, options?: { ocr?: boolean }): Promise<ExtractedDocument> {
  const format = detectFormat(path)

  // OCR is slow, so it only runs when enabled; otherwise image-only files are flagged for OCR instead.
  if (format === 'image') {
    if (options?.ocr) return await extractImage(path)
    return { path, format: 'image', content: '', metadata: { size: statSync(path).size, needsOcr: true } }
  }

  const doc = await extractors[format].extract(path)

  if (format === 'pdf') {
    const text = doc.content.trim()
    const pages = (doc.metadata.pages as number) || 1
    // Under ~25 characters per page means the PDF is mostly scanned images.
    if (text.length < 25 * pages) {
      if (!options?.ocr) return { ...doc, metadata: { ...doc.metadata, needsOcr: true } }
      const ocrPages = await ocrPdf(path)
      const ocrText = ocrPages?.join('\n\n') ?? ''
      if (ocrPages && ocrText.length > text.length) {
        return { ...doc, content: ocrText, pages: ocrPages, metadata: { ...doc.metadata, ocr: true } }
      }
    }
  }

  return doc
}
