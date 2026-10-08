import http from 'node:http'
import https from 'node:https'
import { BlockList, isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns'
import type { LookupFunction } from 'node:net'
import type { ExtractedDocument } from '../types.js'

const MAX_REDIRECTS = 5
const MAX_BYTES = 20 * 1024 * 1024
const TIMEOUT_MS = 15000

// Loopback, private, link-local (incl. cloud metadata), CGNAT, multicast and reserved ranges.
const blocked = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(net, prefix, 'ipv6')

export function isPrivateAddress(address: string): boolean {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) return blocked.check(mapped[1], 'ipv4')
  const family = isIP(address)
  if (family === 4) return blocked.check(address, 'ipv4')
  if (family === 6) return blocked.check(address, 'ipv6')
  return true
}

// Validates every address at connect time, so redirects and DNS rebinding can't reach private hosts.
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0)
    const list = addresses as unknown as { address: string; family: number }[]
    const bad = list.find(a => isPrivateAddress(a.address))
    if (bad) return callback(new Error(`Refusing to fetch private address ${bad.address} for ${hostname}`), '', 0)
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list)
    callback(null, list[0].address, list[0].family)
  })
}

export function isUrl(str: string): boolean {
  try {
    const url = new URL(str)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch { return false }
}

interface FetchedPage { body: string; contentType: string; finalUrl: string }

function fetchPage(url: string, blockPrivate: boolean, redirects = 0): Promise<FetchedPage> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      reject(new Error(`Unsupported URL protocol: ${target.protocol}`))
      return
    }
    if (blockPrivate && isIP(target.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(target.hostname.replace(/^\[|\]$/g, ''))) {
      reject(new Error(`Refusing to fetch private address ${target.hostname}`))
      return
    }
    const client = target.protocol === 'https:' ? https : http
    const req = client.get(target, {
      headers: { 'User-Agent': 'Duct/1.0 (Document Intelligence Pipeline)', 'Accept-Encoding': 'identity' },
      lookup: blockPrivate ? publicOnlyLookup : undefined,
      timeout: TIMEOUT_MS,
    }, res => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        if (redirects >= MAX_REDIRECTS) { reject(new Error(`Too many redirects fetching ${url}`)); return }
        fetchPage(new URL(res.headers.location, target).href, blockPrivate, redirects + 1).then(resolve, reject)
        return
      }
      if (status < 200 || status >= 300) {
        res.resume()
        reject(new Error(`Failed to fetch ${url}: ${status}`))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BYTES) { req.destroy(new Error(`Page too large (over ${MAX_BYTES / 1024 / 1024} MB): ${url}`)); return }
        chunks.push(chunk)
      })
      res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf-8'), contentType: res.headers['content-type'] || '', finalUrl: target.href }))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error(`Timed out fetching ${url}`)))
    req.on('error', reject)
  })
}

export async function extractUrl(url: string, options?: { blockPrivate?: boolean }): Promise<ExtractedDocument> {
  const { body: html, contentType } = await fetchPage(url, options?.blockPrivate ?? false)

  const cheerio = await import('cheerio')
  const $ = cheerio.load(html)
  $('script, style, nav, footer, header, iframe, noscript').remove()
  const text = $('body').text().replace(/\s+/g, ' ').trim()

  const title = $('title').text().trim() || url
  const links: string[] = []
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')
    if (href) {
      try {
        const absolute = new URL(href, url).href
        if (absolute.startsWith('http') && !links.includes(absolute)) {
          links.push(absolute)
        }
      } catch {}
    }
  })

  return {
    path: url,
    format: 'url',
    content: text,
    metadata: {
      title,
      url,
      contentType,
      charset: 'utf-8',
      links: links.slice(0, 100),
      size: text.length,
    },
  }
}
