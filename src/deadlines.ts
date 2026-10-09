// The deadlines radar: dates in documents that something happens by: a contract that expires, an invoice that's
// due, a licence that renews. Found on this computer by reading the words next to each date, so "expires on
// 31 March 2027" counts and "dated 1 March 2026" doesn't. Duct can't know whether an invoice was paid, so a
// passed due date is reported as passed, not as overdue.

export type DeadlineKind = 'expires' | 'due' | 'renews'

export interface FoundDate {
  /** YYYY-MM-DD */
  date: string
  kind: DeadlineKind
  /** Where the date is in the text. */
  index: number
  length: number
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTH = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)'
const DATE_PATTERNS: { re: RegExp; parts: (m: RegExpExecArray) => [number, number, number] | null }[] = [
  // 31 March 2027, 31st March, 2027, 31st day of March 2027
  { re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+day)?\\s+(?:of\\s+)?${MONTH}\\.?,?\\s+(\\d{4})\\b`, 'gi'), parts: m => [Number(m[3]), monthIndex(m[2]), Number(m[1])] },
  // March 31, 2027
  { re: new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'), parts: m => [Number(m[3]), monthIndex(m[1]), Number(m[2])] },
  // 2027-03-31
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, parts: m => [Number(m[1]), Number(m[2]) - 1, Number(m[3])] },
  // 31/03/2027 or 31.03.2027: day first, unless the second number can't be a month
  { re: /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/g, parts: m => { const a = Number(m[1]), b = Number(m[2]); return b > 12 ? (a > 12 ? null : [Number(m[3]), a - 1, b]) : [Number(m[3]), b - 1, a] } },
]

function monthIndex(name: string): number { return MONTHS.indexOf(name.slice(0, 3).toLowerCase()) }

// The words before a date say what it is. The nearest one wins; "skip" words mark dates that aren't deadlines.
const CUES: { kind: DeadlineKind | 'skip'; re: RegExp }[] = [
  { kind: 'skip', re: /\b(dated|signed|executed|effective(?: date| from| as of)?|commenc\w*|issued|made on|entered into|date of (?:issue|invoice|signature|birth)|invoice date|born|since|from)\b/gi },
  { kind: 'renews', re: /\b(renew\w*|anniversary)\b/gi },
  { kind: 'expires', re: /\b(expir\w*|valid (?:until|till|through|to)|lapses?|ends? on|end date|terminat\w*(?: on)?|until)\b/gi },
  { kind: 'due', re: /\b(due(?: date| on| by)?|payable(?: on| by)?|deadline|no later than|on or before|submit\w*(?: by)?|pay(?:ment)? by|closing date|closes on)\b/gi },
]

const WINDOW = 90

/** Deadline-like dates in a passage. */
export function findDeadlines(text: string): FoundDate[] {
  const out: FoundDate[] = []
  for (const { re, parts } of DATE_PATTERNS) {
    re.lastIndex = 0
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const p = parts(m)
      if (!p) continue
      const [y, mo, d] = p
      const dt = new Date(Date.UTC(y, mo, d))
      if (mo < 0 || dt.getUTCMonth() !== mo || dt.getUTCDate() !== d || y < 1990 || y > 2100) continue
      // The nearest cue in the words just before the date (within the same sentence).
      const before = text.slice(Math.max(0, m.index - WINDOW), m.index)
      const sentence = before.slice(Math.max(before.lastIndexOf('. '), before.lastIndexOf('\n')) + 1)
      let best: { kind: DeadlineKind | 'skip'; at: number } | null = null
      for (const cue of CUES) {
        cue.re.lastIndex = 0
        for (let c = cue.re.exec(sentence); c; c = cue.re.exec(sentence)) {
          if (!best || c.index > best.at) best = { kind: cue.kind, at: c.index }
        }
      }
      if (!best || best.kind === 'skip') continue
      if (out.some(o => o.index === m!.index)) continue
      out.push({ date: dt.toISOString().slice(0, 10), kind: best.kind, index: m.index, length: m[0].length })
    }
  }
  return out.sort((a, b) => a.index - b.index)
}

export interface Deadline {
  path: string
  name: string
  format: string
  page?: number
  heading?: string
  date: string
  kind: DeadlineKind
  /** The sentence around the date, with the date wrapped in \u0002 … \u0003. */
  text: string
}

export interface Radar {
  /** Dates in the last `pastDays` days. */
  passed: Deadline[]
  /** In the next 30 days. */
  soon: Deadline[]
  /** After that, up to `days` ahead. */
  later: Deadline[]
}

/** The sentence around a found date, with the date marked. */
export function excerpt(text: string, f: FoundDate): string {
  // From the start of the sentence to its end, cut to 160 characters either side of the date.
  const sentenceStart = Math.max(text.lastIndexOf('. ', f.index - 1) + 2, text.lastIndexOf('\n', f.index - 1) + 1, 0)
  const start = Math.max(sentenceStart, f.index - 160)
  const dot = text.indexOf('. ', f.index + f.length)
  const sentenceEnd = dot === -1 ? text.length : dot + 1
  const end = Math.min(sentenceEnd, f.index + f.length + 160)
  return (start > sentenceStart ? '…' : '') + text.slice(start, f.index).trimStart() + '\u0002' + text.slice(f.index, f.index + f.length) + '\u0003' + text.slice(f.index + f.length, end).trimEnd() + (end < sentenceEnd ? '…' : '')
}

/** Sorts found deadlines into the radar's groups; one entry per document, date and kind. */
export function radarFrom(items: Deadline[], now: Date, days = 365, pastDays = 30): Radar {
  const today = now.toISOString().slice(0, 10)
  const add = (n: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + n)).toISOString().slice(0, 10)
  const from = add(-pastDays), soon = add(30), until = add(days)
  const seen = new Set<string>()
  const radar: Radar = { passed: [], soon: [], later: [] }
  for (const d of [...items].sort((a, b) => a.date.localeCompare(b.date))) {
    const key = `${d.path}|${d.date}|${d.kind}`
    if (seen.has(key) || d.date < from || d.date > until) continue
    seen.add(key)
    if (d.date < today) radar.passed.push(d)
    else if (d.date <= soon) radar.soon.push(d)
    else radar.later.push(d)
  }
  radar.passed.reverse()   // most recent first
  return radar
}
