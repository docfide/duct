import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duct } from '../src/index.js'
import { createServer } from '../src/server.js'
import { Collections } from '../src/api/collections.js'
import { makeTextPdf } from './helpers.js'

const work = mkdtempSync(join(tmpdir(), 'duct-devapi-'))
let duct: Duct
let collections: Collections
let server: Server
let base: string
let adminKey: string
let searchKey: string

const call = (path: string, key: string | null, init: { method?: string; body?: unknown; form?: FormData } = {}) => fetch(`${base}/v1${path}`, {
  method: init.method ?? (init.body || init.form ? 'POST' : 'GET'),
  headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  body: init.form ?? (init.body ? JSON.stringify(init.body) : undefined),
})
const ok = async (res: Response, status = 200) => {
  const text = await res.text()
  expect(res.status, text).toBe(status)
  return text ? JSON.parse(text) : null
}

beforeAll(async () => {
  duct = new Duct({ persistPath: join(work, 'index'), embed: false })
  collections = new Collections(duct)
  adminKey = duct.createApiKey('test admin', ['admin']).key
  searchKey = duct.createApiKey('frontend', ['search'], ['contracts']).key
  server = createServer(duct, { authToken: 'server-admin', collections, libraryDir: join(work, 'library') }).listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  server.close()
  collections.close()
  duct.close()
  rmSync(work, { recursive: true, force: true })
})

describe('developer API', () => {
  it('requires an API key, and never accepts the UI cookie', async () => {
    expect((await call('/', null)).status).toBe(401)
    expect((await call('/', 'duct_000000000000_' + 'x'.repeat(32))).status).toBe(401)
    const cookie = await fetch(`${base}/v1/`, { headers: { Cookie: 'duct_token=server-admin' } })
    expect(cookie.status).toBe(401)
    expect((await ok(await call('/', 'server-admin'))).scopes).toEqual(['search', 'write', 'admin'])
    expect((await fetch(`${base}/v1/openapi.json`)).status).toBe(200)
  })

  it('creates collections as separate indexes on disk', async () => {
    const created = await ok(await call('/collections', adminKey, { body: { name: 'contracts' } }), 201)
    expect(created).toMatchObject({ name: 'contracts', documents: 0 })
    expect(existsSync(join(work, 'index', 'collections', 'contracts', 'duct.db'))).toBe(true)
    expect((await call('/collections', adminKey, { body: { name: 'contracts' } })).status).toBe(409)
    expect((await call('/collections', adminKey, { body: { name: '../evil' } })).status).toBe(400)
    expect((await call('/collections', searchKey, { body: { name: 'other' } })).status).toBe(403)
  })

  it('indexes text by id, skips unchanged text and replaces changed text', async () => {
    const docs = [
      { id: 'c-1', title: 'Acme supply agreement', text: 'Either party may terminate this agreement with ninety days notice.', metadata: { client: 'acme', year: 2025 } },
      { id: 'c-2', title: 'Globex NDA', pages: ['Confidential information stays confidential.', 'This NDA terminates after three years.'], metadata: { client: 'globex', year: 2026 } },
      { id: 'c-3', text: 'Payment is due within thirty days of invoice.', metadata: { client: 'acme', year: 2026 } },
    ]
    const first = await ok(await call('/collections/contracts/documents', adminKey, { body: { documents: docs } }))
    expect(first.results.map((r: { status: string }) => r.status)).toEqual(['indexed', 'indexed', 'indexed'])
    const again = await ok(await call('/collections/contracts/documents', adminKey, { body: { documents: docs } }))
    expect(again.results.every((r: { status: string }) => r.status === 'unchanged')).toBe(true)
    const put = await ok(await call('/collections/contracts/documents/c-3', adminKey, { method: 'PUT', body: { text: 'Payment is due within sixty days of invoice.', metadata: { client: 'acme', year: 2026 } } }))
    expect(put.status).toBe('indexed')
    expect((await ok(await call('/collections/contracts/documents/c-3?include=text', searchKey))).text).toContain('sixty days')
  })

  it('validates a whole batch before indexing any of it', async () => {
    const res = await call('/collections/contracts/documents', adminKey, { body: { documents: [{ id: 'ok-1', text: 'fine' }, { id: 'bad id!', text: 'x' }] } })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('invalid_id')
    expect((await call('/collections/contracts/documents/ok-1', adminKey)).status).toBe(404)
    expect((await call('/collections/contracts/documents', adminKey, { body: { documents: [{ id: 'm', text: 'x', metadata: { nested: { a: 1 } } }] } })).status).toBe(400)
  })

  it('searches with word forms, highlights, pages, filters, facets and pagination', async () => {
    const r = await ok(await call('/collections/contracts/search?q=termination', searchKey))
    expect(r.hits.map((h: { id: string }) => h.id).sort()).toEqual(['c-1', 'c-2'])
    const nda = r.hits.find((h: { id: string }) => h.id === 'c-2')
    expect(nda).toMatchObject({ title: 'Globex NDA', page: 2, page_label: 'p. 2', metadata: { client: 'globex', year: 2026 } })
    expect(nda.highlight).toContain('<mark>terminates</mark>')
    expect(nda.snippet).not.toContain('<mark>')

    const filtered = await ok(await call('/collections/contracts/search', searchKey, { body: { q: 'terminate', filter: { client: 'acme' } } }))
    expect(filtered.hits.map((h: { id: string }) => h.id)).toEqual(['c-1'])

    const faceted = await ok(await call('/collections/contracts/search', searchKey, { body: { q: '', facets: ['client', 'year'] } }))
    expect(faceted.facets).toEqual({ client: { acme: 2, globex: 1 }, year: { '2026': 2, '2025': 1 } })

    const page1 = await ok(await call('/collections/contracts/search?q=days&limit=1', searchKey))
    expect(page1.hits).toHaveLength(1)
    expect(page1.has_more).toBe(true)
    const page2 = await ok(await call('/collections/contracts/search?q=days&limit=1&offset=1', searchKey))
    expect(page2.hits[0].id).not.toBe(page1.hits[0].id)
  })

  it('sorts matches by a metadata field', async () => {
    const asc = await ok(await call('/collections/contracts/search', searchKey, { body: { q: 'days', sort: 'year:asc' } }))
    expect(asc.hits.map((h: { metadata: { year: number } }) => h.metadata.year)).toEqual([2025, 2026])
    const desc = await ok(await call('/collections/contracts/search?q=days&sort=year:desc', searchKey))
    expect(desc.hits.map((h: { metadata: { year: number } }) => h.metadata.year)).toEqual([2026, 2025])
    expect((await call('/collections/contracts/search?q=days&sort=year', searchKey)).status).toBe(400)
  })

  it('reads uploaded files with the same extractors as the app', async () => {
    const form = new FormData()
    form.append('file', new Blob([makeTextPdf([[[12, 700, 'Cover page']], [[12, 700, 'The indemnity clause survives termination.']]])]), 'msa.pdf')
    form.append('id', 'msa-2026')
    form.append('metadata', JSON.stringify({ client: 'initech' }))
    const doc = await ok(await call('/collections/contracts/files', adminKey, { form }))
    expect(doc).toMatchObject({ id: 'msa-2026', title: 'msa.pdf', format: 'pdf', status: 'indexed' })
    const hits = (await ok(await call('/collections/contracts/search?q=indemnity', searchKey))).hits
    expect(hits[0]).toMatchObject({ id: 'msa-2026', page: 2, format: 'pdf', metadata: { client: 'initech' } })

    const bad = new FormData()
    bad.append('file', new Blob(['x']), 'tool.exe')
    expect((await call('/collections/contracts/files', adminKey, { form: bad })).status).toBe(415)

    expect((await call('/collections/contracts/documents/msa-2026', adminKey, { method: 'DELETE' })).status).toBe(204)
    expect((await ok(await call('/collections/contracts/search?q=indemnity', searchKey))).hits).toHaveLength(0)
    expect(existsSync(join(work, 'index', 'collections', 'contracts', 'files', 'msa-2026'))).toBe(false)
  })

  it('keeps collections apart and enforces key scopes and collection limits', async () => {
    await ok(await call('/collections', adminKey, { body: { name: 'hr' } }), 201)
    await ok(await call('/collections/hr/documents', adminKey, { body: { documents: [{ id: 'h1', text: 'Salary review terminates in March.' }] } }))
    expect((await ok(await call('/collections/contracts/search?q=salary', adminKey))).hits).toHaveLength(0)
    expect((await call('/collections/hr/search?q=salary', searchKey)).status).toBe(404)
    expect((await call('/collections/contracts/documents/c-1', searchKey, { method: 'DELETE' })).status).toBe(403)
    expect((await ok(await call('/collections', searchKey))).collections.map((c: { name: string }) => c.name)).toEqual(['contracts'])
    // The main index (the app's documents) is untouched by API documents.
    expect(duct.stats().documents).toBe(0)
  })

  it('manages keys; a limited key cannot widen its reach', async () => {
    const limitedAdmin = (await ok(await call('/keys', adminKey, { body: { name: 'hr admin', scopes: ['admin'], collections: ['hr'] } }), 201)).key
    const made = await ok(await call('/keys', limitedAdmin, { body: { name: 'sneaky', scopes: ['search'], collections: ['contracts', 'hr'] } }), 201)
    expect(made.collections).toEqual(['hr'])
    const list = await ok(await call('/keys', adminKey))
    expect(list.keys.some((k: { name: string }) => k.name === 'sneaky')).toBe(true)
    expect(JSON.stringify(list)).not.toContain(made.key)
    expect((await call(`/keys/${made.id}`, adminKey, { method: 'DELETE' })).status).toBe(204)
    expect((await call('/', made.key)).status).toBe(401)
  })

  it('answers 403 when the Developer API is switched off', async () => {
    duct.setFeatures({ developerApi: false })
    const res = await call('/collections', adminKey)
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('feature_disabled')
    duct.setFeatures({ developerApi: true })
  })

  it('deletes a collection with its files', async () => {
    expect((await call('/collections/hr', adminKey, { method: 'DELETE' })).status).toBe(204)
    expect(existsSync(join(work, 'index', 'collections', 'hr'))).toBe(false)
    expect((await call('/collections/hr', adminKey)).status).toBe(404)
  })

  it('returns JSON errors for bad JSON', async () => {
    const res = await fetch(`${base}/v1/collections`, { method: 'POST', headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' }, body: '{nope' })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('invalid_json')
  })
})

describe('TypeScript client', () => {
  it('drives the API end to end', async () => {
    const { DuctClient, DuctApiError } = await import('../src/api/client.js')
    const client = new DuctClient({ url: base + '/', key: adminKey })
    await client.createCollection('help')
    await client.upsertMany('help', [{ id: 'refunds', title: 'Refunds', text: 'Refunds take five working days.', metadata: { lang: 'en' } }])
    const r = await client.search('help', { q: 'refund', facets: ['lang'] })
    expect(r.hits[0]).toMatchObject({ id: 'refunds', title: 'Refunds' })
    expect(r.facets).toEqual({ lang: { en: 1 } })
    const file = await client.uploadFile('help', new Blob([makeTextPdf([[[12, 700, 'Shipping takes two days.']]])]), { filename: 'shipping.pdf', id: 'shipping' })
    expect(file.status).toBe('indexed')
    expect((await client.getDocument('help', 'refunds', { includeText: true })).text).toContain('five')
    await client.deleteDocument('help', 'refunds')
    await expect(client.getDocument('help', 'refunds')).rejects.toBeInstanceOf(DuctApiError)
    await client.deleteCollection('help')
  })
})
