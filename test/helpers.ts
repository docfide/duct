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

/** A ZIP file from { path: contents }. */
export async function makeZip(entries: Record<string, string | Uint8Array>): Promise<Buffer> {
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  for (const [name, data] of Object.entries(entries)) zip.file(name, data)
  return zip.generateAsync({ type: 'nodebuffer' })
}

/** A minimal .docx whose body has these paragraphs. */
export function makeDocx(paragraphs: string[]): Promise<Buffer> {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return makeZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      paragraphs.map(p => `<w:p><w:r><w:t>${esc(p)}</w:t></w:r></w:p>`).join('') + '</w:body></w:document>',
  })
}

const ODF_NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"'

/** A minimal OpenDocument file: `body` goes inside <office:body>. */
export function makeOdf(mimetype: string, body: string, title = ''): Promise<Buffer> {
  return makeZip({
    mimetype,
    'content.xml': `<?xml version="1.0"?><office:document-content ${ODF_NS}><office:body>${body}</office:body></office:document-content>`,
    'meta.xml': `<?xml version="1.0"?><office:document-meta ${ODF_NS}><office:meta><dc:title>${title}</dc:title></office:meta></office:document-meta>`,
  })
}

/** A minimal EPUB with these chapters (HTML bodies) in reading order. */
export function makeEpub(title: string, chapters: string[]): Promise<Buffer> {
  const entries: Record<string, string> = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'OEBPS/content.opf': `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title></metadata><manifest>` +
      chapters.map((_, i) => `<item id="c${i}" href="text/ch${i}.xhtml" media-type="application/xhtml+xml"/>`).join('') +
      '</manifest><spine>' + chapters.map((_, i) => `<itemref idref="c${i}"/>`).join('') + '</spine></package>',
  }
  chapters.forEach((html, i) => { entries[`OEBPS/text/ch${i}.xhtml`] = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>${html}</body></html>` })
  return makeZip(entries)
}

function varint(n: number): number[] {
  const out: number[] = []
  do { out.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0)); n = Math.floor(n / 128) } while (n > 0)
  return out
}
const protoField = (field: number, wire: number) => varint(field * 8 + wire)
const protoVarint = (field: number, value: number) => Buffer.from([...protoField(field, 0), ...varint(value)])
const protoBytes = (field: number, bytes: Buffer) => Buffer.concat([Buffer.from([...protoField(field, 2), ...varint(bytes.length)]), bytes])

/** An iWork .iwa file holding text storages (TSWP.StorageArchive, type 2001), snappy-framed like the real thing. */
export function makeIwa(texts: string[]): Buffer {
  const parts: Buffer[] = []
  texts.forEach((text, i) => {
    const payload = protoBytes(3, Buffer.from(text, 'utf-8'))
    const info = Buffer.concat([protoVarint(1, i + 1), protoBytes(2, Buffer.concat([protoVarint(1, 2001), protoVarint(3, payload.length)]))])
    parts.push(Buffer.from(varint(info.length)), info, payload)
  })
  const data = Buffer.concat(parts)
  // Snappy block made of literals only (valid, just not compressed).
  const snappy: number[] = [...varint(data.length)]
  for (let i = 0; i < data.length; i += 65536) {
    const chunk = data.subarray(i, i + 65536)
    const n = chunk.length - 1
    if (n < 60) snappy.push(n << 2)
    else if (n < 256) snappy.push(60 << 2, n)
    else snappy.push(61 << 2, n & 0xff, n >> 8)
    snappy.push(...chunk)
  }
  return Buffer.concat([Buffer.from([0, snappy.length & 0xff, (snappy.length >> 8) & 0xff, snappy.length >> 16]), Buffer.from(snappy)])
}
