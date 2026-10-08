import { readFileSync } from 'node:fs'
import type { ExtractedDocument } from '../types.js'
import type { ExtractOptions } from './common.js'
import { extractEmbedded, type ExtractFile } from './packages.js'

type Section = { title: string; text: string }

// The parts of @kenjiuno/msgreader used here.
interface MsgFields {
  error?: string
  subject?: string
  senderName?: string
  senderEmail?: string
  body?: string
  bodyHtml?: string
  messageDeliveryTime?: string
  clientSubmitTime?: string
  creationTime?: string
  recipients?: { name?: string; email?: string }[]
  attachments?: MsgFields[]
}
type MsgReaderClass = new (data: ArrayBuffer) => {
  getFileData(): MsgFields
  getAttachment(attachment: MsgFields): { fileName: string; content: Uint8Array }
}

async function htmlToText(html: string): Promise<string> {
  const cheerio = await import('cheerio')
  const $ = cheerio.load(html)
  $('script, style, head').remove()
  $('br').replaceWith('\n')
  $('p, div, h1, h2, h3, h4, h5, h6, li, tr, blockquote, table').append('\n')
  return $('body').text().split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')
}

/** The email's own text: a header block (so "from:" and subject words are searchable) and the body. */
function emailText(headers: [string, string | undefined][], body: string): string {
  const head = headers.filter(([, v]) => v && v.trim()).map(([k, v]) => `${k}: ${v!.trim()}`).join('\n')
  return [head, body.trim()].filter(Boolean).join('\n\n')
}

async function withAttachments(
  path: string,
  format: 'eml' | 'msg',
  subject: string,
  main: string,
  attachments: { name: string; bytes: Uint8Array }[],
  options: ExtractOptions,
  extractFile: ExtractFile,
  size: number,
): Promise<ExtractedDocument> {
  const sections: Section[] = [{ title: subject || 'Email', text: main }]
  const unread: string[] = []
  for (const a of attachments) {
    const text = await extractEmbedded(a.name, a.bytes, options, extractFile)
    if (text) sections.push({ title: `Attachment: ${a.name}`, text })
    else unread.push(a.name)
  }
  return {
    path,
    format,
    content: sections.map(s => s.text).join('\n\n'),
    sections,
    metadata: { size, subject, attachments: attachments.map(a => a.name), ...(unread.length ? { unreadAttachments: unread } : {}) },
  }
}

export async function extractEml(path: string, options: ExtractOptions, extractFile: ExtractFile): Promise<ExtractedDocument> {
  const buffer = readFileSync(path)
  const { default: PostalMime } = await import('postal-mime')
  const mail = await PostalMime.parse(buffer)
  const who = (a?: { name?: string; address?: string } | null) => a ? [a.name, a.address ? `<${a.address}>` : ''].filter(Boolean).join(' ') : undefined
  const list = (as?: { name?: string; address?: string }[]) => as?.map(who).filter(Boolean).join(', ')
  const body = mail.text?.trim() ? mail.text : mail.html ? await htmlToText(mail.html) : ''
  const main = emailText([
    ['Subject', mail.subject], ['From', who(mail.from as never)], ['To', list(mail.to as never)], ['Cc', list(mail.cc as never)], ['Date', mail.date],
  ], body)
  const attachments = (mail.attachments ?? [])
    .filter(a => a.filename)
    .map(a => ({ name: a.filename!, bytes: typeof a.content === 'string' ? new TextEncoder().encode(a.content) : new Uint8Array(a.content) }))
  return withAttachments(path, 'eml', mail.subject ?? '', main, attachments, options, extractFile, buffer.length)
}

export async function extractMsg(path: string, options: ExtractOptions, extractFile: ExtractFile): Promise<ExtractedDocument> {
  const buffer = readFileSync(path)
  // A CommonJS module with an ES-style default export: under Node's ESM the class is on .default.default.
  const mod = await import('@kenjiuno/msgreader') as unknown as { default: MsgReaderClass | { default: MsgReaderClass } }
  const MsgReader = 'default' in mod.default ? mod.default.default : mod.default
  const reader = new MsgReader(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer)
  const data = reader.getFileData()
  if (data.error) throw new Error(data.error)
  const recipients = (data.recipients ?? []).map((r: { name?: string; email?: string }) => [r.name, r.email ? `<${r.email}>` : ''].filter(Boolean).join(' ')).join(', ')
  const body = data.body?.trim() ? data.body : data.bodyHtml ? await htmlToText(data.bodyHtml) : ''
  const main = emailText([
    ['Subject', data.subject], ['From', [data.senderName, data.senderEmail ? `<${data.senderEmail}>` : ''].filter(Boolean).join(' ')],
    ['To', recipients], ['Date', data.messageDeliveryTime ?? data.clientSubmitTime ?? data.creationTime],
  ], body)
  const attachments: { name: string; bytes: Uint8Array }[] = []
  for (const att of data.attachments ?? []) {
    try {
      const file = reader.getAttachment(att)
      if (file.fileName && file.content) attachments.push({ name: file.fileName, bytes: file.content })
    } catch {}
  }
  return withAttachments(path, 'msg', data.subject ?? '', main, attachments, options, extractFile, buffer.length)
}

