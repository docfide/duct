import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { Duct } from '../src/index.js'
import { chatSections, chatTitle, importWhatsApp, parseWhatsAppChat } from '../src/whatsapp.js'
import { makeDocx } from './helpers.js'

const work = mkdtempSync(join(tmpdir(), 'duct-wa-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const LRM = '‎'
const IOS = [
  `[08/03/2026, 14:20:01] Okafor Holdings: ${LRM}Messages and calls are end-to-end encrypted.`,
  `[08/03/2026, 14:22:05] Chidi Okafor: Please see the supply agreement`,
  `${LRM}[08/03/2026, 14:22:40] Chidi Okafor: ${LRM}<attached: 00000013-Supply agreement.docx>`,
  `[13/03/2026, 09:05:00] Ada Bello: Signed. The invoice follows`,
  `on Monday, with the delivery note.`,
  `[13/03/2026, 09:06:10] Ada Bello: ${LRM}<attached: 00000014-PHOTO-2026-03-13-09-06-10.jpg>`,
  `[13/03/2026, 09:07:00] Ada Bello: ${LRM}<attached: 00000015-AUDIO-2026-03-13-09-07-00.opus>`,
].join('\n')

const ANDROID = [
  '3/8/26, 2:22 PM - Messages and calls are end-to-end encrypted. No one outside of this chat can read them.',
  '3/8/26, 2:22 PM - Chidi Okafor: Contract.pdf (file attached)',
  'Here is the contract',
  '3/14/26, 9:05 AM - Ada Bello: Received, thanks',
].join('\n')

describe('reading an exported chat', () => {
  it('reads iPhone exports: senders, times, multi-line messages and attachments', () => {
    const m = parseWhatsAppChat(IOS)
    expect(m).toHaveLength(6)
    expect(m[2]).toMatchObject({ sender: 'Chidi Okafor', attachment: '00000013-Supply agreement.docx', text: '' })
    expect(new Date(m[2].at)).toEqual(new Date(2026, 2, 8, 14, 22, 40))
    expect(m[3].text).toBe('Signed. The invoice follows\non Monday, with the delivery note.')
  })

  it('reads Android exports, month-first dates and 12-hour times', () => {
    const m = parseWhatsAppChat(ANDROID)
    expect(m).toHaveLength(3)
    expect(m[0].sender).toBe('')
    expect(m[1]).toMatchObject({ sender: 'Chidi Okafor', attachment: 'Contract.pdf', text: 'Here is the contract' })
    expect(new Date(m[1].at)).toEqual(new Date(2026, 2, 8, 14, 22))
    expect(new Date(m[2].at)).toEqual(new Date(2026, 2, 14, 9, 5))
  })

  it('is not fooled by other text', () => {
    expect(parseWhatsAppChat('Meeting notes\n12/03/2026, 10:00 - agenda\nWe discussed many things\nand more\nand more\nand more\nand more')).toEqual([])
    expect(chatTitle('WhatsApp Chat - Okafor Holdings.zip')).toBe('Okafor Holdings')
    expect(chatTitle('WhatsApp Chat with Chidi Okafor.txt')).toBe('Chidi Okafor')
    expect(chatTitle('_chat.txt')).toBeUndefined()
  })

  it('makes one section per day', () => {
    const s = chatSections(parseWhatsAppChat(IOS))
    expect(s.map(x => x.title)).toEqual(['8 March 2026', '13 March 2026'])
    expect(s[0].text).toContain('14:22 Chidi Okafor: [sent 00000013-Supply agreement.docx]')
  })
})

describe('importing an export', () => {
  it('indexes the chat by day and each attachment with its sender and date; a new export replaces the old', async () => {
    const zip = new JSZip()
    zip.file('_chat.txt', IOS)
    zip.file('00000013-Supply agreement.docx', await makeDocx(['The supplier shall deliver 400 bags of cement to the Lekki site.']))
    zip.file('00000015-AUDIO-2026-03-13-09-07-00.opus', Buffer.from('voice'))
    zip.file('__MACOSX/._chat.txt', 'junk')
    const zipPath = join(work, 'upload-123.zip')
    writeFileSync(zipPath, await zip.generateAsync({ type: 'nodebuffer' }))

    const duct = new Duct({ embed: false })
    const lib = join(work, 'lib')
    const r = await importWhatsApp(duct, lib, zipPath, 'WhatsApp Chat - Okafor Holdings.zip')
    expect(r).toMatchObject({ chat: 'Okafor Holdings', messages: 6, attachments: 1, skipped: 1 })

    const doc = duct.getDocuments().find(d => d.displayName === 'Supply agreement.docx · from Chidi Okafor')!
    expect(doc.path.endsWith(join('WhatsApp', 'Okafor Holdings', 'Supply agreement.docx'))).toBe(true)
    expect(statSync(doc.path).mtime).toEqual(new Date(2026, 2, 8, 14, 22, 40))
    const [hit] = await duct.search('cement')
    expect(hit.chunk.metadata).toMatchObject({ whatsappChat: 'Okafor Holdings', whatsappSender: 'Chidi Okafor' })
    // "chidi agreement": the sender is part of the name.
    expect((await duct.search('chidi agreement')).some(x => x.chunk.documentPath === doc.path)).toBe(true)
    const [said] = await duct.search('delivery note')
    expect(said.chunk.heading).toBe('13 March 2026')
    expect(duct.getDocuments().some(d => d.displayName === 'WhatsApp: Okafor Holdings')).toBe(true)

    await importWhatsApp(duct, lib, zipPath, 'WhatsApp Chat - Okafor Holdings.zip')
    expect(duct.getDocuments().filter(d => d.displayName === 'WhatsApp: Okafor Holdings')).toHaveLength(1)
  })

  it('refuses files that aren\'t chat exports', async () => {
    const p = join(work, 'notes.txt')
    writeFileSync(p, 'just some notes')
    await expect(importWhatsApp(new Duct({ embed: false }), join(work, 'lib2'), p)).rejects.toThrow(/Export chat/)
  })
})
