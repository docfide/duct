// Who may see a document on a shared server (permission-aware team search). A document can carry an access list
// of principals: "user:ada@okafor.ng", "domain:okafor.ng" or "anyone". Without a list it's visible to everyone
// who can use the server, as before. Cloud sources set lists from each file's sharing at the source, so results
// follow the source's own permissions; links that merely exist ("anyone with the link") don't make a file
// visible to everyone, since that's how files get overshared.

export const ANYONE = 'anyone'

/** What a signed-in person matches: themselves, their email domain, and documents open to anyone. */
export function principalsFor(email: string | undefined | null): string[] {
  const e = (email ?? '').trim().toLowerCase()
  if (!e.includes('@')) return [ANYONE]
  return [`user:${e}`, `domain:${e.split('@')[1]}`, ANYONE]
}

/** "Ada@Okafor.NG" → "user:ada@okafor.ng", "@okafor.ng" or "okafor.ng" → "domain:okafor.ng", "anyone" / "*" → "anyone". */
export function parsePrincipal(raw: string): string | null {
  const v = raw.trim().toLowerCase()
  if (!v) return null
  if (v === ANYONE || v === '*' || v === 'everyone') return ANYONE
  if (/^(user|domain|group):\S+$/.test(v)) return v
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return `user:${v}`
  const d = v.replace(/^@/, '')
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) return `domain:${d}`
  return null
}

/** Whether a viewer (undefined: no restriction, e.g. the desktop app) may see a document with this access list. */
export function canSee(access: string[] | null | undefined, viewer: string[] | undefined): boolean {
  if (!viewer || !access) return true
  return access.some(p => viewer.includes(p))
}
