import { readFileSync } from 'node:fs'
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

async function extractPdf(path: string): Promise<ExtractedDocument> {
  await ensureDOMMatrix()
  const { getDocument } = await import('pdfjs-dist')
  const buffer = readFileSync(path)
  const data: Uint8Array = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const pdf = await getDocument({ data }).promise
  const textParts: string[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    const text = content.items.map((item: any) => item.str).join(' ')
    textParts.push(text)
  }
  return {
    path,
    format: 'pdf',
    content: textParts.join('\n\n'),
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

async function extractPptx(path: string): Promise<ExtractedDocument> {
  const { default: JSZip } = await import('jszip')
  const buffer = readFileSync(path)
  const zip = await JSZip.loadAsync(buffer)
  const slideFiles = Object.keys(zip.files)
    .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort()
  const parts: string[] = []
  for (const file of slideFiles) {
    const xml = await zip.files[file].async('text')
    const text = xml.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
    if (text) parts.push(text)
  }
  return {
    path,
    format: 'pptx',
    content: parts.join('\n\n'),
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

  if (format === 'image') {
    return await extractImage(path)
  }

  const doc = await extractors[format].extract(path)

  if (format === 'pdf' && options?.ocr) {
    const text = doc.content.trim()
    const pages = (doc.metadata.pages as number) || 1
    if (text.length < 50 && pages > 1) {
      const ocrText = await ocrPdf(path)
      if (ocrText && ocrText.length > text.length) {
        return { ...doc, content: ocrText, metadata: { ...doc.metadata, ocr: true } }
      }
    }
  }

  return doc
}
