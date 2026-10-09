// "What's in here?": a first look at a library, worked out on this computer from each document's name and opening
// text. Used for the first run ("Found 38 invoices, 12 contracts, 4 CVs") and for search suggestions drawn from
// the person's own files. Heuristics, not a classifier: a document counts once, under the first kind it fits.

import type { DocumentFormat } from './types.js'

export interface DocumentKind { id: string; label: string; one: string; count: number }

export interface Discovery {
  documents: number
  kinds: DocumentKind[]
  /** Searches that find something in these documents, to try first. */
  suggestions: string[]
}

interface KindRule { id: string; one: string; label: string; test: RegExp; tries: string[] }

/** In priority order: an invoice that mentions an agreement is still an invoice. */
export const KIND_RULES: KindRule[] = [
  { id: 'invoice', one: 'invoice', label: 'invoices', test: /\b(tax )?invoice\b|\binv[-_ #]?\d{2,}|\bamount due\b|\bbill to\b/i, tries: ['amount due', 'payment terms'] },
  { id: 'receipt', one: 'receipt', label: 'receipts', test: /\breceipt\b|\bpayment received\b/i, tries: ['total paid'] },
  { id: 'statement', one: 'statement', label: 'statements', test: /\b(bank|account) statement\b|\bopening balance\b|\bclosing balance\b/i, tries: ['closing balance'] },
  { id: 'cv', one: 'CV', label: 'CVs', test: /\b(curriculum vitae|résumé|resume)\b|(^|[\s_-])cv([\s_.-]|$)|\bwork experience\b[\s\S]{0,2000}\beducation\b/i, tries: ['experience', 'skills'] },
  { id: 'contract', one: 'contract', label: 'contracts', test: /\bagreement\b|\bcontract\b|\bwhereas\b|\bhereinafter\b|\bnon[- ]disclosure\b|\bNDA\b/i, tries: ['termination', 'confidentiality', 'governing law'] },
  { id: 'proposal', one: 'proposal', label: 'proposals and tenders', test: /\bproposal\b|\brequest for (proposal|quotation)\b|\btender\b|\bRFP\b|\bRFQ\b/i, tries: ['scope of work', 'deliverables'] },
  { id: 'minutes', one: 'set of minutes', label: 'meeting minutes', test: /\bminutes\b|\bagenda\b|\battendees\b|\baction items\b/i, tries: ['action items'] },
  { id: 'policy', one: 'policy', label: 'policies and handbooks', test: /\bpolicy\b|\bprocedures?\b|\bhandbook\b|\bcode of conduct\b/i, tries: ['annual leave', 'approval'] },
  { id: 'letter', one: 'letter', label: 'letters', test: /^\s*dear\b|\byours (sincerely|faithfully)\b/im, tries: [] },
  { id: 'report', one: 'report', label: 'reports', test: /\breport\b|\bexecutive summary\b|\bfindings\b|\brecommendations\b/i, tries: ['recommendations'] },
]

const BY_FORMAT: { id: string; one: string; label: string; formats: DocumentFormat[] }[] = [
  { id: 'slides', one: 'presentation', label: 'presentations', formats: ['pptx', 'odp', 'key'] },
  { id: 'sheets', one: 'spreadsheet', label: 'spreadsheets', formats: ['xlsx', 'ods', 'numbers'] },
  { id: 'email', one: 'email', label: 'emails', formats: ['eml', 'msg'] },
  { id: 'scans', one: 'image or scan', label: 'images and scans', formats: ['image'] },
]

export function kindOf(name: string, text: string, format: string): string {
  for (const f of BY_FORMAT) if ((f.formats as string[]).includes(format) && f.id !== 'sheets') return f.id
  const sample = name.replace(/[_-]+/g, ' ') + '\n' + text.slice(0, 2500)
  for (const r of KIND_RULES) if (r.test.test(sample)) return r.id
  for (const f of BY_FORMAT) if ((f.formats as string[]).includes(format)) return f.id
  return 'other'
}

export function summarizeKinds(docs: { name: string; text: string; format: string }[]): DocumentKind[] {
  const counts = new Map<string, number>()
  for (const d of docs) { const k = kindOf(d.name, d.text, d.format); counts.set(k, (counts.get(k) ?? 0) + 1) }
  const meta = [...KIND_RULES, ...BY_FORMAT]
  return [...counts.entries()].filter(([id]) => id !== 'other')
    .map(([id, count]) => { const m = meta.find(x => x.id === id)!; return { id, label: m.label, one: m.one, count } })
    .sort((a, b) => b.count - a.count)
}

const COMMON = new Set(('the this that these those there their they then than what when where which while with within without from into onto your yours have has had will would shall should could may might must about above after again against all also and any are because been before being below between both but can cannot did does doing down during each few for further here how just more most not now only other our out over own same some such too under until very was were who whom why you page date total name number section part item note dear yours sincerely regards subject please thank thanks january february march april june july august september october november december monday tuesday wednesday thursday friday saturday sunday limited ltd plc inc company table figure appendix schedule annex article clause chapter').split(' '))

/** Names, places and organisations that recur across documents ("Okafor", "Lagos"): good first searches. */
export function recurringNames(texts: string[], limit = 4): string[] {
  const df = new Map<string, number>()
  for (const t of texts) {
    const seen = new Set<string>()
    // Capitalised words that don't start a sentence or line.
    for (const m of t.slice(0, 4000).matchAll(/(?<=[\p{Ll},;:)] )(\p{Lu}\p{Ll}{3,})\b/gu)) {
      const w = m[1]
      if (!COMMON.has(w.toLowerCase())) seen.add(w)
    }
    for (const w of seen) df.set(w, (df.get(w) ?? 0) + 1)
  }
  const max = Math.max(2, Math.ceil(texts.length * 0.6))
  return [...df.entries()].filter(([, n]) => n >= 2 && n <= max).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([w]) => w)
}

export function triesFor(kinds: DocumentKind[]): string[] {
  const out: string[] = []
  for (const k of kinds) for (const t of KIND_RULES.find(r => r.id === k.id)?.tries ?? []) out.push(t)
  return out
}
