import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Duct } from '../src/index.js'
import { createServer } from '../src/server.js'

describe('server mascot assets', () => {
  let server: Server
  let base: string

  beforeAll(async () => {
    server = createServer(new Duct()).listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => {
    server.close()
  })

  it('serves the mascot animation and fallback art', async () => {
    const lottie = await fetch(`${base}/mascot/mascot.lottie`)
    expect(lottie.status).toBe(200)
    expect((await lottie.arrayBuffer()).byteLength).toBeGreaterThan(0)

    const svg = await fetch(`${base}/mascot/pose-welcome.svg`)
    expect(svg.status).toBe(200)
    expect(svg.headers.get('content-type')).toContain('image/svg+xml')
  })

  it('serves the dotLottie player and wasm locally', async () => {
    const js = await fetch(`${base}/vendor/dotlottie/index.js`)
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toContain('javascript')

    const wasm = await fetch(`${base}/vendor/dotlottie/dotlottie-player.wasm`)
    expect(wasm.status).toBe(200)
    expect(wasm.headers.get('content-type')).toBe('application/wasm')
  })

  it('references only local mascot assets from the page', async () => {
    const page = await (await fetch(`${base}/`)).text()
    expect(page).toContain("import('/vendor/dotlottie/index.js')")
    expect(page).toContain("setWasmUrl('/vendor/dotlottie/dotlottie-player.wasm')")
    expect(page).not.toMatch(/jsdelivr|unpkg/)
  })
})
