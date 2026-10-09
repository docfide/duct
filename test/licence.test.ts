import { describe, it, expect, afterEach } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duct } from '../src/index.js'
import { createServer } from '../src/server.js'
import { TeamLicence, EVALUATION_DAYS } from '../src/team/licence.js'
import type { OidcLogin } from '../src/team/oidc.js'

const DAY = 86_400_000

describe('the team licence', () => {
  it('runs a 30-day evaluation from the first check, then needs the entitlement', () => {
    let now = Date.parse('2026-10-09T00:00:00Z')
    const duct = new Duct({ embed: false })
    let has = false
    const account = { has: () => has, status: () => ({ signedIn: true }) } as never
    const licence = new TeamLicence(duct, account, () => now)
    expect(licence.status()).toMatchObject({ active: true, state: 'evaluation', evaluationEndsAt: now + EVALUATION_DAYS * DAY })
    now += 31 * DAY
    expect(licence.status()).toMatchObject({ active: false, state: 'lapsed' })
    expect(licence.status().message).toMatch(/renew it from Settings › Account/)
    // The start is kept with the index, so restarting the server doesn't restart the evaluation.
    expect(new TeamLicence(duct, account, () => now).allows('team.sso')).toBe(false)
    has = true
    expect(licence.status()).toMatchObject({ active: true, state: 'plan' })
  })
})

describe('a team server whose licence lapsed', () => {
  let server: Server | undefined
  let dir: string
  afterEach(() => { server?.close(); rmSync(dir, { recursive: true, force: true }) })

  it('turns people away with what to do, keeps the admin token working, and stops sharing and public pages', async () => {
    dir = mkdtempSync(join(tmpdir(), 'duct-licence-'))
    writeFileSync(join(dir, 'a.txt'), 'The lease ends in March.')
    const duct = new Duct({ embed: false })
    await duct.index(join(dir, 'a.txt'))
    const oidc = {
      session: (req: { headers: Record<string, unknown> }) => (typeof req.headers['x-test-user'] === 'string' ? { email: req.headers['x-test-user'], role: 'member' } : null),
      router: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    } as unknown as OidcLogin
    server = createServer(duct, { libraryDir: join(dir, 'lib'), oidc, authToken: 'admin-t', allowedHosts: '*' }).listen(0, '127.0.0.1')
    await new Promise(resolve => server!.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const as = (headers: Record<string, string>) => (method: string, path: string, body?: unknown) =>
      fetch(base + path, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const ada = as({ 'X-Test-User': 'ada@okafor.ng' })
    const admin = as({ Authorization: 'Bearer admin-t' })

    // During the evaluation everything works.
    const id = (await (await ada('POST', '/api/notebooks', { name: 'Brief' })).json()).notebook.id
    const link = (await (await ada('POST', `/api/notebooks/${id}/public-link`)).json()).publicLink
    expect((await fetch(base + link)).status).toBe(200)

    duct.storeValue('teamEvaluationStartedAt', Date.now() - 31 * DAY)
    const refused = await ada('GET', '/api/search?q=lease')
    expect(refused.status).toBe(402)
    expect(await refused.json()).toMatchObject({ code: 'licence', error: expect.stringMatching(/evaluation has ended/) })
    expect((await fetch(base + link)).status).toBe(404)

    expect((await admin('GET', '/api/search?q=lease')).status).toBe(200)
    expect((await admin('GET', '/api/audit')).status).toBe(200)
    expect((await admin('GET', '/api/notebooks')).json()).resolves.toMatchObject({ sharing: false, publicLinks: false })
  })
})
