// Copyright Tensflare Ltd. Licensed under the Elastic License 2.0; see src/team/LICENSE.
//
// Sharing a notebook with people on a server where they sign in (see ../notebooks.ts for what each role may do).

import { ANYONE, parsePrincipal } from '../access.js'
import type { NotebookShare } from '../notebooks.js'

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
