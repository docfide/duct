// Reading WhatsApp's "Export chat" text: the iPhone ("[08/03/2026, 14:22:05] Name: text") and Android
// ("08/03/2026, 14:22 - Name: text") layouts, either date order, 12- or 24-hour times, multi-line messages
// and attachments. No dependencies, so the text extractor can use it.

import { basename } from 'node:path'

export interface ChatMessage {
  /** Local time the message was sent (ms since 1970). */
  at: number
  /** Empty for WhatsApp's own notices ("Messages are end-to-end encrypted…"). */
  sender: string
  text: string
  /** The attached file's name, when the export included it. */
  attachment?: string
}

const BIDI = /[‎‏‪-‮⁦-⁩]/g
// [08/03/2026, 14:22:05] Name: text          (iPhone)
// 08/03/2026, 14:22 - Name: text             (Android)
// 3/8/26, 2:22 PM - Name: text, 08.03.26 14:22 - …, 2026-03-08 14:22 - …
const HEADER = /^\[?(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?(?:[\s ]*([AaPp])\.?\s?[Mm]\.?)?\]?\s*(?:-\s)?(.*)$/
const IOS_ATTACHED = /<attached:\s*([^>]+)>/i
const ANDROID_ATTACHED = /^(.+?\.[A-Za-z0-9]{2,5})\s+\((?:file attached|fichier joint|archivo adjunto|arquivo anexado|Datei angehängt|file allegato|bestand bijgevoegd)\)/i

/** Parses an exported chat. Returns [] when the text isn't one. */
export function parseWhatsAppChat(raw: string): ChatMessage[] {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n')
  const heads: { line: number; m: RegExpExecArray }[] = []
  lines.forEach((l, i) => { const m = HEADER.exec(l.replace(BIDI, '')); if (m) heads.push({ line: i, m }) })
  if (heads.length < 2) return []

  // Day and month order: a first number over 12 means day-first, a second over 12 month-first. Exports that
  // never show either are read day-first, as in most countries where WhatsApp is used.
  let order: 'dmy' | 'mdy' | 'ymd' = 'dmy'
  if (heads.some(h => h.m[1].length === 4)) order = 'ymd'
  else if (heads.some(h => Number(h.m[1]) > 12)) order = 'dmy'
  else if (heads.some(h => Number(h.m[2]) > 12)) order = 'mdy'

  const messages: ChatMessage[] = []
  for (let k = 0; k < heads.length; k++) {
    const { m, line } = heads[k]
    const a = Number(m[1]), b = Number(m[2]), c = Number(m[3])
    const [y, mo, d] = order === 'ymd' ? [a, b, c] : order === 'mdy' ? [c, a, b] : [c, b, a]
    const year = y < 100 ? 2000 + y : y
    let hour = Number(m[4])
    if (m[7]) { const pm = m[7].toLowerCase() === 'p'; if (pm && hour < 12) hour += 12; if (!pm && hour === 12) hour = 0 }
    const at = new Date(year, mo - 1, d, hour, Number(m[5]), Number(m[6] ?? 0)).getTime()
    if (Number.isNaN(at) || mo < 1 || mo > 12 || d < 1 || d > 31) continue
    // The rest of the line, plus any lines up to the next message (multi-line messages).
    const next = k + 1 < heads.length ? heads[k + 1].line : lines.length
    const body = [m[8], ...lines.slice(line + 1, next)].join('\n').replace(BIDI, '').trim()
    const colon = body.indexOf(': ')
    const sender = colon > 0 && colon < 80 ? body.slice(0, colon).trim() : ''
    let text = sender ? body.slice(colon + 2) : body
    let attachment: string | undefined
    const ios = IOS_ATTACHED.exec(text)
    const android = ANDROID_ATTACHED.exec(text)
    if (ios) { attachment = ios[1].trim(); text = text.replace(IOS_ATTACHED, '').trim() }
    else if (android) { attachment = android[1].trim(); text = text.slice(android[0].length).trim() }
    messages.push({ at, sender, text, ...(attachment ? { attachment } : {}) })
  }
  // Mostly message lines, or it's some other text that happens to start with dates.
  return messages.length >= 2 && heads.length * 3 >= lines.filter(l => l.trim()).length ? messages : []
}

/** Files that hold an exported chat: "_chat.txt" (iPhone) or "WhatsApp Chat with Ada.txt" (Android). */
export function isChatFileName(name: string): boolean {
  return /^_chat\.txt$/i.test(name) || /^WhatsApp Chat\b.*\.txt$/i.test(name)
}

/** "WhatsApp Chat - Okafor Holdings.zip" → "Okafor Holdings" */
export function chatTitle(name: string): string | undefined {
  const m = /^WhatsApp Chat\s*(?:with|-|–)\s*(.+?)(?:\.(?:zip|txt))?$/i.exec(basename(name).trim())
  return m ? m[1].trim() : undefined
}

const dayTitle = (at: number) => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
const clock = (at: number) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

/** The conversation as one section per day, for indexing ("8 March 2026" as the heading). */
export function chatSections(messages: ChatMessage[]): { title: string; text: string }[] {
  const days = new Map<string, string[]>()
  for (const m of messages) {
    const title = dayTitle(m.at)
    const line = m.sender
      ? `${clock(m.at)} ${m.sender}: ${m.attachment ? `[sent ${m.attachment}] ` : ''}${m.text}`.trim()
      : `${clock(m.at)} ${m.text}`
    if (!days.has(title)) days.set(title, [])
    days.get(title)!.push(line)
  }
  return [...days.entries()].map(([title, ls]) => ({ title, text: ls.join('\n') }))
}
