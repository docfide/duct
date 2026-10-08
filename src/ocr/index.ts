import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { IMAGE_EXTENSIONS } from '../formats.js'
import type Tesseract from 'tesseract.js'
import { ensureDOMMatrix } from '../dommatrix.js'

export const IMAGE_EXTS = IMAGE_EXTENSIONS

const IDLE_MS = 60_000

export function isImageFile(path: string): boolean {
  return IMAGE_EXTS.has(extname(path).toLowerCase())
}

/** The bundled English model (assets/ocr/eng.traineddata), so OCR never downloads anything. */
function langPath(): string {
  const dir = fileURLToPath(new URL('../../assets/ocr', import.meta.url))
  // Inside a packaged Electron app the model is unpacked next to app.asar so the OCR worker can read it.
  const unpacked = dir.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  return existsSync(unpacked) ? unpacked : dir
}

let worker: Promise<Tesseract.Worker> | null = null
let idleTimer: NodeJS.Timeout | null = null
let queue: Promise<unknown> = Promise.resolve()

/** One shared worker, created on first use and closed after a minute without OCR work. */
async function recognize(image: Buffer): Promise<string> {
  const run = queue.then(async () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    if (!worker) {
      const { createWorker } = (await import('tesseract.js')).default
      worker = createWorker('eng', 1, { langPath: langPath(), gzip: false, cacheMethod: 'none', logger: () => {} })
    }
    const { data } = await (await worker).recognize(image)
    return data.text
  })
  queue = run.catch(() => {}).then(() => {
    idleTimer = setTimeout(() => { terminateOcr() }, IDLE_MS)
    idleTimer.unref()
  })
  return run
}

/** Stops the shared OCR worker (called when Duct closes). */
export async function terminateOcr(): Promise<void> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  const current = worker
  worker = null
  if (current) await (await current).terminate()
}

async function prepare(input: string | Buffer): Promise<Buffer> {
  const sharp = (await import('sharp')).default
  return sharp(input).grayscale().normalize().median(1).toBuffer()
}

/**
 * iPhone photos (HEIC) use a codec sharp's bundled libvips can't decode. macOS converts them with its
 * built-in `sips`; elsewhere the optional heic-decode package (libheif, LGPL) is used if installed.
 */
async function decodeImage(imagePath: string): Promise<string | Buffer> {
  const ext = extname(imagePath).toLowerCase()
  if (ext !== '.heic' && ext !== '.heif') return imagePath
  if (process.platform === 'darwin') {
    const dir = mkdtempSync(join(tmpdir(), 'duct-heic-'))
    try {
      const out = join(dir, 'image.png')
      await promisify(execFile)('sips', ['-s', 'format', 'png', imagePath, '--out', out])
      return readFileSync(out)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  let decode: (input: { buffer: Uint8Array }) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>
  try {
    decode = (await import('heic-decode')).default
  } catch {
    throw new Error('Reading HEIC images needs the optional heic-decode package on this system')
  }
  const { width, height, data } = await decode({ buffer: readFileSync(imagePath) })
  const sharp = (await import('sharp')).default
  return sharp(Buffer.from(data), { raw: { width, height, channels: 4 } }).png().toBuffer()
}

export async function ocrImage(imagePath: string): Promise<string> {
  return (await recognize(await prepare(await decodeImage(imagePath)))).trim()
}

/** OCR for an image already in memory (e.g. an iWork document's preview). */
export async function ocrBuffer(image: Buffer): Promise<string> {
  return (await recognize(await prepare(image))).trim()
}

/** OCRs each page of a PDF; returns the text per page, or null if rendering isn't available. */
export async function ocrPdf(pdfPath: string): Promise<string[] | null> {
  let pdfjsLib: typeof import('pdfjs-dist/legacy/build/pdf.mjs')
  try {
    await ensureDOMMatrix()
    pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')
  } catch {
    return null
  }

  const buffer = readFileSync(pdfPath)
  const data: Uint8Array = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const task = pdfjsLib.getDocument({ data, verbosity: 0 })
  const pdf = await task.promise
  // pdf.js renders in Node through its own canvas factory (backed by @napi-rs/canvas).
  const factory = (pdf as unknown as { canvasFactory: PdfCanvasFactory }).canvasFactory

  const pages: string[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const viewport = page.getViewport({ scale: 2 })
    const target = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height))
    try {
      await page.render({ canvasContext: target.context, canvas: target.canvas, viewport } as unknown as Parameters<typeof page.render>[0]).promise
      pages.push((await recognize(await prepare(target.canvas.toBuffer('image/png')))).trim())
    } finally {
      factory.destroy(target)
      page.cleanup()
    }
  }
  await task.destroy()

  return pages
}

interface PdfCanvasFactory {
  create(width: number, height: number): { canvas: { toBuffer(mime: 'image/png'): Buffer }; context: unknown }
  destroy(target: unknown): void
}
