// Exports passages with their sources: an evidence list for an audit file, a set of past answers for a bid,
// quotes for a brief. CSV opens in Excel, Markdown pastes anywhere, and .docx opens in Word.

export interface ExportItem {
  /** The document's name as people know it. */
  name: string
  path: string
  /** "p. 12", "slide 3", "sheet 2"… */
  location?: string
  heading?: string
  text: string
  score?: number
  tags?: string[]
  /** The reader's own comment on the passage (notebooks). */
  note?: string
}

export type ExportFormat = 'csv' | 'md' | 'json' | 'docx'

export const EXPORT_TYPES: Record<ExportFormat, { ext: string; mime: string }> = {
  csv: { ext: 'csv', mime: 'text/csv; charset=utf-8' },
  md: { ext: 'md', mime: 'text/markdown; charset=utf-8' },
  json: { ext: 'json', mime: 'application/json; charset=utf-8' },
  docx: { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
}

export function isExportFormat(v: unknown): v is ExportFormat {
  return typeof v === 'string' && v in EXPORT_TYPES
}

/** "Contract.pdf, p. 12 › Termination" */
export function sourceLine(item: ExportItem): string {
  return item.name + (item.location ? `, ${item.location}` : '') + (item.heading ? ` › ${item.heading}` : '')
}

/** A CSV cell. Cells that start like a formula are prefixed with ' so spreadsheets show them as text. */
function cell(value: unknown): string {
  let s = value == null ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return `"${s.replace(/"/g, '""')}"`
}

export function toCsv(items: ExportItem[]): string {
  const withNotes = items.some(i => i.note)
  const rows = [['document', 'location', 'section', 'passage', ...(withNotes ? ['note'] : []), 'path', 'tags', 'score']]
  for (const i of items) rows.push([i.name, i.location ?? '', i.heading ?? '', i.text, ...(withNotes ? [i.note ?? ''] : []), i.path, (i.tags ?? []).join('; '), i.score === undefined ? '' : String(Math.round(i.score * 1000) / 1000)])
  // A byte-order mark so Excel reads UTF-8 (accents, currency signs) correctly.
  return '\ufeff' + rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n'
}

export function toMarkdown(items: ExportItem[], title: string): string {
  const out = [`# ${title}`, '']
  for (const i of items) {
    out.push(...i.text.trim().split(/\r?\n/).map(line => `> ${line}`), '', `— **${sourceLine(i)}**`, '')
    if (i.note?.trim()) out.push(...i.note.trim().split(/\r?\n/).map(line => line ? `${line}  ` : ''), '')
  }
  return out.join('\n')
}

const xmlEscape = (s: string) => s
  // Characters XML 1.0 forbids (control codes from PDFs and spreadsheets) would make Word refuse the file.
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function run(text: string, props = ''): string {
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`
}

function paragraph(runs: string, props = ''): string {
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${runs}</w:p>`
}

/** A Word document: a title, then each passage (indented) followed by its source in grey. */
export async function toDocx(items: ExportItem[], title: string): Promise<Buffer> {
  const JSZip = (await import('jszip')).default
  const zip = new JSZip()
  const body: string[] = [
    paragraph(run(title, '<w:b/><w:sz w:val="36"/>'), '<w:spacing w:after="240"/>'),
    paragraph(run(`${items.length} passage${items.length === 1 ? '' : 's'}, exported from Duct on ${new Date().toISOString().slice(0, 10)}`, '<w:color w:val="666666"/><w:sz w:val="18"/>'), '<w:spacing w:after="360"/>'),
  ]
  for (const i of items) {
    for (const line of i.text.trim().split(/\r?\n/)) body.push(paragraph(run(line), '<w:ind w:left="567"/><w:spacing w:after="60"/>'))
    const hasNote = !!i.note?.trim()
    body.push(paragraph(run(sourceLine(i), '<w:i/><w:color w:val="555555"/><w:sz w:val="18"/>') + (i.tags?.length ? run(`  ·  ${i.tags.join(', ')}`, '<w:color w:val="888888"/><w:sz w:val="18"/>') : ''), `<w:ind w:left="567"/><w:spacing w:after="${hasNote ? 120 : 320}"/>`))
    // The reader's own words sit under the source, at the margin, so quote and comment stay apart.
    if (hasNote) {
      for (const line of i.note!.trim().split(/\r?\n/)) body.push(paragraph(run(line), '<w:spacing w:after="60"/>'))
      body.push(paragraph('', '<w:spacing w:after="260"/>'))
    }
  }
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>')
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>')
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(title)}</dc:title><dc:creator>Duct</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>`)
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

export async function renderExport(items: ExportItem[], format: ExportFormat, title: string): Promise<Buffer | string> {
  if (format === 'csv') return toCsv(items)
  if (format === 'md') return toMarkdown(items, title)
  if (format === 'docx') return toDocx(items, title)
  return JSON.stringify({ title, exported_at: new Date().toISOString(), items }, null, 2)
}

/** A file name from a title: "Termination clauses" → "duct-termination-clauses". */
export function exportFileName(title: string, format: ExportFormat): string {
  const slug = title.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'export'
  return `duct-${slug}.${EXPORT_TYPES[format].ext}`
}
