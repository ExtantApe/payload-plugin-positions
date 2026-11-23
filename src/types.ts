import type { Payload, PayloadRequest, Where } from 'payload'

export const GRANTS = 'position-grants'
export const HISTORY = 'position-grant-history'

export type PositionStatus = 'active' | 'paused' | 'revoked' | 'expired'

export type PositionScope = { kind: string; id: string }

/** A kind of position the host offers. `value` is stored; `label` is shown in the admin. */
export type PositionType = {
  value: string
  label?: string
  /** Scope kinds this type may be granted on. Omit to allow any of the host's scope kinds. */
  scopeKinds?: string[]
  /** A position with no scope, such as one that applies to the whole site. Such grants carry no scope kind or id. */
  unscoped?: boolean
}

export type ScopeKind = { value: string; label?: string }

/** What a grant looks like to the host's hooks. Ids are plain strings or numbers, never populated documents. */
export type PositionGrant = {
  id?: string | number
  holder: string | number
  position: string
  scopeKind?: string | null
  scopeId?: string | null
  startsAt?: string | null
  endsAt?: string | null
  grantedBy?: string | number | null
  status: PositionStatus
  revokedAt?: string | null
  revokedBy?: string | number | null
  notes?: string | null
}

export type AccessArgs = {
  req: PayloadRequest
  user: { id: string | number; collection?: string } & Record<string, unknown>
  /** The change being made: the new grant's data, or the fields of an update. The holder is always a plain id. */
  data?: Partial<PositionGrant>
  /** The id of the grant being changed, for an update. */
  id?: string | number
  /** The grant as it is now, when the question is about changing one. Set for `resume` and `extend`. */
  grant?: PositionGrant
  /** What is being asked: a new `grant`, a paused grant switched back on (`resume`), or an end date moved later or removed (`extend`). */
  change?: 'grant' | 'resume' | 'extend'
}

export type RefuseArgs = {
  req: PayloadRequest
  /** The holder's user document. */
  holder: Record<string, unknown> & { id: string | number }
  grant: PositionGrant
  /** `grant` for a new grant, `reactivate` when a paused grant is switched back on, `extend` when its end date is moved later or removed. */
  action: 'grant' | 'reactivate' | 'extend'
}

export type AuditName = 'grant' | 'revoke' | 'expire' | 'pause' | 'resume' | 'endDate'

export type AuditEvent = {
  event: AuditName
  phase: 'before' | 'after'
  grant: PositionGrant
  /** The grant as it was before a revoke or expiry. Absent for a grant. */
  previous?: PositionGrant
  /** Who acted: the signed-in user's auth collection and id, or null for server code and the expiry sweep. */
  by: { collection: string; id: string | number } | null
  req: PayloadRequest
}

export type AuditHook = (event: AuditEvent) => void | Promise<void>

export type RefuseFn = (args: RefuseArgs) => string | null | undefined | Promise<string | null | undefined>

export type PositionsOptions = {
  /** Turn the plugin off without removing it. Default true. */
  enabled?: boolean
  /** The users collection holders come from. Default `users`. */
  users?: string
  /** The kinds of position the host offers. With none, nothing can be granted. */
  positionTypes: PositionType[]
  /** The kinds of record a position can be scoped to, such as an organization or a project. */
  scopeKinds: ScopeKind[]
  /**
   * Who may grant. Only an exact `true` counts: a truthy value, a throw or no hook at all means nobody can. Called with
   * the new grant's data when a grant is created.
   */
  canGrant?: (args: AccessArgs) => boolean | Promise<boolean>
  /** Who may revoke, pause or shorten a grant. Default: whoever `canGrant` allows. Fails closed the same way. Resuming a grant or moving its end date later or to none always needs `canGrant` too, and the veto. */
  canRevoke?: (args: AccessArgs) => boolean | Promise<boolean>
  /**
   * Who may read grants. Default: anyone `canGrant` allows reads all; everyone else reads only their own. May return a
   * Payload `where` to narrow what is visible.
   */
  canRead?: (args: Omit<AccessArgs, 'data'>) => boolean | Where | Promise<boolean | Where>
  /**
   * A veto the host controls, asked on every grant and when a paused grant is switched back on, even for server code
   * that skips access. Required: pass `false` to say there is no veto. The reason is only seen by server code with no signed-in user.
   * A signed-in person who is vetoed gets the same answer as someone who may not grant at all, so it can't tell them who is barred. Return `null` (or nothing) to go ahead, or a reason to refuse. A throw, `false` or anything else
   * also refuses, with a general reason.
   */
  refuseGrant: RefuseFn | false
  /**
   * Who may read a grant's notes and the history. Separate from `canGrant`, so a granter limited to one scope doesn't
   * read everything. Nobody can unless this is given. For notes it is called with the `grant` and must answer exactly
   * `true`. For the history it is called with no grant, and may answer `true` or a Payload `where` on the history rows
   * (`snapshot.scopeKind`, `snapshot.scopeId`, `snapshot.holder` and so on) to narrow what is visible.
   */
  canReadPrivate?: (args: { req: PayloadRequest; user: AccessArgs['user']; grant: PositionGrant | undefined }) => boolean | Where | Promise<boolean | Where>
  /**
   * The plugin writes the history in the same database transaction as the grant, so a history failure undoes the
   * change. Without transactions it can't promise that, so it refuses every change. Set true only if you accept a
   * grant that can be saved without its history row. Default false.
   */
  allowWithoutTransactions?: boolean
  /** Audit hooks. A `before` hook that throws stops the change. An `after` hook that throws is logged and ignored. */
  audit?: {
    beforeGrant?: AuditHook
    afterGrant?: AuditHook
    beforeRevoke?: AuditHook
    afterRevoke?: AuditHook
    beforeExpire?: AuditHook
    afterExpire?: AuditHook
    beforePause?: AuditHook
    afterPause?: AuditHook
    beforeResume?: AuditHook
    afterResume?: AuditHook
    beforeEndDateChange?: AuditHook
    afterEndDateChange?: AuditHook
  }
  /** Let people grant positions to themselves. Default false: a person can't grant, resume or extend their own. */
  allowSelfGrant?: boolean
  /** The admin group the collection sits in. Default `Accounts`. */
  adminGroup?: string
}

export type PayloadLike = Payload | { payload: Payload }
