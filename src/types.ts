import type { Payload, PayloadRequest, Where } from 'payload'

export const GRANTS = 'position-grants'

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
  /** The grant being created. Only set when the question is about a new grant. */
  data?: Partial<PositionGrant>
}

export type RefuseArgs = {
  req: PayloadRequest
  /** The holder's user document. */
  holder: Record<string, unknown> & { id: string | number }
  grant: PositionGrant
  /** `grant` for a new grant, `reactivate` when a paused grant is switched back on. */
  action: 'grant' | 'reactivate'
}

export type AuditEvent = {
  event: 'grant' | 'revoke' | 'expire'
  phase: 'before' | 'after'
  grant: PositionGrant
  /** The grant as it was before a revoke or expiry. Absent for a grant. */
  previous?: PositionGrant
  /** The signed-in user's id, or null for server code and the expiry sweep. */
  by: string | number | null
  req: PayloadRequest
}

export type AuditHook = (event: AuditEvent) => void | Promise<void>

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
  /** Who may revoke, pause or change a grant's end date. Default: whoever `canGrant` allows. Fails closed the same way. */
  canRevoke?: (args: AccessArgs) => boolean | Promise<boolean>
  /**
   * Who may read grants. Default: anyone `canGrant` allows reads all; everyone else reads only their own. May return a
   * Payload `where` to narrow what is visible.
   */
  canRead?: (args: Omit<AccessArgs, 'data'>) => boolean | Where | Promise<boolean | Where>
  /**
   * A veto the host controls, asked on every grant and when a paused grant is switched back on, even for server code
   * that skips access. Return `null` (or nothing) to go ahead, or a reason to refuse. A throw, `false` or anything else
   * also refuses, with a general reason.
   */
  refuseGrant?: (args: RefuseArgs) => string | null | undefined | Promise<string | null | undefined>
  /** Audit hooks. A `before` hook that throws stops the change. An `after` hook that throws is logged and ignored. */
  audit?: {
    beforeGrant?: AuditHook
    afterGrant?: AuditHook
    beforeRevoke?: AuditHook
    afterRevoke?: AuditHook
    beforeExpire?: AuditHook
    afterExpire?: AuditHook
  }
  /** The admin group the collection sits in. Default `Accounts`. */
  adminGroup?: string
}

export type PayloadLike = Payload | { payload: Payload }
