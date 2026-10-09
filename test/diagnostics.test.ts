import { describe, it, expect, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duct } from '../src/index.js'
import { createServer } from '../src/server.js'
import { collectDiagnostics, errorCode, listCrashes, recordCrash, sanitizeStack } from '../src/diagnostics.js'

const work = mkdtempSync(join(tmpdir(), 'duct-diag-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

describe('diagnostics', () => {
  it('reduces error messages to fixed codes', () => {
    expect(errorCode('Password required: /Users/ada/Secret Deal.pdf')).toBe('encrypted')
    expect(errorCode("ENOENT: no such file '/Users/ada/x.docx'")).toBe('missing_file')
    expect(errorCode('Invalid PDF structure')).toBe('damaged_file')
    expect(errorCode('something odd about Quillbright')).toBe('extract_failed')
  })

  it('never contains file names, paths or words from the documents', async () => {
    const dir = join(work, 'Okafor Matter')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'zebrafinch-settlement.txt'), 'Quillbright Holdings owes 4,750,000')
    writeFileSync(join(dir, 'broken.pdf'), 'not a pdf')
    const duct = new Duct({ embed: false })
    await duct.index(dir)
    const text = JSON.stringify(collectDiagnostics(duct, 'desktop'))
    for (const secret of ['Okafor', 'zebrafinch', 'Quillbright', '4,750,000', 'broken', work, homedir()]) expect(text, secret).not.toContain(secret)
    expect(JSON.parse(text)).toMatchObject({ channel: 'desktop', documents: '1-10', formats: ['pdf', 'txt'] })
    expect(Object.keys(JSON.parse(text).failed)[0]).toMatch(/^[a-z_]+\.pdf$/)
    duct.close()
  })
})

describe('crash records', () => {
  it('keep only the error type and Duct’s own stack frames', () => {
    const err = new TypeError(`Cannot read 'x' of undefined at ${homedir()}/Documents/Payroll 2026.xlsx`)
    err.stack = [
      `TypeError: Cannot read 'x' of undefined at ${homedir()}/Documents/Payroll 2026.xlsx`,
      `    at search (${homedir()}/Applications/Duct.app/Contents/Resources/app.asar/dist/index.js:812:14)`,
      '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
      `    at Object.read (${homedir()}/Library/node_modules/xlsx/xlsx.mjs:100:2)`,
    ].join('\n')
    expect(sanitizeStack(err.stack)).toEqual(['search (dist/index.js:812)'])
    const dir = join(work, 'crashes')
    const rec = recordCrash(dir, 'main', err)
    const text = JSON.stringify(listCrashes(dir))
    expect(rec.kind).toBe('TypeError')
    for (const secret of ['Payroll', 'Documents', homedir(), 'Cannot read']) expect(text, secret).not.toContain(secret)
  })

  it('keeps the 20 most recent', () => {
    const dir = join(work, 'many')
    for (let i = 0; i < 25; i++) recordCrash(dir, 'main', new Error('x'))
    expect(listCrashes(dir)).toHaveLength(20)
  })
})

describe('feedback through the app', () => {
  it('sends the message, and diagnostics and crash records only when ticked', async () => {
    const received: Record<string, unknown>[] = []
    const fake = http.createServer(async (req, res) => {
      let body = ''
      for await (const c of req) body += c
      received.push(JSON.parse(body))
      res.writeHead(201, { 'Content-Type': 'application/json' }).end('{"id":"fb_1"}')
    }).listen(0, '127.0.0.1')
    await new Promise(r => fake.once('listening', r))
    const crashDir = join(work, 'app-crashes')
    recordCrash(crashDir, 'page', 'oom')
    const duct = new Duct({ embed: false })
    const server = createServer(duct, { crashDir, channel: 'desktop', feedbackUrl: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/` }).listen(0, '127.0.0.1')
    await new Promise(r => server.once('listening', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const post = (body: unknown) => fetch(`${base}/api/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    try {
      expect((await post({ message: '' })).status).toBe(400)
      expect((await post({ message: 'Plain feedback' })).status).toBe(200)
      expect((await post({ message: 'With details', email: 'ada@example.com', includeDiagnostics: true, includeCrashes: true })).status).toBe(200)
      expect(received[0]).toEqual({ schema: 1, message: 'Plain feedback' })
      expect(received[1]).toMatchObject({ message: 'With details', email: 'ada@example.com', diagnostics: { channel: 'desktop', crashes: 1 }, crashes: [{ where: 'page', kind: 'oom' }] })
      expect((await (await fetch(`${base}/api/crashes`)).json()).crashes).toHaveLength(1)
      await fetch(`${base}/api/crashes`, { method: 'DELETE' })
      expect((await (await fetch(`${base}/api/crashes`)).json()).crashes).toHaveLength(0)
    } finally {
      server.close()
      fake.close()
      duct.close()
    }
  })
})
