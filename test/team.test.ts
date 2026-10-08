import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duct } from '../src/index.js'
import { createServer } from '../src/server.js'

const work = mkdtempSync(join(tmpdir(), 'duct-team-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

describe('admin and member tokens', () => {
  let server: Server
  let base: string
  const admin = { Authorization: 'Bearer admin-secret' }
  const member = { Authorization: 'Bearer member-secret' }

  beforeAll(async () => {
    const duct = new Duct()
    writeFileSync(join(work, 'shared.txt'), 'team handbook about onboarding')
    await duct.index(join(work, 'shared.txt'))
    server = createServer(duct, { authToken: 'admin-secret', memberTokens: ['member-secret'], libraryDir: join(work, 'lib') }).listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => server.close())

  it('tells the page which role it has', async () => {
    expect(await (await fetch(`${base}/api/me`, { headers: admin })).json()).toEqual({ role: 'admin', auth: true })
    expect(await (await fetch(`${base}/api/me`, { headers: member })).json()).toEqual({ role: 'member', auth: true })
  })

  it('lets members search, open and upload', async () => {
    const found = await (await fetch(`${base}/api/search?q=onboarding`, { headers: member })).json()
    expect(found.results).toHaveLength(1)
    const path = found.results[0].chunk.documentPath
    expect((await fetch(`${base}/api/file?path=${encodeURIComponent(path)}`, { headers: member })).status).toBe(200)
    const form = new FormData()
    form.append('files', new Blob(['member upload about payroll']), 'payroll.txt')
    expect((await fetch(`${base}/api/index`, { method: 'POST', body: form, headers: member })).status).toBe(200)
  })

  it('keeps settings, deletes and clearing for admins', async () => {
    const asMember = (method: string, path: string, body?: unknown) =>
      fetch(`${base}${path}`, { method, headers: { ...member, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    expect((await asMember('PUT', '/api/config', { searchMode: 'hybrid' })).status).toBe(403)
    expect((await asMember('DELETE', '/api/clear')).status).toBe(403)
    expect((await asMember('DELETE', `/api/documents?path=${encodeURIComponent(join(work, 'shared.txt'))}`)).status).toBe(403)
    expect((await asMember('POST', '/api/unwatch')).status).toBe(403)
    expect((await fetch(`${base}/api/config`, { method: 'PUT', headers: { ...admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ chunkSize: 900 }) })).status).toBe(200)
  })

  it('gives members a member login cookie', async () => {
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'member-secret' }) })
    const cookie = (res.headers.get('set-cookie') || '').split(';')[0]
    expect(await (await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })).json()).toMatchObject({ role: 'member' })
  })

  it('refuses member tokens without an admin token', () => {
    expect(() => createServer(new Duct(), { memberTokens: ['x'] })).toThrow(/authToken/)
  })
})

describe('rescanning watched folders', () => {
  it('catches changes that produced no file events', async () => {
    const dir = join(work, 'share')
    mkdirSync(dir)
    writeFileSync(join(dir, 'a.txt'), 'first file about cedar')
    writeFileSync(join(dir, 'b.txt'), 'second file about birch')
    const duct = new Duct()
    await duct.watch([dir])
    duct.unwatch() // simulate a network drive whose events never arrive

    unlinkSync(join(dir, 'a.txt'))
    writeFileSync(join(dir, 'c.txt'), 'third file about maple')
    expect(await duct.search('maple')).toHaveLength(0)

    await duct.rescanSources()
    expect(await duct.search('maple')).toHaveLength(1)
    expect(await duct.search('cedar')).toHaveLength(0)
    expect(duct.stats().documents).toBe(2)
  })
})
