import type { ExtractedDocument } from '../types.js'

export function isUrl(str: string): boolean {
  try {
    const url = new URL(str)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch { return false }
}

export async function extractUrl(url: string): Promise<ExtractedDocument> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Duct/1.0 (Document Intelligence Pipeline)' },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)
  const html = await res.text()
  const contentType = res.headers.get('content-type') || ''

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
