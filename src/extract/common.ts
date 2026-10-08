import { ensureDOMMatrix } from '../dommatrix.js'

/**
 * The file has a supported extension but isn't that kind of file (e.g. a PEM private key named "server.key",
 * which is not a Keynote deck). The indexer skips these quietly instead of reporting them as failures.
 */
export class UnsupportedFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedFileError'
  }
}

export interface ExtractOptions {
  ocr?: boolean
  /** How deep we are inside containers (emails, ZIPs); nested containers stop at MAX_DEPTH. */
  depth?: number
}

export const MAX_DEPTH = 2

/**
 * Decodes text files written in UTF-8, UTF-16 (with a byte-order mark) or, failing that, Windows-1252,
 * which covers most "this file looks like gibberish" cases from older Windows software.
 */
export function decodeText(buffer: Buffer): string {
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.subarray(3).toString('utf-8')
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer.subarray(2))
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer.subarray(2))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return new TextDecoder('windows-1252').decode(buffer)
  }
}

export function decodeXml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

export function isZip(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)
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

/** Text of every page of a PDF held in memory. */
export async function readPdf(buffer: Buffer): Promise<string[]> {
  await ensureDOMMatrix()
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // pdf.js takes ownership of the bytes it is given, so pass a copy.
  const data = new Uint8Array(buffer)
  const pdf = await getDocument({ data, verbosity: 0 }).promise
  try {
    const pages: string[] = []
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i)
      pages.push(pageText((await page.getTextContent()).items as PdfTextItem[]))
      page.cleanup()
    }
    return pages
  } finally {
    await pdf.destroy()
  }
}
