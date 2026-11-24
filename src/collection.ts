import { AsyncLocalStorage } from 'node:async_hooks'

import { APIError, Forbidden, ValidationError, type CollectionBeforeChangeHook, type CollectionConfig, type PayloadRequest, type Where } from 'payload'

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
const HOLDS = 'That account already holds this position here.'
const PENDING = 'A grant is set to pending by the plugin only.'
const GENERAL = 'This position can’t be granted.'
const CLAIM = Symbol.for('positions.claim')
const LIVE: PositionStatus[] = ['pending', 'active', 'paused']
/** Payload's own where operators (`validOperators` in payload 3.92). Any other key under a field is not an operator, and the answer is no. */
const OPERATORS = new Set(['equals', 'not_equals', 'in', 'not_in', 'all', 'exists', 'greater_than', 'greater_than_equal', 'less_than', 'less_than_equal', 'like', 'not_like', 'contains', 'near', 'within', 'intersects'])
/** A where from the host counts only when it is a real one: at least one condition, every field holding only Payload's operators, and `and` or `or` holding a non-empty list of wheres. `{}`, `[]` and anything else mean no. */
const isWhere = (v: unknown): v is Where => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const entries = Object.entries(v)
  if (entries.length === 0) return false
  // `and` and `or` hold a non-empty list of wheres; any other key is a field holding at least one operator.
  return entries.every(([key, value]) =>
    key === 'and' || key === 'or'
      ? Array.isArray(value) && value.length > 0 && value.every(isWhere)
      : !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0 && Object.keys(value).every((op) => OPERATORS.has(op)),
  )
}
/**
 * True when every field a where names exists on the collection, so a stray field never reaches the database as a query error (a 500).
 * `nested` lists the fields that may be dotted into (a relationship, or a JSON field); any other field with a dot is refused.
 * `related` answers for the path after a relationship's name (`holder.email` gives `['email']`).
 */
const usesOnly = (w: Where, fields: Set<string>, nested: Set<string>, related?: (rest: string[]) => boolean): boolean =>
  Object.entries(w).every(([key, value]) => {
    if (key === 'and' || key === 'or') return (value as Where[]).every((x) => usesOnly(x, fields, nested, related))
    const [head, ...rest] = key.split('.')
    if (!fields.has(head!)) return false
    if (rest.length === 0) return true
    if (!nested.has(head!)) return false
    // A dotted relationship (`holder.email`) must name a field the related collection has; any other would be a query error.
    return !related || related(rest)
  })
type FlatField = { name?: string; type?: string; relationTo?: unknown; flattenedFields?: FlatField[]; fields?: FlatField[] }
const BASE_FIELDS = new Set(['id', 'createdAt', 'updatedAt'])
/**
 * Whether a path (already split at the dots) names a real field, read from a collection's flattened fields. It goes into
 * groups, tabs and arrays, follows a relationship to one collection, and lets a JSON field take any path below it.
 * Anything else, and any path that runs past a plain field (`email.x`), is no.
 */
function resolvesIn(fields: FlatField[], path: string[], collections: Record<string, { config?: { flattenedFields?: FlatField[] } }>, depth = 0): boolean {
  const [head, ...rest] = path
  if (head === undefined || depth > 8) return false
  const f = fields.find((x) => x.name === head)
  if (!f) return rest.length === 0 && BASE_FIELDS.has(head)
  if (rest.length === 0) return true
  if (f.type === 'json') return true
  if (f.type === 'group' || f.type === 'tab' || f.type === 'array') return resolvesIn(f.flattenedFields ?? f.fields ?? [], rest, collections, depth + 1)
  if ((f.type === 'relationship' || f.type === 'upload') && typeof f.relationTo === 'string') {
    const next = collections[f.relationTo]?.config?.flattenedFields
    return !!next && resolvesIn(next, rest, collections, depth + 1)
  }
  return false
}
/** The fields a history row has. Only `snapshot` and `previous` (JSON) can be dotted into; `grant`, `event` and `by` are text. */
const HISTORY_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'grant', 'event', 'by', 'snapshot', 'previous'])
const usesOnHistory = (w: Where) => usesOnly(w, HISTORY_FIELDS, new Set(['snapshot', 'previous']))
/** The fields a grant has that a host where may name. `notes` and the hidden live key are left out. The relationships can be dotted into. */
const GRANT_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'holder', 'position', 'scopeKind', 'scopeId', 'startsAt', 'endsAt', 'grantedBy', 'status', 'revokedAt', 'revokedBy'])
const RELATED = new Set(['holder', 'grantedBy', 'revokedBy'])
const usesOnGrants = (w: Where, related: (rest: string[]) => boolean) => usesOnly(w, GRANT_FIELDS, RELATED, related)
const NO_ROWS: Where = { id: { in: [] } }
const STATUSES = ['pending', 'active', 'paused', 'revoked', 'expired']
/** A date, or a date and a time that carries its zone (`Z` or an offset). A time with no zone would be read in the server's zone, so it is refused. */
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):?(\d{2})))?$/
const none = (v: unknown) => v === null || v === undefined || v === ''
/** True when the string is a real calendar date and time, so `2026-02-30` is refused instead of rolling over to 2 March. */
function realIso(v: string): boolean {
  const m = ISO.exec(v)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const day = new Date(Date.UTC(y, mo - 1, d))
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return false
  if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59 || (m[6] !== undefined && Number(m[6]) > 59))) return false
  if (m[8] !== undefined && (Number(m[8]) > 23 || Number(m[9]) > 59)) return false
  return true
}
const ms = (v: unknown): number | null => (none(v) ? null : v instanceof Date ? v.getTime() : typeof v === 'string' && realIso(v) ? Date.parse(v) : Number.NaN)
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
    else if (next.status === 'active') out.push(prev.status === 'pending' ? 'accept' : 'resume')
    else if (next.status === 'pending' && prev.status === 'paused') out.push('resume')
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
      return !grant && isWhere(answer) ? answer : false
    } catch {
      return false
    }
  }
  /** True for the errors a database gives when two transactions write the same row at once. */
  const conflict = (e: unknown) => {
    const x = e as { code?: unknown; codeName?: string; errorLabels?: string[]; hasErrorLabel?: (l: string) => boolean; message?: string }
    return (
      x?.code === 112 ||
      x?.codeName === 'WriteConflict' ||
      !!x?.errorLabels?.includes('TransientTransactionError') ||
      (typeof x?.hasErrorLabel === 'function' && x.hasErrorLabel('TransientTransactionError')) ||
      /write conflict|deadlock|could not serialize|serialization/i.test(String(x?.message ?? ''))
    )
  }
  /** Writes the row once to hold its lock for this transaction. Two changes at once: the second gets a clean refusal. */
  async function claim(req: PayloadRequest, id: unknown) {
    // With no transaction the write can't be rolled back by a later refusal, so it would only leave an `updatedAt` bump behind.
    if (!(await req.transactionID)) return
    try {
      await req.payload.db.updateOne({ collection: GRANTS as never, id: id as never, data: {} as never, req, returning: false } as never)
    } catch (e) {
      if (conflict(e)) throw refuse('This grant was just changed. Check it and try again.')
      throw e
    }
  }
  /** Whether a path below a relationship to the accounts collection is a real field there. Anything unreadable is no. */
  const userPathOf = (req: PayloadRequest) => (rest: string[]): boolean => {
    try {
      const cols = req.payload.collections as unknown as Record<string, { config?: { flattenedFields?: FlatField[] } }>
      return resolvesIn(cols[users as unknown as string]?.config?.flattenedFields ?? [], rest, cols)
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

  /**
   * The host's veto, run only when the holder accepts a grant, never when someone grants it, so the granter can't learn
   * the answer. Only `null` or nothing goes ahead. A person (a signed-in request) who is vetoed gets a plain Forbidden.
   * Server code with no user still gets the host's reason.
   */
  async function vetoed(req: PayloadRequest, grant: PositionGrant, action: 'grant') {
    const veto = opts.refuseGrant
    if (!veto) return
    const no = (reason: string) => (req.user ? new Forbidden(req.t) : refuse(reason))
    const holder = await req.payload
      .findByID({ collection: users as never, id: grant.holder, depth: 0, overrideAccess: true, req })
      .catch(() => null)
    if (!holder) throw no(GENERAL)
    let why: unknown
    try {
      // No end date is always null, never missing, so a veto can tell "no end" from a field it forgot to read.
      why = await veto({ req, holder: holder as never, grant: { ...grant, endsAt: none(grant.endsAt) ? null : grant.endsAt } as PositionGrant, action })
    } catch {
      throw no(GENERAL)
    }
    if (why === null || why === undefined) return
    throw no(typeof why === 'string' && why.trim() ? why : GENERAL)
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

  /**
   * Takes the row's write lock, after every refusal and the veto. The lock writes the row (and bumps `updatedAt`), and a
   * second change at the same moment gets a clean refusal here. Claiming earlier would let a refused accept of a vetoed
   * holder make a granter's edit fail, or bump `updatedAt`, which would tell the granter. `claimLast` keeps it after hooks
   * the host adds.
   */
  const claimHook: CollectionBeforeChangeHook = Object.assign(
    async ({ data, originalDoc, operation, req }: Parameters<CollectionBeforeChangeHook>[0]) => {
      if (operation === 'update' && originalDoc) await claim(req, originalDoc.id)
      return data
    },
    { [CLAIM]: true },
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
      update: async ({ req, id, data }) => {
        if (await canRevoke(req, { id, data: data as Partial<PositionGrant> })) return true
        // A holder may touch only their own pending grant (to accept or decline it); the hook narrows it further.
        const user = signedIn(req)
        return user ? ({ and: [{ holder: { equals: user.id } }, { status: { equals: 'pending' } }] } as Where) : false
      },
      delete: () => false,
      read: async ({ req }) => {
        const user = signedIn(req)
        if (!user) return false
        if (opts.canRead) {
          try {
            const answer = await opts.canRead({ req, user })
            return answer === true ? true : isWhere(answer) ? (usesOnGrants(answer, userPathOf(req)) ? answer : NO_ROWS) : false
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
        // No default and not required: the plugin sets every new grant to pending itself, and refuses a client that asks for it.
        index: true,
        options: [
          { label: 'Pending acceptance', value: 'pending' },
          { label: 'Active', value: 'active' },
          { label: 'Paused', value: 'paused' },
          { label: 'Revoked', value: 'revoked' },
          { label: 'Expired', value: 'expired' },
        ],
        admin: {
          // A new grant always starts pending, set by the plugin, so the create form doesn't offer a status to pick.
          condition: (data) => Boolean((data as { id?: unknown } | undefined)?.id),
          description: 'A grant is pending until the holder accepts it, and gives nothing until then. Revoked and expired are final. A paused grant gives nothing until it is made active again.',
        },
      },
      { name: 'revokedAt', type: 'date', admin: { readOnly: true } },
      { name: 'revokedBy', type: 'relationship', relationTo: users as never, admin: { readOnly: true } },
      {
        name: 'notes',
        type: 'textarea',
        maxLength: 2000,
        // With no document (a `where` on notes), the answer is no: filtering would show which rows match.
        access: { read: async ({ req, doc }) => (doc ? (await readPrivate(req, normalize(doc as Record<string, unknown>))) === true : false) },
        admin: { description: 'Only people the host allows can read these (canReadPrivate). The holder can’t.' },
      },
      // Makes a second live grant for the same holder, position and scope fail in the database, not just in a check.
      { name: 'liveKey', type: 'text', unique: true, index: true, hidden: true, admin: { disabled: true } },
    ],
    hooks: {
      // A bulk update (a `where`, no id) is refused before access and before any other hook. Payload's bulk update catches each row's
      // error and commits, so a refused accept would keep the write lock's `updatedAt` bump and show which holders were vetoed.
      beforeOperation: [
        ({ args, operation }) => {
          const a = args as { where?: unknown; id?: unknown }
          if (operation === 'update' && a.id === undefined && a.where !== undefined) throw refuse('Grants are changed one at a time. Update each grant by its id.')
        },
      ],
      beforeValidate: [
        ({ data, operation }) => {
          if (operation !== 'create' || !data) return data
          if (data.status === 'pending') throw refuse(PENDING)
          data.status = 'pending'
          return data
        },
      ],
      beforeDelete: [
        () => {
          throw refuse('Grants are never deleted. Revoke the grant instead.')
        },
      ],
      beforeChange: [
        async ({ data, originalDoc, operation, req }) => {
          await needTransaction(req)
          const now = Date.now()
          // Only the plugin sets a grant to pending (on create, in beforeValidate, and on a resume or an extension). A client can't, over any API:
          // it would skip the grant check on a resume and let a paused or active grant be lifted by the holder accepting.
          if (operation === 'update' && data.status === 'pending' && originalDoc?.status !== 'pending') throw refuse(PENDING)
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
            // Every grant starts pending, for everyone. The host veto runs when the holder accepts.
            data.status = 'pending'
            data.revokedAt = null
            data.revokedBy = null
            data.holder = holder
            const asker = by(req)
            if (asker !== null) data.grantedBy = asker
            const grant = normalize(data)
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
              // No page count: Payload's Mongo adapter sends the find and its count at once, and when this is the first
              // query in the transaction the two race to start it (NoSuchTransaction). We don't need the total.
              pagination: false,
              depth: 0,
              overrideAccess: true,
              req,
            })
            // A grant past its end that the sweep hasn't reached is expired now, so it doesn't block a fresh one.
            for (const d of dup.docs as unknown as PositionGrant[]) {
              if (d.endsAt && Date.parse(d.endsAt) <= now)
                await req.payload.update({ collection: GRANTS as never, id: d.id as never, data: { status: 'expired' } as never, overrideAccess: true, req })
              else throw refuse(HOLDS)
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
          // A status that is sent must be one of the five. null or an empty value would end the grant with no history row and no audit event.
          if ('status' in data && data.status !== undefined && !STATUSES.includes(data.status as string)) throw refuse('Unknown status.')
          const status: PositionStatus = (data.status ?? before.status) as PositionStatus
          if (!STATUSES.includes(status)) throw refuse('Unknown status.')
          const wasLive = LIVE.includes(before.status)
          const final = 'A revoked or expired grant is final. Make a new one.'
          if (status !== before.status && !wasLive) throw refuse(final)
          const me0 = signedIn(req)
          const accepting = before.status === 'pending' && status === 'active'
          if (accepting) {
            // Only the holder (or server code with no user) accepts, and the veto runs here.
            if (req.user && !(me0 && same(me0.id, before.holder))) throw new Forbidden(req.t)
          }
          // A holder with no right to revoke may only accept or decline their own pending grant, and change nothing else.
          if (me0 && same(me0.id, before.holder) && !(await canRevoke(req, { id: before.id, data: data as Partial<PositionGrant> }))) {
            if (before.status !== 'pending' || (status !== 'active' && status !== 'revoked') || ('endsAt' in data && ms(data.endsAt) !== ms(originalDoc.endsAt))) throw new Forbidden(req.t)
          }
          const e0 = ms(originalDoc.endsAt)
          const endChanged = 'endsAt' in data && ms(data.endsAt) !== ms(originalDoc.endsAt)
          if (endChanged && (status === 'revoked' || status === 'expired') && before.status !== status) delete data.endsAt
          else if (endChanged) {
            if (!wasLive) throw refuse(final)
            if (!dateOk(data.endsAt)) throw refuse('That date isn’t valid.')
            const e = ms(data.endsAt)
            const s = ms(originalDoc.startsAt)
            if (e !== null && s !== null && e <= s) throw refuse('The end date must come after the start date.')
          }
          let next = { ...originalDoc, ...data }
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
                throw new Forbidden(req.t)
            } else if (req.user) throw new Forbidden(req.t)
            // The grant goes back to pending, whatever the holder is. The veto runs when the holder accepts again.
            // A paused grant that is only extended stays paused: an extension must not undo the pause.
            data.status = before.status === 'paused' && status === 'paused' ? 'paused' : 'pending'
            next = { ...originalDoc, ...data }
          }
          if (accepting) {
            if (e0 !== null && e0 <= now) throw refuse('The end date has already passed.')
            // The veto sees the grant as it stands, so it can judge its end date.
            await vetoed(req, { ...normalize({ ...originalDoc, ...data }), id: before.id }, 'grant')
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
        claimHook,
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
      read: async ({ req }) => {
        const answer = await readPrivate(req)
        return typeof answer === 'object' && !usesOnHistory(answer) ? NO_ROWS : answer
      },
      create: () => false,
      update: () => false,
      delete: () => false,
    },
    fields: [
      { name: 'grant', type: 'text', required: true, index: true },
      { name: 'event', type: 'select', required: true, options: ['grant', 'accept', 'revoke', 'expire', 'pause', 'resume', 'endDate'] },
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

/**
 * Moves the write lock to the end of the grants' beforeChange hooks, so a hook another plugin or the host added after
 * this one runs before it. A refusal from such a hook then leaves the row unwritten, with or without transactions.
 */
export function claimLast(payload: { collections?: Record<string, unknown> }): void {
  const hooks = (payload.collections?.[GRANTS] as { config?: { hooks?: { beforeChange?: unknown[] } } } | undefined)?.config?.hooks
  const list = hooks?.beforeChange
  if (!hooks || !list) return
  const mine = list.filter((h) => (h as Record<symbol, unknown>)[CLAIM])
  hooks.beforeChange = [...list.filter((h) => !(h as Record<symbol, unknown>)[CLAIM]), ...mine]
}

const names = (v: unknown) => /liveKey/.test(typeof v === 'string' ? v : v && typeof v === 'object' ? JSON.stringify(v) : '')
/**
 * True for the three errors that mean two identical grants met: a duplicate key on `liveKey` (and no other index), the
 * validation error the Mongo adapter makes of one, and a write conflict. Anything else is not ours to map.
 */
function isDuplicateGrant(e: unknown): boolean {
  const x = e as { code?: unknown; codeName?: string; message?: string; keyPattern?: unknown; keyValue?: unknown; data?: { errors?: { path?: string }[] } } | null
  if (!x || typeof x !== 'object') return false
  if (x.code === 112 || x.codeName === 'WriteConflict') return true
  if ((x.code === 11000 || x.code === 11001 || /E11000/.test(String(x.message ?? ''))) && (names(x.message) || names(x.keyPattern) || names(x.keyValue))) return true
  return e instanceof ValidationError && !!x.data?.errors?.some((f) => f?.path === 'liveKey')
}

/**
 * Two identical grants at once both pass the check for a live one, and the database's unique key on `liveKey` stops the
 * second. That arrives as a duplicate-key error, or, inside a transaction, as a write conflict on the same key. Either
 * one becomes the same refusal as the check gives. Only creates of grants are touched, and only those three errors.
 * The wrapper is needed because `afterError` hooks never see the Local API, and a check beforehand can't close the race.
 */
export function mapDuplicateGrant(payload: { db: { create: (args: never) => Promise<unknown> } }): void {
  const db = payload.db as { create: (args: { collection?: string }) => Promise<unknown>; __positionsGuard?: boolean }
  if (db.__positionsGuard) return
  db.__positionsGuard = true
  const create = db.create.bind(db)
  db.create = async (args) => {
    try {
      return await create(args)
    } catch (e) {
      if (args?.collection === GRANTS && isDuplicateGrant(e)) throw refuse(HOLDS)
      throw e
    }
  }
}
