import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas } from 'canvas'
import sharp from 'sharp'
import { extract } from '../src/extract/index.js'
import { terminateOcr } from '../src/ocr/index.js'

const work = mkdtempSync(join(tmpdir(), 'duct-pdf-'))
const textPdf = join(work, 'text.pdf')
const scanPdf = join(work, 'scan.pdf')
const scanPng = join(work, 'scan.png')

/** Writes a minimal PDF whose pages draw [fontSize, y, text] lines in Helvetica as real text. */
function makeTextPdf(pages: [number, number, string][][]): Buffer {
  const objects: string[] = []
  const add = (body: string) => { objects.push(body); return objects.length }
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const pagesId = objects.length + 1 + pages.length * 2
  const pageIds: number[] = []
  for (const lines of pages) {
    const stream = lines.map(([size, y, text]) => `BT /F1 ${size} Tf 72 ${y} Td (${text}) Tj ET`).join('\n')
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`))
  }
  add(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`)
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`)
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

async function renderTextImage(lines: string[]): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${120 + lines.length * 90}">
    <rect width="100%" height="100%" fill="white"/>
    ${lines.map((l, i) => `<text x="60" y="${110 + i * 90}" font-family="Helvetica, Arial, sans-serif" font-size="56" fill="black">${l}</text>`).join('')}
  </svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

beforeAll(async () => {
  // A normal PDF with a text layer: a heading, then a paragraph, on two pages.
  writeFileSync(textPdf, makeTextPdf([
    [[20, 700, 'Termination Clause'], [12, 660, 'Either party may terminate this agreement'], [12, 644, 'with thirty days written notice.']],
    [[20, 700, 'Governing Law']],
  ]))

  // A one-page "scan": only an image, no text layer.
  const png = await renderTextImage(['Confidential scanned invoice', 'Total amount due'])
  writeFileSync(scanPng, png)
  const { loadImage } = await import('canvas')
  const image = await loadImage(png)
  const scan = createCanvas(612, 792, 'pdf')
  scan.getContext('2d').drawImage(image, 36, 36, 540, 540 * image.height / image.width)
  writeFileSync(scanPdf, scan.toBuffer())
})

afterAll(async () => {
  await terminateOcr()
  rmSync(work, { recursive: true, force: true })
})

describe('PDF extraction', () => {
  it('keeps line breaks and whole words', async () => {
    const doc = await extract(textPdf)
    expect(doc.metadata.pages).toBe(2)
    const lines = doc.content.split('\n').map(l => l.trim()).filter(Boolean)
    expect(lines).toContain('Termination Clause')
    expect(lines).toContain('Either party may terminate this agreement')
    expect(lines).toContain('Governing Law')
  })

  it('flags a one-page scan for OCR when OCR is off', async () => {
    const doc = await extract(scanPdf)
    expect(doc.content.trim()).toBe('')
    expect(doc.metadata.needsOcr).toBe(true)
  })

  it('reads a one-page scan with the bundled OCR model when OCR is on', async () => {
    const doc = await extract(scanPdf, { ocr: true })
    expect(doc.metadata.ocr).toBe(true)
    expect(doc.content.toLowerCase()).toContain('invoice')
  }, 60_000)
})

describe('image extraction', () => {
  it('skips OCR for images unless it is enabled', async () => {
    const off = await extract(scanPng)
    expect(off.content).toBe('')
    expect(off.metadata.needsOcr).toBe(true)

    const on = await extract(scanPng, { ocr: true })
    expect(on.content.toLowerCase()).toContain('amount')
  }, 60_000)
})
