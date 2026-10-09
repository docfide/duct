import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duct } from '../src/index.js'
import { createServer } from '../src/server.js'
import type { OidcLogin } from '../src/oidc.js'
import { notebookPage, parseSharedNotebook } from '../src/notebook-page.js'

describe('notebooks', () => {
  let dir: string
  let duct: Duct
  let server: Server
  let base: string
  let doc: string
  let deck: string

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, res, json: res.headers.get('content-type')?.includes('json') ? await res.json() : undefined }
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'duct-notebooks-'))
    doc = join(dir, 'lease.md')
    writeFileSync(doc, '# Lease\n\nThe tenant may terminate this lease with 60 days written notice.\n\nRent is due on the first of the month.')
    deck = join(dir, 'terms.html')
    writeFileSync(deck, '<html><body><h1>Terms</h1><p>Either party may terminate for convenience.</p></body></html>')
    duct = new Duct()
    await duct.index([doc, deck])
    server = createServer(duct, { libraryDir: join(dir, 'library') }).listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates, renames and lists notebooks', async () => {
    const made = await call('POST', '/api/notebooks', { name: '  Acme   lease review ' })
    expect(made.status).toBe(201)
    expect(made.json.notebook.name).toBe('Acme lease review')
    expect((await call('PATCH', `/api/notebooks/${made.json.notebook.id}`, { name: 'Acme' })).status).toBe(200)
    const list = await call('GET', '/api/notebooks')
    expect(list.json.notebooks.map((b: { name: string }) => b.name)).toContain('Acme')
    expect((await call('PATCH', '/api/notebooks/nope', { name: 'x' })).status).toBe(404)
  })

  it('adds notes from two documents, comments on them and reorders them', async () => {
    const { json: { notebook } } = await call('POST', '/api/notebooks', { name: 'Termination' })
    const a = await call('POST', `/api/notebooks/${notebook.id}/notes`, { path: doc, quote: 'terminate this lease with 60 days written notice' })
    const b = await call('POST', `/api/notebooks/${notebook.id}/notes`, { path: deck, quote: 'Either party may terminate for convenience.', page: 2 })
    expect(a.status).toBe(201)
    expect(a.json.note.docName).toBe('lease.md')
    expect(a.json.note.page).toBeNull()
    expect(b.json.note.page).toBe(2)

    expect((await call('PATCH', `/api/notes/${a.json.note.id}`, { comment: 'Notice period is 60 days' })).status).toBe(200)
    await call('PUT', `/api/notebooks/${notebook.id}/order`, { ids: [b.json.note.id, a.json.note.id] })

    const { json } = await call('GET', `/api/notebooks/${notebook.id}/notes`)
    expect(json.notes.map((n: { id: string }) => n.id)).toEqual([b.json.note.id, a.json.note.id])
    expect(json.notes[1].comment).toBe('Notice period is 60 days')
    expect(json.notebook.notes).toBe(2)

    await call('DELETE', `/api/notes/${b.json.note.id}`)
    expect((await call('GET', `/api/notebooks/${notebook.id}/notes`)).json.notes).toHaveLength(1)
  })

  it('refuses notes for unknown documents, empty quotes and unknown notebooks', async () => {
    const { json: { notebook } } = await call('POST', '/api/notebooks', { name: 'Refusals' })
    expect((await call('POST', `/api/notebooks/${notebook.id}/notes`, { path: '/etc/passwd', quote: 'root' })).status).toBe(404)
    expect((await call('POST', `/api/notebooks/${notebook.id}/notes`, { path: doc, quote: '   ' })).status).toBe(400)
    expect((await call('POST', '/api/notebooks/nope/notes', { path: doc, quote: 'x' })).status).toBe(404)
  })

  it('exports a notebook with sources and comments', async () => {
    const { json: { notebook } } = await call('POST', '/api/notebooks', { name: 'Export me' })
    expect((await call('GET', `/api/notebooks/${notebook.id}/export?format=md`)).status).toBe(400)  // nothing in it yet
    const note = (await call('POST', `/api/notebooks/${notebook.id}/notes`, { path: doc, quote: 'Rent is due on the first of the month.' })).json.note
    await call('PATCH', `/api/notes/${note.id}`, { comment: 'Check against schedule 2' })

    const md = await (await fetch(`${base}/api/notebooks/${notebook.id}/export?format=md`)).text()
    expect(md).toContain('# Export me')
    expect(md).toContain('> Rent is due on the first of the month.')
    expect(md).toContain('lease.md')
    expect(md).toContain('Check against schedule 2')

    const csv = await (await fetch(`${base}/api/notebooks/${notebook.id}/export?format=csv`)).text()
    expect(csv).toContain('"note"')
    expect(csv).toContain('Check against schedule 2')

    const docx = await fetch(`${base}/api/notebooks/${notebook.id}/export?format=docx`)
    expect(docx.status).toBe(200)
    const zip = await (await import('jszip')).default.loadAsync(await docx.arrayBuffer())
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml).toContain('Check against schedule 2')
    expect(xml).toContain('Rent is due on the first of the month.')
  })

  it('deleting a notebook deletes its notes', async () => {
    const { json: { notebook } } = await call('POST', '/api/notebooks', { name: 'Temporary' })
    const note = (await call('POST', `/api/notebooks/${notebook.id}/notes`, { path: doc, quote: 'Lease' })).json.note
    expect((await call('DELETE', `/api/notebooks/${notebook.id}`)).status).toBe(200)
    expect((await call('DELETE', `/api/notes/${note.id}`)).status).toBe(404)
    expect((await call('GET', `/api/notebooks/${notebook.id}/notes`)).status).toBe(404)
  })

  it('serves a document as text sections for the workspace', async () => {
    const { status, json } = await call('GET', `/api/document-text?path=${encodeURIComponent(doc)}`)
    expect(status).toBe(200)
    expect(json.format).toBe('md')
    expect(json.sections.map((s: { text: string }) => s.text).join('\n')).toContain('60 days written notice')
    expect((await call('GET', '/api/document-text?path=/etc/passwd')).status).toBe(404)
  })
})

describe('notebooks on a shared server: notes follow who may see the document they quote', () => {
  it('leaves out, doesn\'t count, export, change or delete notes from documents a person can\'t see', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duct-notebooks-acl-'))
    const open = join(dir, 'handbook.txt')
    const secret = join(dir, 'salaries.txt')
    writeFileSync(open, 'Payroll is paid on the 25th.')
    writeFileSync(secret, 'The payroll budget for 2027 rises by eight percent.')
    const duct = new Duct({ embed: false })
    await duct.index([open, secret])
    duct.setDocumentAccess(secret, ['user:boss@okafor.ng'])
    const server = createServer(duct, { libraryDir: join(dir, 'library'), authToken: 'admin-t', memberTokens: ['member-t'], allowedHosts: '*' }).listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const as = (t: string) => async (method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      return { status: res.status, json: res.headers.get('content-type')?.includes('json') ? await res.json() : undefined, text: res.headers.get('content-type')?.includes('json') ? '' : await res.text() }
    }
    const admin = as('admin-t')
    const member = as('member-t')
    try {
      const nb = (await admin('POST', '/api/notebooks', { name: 'Payroll' })).json.notebook.id
      await admin('POST', `/api/notebooks/${nb}/notes`, { path: open, quote: 'Payroll is paid on the 25th.' })
      const hiddenNote = (await admin('POST', `/api/notebooks/${nb}/notes`, { path: secret, quote: 'rises by eight percent' })).json.note.id
      expect((await member('POST', `/api/notebooks/${nb}/notes`, { path: secret, quote: 'x' })).status).toBe(404)

      expect((await admin('GET', `/api/notebooks/${nb}/notes`)).json.notes).toHaveLength(2)
      const seen = await member('GET', `/api/notebooks/${nb}/notes`)
      expect(seen.json.notes.map((n: { quote: string }) => n.quote)).toEqual(['Payroll is paid on the 25th.'])
      expect(seen.json.notebook.notes).toBe(1)
      expect((await member('GET', '/api/notebooks')).json.notebooks[0].notes).toBe(1)
      const exported = await member('GET', `/api/notebooks/${nb}/export?format=md`)
      expect(exported.text).toContain('paid on the 25th')
      expect(exported.text).not.toContain('eight percent')

      expect((await member('PATCH', `/api/notes/${hiddenNote}`, { comment: 'x' })).status).toBe(404)
      expect((await member('DELETE', `/api/notes/${hiddenNote}`)).status).toBe(404)
      expect((await member('DELETE', `/api/notebooks/${nb}`)).status).toBe(403)
      expect((await admin('GET', `/api/notebooks/${nb}/notes`)).json.notes).toHaveLength(2)
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('shared notebooks on a server where people sign in', () => {
  let dir: string
  let duct: Duct
  let server: Server
  let base: string
  let lease: string
  let salaries: string

  // A stand-in for OIDC sign-in: the person is whoever the X-Test-User header names.
  const fakeOidc = {
    session: (req: { headers: Record<string, unknown> }) => {
      const email = req.headers['x-test-user']
      return typeof email === 'string' ? { email, role: email === 'boss@okafor.ng' ? 'admin' : 'member' } : null
    },
    router: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  } as unknown as OidcLogin

  const as = (email: string) => async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'X-Test-User': email, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const isJson = res.headers.get('content-type')?.includes('json')
    return { status: res.status, json: isJson ? await res.json() : undefined, text: isJson ? '' : await res.text() }
  }
  const ada = as('ada@okafor.ng')
  const ben = as('ben@okafor.ng')
  const boss = as('boss@okafor.ng')
  const guest = as('guest@elsewhere.com')

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'duct-shared-notebooks-'))
    lease = join(dir, 'lease.md')
    salaries = join(dir, 'salaries.txt')
    writeFileSync(lease, 'The tenant may terminate this lease with 60 days written notice.')
    writeFileSync(salaries, 'The payroll budget for 2027 rises by eight percent.')
    duct = new Duct({ embed: false })
    await duct.index([lease, salaries])
    duct.setDocumentAccess(salaries, ['user:ada@okafor.ng'])
    server = createServer(duct, { libraryDir: join(dir, 'library'), oidc: fakeOidc, allowedHosts: '*', audit: {} }).listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a new notebook is private to whoever made it, even from admins', async () => {
    const made = await ada('POST', '/api/notebooks', { name: 'Ada private' })
    expect(made.json.notebook).toMatchObject({ owner: 'ada@okafor.ng', role: 'owner', sharing: [] })
    const id = made.json.notebook.id
    const list = await ada('GET', '/api/notebooks')
    expect(list.json).toMatchObject({ sharing: true, me: 'ada@okafor.ng' })
    expect(list.json.notebooks.map((b: { id: string }) => b.id)).toContain(id)
    for (const other of [ben, boss]) {
      expect((await other('GET', '/api/notebooks')).json.notebooks.map((b: { id: string }) => b.id)).not.toContain(id)
      expect((await other('GET', `/api/notebooks/${id}/notes`)).status).toBe(404)
      expect((await other('GET', `/api/notebooks/${id}/export?format=md`)).status).toBe(404)
      expect((await other('PATCH', `/api/notebooks/${id}`, { name: 'mine now' })).status).toBe(404)
    }
  })

  it('sharing to read lets people read and export, not change', async () => {
    const id = (await ada('POST', '/api/notebooks', { name: 'Lease review' })).json.notebook.id
    const note = (await ada('POST', `/api/notebooks/${id}/notes`, { path: lease, quote: '60 days written notice' })).json.note
    expect(note.author).toBe('ada@okafor.ng')

    const shared = await ada('PUT', `/api/notebooks/${id}/sharing`, { sharing: [{ to: 'Ben@Okafor.ng' }, { to: 'ada@okafor.ng', can: 'edit' }] })
    expect(shared.json.sharing).toEqual([{ to: 'user:ben@okafor.ng', can: 'view' }])  // the owner is left out

    const seen = await ben('GET', `/api/notebooks/${id}/notes`)
    expect(seen.json.notebook).toMatchObject({ role: 'view', owner: 'ada@okafor.ng', sharing: [] })
    expect(seen.json.notes[0].quote).toBe('60 days written notice')
    expect((await ben('GET', `/api/notebooks/${id}/export?format=md`)).text).toContain('60 days written notice')

    const refused = await ben('POST', `/api/notebooks/${id}/notes`, { path: lease, quote: 'terminate' })
    expect(refused.status).toBe(403)
    expect(refused.json.error).toMatch(/read this notebook but not change it\. Ask ada@okafor\.ng/)
    expect((await ben('PATCH', `/api/notes/${note.id}`, { comment: 'x' })).status).toBe(403)
    expect((await ben('DELETE', `/api/notes/${note.id}`)).status).toBe(403)
    expect((await ben('PUT', `/api/notebooks/${id}/order`, { ids: [note.id] })).status).toBe(403)
    expect((await guest('GET', `/api/notebooks/${id}/notes`)).status).toBe(404)
  })

  it('sharing with a domain to edit lets its people add and comment, but only the owner renames, shares or deletes', async () => {
    const id = (await ada('POST', '/api/notebooks', { name: 'Team notes' })).json.notebook.id
    await ada('PUT', `/api/notebooks/${id}/sharing`, { sharing: [{ to: 'okafor.ng', can: 'edit' }, { to: 'ben@okafor.ng', can: 'view' }] })

    const added = await ben('POST', `/api/notebooks/${id}/notes`, { path: lease, quote: 'The tenant may terminate' })
    expect(added.status).toBe(201)
    expect(added.json.note.author).toBe('ben@okafor.ng')
    expect((await ben('PATCH', `/api/notes/${added.json.note.id}`, { comment: 'Ben was here' })).status).toBe(200)
    expect((await ben('GET', '/api/notebooks')).json.notebooks.find((b: { id: string }) => b.id === id).role).toBe('edit')  // the stronger grant wins

    expect((await ben('PATCH', `/api/notebooks/${id}`, { name: 'x' })).status).toBe(403)
    expect((await ben('PUT', `/api/notebooks/${id}/sharing`, { sharing: [] })).status).toBe(403)
    expect((await ben('DELETE', `/api/notebooks/${id}`)).status).toBe(403)
    expect((await guest('GET', `/api/notebooks/${id}/notes`)).status).toBe(404)  // another domain

    expect((await ada('PUT', `/api/notebooks/${id}/sharing`, { sharing: [{ to: 'not a person' }] })).status).toBe(400)
    await ada('PUT', `/api/notebooks/${id}/sharing`, { sharing: [] })
    expect((await ben('GET', `/api/notebooks/${id}/notes`)).status).toBe(404)
    const log = duct.auditLog({ limit: 50 }).map(e => e.detail)
    expect(log).toContain('shared a notebook with ben@okafor.ng (view), okafor.ng (edit)')
    expect(log).toContain('stopped sharing a notebook')
  })

  it('sharing a notebook never shares the documents it quotes', async () => {
    const id = (await ada('POST', '/api/notebooks', { name: 'Budget' })).json.notebook.id
    await ada('POST', `/api/notebooks/${id}/notes`, { path: salaries, quote: 'rises by eight percent' })
    await ada('POST', `/api/notebooks/${id}/notes`, { path: lease, quote: '60 days' })
    await ada('PUT', `/api/notebooks/${id}/sharing`, { sharing: [{ to: 'anyone', can: 'edit' }] })
    const seen = await guest('GET', `/api/notebooks/${id}/notes`)
    expect(seen.json.notes.map((n: { quote: string }) => n.quote)).toEqual(['60 days'])
    expect(seen.json.notebook.notes).toBe(1)
    const page = await guest('GET', `/api/notebooks/${id}/export?format=html`)
    expect(page.text).toContain('60 days')
    expect(page.text).not.toContain('eight percent')
  })

  it('a public link opens the notebook for anyone, as its owner sees it, without saying who wrote what', async () => {
    const id = (await ada('POST', '/api/notebooks', { name: 'Public brief' })).json.notebook.id
    await ada('POST', `/api/notebooks/${id}/notes`, { path: lease, quote: 'The tenant may terminate', comment: 'Ada’s comment' })
    await ada('POST', `/api/notebooks/${id}/notes`, { path: salaries, quote: 'rises by eight percent' })
    expect((await ben('POST', `/api/notebooks/${id}/public-link`)).status).toBe(404)  // not his to see, let alone publish

    const made = await ada('POST', `/api/notebooks/${id}/public-link`)
    expect(made.status).toBe(201)
    const link = made.json.publicLink as string
    expect(link).toMatch(/^\/n\/[\w-]{24}$/)

    const page = await fetch(base + link)  // no sign-in
    const html = await page.text()
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(page.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(html).toContain('The tenant may terminate')
    expect(html).toContain('rises by eight percent')   // Ada can open the salary review, and chose to publish
    expect(html).toContain('Ada’s comment')
    expect(html).not.toContain('ada@okafor.ng')         // no names of who added notes, or who shared

    await fetch(base + link)
    const listed = (await ada('GET', '/api/notebooks')).json
    expect(listed.publicLinks).toBe(true)
    expect(listed.notebooks.find((b: { id: string }) => b.id === id)).toMatchObject({ publicLink: link, publicViews: 2 })
    await ada('PUT', `/api/notebooks/${id}/sharing`, { sharing: [{ to: 'ben@okafor.ng' }] })
    const forBen = (await ben('GET', '/api/notebooks')).json.notebooks.find((b: { id: string }) => b.id === id)
    expect(forBen.publicLink).toBeUndefined()           // the link is the owner's to hand out
    expect(forBen.publicToken).toBeUndefined()

    // A new link replaces the old; turning it off ends it.
    const again = (await ada('POST', `/api/notebooks/${id}/public-link`)).json.publicLink
    expect((await fetch(base + link)).status).toBe(404)
    await ada('DELETE', `/api/notebooks/${id}/public-link`)
    expect((await fetch(base + again)).status).toBe(404)

    // Admins can switch public links off for the whole server.
    const relink = (await ada('POST', `/api/notebooks/${id}/public-link`)).json.publicLink
    duct.setFeatures({ publicLinks: false })
    expect((await fetch(base + relink)).status).toBe(404)
    expect((await ada('POST', `/api/notebooks/${id}/public-link`)).status).toBe(403)
    duct.setFeatures({ publicLinks: true })
  })

  it('notebooks from before sharing stay everyone’s', async () => {
    const old = duct.createNotebook('From 0.x')
    expect((await ben('GET', `/api/notebooks/${old.id}/notes`)).json.notebook.role).toBe('edit')
    expect((await boss('GET', `/api/notebooks/${old.id}/notes`)).json.notebook.role).toBe('owner')
    expect((await ben('POST', `/api/notebooks/${old.id}/notes`, { path: lease, quote: 'lease' })).status).toBe(201)
  })
})

describe('a notebook as a page to send', () => {
  const notes = [
    { quote: 'Either party may terminate </script><script>alert(1)</script> for convenience.', doc: 'MSA <final>.pdf', page: 4, pageLabel: 'Page', format: 'pdf', comment: 'Line one\nLine two', author: 'ada@okafor.ng' },
    { quote: 'Rent is due on the first.', doc: 'lease.md', format: 'md', author: 'ben@okafor.ng' },
  ]

  it('is one file with no scripts, escapes what it shows, and leaves out file paths', () => {
    const html = notebookPage({ name: 'Acme & co', notes }, { sharedBy: 'ada@okafor.ng', date: new Date('2026-10-09') })
    expect(html).toContain('<title>Acme &amp; co</title>')
    expect(html).toContain('2 quotes from 2 documents · shared by ada@okafor.ng · 9 October 2026')
    expect(html).toContain('MSA &lt;final&gt;.pdf')
    expect(html).toContain('Page 4')
    expect(html).toContain('Line one<br>Line two')
    expect(html).toContain('added by ben@okafor.ng')
    expect(html).not.toMatch(/<script(?![^>]*application\/json)/)
    expect(html.match(/<\/script>/g)).toHaveLength(1)  // only the data block's own end
    expect(html).toContain("default-src 'none'")
  })

  it('reads back what it carries, and Duct’s JSON export too', () => {
    const back = parseSharedNotebook(notebookPage({ name: 'Acme', notes }))
    expect(back).toEqual({ name: 'Acme', notes })
    const fromExport = parseSharedNotebook(JSON.stringify({ title: 'Collected', items: [{ name: 'a.pdf', path: '/x/a.pdf', location: 'Slide 3', text: 'Quote', note: 'Mine' }] }))
    expect(fromExport).toEqual({ name: 'Collected', notes: [{ quote: 'Quote', doc: 'a.pdf', page: 3, pageLabel: 'Slide', comment: 'Mine' }] })
    expect(parseSharedNotebook('<html>not one</html>')).toBeNull()
    expect(parseSharedNotebook('{"name":"x"}')).toBeNull()
  })

  it('imports into a notebook, matching documents this Duct has by name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duct-import-'))
    const lease = join(dir, 'lease.md')
    writeFileSync(lease, 'Rent is due on the first.')
    const duct = new Duct({ embed: false })
    await duct.index(lease)
    const server = createServer(duct, { libraryDir: join(dir, 'library') }).listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const post = (body: unknown) => fetch(`${base}/api/notebooks/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    try {
      const res = await post({ content: notebookPage({ name: 'From Ada', notes }) })
      expect(res.status).toBe(201)
      const { notebook } = await res.json()
      expect(notebook).toMatchObject({ name: 'From Ada', notes: 2 })
      const got = duct.listNotes(notebook.id)
      expect(got.map(n => n.path)).toEqual(['shared:MSA <final>.pdf', lease])
      expect(got[0]).toMatchObject({ page: 4, comment: 'Line one\nLine two', author: 'ada@okafor.ng' })
      expect((await post({ content: 'hello' })).status).toBe(400)
      // Public links need a server where people sign in; here the page file is the way to share.
      const refused = await fetch(`${base}/api/notebooks/${notebook.id}/public-link`, { method: 'POST' })
      expect(refused.status).toBe(403)
      expect((await refused.json()).error).toMatch(/send the notebook as a page/)
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('links hosted by Tensflare, from the desktop app', () => {
  it('uploads only quotes, names, pages and comments, replaces old links, and takes them down', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duct-hosted-'))
    const lease = join(dir, 'lease.md')
    writeFileSync(lease, 'The tenant may terminate this lease with 60 days written notice.')
    const duct = new Duct({ embed: false })
    await duct.index(lease)
    let signedIn = false
    const published: unknown[] = []
    const removed: string[] = []
    const account = {
      status: () => ({ signedIn, plan: 'free', entitlements: [], limits: {} }),
      publishNotebook: async (notebook: unknown, days: number) => { published.push({ notebook, days }); const id = `link${published.length}`.padEnd(22, 'x'); return { id, url: `https://accounts.tensflare.com/n/${id}`, expiresAt: '2026-11-08T00:00:00.000Z' } },
      removeNotebookLink: async (id: string) => { removed.push(id) },
    } as never
    const server = createServer(duct, { libraryDir: join(dir, 'library'), account }).listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      return { status: res.status, json: await res.json() }
    }
    try {
      const nb = duct.createNotebook('For Bola')
      duct.addNote(nb.id, { path: lease, quote: '60 days written notice', page: 2, comment: 'Check this', author: 'ada@okafor.ng' })
      expect((await call('GET', '/api/notebooks')).json).toMatchObject({ hostedLinks: true, signedIn: false })

      const refused = await call('POST', `/api/notebooks/${nb.id}/hosted-link`, { days: 7 })
      expect(refused.status).toBe(409)
      expect(refused.json.code).toBe('signin')
      expect(published).toHaveLength(0)

      signedIn = true
      const made = await call('POST', `/api/notebooks/${nb.id}/hosted-link`, { days: 7 })
      expect(made.status).toBe(201)
      expect(made.json.hostedLink.url).toMatch(/^https:\/\/accounts\.tensflare\.com\/n\//)
      expect(published[0]).toEqual({ days: 7, notebook: { name: 'For Bola', notes: [{ quote: '60 days written notice', doc: 'lease.md', page: 2, pageLabel: 'p.', comment: 'Check this' }] } })
      expect(JSON.stringify(published)).not.toContain(dir)            // no paths
      expect(JSON.stringify(published)).not.toContain('ada@okafor.ng') // no authors

      await call('POST', `/api/notebooks/${nb.id}/hosted-link`, { days: 30 })
      expect(removed).toEqual(['link1'.padEnd(22, 'x')])              // the new link replaced the old one
      expect((await call('GET', '/api/notebooks')).json.notebooks[0].hostedLink.url).toContain('link2')

      expect((await call('DELETE', `/api/notebooks/${nb.id}/hosted-link`)).status).toBe(200)
      expect(removed).toHaveLength(2)
      expect((await call('GET', '/api/notebooks')).json.notebooks[0].hostedLink).toBeNull()
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
