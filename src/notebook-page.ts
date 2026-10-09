// A notebook as a page to send to anyone: one .html file that opens in any browser, on any phone, with no Duct and no
// account, and prints cleanly. It has no scripts and loads nothing. It carries the notebook as JSON too, so someone
// who has Duct can add it to their own notebooks ("Import a shared notebook").
//
// It holds the notebook's name, its quotes with each document's name and page, comments and who wrote them; never
// file paths, which can name people and folders.

import type { Note } from './store/sqlite.js'

export interface SharedNotebook {
  name: string
  notes: { quote: string; doc: string; page?: number; pageLabel?: string; format?: string; comment?: string; author?: string }[]
}

const DATA_ID = 'duct-notebook'
const MAX_NOTES = 5000

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
/** Paragraphs from plain text: blank lines split them, single newlines become line breaks. */
const paras = (s: string) => s.trim().split(/\n\s*\n/).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')

/** The data a shared page carries. */
export function sharedFrom(name: string, notes: Note[], pageLabel: (format: string) => string): SharedNotebook {
  return {
    name,
    notes: notes.map(n => ({
      quote: n.quote,
      doc: n.docName,
      ...(n.page ? { page: n.page, pageLabel: pageLabel(n.format) } : {}),
      format: n.format,
      ...(n.comment.trim() ? { comment: n.comment } : {}),
      ...(n.author ? { author: n.author } : {}),
    })),
  }
}

export function notebookPage(nb: SharedNotebook, opts: { sharedBy?: string; date?: Date; noindex?: boolean } = {}): string {
  const date = (opts.date ?? new Date()).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  const docs = new Set(nb.notes.map(n => n.doc)).size
  const count = `${nb.notes.length} ${nb.notes.length === 1 ? 'quote' : 'quotes'} from ${docs} ${docs === 1 ? 'document' : 'documents'}`
  const authors = new Set(nb.notes.map(n => n.author).filter(Boolean))
  const notes = nb.notes.map((n, i) => `
    <article class="note" id="n${i + 1}">
      <blockquote>${paras(n.quote)}</blockquote>
      <p class="src"><span class="doc">${esc(n.doc)}</span>${n.page ? `<span class="pg">${esc(n.pageLabel || 'Page')} ${n.page}</span>` : ''}${authors.size > 1 && n.author ? `<span class="by">added by ${esc(n.author)}</span>` : ''}</p>
      ${n.comment?.trim() ? `<div class="comment">${paras(n.comment)}</div>` : ''}
    </article>`).join('')
  // JSON inside a script element: "<" is escaped so no text in it can close the element.
  const data = JSON.stringify({ duct: 'notebook', version: 1, ...nb }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<meta name="generator" content="Duct">${opts.noindex ? '\n<meta name="robots" content="noindex, nofollow">' : ''}
<title>${esc(nb.name)}</title>
<style>
:root { --bg: #FBFAF6; --card: #FFFFFF; --text: #1B1B19; --muted: #6B6B66; --line: #E6E4DC; --accent: #4D7C0F; --mark: #A3E635; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #0C0C0B; --card: #141413; --text: #F0EFE8; --muted: #8E8E88; --line: #262623; --accent: #A3E635; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 17px/1.6 Charter, 'Iowan Old Style', Georgia, serif; -webkit-text-size-adjust: 100%; }
main { max-width: 42rem; margin: 0 auto; padding: 56px 20px 40px; }
header { margin-bottom: 36px; }
.kicker { font: 600 12px/1 ui-sans-serif, -apple-system, 'Segoe UI', sans-serif; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); margin: 0 0 14px; display: flex; align-items: center; gap: 8px; }
h1 { font: 700 clamp(28px, 6vw, 40px)/1.15 ui-sans-serif, -apple-system, 'Segoe UI', sans-serif; letter-spacing: -.02em; margin: 0 0 12px; overflow-wrap: anywhere; }
.meta { font: 14px/1.5 ui-sans-serif, -apple-system, 'Segoe UI', sans-serif; color: var(--muted); margin: 0; }
.note { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 22px 24px; margin: 0 0 18px; break-inside: avoid; }
blockquote { margin: 0; padding-left: 16px; border-left: 3px solid var(--mark); overflow-wrap: anywhere; }
blockquote p { margin: 0 0 10px; }
blockquote p:last-child { margin-bottom: 0; }
.src { font: 13px/1.5 ui-sans-serif, -apple-system, 'Segoe UI', sans-serif; color: var(--muted); margin: 12px 0 0 19px; display: flex; flex-wrap: wrap; gap: 4px 12px; }
.src .doc { font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
.comment { font: 15px/1.6 ui-sans-serif, -apple-system, 'Segoe UI', sans-serif; margin: 16px 0 0; padding-top: 14px; border-top: 1px dashed var(--line); }
.comment p { margin: 0 0 8px; }
.comment p:last-child { margin-bottom: 0; }
footer { max-width: 42rem; margin: 0 auto; padding: 8px 20px 56px; font: 13px/1.6 ui-sans-serif, -apple-system, 'Segoe UI', sans-serif; color: var(--muted); }
footer a { color: var(--accent); text-decoration: none; font-weight: 600; }
footer a:hover { text-decoration: underline; }
@media (max-width: 520px) { main { padding-top: 36px; } .note { padding: 18px 16px; border-radius: 12px; } blockquote { padding-left: 12px; } .src { margin-left: 15px; } }
@media print { body { background: #fff; color: #000; font-size: 12pt; } main { padding-top: 0; } .note { border-color: #ccc; } footer { padding-bottom: 0; } }
</style>
</head>
<body>
<main>
  <header>
    <p class="kicker"><svg width="18" height="18" viewBox="0 0 30 30" fill="none" aria-hidden="true"><line x1="4" y1="9" x2="16" y2="9" stroke="currentColor" stroke-opacity=".45" stroke-width="2.4" stroke-linecap="round"/><line x1="4" y1="15" x2="22" y2="15" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><line x1="4" y1="21" x2="12" y2="21" stroke="currentColor" stroke-opacity=".45" stroke-width="2.4" stroke-linecap="round"/><path d="M24 12 L28 15 L24 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>Notebook</p>
    <h1>${esc(nb.name)}</h1>
    <p class="meta">${count}${opts.sharedBy ? ` · shared by ${esc(opts.sharedBy)}` : ''} · ${esc(date)}</p>
  </header>
  ${notes || '<p class="meta">This notebook is empty.</p>'}
</main>
<footer>
  Quotes picked with <a href="https://duct.tensflare.com/?ref=notebook">Duct</a>, which finds anything in your documents on your own computer. If you use Duct, choose <strong>Import a shared notebook</strong> to add this one to yours.
</footer>
<script type="application/json" id="${DATA_ID}">${data}</script>
</body>
</html>
`
}

/**
 * Reads a notebook from a shared page or its JSON (a notebook export or `{ duct: 'notebook', … }`). Returns null
 * if it isn't one. Everything in it is treated as untrusted text.
 */
export function parseSharedNotebook(input: string): SharedNotebook | null {
  let raw: unknown
  const text = input.trim()
  if (text.startsWith('{')) {
    try { raw = JSON.parse(text) } catch { return null }
  } else {
    const m = new RegExp(`<script[^>]*id=["']${DATA_ID}["'][^>]*>([\\s\\S]*?)</script>`, 'i').exec(text)
    if (!m) return null
    try { raw = JSON.parse(m[1]) } catch { return null }
  }
  // A shared page has name/notes; Duct's JSON export has title/items.
  const o = raw as { name?: unknown; title?: unknown; notes?: unknown; items?: unknown }
  const list = Array.isArray(o?.notes) ? o.notes : Array.isArray(o?.items) ? o.items : null
  if (!list) return null
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')
  const notes: SharedNotebook['notes'] = []
  for (const n of list.slice(0, MAX_NOTES) as Record<string, unknown>[]) {
    // A shared page uses quote/doc/page; Duct's JSON export uses text/name/location ("Page 4").
    const quote = str(n?.quote ?? n?.text, 20_000).trim()
    const doc = str(n?.doc ?? n?.name, 300).trim()
    if (!quote || !doc) continue
    const loc = /^(\S.*?)\s+(\d+)$/.exec(str(n.location, 40))
    const page = Number(n.page ?? loc?.[2])
    const pageLabel = str(n.pageLabel, 20) || loc?.[1] || ''
    notes.push({
      quote, doc,
      ...(Number.isInteger(page) && page > 0 ? { page, ...(pageLabel ? { pageLabel } : {}) } : {}),
      ...(str(n.format, 20) ? { format: str(n.format, 20) } : {}),
      ...(str(n.comment ?? n.note, 5000).trim() ? { comment: str(n.comment ?? n.note, 5000) } : {}),
      ...(/^[^@\s]+@[^@\s]+$/.test(str(n.author, 200)) ? { author: str(n.author, 200) } : {}),
    })
  }
  const name = str(o.name ?? o.title, 120).trim() || 'Shared notebook'
  return { name, notes }
}
