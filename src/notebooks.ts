// Who may do what with a notebook. On a server where people sign in, a notebook belongs to the person who made it
// and is private until they share it: with people ("user:ada@okafor.ng"), a whole domain ("domain:okafor.ng") or
// everyone on the server ("anyone"), to read or to edit. Without sign-in (the desktop app, a token-only server)
// there are no people to tell apart, so notebooks belong to everyone using it, as they always have.
//
// Sharing a notebook never shares the documents it quotes: someone who can't open a document doesn't see notes
// from it, even in a notebook shared with them (see server.ts).

import { ANYONE, parsePrincipal } from './access.js'

export type NotebookRole = 'owner' | 'edit' | 'view'
export interface NotebookShare { to: string; can: 'edit' | 'view' }

/** Who is asking: their email when signed in, whether they're an admin, and the principals they match. */
export interface NotebookActor { email?: string; admin?: boolean; principals?: string[] }

const RANK: Record<NotebookRole, number> = { view: 1, edit: 2, owner: 3 }

/**
 * What someone may do with a notebook, or null if they shouldn't know it exists. No principals: no restriction
 * (this machine's own user, or the admin token). A notebook with no owner was made without sign-in and is
 * everyone's to edit; admins also manage it.
 */
export function notebookRole(nb: { owner: string | null; sharing: NotebookShare[] }, who: NotebookActor): NotebookRole | null {
  if (!who.principals) return 'owner'
  const email = who.email?.toLowerCase()
  if (!nb.owner) return who.admin ? 'owner' : 'edit'
  if (email && nb.owner.toLowerCase() === email) return 'owner'
  let best: NotebookRole | null = null
  for (const s of nb.sharing) {
    if (who.principals.includes(s.to) && (!best || RANK[s.can] > RANK[best])) best = s.can
  }
  return best
}

export function canDo(role: NotebookRole | null, needs: NotebookRole): boolean {
  return !!role && RANK[role] >= RANK[needs]
}

/**
 * Cleans a sharing list sent by a client: each entry's `to` is an email, a domain ("okafor.ng"), "anyone" or a
 * principal; `can` is "edit" or "view" (default). Duplicates keep the stronger grant; the owner is left out.
 * Throws with a message naming what couldn't be read.
 */
export function cleanSharing(raw: unknown, owner: string | null): NotebookShare[] {
  if (!Array.isArray(raw)) throw new Error('Send { "sharing": [{ "to": "ada@okafor.ng", "can": "edit" }] }')
  const out = new Map<string, NotebookShare['can']>()
  for (const entry of raw.slice(0, 200)) {
    const to = parsePrincipal(String((entry as { to?: unknown })?.to ?? ''))
    if (!to || to.startsWith('group:')) throw new Error(`“${String((entry as { to?: unknown })?.to ?? '')}” isn’t an email address, a domain or “anyone”.`)
    if (owner && to === `user:${owner.toLowerCase()}`) continue
    const can = (entry as { can?: unknown }).can === 'edit' ? 'edit' : 'view'
    if (out.get(to) !== 'edit') out.set(to, can)
  }
  // People first, then domains, then everyone: the order the sharing dialog shows.
  const order = (p: string) => (p === ANYONE ? 2 : p.startsWith('domain:') ? 1 : 0)
  return [...out].map(([to, can]) => ({ to, can })).sort((a, b) => order(a.to) - order(b.to) || a.to.localeCompare(b.to))
}
