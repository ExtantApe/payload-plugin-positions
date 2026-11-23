import type { Payload, PayloadRequest } from 'payload'

import { GRANTS, type PayloadLike, type PositionGrant, type PositionScope } from './types.js'

const payloadOf = (p: PayloadLike): Payload => ('payload' in p ? p.payload : p) as Payload

/** The id of a user given as a document, an id, or nothing. */
export const idOf = (value: unknown): string | number | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return idOf((value as { id?: unknown }).id)
  return typeof value === 'string' || typeof value === 'number' ? value : null
}

/** Whether a grant is in force at `at`: active, started and not ended. Paused, revoked and expired grants never are. */
export function inForce(grant: Pick<PositionGrant, 'status' | 'startsAt' | 'endsAt'>, at: Date): boolean {
  if (grant.status !== 'active') return false
  const t = at.getTime()
  if (Number.isNaN(t)) return false
  if (grant.startsAt) {
    const s = Date.parse(grant.startsAt)
    if (Number.isNaN(s) || s > t) return false
  }
  if (grant.endsAt) {
    const e = Date.parse(grant.endsAt)
    if (Number.isNaN(e) || e <= t) return false
  }
  return true
}

export type HeldPosition = {
  id: string | number
  position: string
  scope: PositionScope | null
  startsAt: string | null
  endsAt: string | null
}

export type HelperOptions = {
  /** The moment to check. Default now. */
  at?: Date
  /** Pass the request to stay inside its transaction. */
  req?: PayloadRequest
}

/**
 * The holder id for a user. A signed-in user (which carries its auth collection) counts only if it comes from the
 * users collection the plugin was set up with, so an id from another collection can't match. A bare id is taken as a
 * users id. A document with no collection is not accepted.
 */
function holderOf(p: Payload, user: unknown): string | number | null {
  if (user && typeof user === 'object') {
    const slug = (p.config.custom as { positionsUsers?: string } | undefined)?.positionsUsers ?? 'users'
    if ((user as { collection?: unknown }).collection !== slug) return null
  }
  return idOf(user)
}

async function liveGrants(payload: PayloadLike, user: unknown, options: HelperOptions) {
  const p = payloadOf(payload)
  const holder = holderOf(p, user)
  if (holder === null) return []
  const found = await p.find({
    collection: GRANTS as never,
    where: { and: [{ holder: { equals: holder } }, { status: { equals: 'active' } }] },
    pagination: false,
    depth: 0,
    overrideAccess: true,
    req: options.req,
  })
  const at = options.at ?? new Date()
  return (found.docs as unknown as PositionGrant[]).filter((g) => inForce(g, at))
}

/** The positions a user holds right now (or at `at`), with their scopes. Throws if the grants can't be read. */
export async function positionsOf(payload: PayloadLike, user: unknown, options: HelperOptions = {}): Promise<HeldPosition[]> {
  const grants = await liveGrants(payload, user, options)
  return grants.map((g) => ({
    id: g.id as string | number,
    position: g.position,
    scope: g.scopeKind && g.scopeId ? { kind: g.scopeKind, id: g.scopeId } : null,
    startsAt: g.startsAt ?? null,
    endsAt: g.endsAt ?? null,
  }))
}

/**
 * Whether a user holds a position now. The user is a signed-in user (`req.user`) or an id (or at `at`). Give a scope to match a scoped grant exactly, or leave it out to
 * match an unscoped grant. A grant on one record never answers for another. No user, a paused, revoked or expired
 * grant, a date outside its window, or any error reading the grants is a no.
 */
export async function hasPosition(
  payload: PayloadLike,
  user: unknown,
  position: string,
  scope?: PositionScope | null,
  options: HelperOptions = {},
): Promise<boolean> {
  try {
    const held = await positionsOf(payload, user, options)
    return held.some(
      (h) => h.position === position && (scope ? h.scope?.kind === scope.kind && String(h.scope.id) === String(scope.id) : h.scope === null),
    )
  } catch {
    return false
  }
}
