import { existsSync, readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type Tesseract from 'tesseract.js'
import { ensureDOMMatrix } from '../dommatrix.js'

export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.gif', '.webp'])

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

export async function ocrImage(imagePath: string): Promise<string> {
  return (await recognize(await prepare(imagePath))).trim()
}

export async function ocrPdf(pdfPath: string): Promise<string | null> {
  let pdfjsLib: typeof import('pdfjs-dist/legacy/build/pdf.mjs')
  try {
    await ensureDOMMatrix()
    pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')
  } catch {
    return null
  }

  const buffer = readFileSync(pdfPath)
  const data: Uint8Array = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const pdf = await pdfjsLib.getDocument({ data }).promise
  // pdf.js renders in Node through its own canvas factory (backed by @napi-rs/canvas).
  const factory = (pdf as unknown as { canvasFactory: PdfCanvasFactory }).canvasFactory

  let fullText = ''
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const viewport = page.getViewport({ scale: 2 })
    const target = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height))
    try {
      await page.render({ canvasContext: target.context, canvas: target.canvas, viewport } as unknown as Parameters<typeof page.render>[0]).promise
      fullText += (await recognize(await prepare(target.canvas.toBuffer('image/png')))) + '\n\n'
    } finally {
      factory.destroy(target)
      page.cleanup()
    }
  }
  await pdf.destroy()

  return fullText.trim()
}

interface PdfCanvasFactory {
  create(width: number, height: number): { canvas: { toBuffer(mime: 'image/png'): Buffer }; context: unknown }
  destroy(target: unknown): void
}
