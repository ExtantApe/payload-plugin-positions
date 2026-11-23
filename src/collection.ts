import { APIError, type CollectionConfig, type PayloadRequest } from 'payload'

import { idOf } from './helpers.js'
import {
  GRANTS,
  type AccessArgs,
  type AuditEvent,
  type AuditHook,
  type PositionGrant,
  type PositionStatus,
  type PositionsOptions,
} from './types.js'

const refuse = (message: string) => new APIError(message, 403, undefined, true)
const GENERAL = 'This position can’t be granted.'
const LIVE: PositionStatus[] = ['active', 'paused']
const dateOk = (v: unknown) => v === null || v === undefined || v === '' || !Number.isNaN(Date.parse(String(v)))
const ms = (v: unknown) => (v ? Date.parse(String(v)) : null)

/** Only an exact `true` passes. A throw, a rejection or any other answer is a no. */
async function exactlyTrue(check: () => unknown): Promise<boolean> {
  try {
    return (await check()) === true
  } catch {
    return false
  }
}

const normalize = (doc: Record<string, unknown>): PositionGrant => ({
  ...(doc as unknown as PositionGrant),
  holder: idOf(doc.holder) as string | number,
  grantedBy: idOf(doc.grantedBy),
  revokedBy: idOf(doc.revokedBy),
})

export function positionGrantsCollection(opts: Required<Pick<PositionsOptions, 'users' | 'positionTypes' | 'scopeKinds'>> & PositionsOptions): CollectionConfig {
  const { users, positionTypes, scopeKinds } = opts
  const signedIn = (req: PayloadRequest) => {
    const user = req.user as ({ id: string | number; collection?: string } & Record<string, unknown>) | null
    return user && user.collection === users ? user : null
  }
  const ask = (fn: PositionsOptions['canGrant'], req: PayloadRequest, data?: Partial<PositionGrant>) => {
    const user = signedIn(req)
    if (!user || !fn) return false
    return exactlyTrue(() => fn({ req, user, data } as AccessArgs))
  }
  const canGrant = (req: PayloadRequest, data?: Partial<PositionGrant>) => ask(opts.canGrant, req, data)
  const canRevoke = (req: PayloadRequest) => ask(opts.canRevoke ?? opts.canGrant, req)

  const run = async (hook: AuditHook | undefined, event: AuditEvent, mustPass: boolean) => {
    if (!hook) return
    try {
      await hook(event)
    } catch (error) {
      if (mustPass) throw refuse('This change can’t be recorded right now, so it wasn’t made.')
      event.req.payload.logger.error(`positions: the ${event.event} audit hook failed: ${(error as Error).message}`)
    }
  }
  const by = (req: PayloadRequest) => idOf(req.user)

  /** The host's veto. Only `null` or nothing goes ahead; a reason is shown; anything else is a general refusal. */
  async function vetoed(req: PayloadRequest, grant: PositionGrant, action: 'grant' | 'reactivate') {
    if (!opts.refuseGrant) return
    const holder = await req.payload
      .findByID({ collection: users as never, id: grant.holder, depth: 0, overrideAccess: true, req })
      .catch(() => null)
    if (!holder) throw refuse(GENERAL)
    let why: unknown
    try {
      why = await opts.refuseGrant({ req, holder: holder as never, grant, action })
    } catch {
      throw refuse(GENERAL)
    }
    if (why === null || why === undefined) return
    throw refuse(typeof why === 'string' && why.trim() ? why : GENERAL)
  }

  return {
    slug: GRANTS,
    labels: { singular: 'Position grant', plural: 'Position grants' },
    admin: {
      group: opts.adminGroup ?? 'Accounts',
      useAsTitle: 'position',
      defaultColumns: ['holder', 'position', 'scopeKind', 'scopeId', 'status', 'endsAt'],
      description:
        'Who holds which position, and where. Revoke a grant by setting its status to Revoked; grants are never deleted, so the record stays.',
    },
    access: {
      create: ({ req, data }) => canGrant(req, data as Partial<PositionGrant>),
      update: ({ req }) => canRevoke(req),
      delete: () => false,
      read: async ({ req }) => {
        const user = signedIn(req)
        if (!user) return false
        if (opts.canRead) {
          try {
            const answer = await opts.canRead({ req, user })
            return answer === true ? true : answer && typeof answer === 'object' ? answer : false
          } catch {
            return false
          }
        }
        if (await canGrant(req)) return true
        return { holder: { equals: user.id } }
      },
    },
    fields: [
      { name: 'holder', type: 'relationship', relationTo: users as never, required: true, index: true, admin: { description: 'The account that holds the position.' } },
      {
        name: 'position',
        type: 'select',
        required: true,
        index: true,
        options: positionTypes.map((t) => ({ label: t.label ?? t.value, value: t.value })),
      },
      {
        name: 'scopeKind',
        type: 'select',
        options: scopeKinds.map((k) => ({ label: k.label ?? k.value, value: k.value })),
        admin: { description: 'What kind of record the position is on. Leave empty for a position that has no scope.' },
      },
      { name: 'scopeId', type: 'text', index: true, admin: { description: 'The id of that record.' } },
      { name: 'startsAt', type: 'date', admin: { description: 'Empty means from now.', date: { pickerAppearance: 'dayAndTime' } } },
      { name: 'endsAt', type: 'date', admin: { description: 'Empty means no end.', date: { pickerAppearance: 'dayAndTime' } } },
      { name: 'grantedBy', type: 'relationship', relationTo: users as never, admin: { readOnly: true } },
      {
        name: 'status',
        type: 'select',
        required: true,
        defaultValue: 'active',
        index: true,
        options: [
          { label: 'Active', value: 'active' },
          { label: 'Paused', value: 'paused' },
          { label: 'Revoked', value: 'revoked' },
          { label: 'Expired', value: 'expired' },
        ],
        admin: { description: 'Revoked and expired are final. A paused grant gives nothing until it is made active again.' },
      },
      { name: 'revokedAt', type: 'date', admin: { readOnly: true } },
      { name: 'revokedBy', type: 'relationship', relationTo: users as never, admin: { readOnly: true } },
      { name: 'notes', type: 'textarea' },
    ],
    hooks: {
      beforeChange: [
        async ({ data, originalDoc, operation, req }) => {
          const now = Date.now()
          if (operation === 'create') {
            const type = positionTypes.find((t) => t.value === data.position)
            if (!type) throw refuse('Unknown position.')
            const holder = idOf(data.holder)
            if (holder === null) throw refuse('A grant needs a holder.')
            if (type.unscoped) {
              if (data.scopeKind || data.scopeId) throw refuse('This position has no scope.')
              data.scopeKind = null
              data.scopeId = null
            } else {
              if (!data.scopeKind || !data.scopeId || !scopeKinds.some((k) => k.value === data.scopeKind))
                throw refuse('This position needs a scope: pick a kind and an id.')
              if (type.scopeKinds && !type.scopeKinds.includes(data.scopeKind)) throw refuse('This position can’t be scoped to that kind.')
              data.scopeId = String(data.scopeId)
            }
            if (!dateOk(data.startsAt) || !dateOk(data.endsAt)) throw refuse('Those dates aren’t valid.')
            const s = ms(data.startsAt)
            const e = ms(data.endsAt)
            if (e !== null && e <= now) throw refuse('The end date has already passed.')
            if (s !== null && e !== null && e <= s) throw refuse('The end date must come after the start date.')
            data.status = 'active'
            data.revokedAt = null
            data.revokedBy = null
            data.holder = holder
            const asker = by(req)
            if (asker !== null) data.grantedBy = asker
            const grant = normalize(data)
            await vetoed(req, grant, 'grant')
            const dup = await req.payload.find({
              collection: GRANTS as never,
              where: {
                and: [
                  { holder: { equals: holder } },
                  { position: { equals: data.position } },
                  { status: { in: LIVE } },
                  data.scopeKind ? { scopeKind: { equals: data.scopeKind } } : { scopeKind: { exists: false } },
                  data.scopeId ? { scopeId: { equals: data.scopeId } } : { scopeId: { exists: false } },
                ],
              },
              limit: 20,
              depth: 0,
              overrideAccess: true,
              req,
            })
            if ((dup.docs as unknown as PositionGrant[]).some((d) => !d.endsAt || Date.parse(d.endsAt) > now))
              throw refuse('That account already holds this position here.')
            await run(opts.audit?.beforeGrant, { event: 'grant', phase: 'before', grant, by: asker, req }, true)
            return data
          }

          // An update. Who, what and where never change; a grant that is wrong is revoked and made again.
          const before = normalize(originalDoc)
          for (const f of ['holder', 'position', 'scopeKind', 'scopeId', 'grantedBy', 'startsAt'] as const) {
            if (!(f in data)) continue
            const a = f === 'holder' || f === 'grantedBy' ? idOf(data[f]) : (data[f] ?? null)
            const b = f === 'holder' || f === 'grantedBy' ? idOf(originalDoc[f]) : (originalDoc[f] ?? null)
            if (f === 'startsAt' ? ms(a) !== ms(b) : String(a ?? '') !== String(b ?? '')) throw refuse('Only the status, end date and notes can be changed.')
          }
          delete data.revokedAt
          delete data.revokedBy
          const status: PositionStatus = (data.status ?? before.status) as PositionStatus
          if (!['active', 'paused', 'revoked', 'expired'].includes(status)) throw refuse('Unknown status.')
          const wasLive = LIVE.includes(before.status)
          if (status !== before.status && !wasLive) throw refuse('A revoked or expired grant is final. Make a new one.')
          if ('endsAt' in data && ms(data.endsAt) !== ms(originalDoc.endsAt)) {
            if (!wasLive) throw refuse('A revoked or expired grant is final. Make a new one.')
            if (!dateOk(data.endsAt)) throw refuse('That date isn’t valid.')
            const e = ms(data.endsAt)
            const s = ms(originalDoc.startsAt)
            if (e !== null && s !== null && e <= s) throw refuse('The end date must come after the start date.')
          }
          if (status === before.status) return data
          const asker = by(req)
          if (status === 'revoked') {
            data.revokedAt = new Date(now).toISOString()
            data.revokedBy = asker
            await run(opts.audit?.beforeRevoke, { event: 'revoke', phase: 'before', grant: { ...before, ...normalize({ ...originalDoc, ...data }) }, previous: before, by: asker, req }, true)
          } else if (status === 'expired') {
            const e = ms(data.endsAt ?? originalDoc.endsAt)
            if (e === null || e > now) throw refuse('A grant can only expire once its end date has passed.')
            await run(opts.audit?.beforeExpire, { event: 'expire', phase: 'before', grant: { ...before, status: 'expired' }, previous: before, by: asker, req }, true)
          } else if (status === 'active') {
            await vetoed(req, before, 'reactivate')
          }
          return data
        },
      ],
      afterChange: [
        async ({ doc, previousDoc, operation, req }) => {
          const grant = normalize(doc)
          const asker = by(req)
          if (operation === 'create') {
            await run(opts.audit?.afterGrant, { event: 'grant', phase: 'after', grant, by: asker, req }, false)
          } else if (previousDoc && previousDoc.status !== doc.status) {
            const previous = normalize(previousDoc)
            if (doc.status === 'revoked') await run(opts.audit?.afterRevoke, { event: 'revoke', phase: 'after', grant, previous, by: asker, req }, false)
            if (doc.status === 'expired') await run(opts.audit?.afterExpire, { event: 'expire', phase: 'after', grant, previous, by: asker, req }, false)
          }
          return doc
        },
      ],
    },
  }
}
