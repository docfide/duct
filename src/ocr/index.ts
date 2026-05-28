import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { ensureDOMMatrix } from '../dommatrix.js'

export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.gif', '.webp'])

export function isImageFile(path: string): boolean {
  return IMAGE_EXTS.has(extname(path).toLowerCase())
}

export async function ocrImage(imagePath: string): Promise<string> {
  const sharp = (await import('sharp')).default
  const { default: Tesseract } = await import('tesseract.js')

  const processed = await sharp(imagePath)
    .grayscale()
    .normalize()
    .median(1)
    .toBuffer()

  const { data } = await Tesseract.recognize(processed, 'eng', {
    logger: () => {},
  })

  return data.text.trim()
}

export async function ocrPdf(pdfPath: string): Promise<string | null> {
  let canvas: any
  let pdfjsLib: any
  try {
    canvas = await import('canvas')
    await ensureDOMMatrix()
    pdfjsLib = await import('pdfjs-dist')
  } catch {
    return null
  }

  const sharp = (await import('sharp')).default
  const { default: Tesseract } = await import('tesseract.js')
  const buffer = readFileSync(pdfPath)
  const data: Uint8Array = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const pdf = await pdfjsLib.getDocument({ data }).promise

  let fullText = ''
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const viewport = page.getViewport({ scale: 2 })
    const cvs = canvas.createCanvas(viewport.width, viewport.height)
    const ctx = cvs.getContext('2d')
    await page.render({ canvasContext: ctx, viewport }).promise
    const buf = cvs.toBuffer('image/png')
    const processed = await sharp(buf).grayscale().normalize().median(1).toBuffer()
    const res = await Tesseract.recognize(processed, 'eng', { logger: () => {} })
    fullText += res.data.text + '\n\n'
  }

  return fullText.trim()
}
