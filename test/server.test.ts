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

describe('pages', () => {
  let server: import('node:http').Server
  let base: string
  beforeAll(async () => {
    server = createServer(new Duct()).listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => server.close())

  // The pages are template literals in TypeScript; a stray backslash or backtick only shows up in the browser.
  for (const [path, expected] of [['/', 2], ['/viewer', 1], ['/island', 1]] as const) {
    it(`${path} has inline scripts that parse`, async () => {
      const vm = await import('node:vm')
      const page = await (await fetch(base + path)).text()
      const scripts = [...page.matchAll(/<script( type="module")?>([\s\S]*?)<\/script>/g)]
      expect(scripts.length).toBe(expected)
      for (const [, isModule, code] of scripts) {
        // Module code may use top-level await; wrapping it in an async function checks the syntax the same way.
        expect(() => new vm.Script(isModule ? `(async () => {\n${code}\n})` : code), `${path} ${isModule ? 'module' : 'page'} script`).not.toThrow()
      }
    })
  }

  it('serves pdf.js for the viewer locally', async () => {
    for (const file of ['build/pdf.mjs', 'build/pdf.worker.mjs', 'web/pdf_viewer.mjs', 'web/pdf_viewer.css', 'standard_fonts/FoxitSans.pfb']) {
      expect((await fetch(`${base}/vendor/pdfjs/${file}`)).status, file).toBe(200)
    }
    expect((await fetch(`${base}/vendor/pdfjs/wasm/openjpeg.wasm`)).headers.get('content-type')).toBe('application/wasm')
    const traversal = await (await fetch(`${base}/vendor/pdfjs/build/%2e%2e/%2e%2e/package.json`)).text()
    expect(traversal).not.toContain('"pdfjs-dist"')
  })
})
