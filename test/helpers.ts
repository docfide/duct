// Shared fixtures for tests that need real documents.

/** Writes a minimal PDF whose pages draw [fontSize, y, text] lines in Helvetica as real text. */
export function makeTextPdf(pages: [number, number, string][][]): Buffer {
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

/** Builds a minimal .pptx whose slides contain the given paragraphs (enough for Duct's extractor). */
export async function makePptx(slides: string[][]): Promise<Buffer> {
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  slides.forEach((paragraphs, i) => {
    // Each paragraph is split into two runs to check that runs are joined without adding spaces.
    const body = paragraphs.map(p => {
      const mid = Math.floor(p.length / 2)
      return `<a:p><a:r><a:t>${esc(p.slice(0, mid))}</a:t></a:r><a:r><a:t>${esc(p.slice(mid))}</a:t></a:r></a:p>`
    }).join('')
    zip.file(`ppt/slides/slide${i + 1}.xml`, `<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody>${body}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`)
  })
  return zip.generateAsync({ type: 'nodebuffer' })
}
