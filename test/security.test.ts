import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duct } from '../src/index.js'
import { createServer, type ServerOptions } from '../src/server.js'
import { extractUrl, isPrivateAddress } from '../src/extract/web.js'

const work = mkdtempSync(join(tmpdir(), 'duct-security-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

async function start(opts?: ServerOptions, duct = new Duct()): Promise<{ server: Server; base: string; port: number }> {
  const server = createServer(duct, opts).listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const port = (server.address() as AddressInfo).port
  return { server, base: `http://127.0.0.1:${port}`, port }
}

function rawRequest(port: number, path: string, headers: Record<string, string>, method = 'GET'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, res => { res.resume(); resolve(res.statusCode ?? 0) })
    req.on('error', reject)
    req.end()
  })
}

describe('server security', () => {
  let s: Awaited<ReturnType<typeof start>>
  const secret = join(work, 'id_fake')
  const victim = join(work, 'victim.txt')

  beforeAll(async () => {
    writeFileSync(secret, 'PRIVATE KEY material zebra')
    writeFileSync(victim, 'do not delete')
    s = await start({ watchRoots: [join(work, 'allowed')] })
    mkdirSync(join(work, 'allowed', 'sub'), { recursive: true })
  })
  afterAll(() => s.server.close())

  it('rejects local paths sent as a URL', async () => {
    const res = await fetch(`${s.base}/api/index`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: secret }) })
    expect(res.status).toBe(400)
    const found = await (await fetch(`${s.base}/api/search?q=zebra`)).json()
    expect(found.results).toHaveLength(0)
  })

  it('never indexes files without a supported extension', async () => {
    const duct = new Duct()
    const r = await duct.index(secret)
    expect(r.documents).toBe(0)
  })

  it('does not delete files outside the uploads folder', async () => {
    const traversal = join(process.cwd(), '.duct-uploads', '..', '..', victim)
    const res = await fetch(`${s.base}/api/documents?path=${encodeURIComponent(traversal)}`, { method: 'DELETE' })
    expect(res.status).toBe(404)
    expect(existsSync(victim)).toBe(true)
  })

  it('only watches folders inside the configured roots', async () => {
    const watch = (dir: string) => fetch(`${s.base}/api/watch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directories: [dir] }) })
    expect((await watch(work)).status).toBe(403)
    expect((await watch(join(work, 'allowed', '..'))).status).toBe(403)
    expect((await watch(join(work, 'allowed', 'sub'))).status).toBe(200)
    await fetch(`${s.base}/api/unwatch`, { method: 'POST' })
  })

  it('disables API watching when no roots are configured', async () => {
    const t = await start()
    const res = await fetch(`${t.base}/api/watch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directories: [work] }) })
    expect(res.status).toBe(403)
    t.server.close()
  })

  it('rejects unexpected Host headers (DNS rebinding)', async () => {
    expect(await rawRequest(s.port, '/api/stats', { Host: `evil.example:${s.port}` })).toBe(403)
    expect(await rawRequest(s.port, '/api/stats', { Host: `localhost:${s.port}` })).toBe(200)
  })

  it('rejects cross-origin writes', async () => {
    const res = await fetch(`${s.base}/api/clear`, { method: 'DELETE', headers: { Origin: 'https://evil.example' } })
    expect(res.status).toBe(403)
    const same = await fetch(`${s.base}/api/clear`, { method: 'DELETE', headers: { Origin: s.base } })
    expect(same.status).toBe(200)
  })

  it('sends a Content-Security-Policy that keeps requests on this server', async () => {
    const res = await fetch(`${s.base}/`)
    const csp = res.headers.get('content-security-policy') || ''
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('shows LLM answers as text, never as HTML', async () => {
    const script = await (await fetch(`${s.base}/ui/app.js`)).text()
    expect(script).toContain('answer.textContent = data.answer')
    expect(script).not.toMatch(/innerHTML\s*=\s*data\.answer/)
  })

  it('forbids inline scripts on the main page', async () => {
    const csp = (await fetch(`${s.base}/`)).headers.get('content-security-policy') || ''
    const scriptSrc = csp.split(';').find(d => d.trim().startsWith('script-src')) || ''
    expect(scriptSrc).not.toContain('unsafe-inline')
    const islandCsp = (await fetch(`${s.base}/island`)).headers.get('content-security-policy') || ''
    expect(islandCsp).toContain("'unsafe-inline'")
  })
})

describe('server authentication', () => {
  let s: Awaited<ReturnType<typeof start>>
  beforeAll(async () => { s = await start({ authToken: 'correct-horse' }) })
  afterAll(() => s.server.close())

  it('requires the token on API requests', async () => {
    expect((await fetch(`${s.base}/api/stats`)).status).toBe(401)
    expect((await fetch(`${s.base}/api/stats`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await fetch(`${s.base}/api/stats`, { headers: { Authorization: 'Bearer correct-horse' } })).status).toBe(200)
  })

  it('exchanges the token for an HttpOnly login cookie', async () => {
    const bad = await fetch(`${s.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'nope' }) })
    expect(bad.status).toBe(401)
    const good = await fetch(`${s.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'correct-horse' }) })
    expect(good.status).toBe(200)
    const cookie = good.headers.get('set-cookie') || ''
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    const withCookie = await fetch(`${s.base}/api/stats`, { headers: { Cookie: cookie.split(';')[0] } })
    expect(withCookie.status).toBe(200)
  })

  it('still serves the page and mascot without a token', async () => {
    expect((await fetch(`${s.base}/`)).status).toBe(200)
    expect((await fetch(`${s.base}/mascot/mascot.lottie`)).status).toBe(200)
  })
})

describe('URL fetching', () => {
  let page: Server
  let pageUrl: string
  beforeAll(async () => {
    page = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html><title>Intranet</title><body>internal wiki</body></html>') }).listen(0, '127.0.0.1')
    await new Promise(resolve => page.once('listening', resolve))
    pageUrl = `http://127.0.0.1:${(page.address() as AddressInfo).port}/`
  })
  afterAll(() => page.close())

  it('classifies private and public addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0']) {
      expect(isPrivateAddress(a), a).toBe(true)
    }
    for (const a of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) {
      expect(isPrivateAddress(a), a).toBe(false)
    }
  })

  it('blocks private addresses when asked, by IP and by hostname', async () => {
    await expect(extractUrl(pageUrl, { blockPrivate: true })).rejects.toThrow(/private address/)
    await expect(extractUrl(pageUrl.replace('127.0.0.1', 'localhost'), { blockPrivate: true })).rejects.toThrow(/private address/)
  })

  it('still fetches private addresses for local CLI use', async () => {
    const doc = await extractUrl(pageUrl)
    expect(doc.content).toContain('internal wiki')
    expect(doc.metadata.title).toBe('Intranet')
  })
})

describe('config persistence', () => {
  it('never writes API keys to disk', () => {
    const dir = join(work, 'persist')
    const saved = { ...process.env }
    try {
      const duct = new Duct({ persistPath: dir })
      duct.configure({ openaiKey: 'sk-test-should-not-persist', chunkSize: 900 })
      duct.close()
      for (const f of readdirSync(dir)) {
        expect(readFileSync(join(dir, f)).includes('sk-test-should-not-persist'), f).toBe(false)
      }
      const reopened = new Duct({ persistPath: dir })
      expect(reopened.getConfig().chunkSize).toBe(900)
      reopened.close()
    } finally {
      process.env = saved
    }
  })

  it('imports settings from an old config.json without its keys', () => {
    const dir = join(work, 'old-config')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ chunkSize: 650, openaiKey: 'sk-old-plaintext' }))
    const duct = new Duct({ persistPath: dir })
    expect(duct.getConfig().chunkSize).toBe(650)
    duct.close()
    expect(existsSync(join(dir, 'config.json'))).toBe(false)
    for (const f of readdirSync(dir).filter(f => f.startsWith('duct.db'))) {
      expect(readFileSync(join(dir, f)).includes('sk-old-plaintext'), f).toBe(false)
    }
  })
})
