import { AsyncLocalStorage } from 'node:async_hooks'

import { APIError, type CollectionConfig, type PayloadRequest, type Where } from 'payload'

import { idOf } from './helpers.js'
import {
  GRANTS,
  HISTORY,
  type AccessArgs,
  type AuditEvent,
  type AuditHook,
  type AuditName,
  type PositionGrant,
  type PositionStatus,
  type PositionsOptions,
} from './types.js'

const refuse = (message: string) => new APIError(message, 403, undefined, true)
const GENERAL = 'This position can’t be granted.'
const LIVE: PositionStatus[] = ['active', 'paused']
const ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/
const none = (v: unknown) => v === null || v === undefined || v === ''
/** A date as milliseconds, null for no date, and NaN for anything that isn't an ISO date string or a Date (so `0` and `'1'` are bad dates, not no date). */
const ms = (v: unknown): number | null => (none(v) ? null : v instanceof Date ? v.getTime() : typeof v === 'string' && ISO.test(v) ? Date.parse(v) : Number.NaN)
const dateOk = (v: unknown) => none(v) || !Number.isNaN(ms(v))
const same = (a: unknown, b: unknown) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b)

/** Only the plugin's own code may add a history row. */
const writingHistory = new AsyncLocalStorage<true>()

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

type Shape = { status?: unknown; endsAt?: unknown }
/** The audit events a change amounts to. */
function eventsOf(prev: Shape, next: Shape): AuditName[] {
  const out: AuditName[] = []
  if (next.status !== prev.status) {
    if (next.status === 'revoked') out.push('revoke')
    else if (next.status === 'expired') out.push('expire')
    else if (next.status === 'paused') out.push('pause')
    else if (next.status === 'active') out.push('resume')
  } else if (ms(next.endsAt) !== ms(prev.endsAt)) out.push('endDate')
  if (next.status !== prev.status && next.status !== 'revoked' && next.status !== 'expired' && ms(next.endsAt) !== ms(prev.endsAt)) out.push('endDate')
  return out
}
const hookName = (phase: 'before' | 'after', event: AuditName) =>
  `${phase}${event === 'endDate' ? 'EndDateChange' : event[0]!.toUpperCase() + event.slice(1)}` as keyof NonNullable<PositionsOptions['audit']>

export function positionCollections(opts: Required<Pick<PositionsOptions, 'users' | 'positionTypes' | 'scopeKinds'>> & PositionsOptions): CollectionConfig[] {
  const { users, positionTypes, scopeKinds } = opts
  const signedIn = (req: PayloadRequest) => {
    const user = req.user as ({ id: string | number; collection?: string } & Record<string, unknown>) | null
    return user && user.collection === users ? user : null
  }
  const ask = (fn: PositionsOptions['canGrant'], req: PayloadRequest, extra: Partial<AccessArgs> = {}) => {
    const user = signedIn(req)
    if (!user || !fn) return false
    const data = extra.data ? { ...extra.data, holder: idOf(extra.data.holder) as string | number } : undefined
    return exactlyTrue(() => fn({ req, user, ...extra, data }))
  }
  const canGrant = (req: PayloadRequest, extra: Partial<AccessArgs> = {}) => ask(opts.canGrant, req, extra)
  const canRevoke = (req: PayloadRequest, extra: Partial<AccessArgs> = {}) => ask(opts.canRevoke ?? opts.canGrant, req, extra)
  /** The signed-in user's id, only when they are in the users collection. Relationship fields can only hold those. */
  const by = (req: PayloadRequest) => idOf(signedIn(req))
  /** Who acted, as `collection:id`, so ids from different collections never look alike. Null for server code. */
  const actor = (req: PayloadRequest) => {
    const u = req.user as { id?: string | number; collection?: string } | null
    return u && u.id !== undefined && u.collection ? { collection: u.collection, id: u.id } : null
  }
  /** Notes and history. Nobody without the host's `canReadPrivate`; only `true` or, for history, a `where` counts. */
  async function readPrivate(req: PayloadRequest, grant?: PositionGrant): Promise<boolean | Where> {
    const user = signedIn(req)
    if (!user || !opts.canReadPrivate) return false
    try {
      const answer = await opts.canReadPrivate({ req, user, grant })
      if (answer === true) return true
      return !grant && answer && typeof answer === 'object' ? answer : false
    } catch {
      return false
    }
  }
  /** Writes need a transaction so the history row and the change stand or fall together. */
  async function needTransaction(req: PayloadRequest) {
    // The id may still be a promise, and stays one when the adapter has no transactions to give.
    if (opts.allowWithoutTransactions || (await req.transactionID)) return
    req.payload.logger.error('positions: refusing a change because the database has transactions off. Turn them on, or set allowWithoutTransactions.')
    throw refuse('This can’t be done right now.')
  }

  const run = async (name: keyof NonNullable<PositionsOptions['audit']>, event: AuditEvent, mustPass: boolean) => {
    const hook: AuditHook | undefined = opts.audit?.[name]
    if (!hook) return
    try {
      await hook(event)
    } catch (error) {
      if (mustPass) throw refuse('This change can’t be recorded right now, so it wasn’t made.')
      event.req.payload.logger.error(`positions: the ${event.event} audit hook failed: ${(error as Error).message}`)
    }
  }

  /** The host's veto. Only `null` or nothing goes ahead; a reason is shown; anything else is a general refusal. */
  async function vetoed(req: PayloadRequest, grant: PositionGrant, action: 'grant' | 'reactivate' | 'extend') {
    const veto = opts.refuseGrant
    if (!veto) return
    const holder = await req.payload
      .findByID({ collection: users as never, id: grant.holder, depth: 0, overrideAccess: true, req })
      .catch(() => null)
    if (!holder) throw refuse(GENERAL)
    let why: unknown
    try {
      why = await veto({ req, holder: holder as never, grant, action })
    } catch {
      throw refuse(GENERAL)
    }
    if (why === null || why === undefined) return
    throw refuse(typeof why === 'string' && why.trim() ? why : GENERAL)
  }

  /** A person can't grant themselves a position unless the host opts in. Server code with no user is not a person. */
  const noSelf = (req: PayloadRequest, holder: unknown) => {
    if (opts.allowSelfGrant) return
    const me = signedIn(req)
    if (me && same(me.id, idOf(holder))) throw refuse('You can’t do that for your own account.')
  }

  const snapshot = (g: PositionGrant) => ({
    holder: g.holder,
    position: g.position,
    scopeKind: g.scopeKind ?? null,
    scopeId: g.scopeId ?? null,
    startsAt: g.startsAt ?? null,
    endsAt: g.endsAt ?? null,
    grantedBy: g.grantedBy ?? null,
    status: g.status,
  })
  const record = (req: PayloadRequest, event: AuditName, grant: PositionGrant, previous?: PositionGrant) =>
    writingHistory.run(true, () =>
      req.payload.create({
        collection: HISTORY as never,
        data: { grant: String(grant.id), event, by: actor(req) ? `${actor(req)!.collection}:${String(actor(req)!.id)}` : null, snapshot: snapshot(grant), previous: previous ? snapshot(previous) : null } as never,
        overrideAccess: true,
        req,
      }),
    )

  const grants: CollectionConfig = {
    slug: GRANTS,
    labels: { singular: 'Position grant', plural: 'Position grants' },
    admin: {
      group: opts.adminGroup ?? 'Accounts',
      useAsTitle: 'position',
      defaultColumns: ['holder', 'position', 'scopeKind', 'scopeId', 'status', 'endsAt'],
      description:
        'Who holds which position, and where. Revoke a grant by setting its status to Revoked; grants are never deleted, so the record stays. The history collection keeps every change.',
    },
    access: {
      create: ({ req, data }) => canGrant(req, { data: data as Partial<PositionGrant>, change: 'grant' }),
      update: ({ req, id, data }) => canRevoke(req, { id, data: data as Partial<PositionGrant> }),
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
      { name: 'scopeId', type: 'text', index: true, maxLength: 200, admin: { description: 'The id of that record.' } },
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
      {
        name: 'notes',
        type: 'textarea',
        maxLength: 2000,
        access: { read: async ({ req, doc }) => (await readPrivate(req, normalize((doc ?? {}) as Record<string, unknown>))) === true },
        admin: { description: 'Only people the host allows can read these (canReadPrivate). The holder can’t.' },
      },
      // Makes a second live grant for the same holder, position and scope fail in the database, not just in a check.
      { name: 'liveKey', type: 'text', unique: true, index: true, hidden: true, admin: { disabled: true } },
    ],
    hooks: {
      beforeDelete: [
        () => {
          throw refuse('Grants are never deleted. Revoke the grant instead.')
        },
      ],
      beforeChange: [
        async ({ data, originalDoc, operation, req }) => {
          await needTransaction(req)
          const now = Date.now()
          if (operation === 'create') {
            const type = positionTypes.find((t) => t.value === data.position)
            if (!type) throw refuse('Unknown position.')
            const holder = idOf(data.holder)
            if (holder === null) throw refuse('A grant needs a holder.')
            noSelf(req, holder)
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
            // A grant past its end that the sweep hasn't reached is expired now, so it doesn't block a fresh one.
            for (const d of dup.docs as unknown as PositionGrant[]) {
              if (d.endsAt && Date.parse(d.endsAt) <= now)
                await req.payload.update({ collection: GRANTS as never, id: d.id as never, data: { status: 'expired' } as never, overrideAccess: true, req })
              else throw refuse('That account already holds this position here.')
            }
            // The database's unique index on this key is what stops two requests at once.
            data.liveKey = JSON.stringify([holder, data.position, data.scopeKind ?? null, data.scopeId ?? null])
            await run('beforeGrant', { event: 'grant', phase: 'before', grant, by: actor(req), req }, true)
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
          delete data.liveKey
          // Someone who can't read the notes can't overwrite them either: it would destroy what they can't see.
          if ('notes' in data && (data.notes ?? '') !== (originalDoc.notes ?? '') && req.user && (await readPrivate(req, before)) !== true)
            throw refuse('You can’t change these notes.')
          const status: PositionStatus = (data.status ?? before.status) as PositionStatus
          if (!['active', 'paused', 'revoked', 'expired'].includes(status)) throw refuse('Unknown status.')
          const wasLive = LIVE.includes(before.status)
          const final = 'A revoked or expired grant is final. Make a new one.'
          if (status !== before.status && !wasLive) throw refuse(final)
          const endChanged = 'endsAt' in data && ms(data.endsAt) !== ms(originalDoc.endsAt)
          if (endChanged && (status === 'revoked' || status === 'expired') && before.status !== status) delete data.endsAt
          else if (endChanged) {
            if (!wasLive) throw refuse(final)
            if (!dateOk(data.endsAt)) throw refuse('That date isn’t valid.')
            const e = ms(data.endsAt)
            const s = ms(originalDoc.startsAt)
            if (e !== null && s !== null && e <= s) throw refuse('The end date must come after the start date.')
          }
          const next = { ...originalDoc, ...data }
          const o = ms(originalDoc.endsAt)
          const n = ms(next.endsAt)
          const resume = before.status === 'paused' && status === 'active'
          const extend = wasLive && status !== 'revoked' && status !== 'expired' && ms(next.endsAt) !== o && ((n === null && o !== null) || (n !== null && o !== null && n > o))
          // Giving more than the grant gave before is a grant: it needs canGrant, the veto, and not being your own.
          if (resume || extend) {
            const me = signedIn(req)
            if (me) {
              noSelf(req, before.holder)
              if (!(await canGrant(req, { id: before.id, data: { ...(data as Partial<PositionGrant>), holder: before.holder }, grant: before, change: resume ? 'resume' : 'extend' })))
                throw refuse('You can’t do that.')
            } else if (req.user) throw refuse('You can’t do that.')
            // The veto sees the grant as it would be after the change, so it can judge the new end date.
            await vetoed(req, { ...normalize({ ...originalDoc, ...data }), id: before.id }, resume ? 'reactivate' : 'extend')
          }
          const asker = by(req)
          const merged = normalize(next)
          if (status === 'revoked' && before.status !== 'revoked') {
            data.revokedAt = new Date(now).toISOString()
            data.revokedBy = asker
            data.liveKey = `ended:${String(originalDoc.id)}`
          } else if (status === 'expired' && before.status !== 'expired') {
            const e = ms(next.endsAt)
            if (e === null || e > now) throw refuse('A grant can only expire once its end date has passed.')
            data.liveKey = `ended:${String(originalDoc.id)}`
          }
          for (const event of eventsOf(before, next))
            await run(hookName('before', event), { event, phase: 'before', grant: merged, previous: before, by: actor(req), req }, true)
          return data
        },
      ],
      afterChange: [
        async ({ doc, previousDoc, operation, req }) => {
          const grant = normalize(doc)
          const asker = by(req)
          if (operation === 'create') {
            await record(req, 'grant', grant)
            await run('afterGrant', { event: 'grant', phase: 'after', grant, by: actor(req), req }, false)
          } else if (previousDoc) {
            const previous = normalize(previousDoc)
            for (const event of eventsOf(previous, grant)) {
              await record(req, event, grant, previous)
              await run(hookName('after', event), { event, phase: 'after', grant, previous, by: actor(req), req }, false)
            }
          }
          return doc
        },
      ],
    },
  }

  const history: CollectionConfig = {
    slug: HISTORY,
    labels: { singular: 'Position grant history', plural: 'Position grant history' },
    admin: {
      group: opts.adminGroup ?? 'Accounts',
      defaultColumns: ['grant', 'event', 'by', 'createdAt'],
      description: 'Every grant, pause, resume, end-date change, revoke and expiry. Rows are added by the plugin and can’t be changed or deleted.',
    },
    access: {
      read: ({ req }) => readPrivate(req),
      create: () => false,
      update: () => false,
      delete: () => false,
    },
    fields: [
      { name: 'grant', type: 'text', required: true, index: true },
      { name: 'event', type: 'select', required: true, options: ['grant', 'revoke', 'expire', 'pause', 'resume', 'endDate'] },
      { name: 'by', type: 'text', admin: { description: 'The signed-in user’s id. Empty for server code and the expiry sweep.' } },
      { name: 'snapshot', type: 'json' },
      { name: 'previous', type: 'json' },
    ],
    hooks: {
      beforeChange: [
        ({ data, operation }) => {
          if (operation !== 'create' || !writingHistory.getStore()) throw refuse('The history is only written by the plugin.')
          return data
        },
      ],
      beforeDelete: [
        () => {
          throw refuse('The history is never deleted.')
        },
      ],
    },
  }

  return [grants, history]
}
