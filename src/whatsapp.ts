// WhatsApp as a source, from WhatsApp's own "Export chat" (with media): the .zip a phone produces, or its
// unzipped folder. The conversation is indexed day by day ("8 March 2026" in results), and every attachment
// is indexed with who sent it, in which chat and when, so "the PDF Chidi sent in March" can be found by
// name ("chidi contract") and by date. Nothing is read from WhatsApp's own app data.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { Duct } from './index.js'
import { safeFileName } from './library.js'
import { isSupportedFile } from './formats.js'
import { decodeText } from './extract/common.js'
import { chatTitle, isChatFileName, parseWhatsAppChat } from './whatsapp-chat.js'
import type { ChatMessage } from './whatsapp-chat.js'

export { chatSections, chatTitle, isChatFileName, parseWhatsAppChat } from './whatsapp-chat.js'
export type { ChatMessage } from './whatsapp-chat.js'

export interface WhatsAppImport {
  chat: string
  messages: number
  /** Attachments Duct can read, indexed with their sender and date. */
  attachments: number
  /** Attachments of kinds Duct doesn't read (voice notes, stickers…), left out. */
  skipped: number
  dir: string
}

/** One exported file: its name and how to get its bytes. */
type Entry = { name: string; bytes: () => Promise<Buffer> }

async function entriesOf(source: string): Promise<Entry[]> {
  const st = statSync(source)
  if (st.isDirectory()) {
    return readdirSync(source).filter(n => !n.startsWith('.')).map(n => join(source, n)).filter(p => statSync(p).isFile())
      .map(p => ({ name: basename(p), bytes: async () => readFileSync(p) }))
  }
  if (extname(source).toLowerCase() === '.zip') {
    const { default: JSZip } = await import('jszip')
    const zip = await JSZip.loadAsync(readFileSync(source))
    return Object.values(zip.files)
      .filter(f => !f.dir && !f.name.startsWith('__MACOSX/') && !basename(f.name).startsWith('.'))
      // Only the file name is kept, so an entry can't write outside the chat's folder.
      .map(f => ({ name: basename(f.name), bytes: () => f.async('nodebuffer') }))
  }
  return [{ name: basename(source), bytes: async () => readFileSync(source) }]
}

const MAX_FILE_BYTES = 200 * 1024 * 1024

/** dir/name, or dir/name (2).ext if that's taken. */
function uniqueIn(dir: string, name: string): string {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let p = join(dir, name)
  for (let i = 2; existsSync(p); i++) p = join(dir, `${stem} (${i})${ext}`)
  return p
}

/**
 * Adds an exported WhatsApp chat (the .zip, its folder, or the chat .txt alone) to the Library under
 * WhatsApp/<chat>/ and indexes it. Importing the same chat again replaces the earlier import.
 */
export async function importWhatsApp(duct: Duct, libraryDir: string, source: string, originalName?: string): Promise<WhatsAppImport> {
  duct.requireFeature('uploads')
  const entries = await entriesOf(source)
  let chatEntry = entries.find(e => isChatFileName(e.name))
  let messages: ChatMessage[] = []
  if (chatEntry) messages = parseWhatsAppChat(decodeText(await chatEntry.bytes()))
  else {
    for (const e of entries.filter(x => extname(x.name).toLowerCase() === '.txt')) {
      messages = parseWhatsAppChat(decodeText(await e.bytes()))
      if (messages.length) { chatEntry = e; break }
    }
  }
  if (!chatEntry || messages.length === 0) throw Object.assign(new Error('This doesn’t look like a WhatsApp chat export. In WhatsApp, open the chat, choose Export chat (with media), and add the .zip it makes.'), { status: 400 })

  const title = chatTitle(originalName ?? '') ?? chatTitle(basename(source)) ?? chatTitle(chatEntry.name) ?? 'WhatsApp chat'
  const dir = join(libraryDir, 'WhatsApp', safeFileName(title).replace(/\.$/, ''))
  // A new export of the same chat replaces the old one.
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) await duct.removeDocument(join(dir, f))
    rmSync(dir, { recursive: true, force: true })
  }
  mkdirSync(dir, { recursive: true })

  const chatPath = join(dir, `WhatsApp Chat - ${safeFileName(title)}.txt`)
  writeFileSync(chatPath, await chatEntry.bytes())
  const last = messages[messages.length - 1].at
  utimesSync(chatPath, new Date(last), new Date(last))
  await duct.index(chatPath, { whatsappChat: title }, { source: 'library', displayName: `WhatsApp: ${title}` })

  const sentBy = new Map(messages.filter(m => m.attachment).map(m => [m.attachment!, m]))
  let attachments = 0
  let skipped = 0
  for (const e of entries) {
    if (e === chatEntry) continue
    const msg = sentBy.get(e.name)
    if (!isSupportedFile(e.name)) { skipped++; continue }
    const bytes = await e.bytes()
    if (bytes.length > MAX_FILE_BYTES) { skipped++; continue }
    // iPhone exports number their files ("00000013-Contract.pdf"); people know them by the name after it.
    const shown = e.name.replace(/^\d{8}-(?=.)/, '')
    const path = uniqueIn(dir, safeFileName(shown))
    writeFileSync(path, bytes)
    // The file's date is when it was sent, so the "Modified" filters find it by that.
    if (msg) utimesSync(path, new Date(msg.at), new Date(msg.at))
    const metadata = { whatsappChat: title, ...(msg?.sender ? { whatsappSender: msg.sender } : {}), ...(msg ? { whatsappSentAt: new Date(msg.at).toISOString() } : {}) }
    // The sender is part of the name people see and search ("chidi contract").
    const displayName = msg?.sender ? `${shown} · from ${msg.sender}` : shown
    await duct.index(path, metadata, { source: 'library', displayName })
    attachments++
  }
  return { chat: title, messages: messages.length, attachments, skipped, dir }
}
