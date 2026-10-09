// Copyright Tensflare Ltd. Licensed under the Elastic License 2.0; see src/team/LICENSE.
// You may not move, change, disable or circumvent this licence check, or remove or obscure what it protects.
//
// The licence check for Duct's team features. A server where people sign in can use them for a 30-day
// evaluation; after that they need a Team or Enterprise plan on the Tensflare account the server is signed in
// to (Settings › Account), checked offline from the signed entitlement. Connectors check `team.connectors`;
// sign-in, permission-aware search and the audit log `team.sso`; notebook sharing and public links
// `team.workspace`. The admin token keeps working when the licence lapses, so an admin can always fix it.

import type { TensflareAccount } from '../account.js'
import type { Duct } from '../index.js'

export const EVALUATION_DAYS = 30
const DAY = 86_400_000

export interface LicenceStatus {
  /** Team features are on. */
  active: boolean
  /** 'plan': a Team or Enterprise plan; 'evaluation': within the first 30 days; 'lapsed': neither. */
  state: 'plan' | 'evaluation' | 'lapsed'
  /** When the evaluation ends (ms), during and after it. */
  evaluationEndsAt: number
  /** What to tell people when it isn't active. */
  message?: string
}

export class TeamLicence {
  constructor(private duct: Duct, private account: TensflareAccount | undefined, private now: () => number = Date.now) {}

  private evaluationStart(): number {
    const saved = Number(this.duct.storedValue('teamEvaluationStartedAt'))
    if (Number.isFinite(saved) && saved > 0) return saved
    const start = this.now()
    this.duct.storeValue('teamEvaluationStartedAt', start)
    return start
  }

  status(entitlement = 'team.sso'): LicenceStatus {
    const evaluationEndsAt = this.evaluationStart() + EVALUATION_DAYS * DAY
    if (this.account?.has(entitlement)) return { active: true, state: 'plan', evaluationEndsAt }
    if (this.now() < evaluationEndsAt) return { active: true, state: 'evaluation', evaluationEndsAt }
    return {
      active: false, state: 'lapsed', evaluationEndsAt,
      message: this.account?.status().signedIn
        ? 'This Duct server’s Team plan isn’t active. An admin can renew it from Settings › Account.'
        : 'This Duct server’s 30-day evaluation has ended. An admin can sign it in to a Tensflare account with a Team plan, in Settings › Account.',
    }
  }

  allows(entitlement: string): boolean {
    return this.status(entitlement).active
  }
}
