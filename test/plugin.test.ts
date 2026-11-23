import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { configToSchema } from '@payloadcms/graphql'
import { graphql } from 'graphql'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, createLocalReq, getPayload, handleEndpoints, type Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { checkTransactions, expireGrants, hasPosition, positions, positionsOf, type AuditEvent } from '../src/index.js'

/**
 * A made-up site: users with a level (staff may grant), two position types and two scope kinds, a host veto for anyone
 * flagged `underage`, and an audit log in memory.
 */
const PW = 'correct-horse-battery'
let payload: Payload
let mongo: MongoMemoryReplSet
const log: string[] = []
const answers: { canGrant?: () => unknown; refuse?: (a?: never) => unknown; beforeGrant?: () => void } = {}
const seen: { grant?: unknown[]; revoke?: unknown[] } = {}
const DAY = 86_400_000
const iso = (offset: number) => new Date(Date.now() + offset).toISOString()

type U = { id: string | number; level?: string }
let staff: U, other: U, alice: U, kid: U, revoker: U

const as = (user: U) => ({ ...user, collection: 'users' }) as never
const make = (email: string, extra: Record<string, unknown> = {}) =>
  payload.create({ collection: 'users', data: { email, password: PW, ...extra } as never }) as unknown as Promise<U>
const grant = (data: Record<string, unknown>, user: U | null = staff) =>
  payload.create({ collection: 'position-grants' as never, data: data as never, user: (user ? as(user) : undefined) as never, overrideAccess: false })
const base = () => ({ holder: alice.id, position: 'editor', scopeKind: 'project', scopeId: 'p-1' })
const grants = () => payload.find({ collection: 'position-grants' as never, pagination: false, overrideAccess: true })
const refused = async (p: Promise<unknown>) => {
  try {
    await p
    return null
  } catch (e) {
    return (e as Error).message
  }
}
const history = async () => (await payload.find({ collection: 'position-grant-history' as never, pagination: false, overrideAccess: true })).docs
/** Wait for every collection and index of a fresh instance, so the first write doesn't race the index build. */
const settle = async (p: Payload) => {
  await Promise.all(Object.values((p.db as unknown as { collections: Record<string, { init: () => Promise<unknown> }> }).collections).map((m) => m.init()))
}
/** Close an instance, even one whose start-up failed: a second getPayload on that key skips onInit and hands back the cached entry. */
const close = async (config: Awaited<ReturnType<typeof buildConfig>>, key: string) => {
  const p = await getPayload({ config, key, disableOnInit: true }).catch(() => null)
  await p?.db?.destroy?.()
}
const record = (e: AuditEvent) => {
  log.push(`${e.phase}:${e.event}`)
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  const config = await buildConfig({
    secret: 'test-secret-not-for-production',
    telemetry: false,
    typescript: { autoGenerate: false },
    db: mongooseAdapter({ url: mongo.getUri('positions'), ensureIndexes: true }),
    collections: [
      {
        slug: 'users',
        auth: true,
        fields: [{ name: 'level', type: 'text' }, { name: 'underage', type: 'checkbox' }],
      },
    ],
    plugins: [
      positions({
        positionTypes: [
          { value: 'editor', label: 'Editor' },
          { value: 'reviewer', scopeKinds: ['project'] },
          { value: 'steward', unscoped: true },
        ],
        scopeKinds: [{ value: 'project' }, { value: 'group' }],
        canGrant: (a) => {
          seen.grant?.push(a)
          return answers.canGrant ? (answers.canGrant() as boolean) : ['staff', 'scoped'].includes((a.user as U).level ?? '')
        },
        canRevoke: (a) => {
          seen.revoke?.push(a)
          return ['staff', 'revoker'].includes((a.user as U).level ?? '')
        },
        allowSelfGrant: false,
        canReadPrivate: ({ user, grant }) => {
          const level = (user as U).level
          if (level === 'staff') return true
          if (level === 'scoped') return grant ? grant.scopeId === 'p-1' : { 'snapshot.scopeId': { equals: 'p-1' } }
          return false
        },
        refuseGrant: (args) => {
          const { holder } = args
          if (answers.refuse) return answers.refuse(args as never) as string | null
          return (holder as { underage?: boolean }).underage ? 'Not available for this account.' : null
        },
        audit: {
          beforeGrant: (e) => {
            if (answers.beforeGrant) answers.beforeGrant()
            record(e)
          },
          afterGrant: record,
          beforeRevoke: record,
          afterRevoke: record,
          beforeExpire: record,
          afterExpire: record,
          beforePause: record,
          afterPause: record,
          beforeResume: record,
          afterResume: record,
          beforeEndDateChange: record,
          afterEndDateChange: record,
        },
      }),
    ],
  })
  payload = await getPayload({ config })
})

afterAll(async () => {
  await payload?.db?.destroy?.()
  await mongo?.stop()
})

beforeEach(async () => {
  for (const key of Object.keys(answers)) delete (answers as Record<string, unknown>)[key]
  log.length = 0
  delete seen.grant
  delete seen.revoke
  // Grants and history can't be deleted through Payload, so clear the in-memory test database directly.
  const models = (payload.db as unknown as { collections: Record<string, { deleteMany: (f: object) => Promise<unknown> }> }).collections
  await models['position-grants']!.deleteMany({})
  await models['position-grant-history']!.deleteMany({})
  await payload.delete({ collection: 'users', where: { id: { exists: true } }, overrideAccess: true })
  staff = await make('staff@example.com', { level: 'staff' })
  other = await make('other@example.com', { level: 'member' })
  alice = await make('alice@example.com', { level: 'member' })
  kid = await make('kid@example.com', { underage: true })
  revoker = await make('revoker@example.com', { level: 'revoker' })
})

describe('granting', () => {
  it('lets the host grant, records who granted it, and starts active', async () => {
    const g = (await grant({ ...base(), notes: 'made up' })) as never as { id: string; status: string; grantedBy: unknown; scopeId: string }
    expect(g.status).toBe('active')
    expect(String((g.grantedBy as { id?: unknown })?.id ?? g.grantedBy)).toBe(String(staff.id))
    expect(log).toEqual(['before:grant', 'after:grant'])
  })

  it('ignores a status, grantedBy or revoked fields sent by the client', async () => {
    const g = (await grant({ ...base(), status: 'paused', grantedBy: other.id, revokedAt: iso(0) })) as never as Record<string, unknown>
    expect(g.status).toBe('active')
    expect(String((g.grantedBy as { id?: unknown })?.id ?? g.grantedBy)).toBe(String(staff.id))
    expect(g.revokedAt ?? null).toBeNull()
  })

  it('refuses unknown positions, missing or wrong scopes, and scopes on unscoped types', async () => {
    expect(await refused(grant({ ...base(), position: 'nope' }))).toMatch(/Unknown position/)
    expect(await refused(grant({ holder: alice.id, position: 'editor' }))).toMatch(/needs a scope/)
    expect(await refused(grant({ ...base(), scopeKind: 'galaxy' as never }))).toBeTruthy()
    expect(await refused(grant({ ...base(), position: 'reviewer', scopeKind: 'group' }))).toMatch(/can’t be scoped/)
    expect(await refused(grant({ holder: alice.id, position: 'steward', scopeKind: 'project', scopeId: 'p-1' }))).toMatch(/no scope/)
    expect((await grants()).totalDocs).toBe(0)
  })

  it('grants an unscoped position with no scope', async () => {
    await grant({ holder: alice.id, position: 'steward' })
    expect(await hasPosition(payload, as(alice), 'steward')).toBe(true)
    expect(await hasPosition(payload, as(alice), 'steward', { kind: 'project', id: 'p-1' })).toBe(false)
  })

  it('refuses a second live grant for the same holder, position and scope, but not a different scope', async () => {
    await grant(base())
    expect(await refused(grant(base()))).toMatch(/already holds/)
    await grant({ ...base(), scopeId: 'p-2' })
    await grant({ holder: alice.id, position: 'steward' })
    expect(await refused(grant({ holder: alice.id, position: 'steward' }))).toMatch(/already holds/)
    expect((await grants()).totalDocs).toBe(3)
  })

  it('lets only one of several simultaneous identical grants through', async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => grant(base())))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((await grants()).totalDocs).toBe(1)
  })

  it('lets a grant be made again once the old one is expired, even before the sweep', async () => {
    await grant({ ...base(), endsAt: iso(700) })
    await new Promise((r) => setTimeout(r, 900))
    await grant(base())
    const all = (await grants()).docs as unknown as { status: string }[]
    expect(all.map((g) => g.status).sort()).toEqual(['active', 'expired'])
  })

  it('refuses bad dates', async () => {
    expect(await refused(grant({ ...base(), endsAt: iso(-DAY) }))).toMatch(/already passed/)
    expect(await refused(grant({ ...base(), startsAt: iso(2 * DAY), endsAt: iso(DAY) }))).toMatch(/after the start/)
    expect((await grants()).totalDocs).toBe(0)
  })
})

describe('fail-closed access', () => {
  it('refuses everyone when the host gave no canGrant answer of exactly true', async () => {
    for (const bad of [() => 1, () => 'yes', () => ({}), () => undefined, () => { throw new Error('down') }]) {
      answers.canGrant = bad
      expect(await refused(grant(base()))).toBeTruthy()
    }
    expect((await grants()).totalDocs).toBe(0)
  })

  it('refuses a signed-out request and a user who is not staff', async () => {
    expect(await refused(grant(base(), null))).toBeTruthy()
    expect(await refused(grant(base(), other))).toBeTruthy()
    expect((await grants()).totalDocs).toBe(0)
  })

  it('refuses everyone when the plugin has no canGrant at all', async () => {
    const bare = await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri('bare'), transactionOptions: false }),
      collections: [{ slug: 'users', auth: true, fields: [] }],
      plugins: [positions({ positionTypes: [{ value: 'editor' }], scopeKinds: [{ value: 'project' }], refuseGrant: false, allowWithoutTransactions: true })],
    })
    const p = await getPayload({ config: bare, key: 'bare' })
    const u = (await p.create({ collection: 'users', data: { email: 'x@example.com', password: PW } as never })) as unknown as U
    expect(await refused(p.create({ collection: 'position-grants' as never, data: { holder: u.id, position: 'editor', scopeKind: 'project', scopeId: 'a' } as never, user: as(u), overrideAccess: false }))).toBeTruthy()
    await p.db.destroy?.()
  })

  it('never lets a grant be deleted, even by staff', async () => {
    const g = (await grant(base())) as never as { id: string }
    expect(await refused(payload.delete({ collection: 'position-grants' as never, id: g.id, user: as(staff), overrideAccess: false }))).toBeTruthy()
    expect((await grants()).totalDocs).toBe(1)
  })

  it('lets a holder read only their own grants, and staff read all', async () => {
    await grant(base())
    await grant({ holder: other.id, position: 'editor', scopeKind: 'project', scopeId: 'p-9' })
    const read = (u: U | null) => payload.find({ collection: 'position-grants' as never, user: (u ? as(u) : undefined) as never, overrideAccess: false })
    expect((await read(alice)).totalDocs).toBe(1)
    expect((await read(staff)).totalDocs).toBe(2)
    expect(await refused(read(null))).toBeTruthy()
  })
})

describe('host refusal', () => {
  it('refuses a grant the host vetoes, with its reason, and audits nothing', async () => {
    expect(await refused(grant({ ...base(), holder: kid.id }))).toBe('Not available for this account.')
    expect((await grants()).totalDocs).toBe(0)
    expect(log).toEqual([])
  })

  it('applies the veto to server code that skips access', async () => {
    expect(await refused(payload.create({ collection: 'position-grants' as never, data: { ...base(), holder: kid.id } as never, overrideAccess: true }))).toBeTruthy()
  })

  it('treats a throw, false or a non-string answer as a refusal', async () => {
    for (const bad of [() => { throw new Error('down') }, () => false, () => 1, () => '']) {
      answers.refuse = bad
      expect(await refused(grant(base()))).toBeTruthy()
    }
    expect((await grants()).totalDocs).toBe(0)
  })

  it('stops a paused grant coming back for a holder the host now vetoes', async () => {
    const g = (await grant(base())) as never as { id: string }
    await payload.update({ collection: 'position-grants' as never, id: g.id, data: { status: 'paused' } as never, user: as(staff), overrideAccess: false })
    answers.refuse = () => 'Not available for this account.'
    expect(await refused(payload.update({ collection: 'position-grants' as never, id: g.id, data: { status: 'active' } as never, user: as(staff), overrideAccess: false }))).toMatch(/Not available/)
  })

  it('stops a grant when a before-audit hook fails', async () => {
    answers.beforeGrant = () => {
      throw new Error('audit store down')
    }
    expect(await refused(grant(base()))).toMatch(/can’t be recorded/)
    expect((await grants()).totalDocs).toBe(0)
  })
})

describe('date windows and helpers', () => {
  it('holds nothing before the start and nothing after the end', async () => {
    await grant({ ...base(), startsAt: iso(DAY) })
    const scope = { kind: 'project', id: 'p-1' }
    expect(await hasPosition(payload, as(alice), 'editor', scope)).toBe(false)
    expect(await hasPosition(payload, as(alice), 'editor', scope, { at: new Date(Date.now() + 2 * DAY) })).toBe(true)
    await grant({ ...base(), scopeId: 'p-2', endsAt: iso(DAY) })
    const p2 = { kind: 'project', id: 'p-2' }
    expect(await hasPosition(payload, as(alice), 'editor', p2)).toBe(true)
    expect(await hasPosition(payload, as(alice), 'editor', p2, { at: new Date(Date.now() + 2 * DAY) })).toBe(false)
    expect(await hasPosition(payload, as(alice), 'editor', p2, { at: new Date(Date.now() + DAY) })).toBe(false) // the end moment is out
  })

  it('answers for exactly the position and scope asked', async () => {
    await grant(base())
    expect(await hasPosition(payload, as(alice), 'editor', { kind: 'project', id: 'p-1' })).toBe(true)
    expect(await hasPosition(payload, as(alice), 'editor', { kind: 'project', id: 'p-2' })).toBe(false)
    expect(await hasPosition(payload, as(alice), 'editor', { kind: 'group', id: 'p-1' })).toBe(false)
    expect(await hasPosition(payload, as(alice), 'reviewer', { kind: 'project', id: 'p-1' })).toBe(false)
    expect(await hasPosition(payload, as(alice), 'editor')).toBe(false)
    expect(await hasPosition(payload, as(other), 'editor', { kind: 'project', id: 'p-1' })).toBe(false)
    expect(await hasPosition(payload, null, 'editor', { kind: 'project', id: 'p-1' })).toBe(false)
  })

  it('lists what a user holds now, with scopes and dates, and takes a request or a user id', async () => {
    await grant(base())
    await grant({ ...base(), scopeId: 'p-2', startsAt: iso(DAY) })
    await grant({ holder: alice.id, position: 'steward', endsAt: iso(DAY) })
    const held = await positionsOf({ payload } as never, alice.id)
    expect(held.map((h) => [h.position, h.scope?.id ?? null]).sort()).toEqual([['editor', 'p-1'], ['steward', null]])
    expect(held.find((h) => h.position === 'steward')?.endsAt).toBeTruthy()
    expect(await positionsOf(payload, as(other))).toEqual([])
  })

  it('treats a read error as no for hasPosition', async () => {
    const broken = { find: () => Promise.reject(new Error('db down')) } as never
    expect(await hasPosition(broken, as(alice), 'editor', { kind: 'project', id: 'p-1' })).toBe(false)
    await expect(positionsOf(broken, as(alice))).rejects.toThrow()
  })
})

describe('revoke, pause and expiry', () => {
  const update = (id: string, data: Record<string, unknown>, user: U | null = staff) =>
    payload.update({ collection: 'position-grants' as never, id, data: data as never, user: (user ? as(user) : undefined) as never, overrideAccess: false })
  const scope = { kind: 'project', id: 'p-1' }

  it('revokes, stamps who and when, runs both audit hooks, and gives nothing afterwards', async () => {
    const g = (await grant(base())) as never as { id: string }
    log.length = 0
    const r = (await update(g.id, { status: 'revoked' })) as never as Record<string, unknown>
    expect(r.status).toBe('revoked')
    expect(r.revokedAt).toBeTruthy()
    expect(String((r.revokedBy as { id?: unknown })?.id ?? r.revokedBy)).toBe(String(staff.id))
    expect(log).toEqual(['before:revoke', 'after:revoke'])
    expect(await hasPosition(payload, as(alice), 'editor', scope)).toBe(false)
  })

  it('makes a revoked grant final, and lets the same position be granted again', async () => {
    const g = (await grant(base())) as never as { id: string }
    await update(g.id, { status: 'revoked' })
    expect(await refused(update(g.id, { status: 'active' }))).toMatch(/final/)
    expect(await refused(update(g.id, { endsAt: iso(DAY) }))).toMatch(/final/)
    await grant(base())
    expect(await hasPosition(payload, as(alice), 'editor', scope)).toBe(true)
  })

  it('refuses revoking by someone who may not, and edits to who, what or where', async () => {
    const g = (await grant(base())) as never as { id: string }
    expect(await refused(update(g.id, { status: 'revoked' }, other))).toBeTruthy()
    expect(await refused(update(g.id, { status: 'revoked' }, null))).toBeTruthy()
    expect(await refused(update(g.id, { holder: other.id }))).toMatch(/Only the status/)
    expect(await refused(update(g.id, { position: 'reviewer' }))).toMatch(/Only the status/)
    expect(await refused(update(g.id, { scopeId: 'p-2' }))).toMatch(/Only the status/)
    expect(await hasPosition(payload, as(alice), 'editor', scope)).toBe(true)
  })

  it('pauses and resumes, and a paused grant gives nothing', async () => {
    const g = (await grant(base())) as never as { id: string }
    await update(g.id, { status: 'paused' })
    expect(await hasPosition(payload, as(alice), 'editor', scope)).toBe(false)
    await update(g.id, { status: 'active' })
    expect(await hasPosition(payload, as(alice), 'editor', scope)).toBe(true)
  })

  it('does not let a client set revokedAt or revokedBy on a plain edit', async () => {
    const g = (await grant(base())) as never as { id: string }
    const r = (await update(g.id, { notes: 'hello', revokedAt: iso(0), revokedBy: other.id })) as never as Record<string, unknown>
    expect(r.revokedAt ?? null).toBeNull()
  })

  it('lets staff move an end date either way, and refuses an end before the start', async () => {
    const g = (await grant({ ...base(), startsAt: iso(-DAY), endsAt: iso(DAY) })) as never as { id: string }
    await update(g.id, { endsAt: iso(5 * DAY) })
    await update(g.id, { endsAt: null })
    expect(await refused(update(g.id, { endsAt: iso(-2 * DAY) }))).toMatch(/after the start/)
  })

  it('expires due grants with the sweep, runs the expiry hooks once, and leaves live ones alone', async () => {
    const due = (await grant({ ...base(), endsAt: iso(800) })) as never as { id: string }
    await grant({ ...base(), scopeId: 'p-2', endsAt: iso(30 * DAY) })
    log.length = 0
    expect(await expireGrants(payload)).toBe(0) // not due yet
    await new Promise((r) => setTimeout(r, 1000))
    expect(await expireGrants(payload)).toBe(1)
    expect(await expireGrants(payload)).toBe(0)
    const after = (await payload.findByID({ collection: 'position-grants' as never, id: due.id })) as never as { status: string }
    expect(after.status).toBe('expired')
    expect(log).toEqual(['before:expire', 'after:expire'])
    expect(await hasPosition(payload, as(alice), 'editor', { kind: 'project', id: 'p-2' })).toBe(true)
  })

  it('refuses to expire a grant before its end date', async () => {
    const g = (await grant({ ...base(), endsAt: iso(DAY) })) as never as { id: string }
    expect(await refused(update(g.id, { status: 'expired' }))).toMatch(/end date has passed/)
  })
})

describe('review fixes', () => {
  const update = (id: string, data: Record<string, unknown>, user: U | null = staff) =>
    payload.update({ collection: 'position-grants' as never, id, data: data as never, user: (user ? as(user) : undefined) as never, overrideAccess: false })
  const status = async (id: string) => ((await payload.findByID({ collection: 'position-grants' as never, id })) as never as { status: string }).status
  const scope = { kind: 'project', id: 'p-1' }
  const history = async () => ((await payload.find({ collection: 'position-grant-history' as never, pagination: false, sort: 'createdAt', overrideAccess: true })).docs as never as { event: string; by: string | null; snapshot: Record<string, unknown> }[])

  it('stops a revoke-only user from resuming a paused grant, and lets staff do it', async () => {
    const g = (await grant(base())) as never as { id: string }
    await update(g.id, { status: 'paused' }, revoker)
    expect(await refused(update(g.id, { status: 'active' }, revoker))).toMatch(/can’t do that/)
    expect(await status(g.id)).toBe('paused')
    await update(g.id, { status: 'active' })
    expect(await status(g.id)).toBe('active')
  })

  it('stops a revoke-only user from moving an end date later or removing it, but lets them shorten it or revoke', async () => {
    const g = (await grant({ ...base(), endsAt: iso(10 * DAY) })) as never as { id: string }
    expect(await refused(update(g.id, { endsAt: iso(20 * DAY) }, revoker))).toMatch(/can’t do that/)
    expect(await refused(update(g.id, { endsAt: null }, revoker))).toMatch(/can’t do that/)
    await update(g.id, { endsAt: iso(2 * DAY) }, revoker)
    await update(g.id, { status: 'revoked' }, revoker)
    expect(await status(g.id)).toBe('revoked')
  })

  it('cannot give an open-ended grant an end date it did not have to a revoke-only user as an extension', async () => {
    const g = (await grant(base())) as never as { id: string }
    await update(g.id, { endsAt: iso(DAY) }, revoker) // shortening from none is allowed
    expect(await refused(update(g.id, { endsAt: null }, revoker))).toBeTruthy()
  })

  it('runs the host veto on resume and on extension, and tells canGrant what is being changed', async () => {
    const g = (await grant({ ...base(), endsAt: iso(DAY) })) as never as { id: string }
    await update(g.id, { status: 'paused' })
    seen.grant = []
    seen.revoke = []
    answers.refuse = () => 'Not available for this account.'
    expect(await refused(update(g.id, { status: 'active' }))).toMatch(/Not available/)
    await update(g.id, { status: 'active' }).catch(() => null)
    answers.refuse = () => null
    await update(g.id, { status: 'active' })
    answers.refuse = () => 'Not available for this account.'
    expect(await refused(update(g.id, { endsAt: iso(9 * DAY) }))).toMatch(/Not available/)
    const asked = (seen.grant as { change?: string; grant?: { id: unknown }; id?: unknown }[]).filter((a) => a.change === 'resume' || a.change === 'extend')
    expect(asked.map((a) => a.change)).toContain('resume')
    expect(asked.map((a) => a.change)).toContain('extend')
    expect(String(asked[0]!.grant?.id)).toBe(String(g.id))
    const rev = (seen.revoke as { id?: unknown; data?: { status?: string } }[]).find((a) => a.data?.status === 'active')
    expect(String(rev?.id)).toBe(String(g.id))
  })

  it('refuses resuming or extending one’s own grant, and granting oneself', async () => {
    expect(await refused(grant({ holder: staff.id, position: 'editor', scopeKind: 'project', scopeId: 'p-1' }))).toMatch(/your own account/)
    const mine = (await payload.create({ collection: 'position-grants' as never, data: { holder: staff.id, position: 'editor', scopeKind: 'project', scopeId: 'p-1', status: 'active' } as never, overrideAccess: true })) as never as { id: string }
    await update(mine.id, { status: 'paused' })
    expect(await refused(update(mine.id, { status: 'active' }))).toMatch(/your own account/)
    expect(await status(mine.id)).toBe('paused')
  })

  it('lets a self-grant through only when the host opts in', async () => {
    const site = await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri('selfgrant'), transactionOptions: false }),
      collections: [{ slug: 'users', auth: true, fields: [] }],
      plugins: [positions({ positionTypes: [{ value: 'editor' }], scopeKinds: [{ value: 'project' }], refuseGrant: false, allowSelfGrant: true, allowWithoutTransactions: true, canGrant: () => true })],
    })
    const p = await getPayload({ config: site, key: 'selfgrant' })
    const u = (await p.create({ collection: 'users', data: { email: 'me@example.com', password: PW } as never })) as unknown as U
    const g = await p.create({ collection: 'position-grants' as never, data: { holder: u.id, position: 'editor', scopeKind: 'project', scopeId: 'a' } as never, user: as(u), overrideAccess: false })
    expect(g).toBeTruthy()
    await p.db.destroy?.()
  })

  it('gives canGrant a plain holder id even when the holder arrives as a document', async () => {
    seen.grant = []
    await refused(grant({ ...base(), holder: { id: alice.id } }))
    const asked = (seen.grant as { data?: { holder?: unknown } }[]).find((a) => a.data)
    expect(typeof asked?.data?.holder).not.toBe('object')
    expect(String(asked?.data?.holder)).toBe(String(alice.id))
  })

  it('refuses deleting a grant for everyone, including server code that skips access', async () => {
    const g = (await grant(base())) as never as { id: string }
    expect(await refused(payload.delete({ collection: 'position-grants' as never, id: g.id, overrideAccess: true }))).toMatch(/never deleted/)
    const bulk = (await payload.delete({ collection: 'position-grants' as never, where: { id: { exists: true } }, overrideAccess: true }).catch(() => ({ docs: [], errors: [1] }))) as never as { docs: unknown[]; errors: unknown[] }
    expect(bulk.docs).toHaveLength(0)
    expect(bulk.errors.length).toBeGreaterThan(0)
    expect((await grants()).totalDocs).toBe(1)
  })

  it('keeps notes from the holder, and limits the length of notes and scope ids', async () => {
    const g = (await grant({ ...base(), notes: 'for staff only' })) as never as { id: string }
    const asHolder = (await payload.findByID({ collection: 'position-grants' as never, id: g.id, user: as(alice), overrideAccess: false })) as never as Record<string, unknown>
    expect(asHolder.position).toBe('editor')
    expect('notes' in asHolder).toBe(false)
    const asStaff = (await payload.findByID({ collection: 'position-grants' as never, id: g.id, user: as(staff), overrideAccess: false })) as never as Record<string, unknown>
    expect(asStaff.notes).toBe('for staff only')
    expect(await refused(grant({ ...base(), scopeId: 'p-2', notes: 'x'.repeat(2001) }))).toBeTruthy()
    expect(await refused(grant({ ...base(), scopeId: 'x'.repeat(201) }))).toBeTruthy()
    expect((await grants()).totalDocs).toBe(1)
  })

  it('answers only for a user of the right collection', async () => {
    await grant(base())
    expect(await hasPosition(payload, { id: alice.id, collection: 'admins' }, 'editor', scope)).toBe(false)
    expect(await hasPosition(payload, { id: alice.id }, 'editor', scope)).toBe(false)
    expect(await positionsOf(payload, { id: alice.id, collection: 'admins' })).toEqual([])
    expect(await hasPosition(payload, alice.id, 'editor', scope)).toBe(true)
    expect(await hasPosition(payload, { id: alice.id, collection: 'users' }, 'editor', scope)).toBe(true)
  })

  it('keeps a history of each change, hides it from holders, and lets nobody change or delete it', async () => {
    const g = (await grant({ ...base(), notes: 'private' })) as never as { id: string }
    await update(g.id, { status: 'paused' })
    await update(g.id, { status: 'active' })
    await update(g.id, { endsAt: iso(DAY) })
    await update(g.id, { status: 'revoked' })
    const rows = await history()
    expect(rows.map((r) => r.event)).toEqual(['grant', 'pause', 'resume', 'endDate', 'revoke'])
    expect(rows[0]!.by).toBe(`users:${staff.id}`)
    expect(JSON.stringify(rows)).not.toContain('private')
    const row = (await payload.find({ collection: 'position-grant-history' as never, limit: 1, overrideAccess: true })).docs[0] as never as { id: string }
    const read = (u: U) => payload.find({ collection: 'position-grant-history' as never, user: as(u), overrideAccess: false })
    expect(await refused(read(alice))).toBeTruthy()
    expect((await read(staff)).totalDocs).toBe(5)
    expect(await refused(payload.update({ collection: 'position-grant-history' as never, id: row.id, data: { event: 'grant' } as never, overrideAccess: true }))).toBeTruthy()
    expect(await refused(payload.delete({ collection: 'position-grant-history' as never, id: row.id, overrideAccess: true }))).toBeTruthy()
    expect(await refused(payload.create({ collection: 'position-grant-history' as never, data: { grant: 'x', event: 'grant' } as never, overrideAccess: true }))).toBeTruthy()
    expect(await refused(payload.create({ collection: 'position-grant-history' as never, data: { grant: 'x', event: 'grant' } as never, user: as(staff), overrideAccess: false }))).toBeTruthy()
    expect((await history()).length).toBe(5)
  })

  it('audits pause, resume and end-date changes, before and after', async () => {
    const g = (await grant(base())) as never as { id: string }
    log.length = 0
    await update(g.id, { status: 'paused' })
    await update(g.id, { status: 'active' })
    await update(g.id, { endsAt: iso(DAY) })
    expect(log).toEqual(['before:pause', 'after:pause', 'before:resume', 'after:resume', 'before:endDate', 'after:endDate'])
  })

  it('refuses a bulk update by a revoke-only user that would resume grants, and by a user with no rights', async () => {
    const a = (await grant(base())) as never as { id: string }
    const b = (await grant({ ...base(), scopeId: 'p-2' })) as never as { id: string }
    await update(a.id, { status: 'paused' })
    await update(b.id, { status: 'paused' })
    const bulk = (u: U) =>
      payload.update({ collection: 'position-grants' as never, where: { position: { equals: 'editor' } }, data: { status: 'active' } as never, user: as(u), overrideAccess: false })
    const r1 = (await bulk(revoker)) as never as { docs: unknown[]; errors: unknown[] }
    expect(r1.docs).toHaveLength(0)
    expect(r1.errors).toHaveLength(2)
    expect(await refused(bulk(other))).toBeTruthy()
    expect(await status(a.id)).toBe('paused')
    expect(await status(b.id)).toBe('paused')
  })

  describe('over REST and GraphQL', () => {
    const api = async (u: U, path: string, method: string, body?: unknown) => {
      const token = (await payload.login({ collection: 'users', data: { email: (u as never as { email: string }).email ?? '', password: PW } })).token!
      const res = await handleEndpoints({
        config: payload.config as never,
        request: new Request(`https://site.example/api${path}`, {
          method,
          headers: { Authorization: `JWT ${token}`, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      })
      return { status: res.status, body: (await res.json()) as Record<string, any> }
    }
    const withEmail = async (u: U) => (await payload.findByID({ collection: 'users', id: u.id })) as never as U

    it('refuses a create, a resume and a bulk resume over REST, and a delete', async () => {
      const g = (await grant(base())) as never as { id: string }
      await update(g.id, { status: 'paused' })
      const asOther = await withEmail(other)
      const asRevoker = await withEmail(revoker)
      expect((await api(asOther, '/position-grants', 'POST', base())).status).toBe(403)
      expect((await api(asRevoker, '/position-grants', 'POST', { ...base(), scopeId: 'p-7' })).status).toBe(403)
      expect((await api(asRevoker, `/position-grants/${g.id}`, 'PATCH', { status: 'active' })).status).toBe(403)
      const bulk = await api(asRevoker, '/position-grants?where[position][equals]=editor', 'PATCH', { status: 'active' })
      expect(bulk.body.docs ?? []).toHaveLength(0)
      expect((await api(asRevoker, `/position-grants/${g.id}`, 'DELETE')).status).toBe(403)
      expect((await api(asOther, `/position-grants/${g.id}`, 'GET')).status).toBeGreaterThanOrEqual(400)
      expect(await status(g.id)).toBe('paused')
      expect((await grants()).totalDocs).toBe(1)
    })

    it('refuses a create and a resume over GraphQL', async () => {
      const g = (await grant(base())) as never as { id: string }
      await update(g.id, { status: 'paused' })
      const { schema } = configToSchema(payload.config)
      const run = async (u: U, source: string) => {
        const req = await createLocalReq({ user: as(u) }, payload)
        req.user = as(u)
        return graphql({ schema, source, contextValue: { req } })
      }
      const created = await run(other, `mutation { createPositionGrant(data: { holder: "${alice.id}", position: editor, scopeKind: project, scopeId: "p-8" }) { id } }`)
      expect(created.data?.createPositionGrant ?? null).toBeNull()
      expect(created.errors?.length).toBeGreaterThan(0)
      const resumed = await run(revoker, `mutation { updatePositionGrant(id: "${g.id}", data: { status: active }) { id status } }`)
      expect(resumed.data?.updatePositionGrant ?? null).toBeNull()
      expect(resumed.errors?.length).toBeGreaterThan(0)
      expect(await status(g.id)).toBe('paused')
      expect((await grants()).totalDocs).toBe(1)
    })
  })
})

describe('second review fixes', () => {
  const update = (id: string, data: Record<string, unknown>, user: U | null = staff) =>
    payload.update({ collection: 'position-grants' as never, id, data: data as never, user: (user ? as(user) : undefined) as never, overrideAccess: false })

  it('shows the veto the grant as it would be after an extension, so it can refuse a long one', async () => {
    const g = (await grant({ ...base(), endsAt: iso(5 * DAY) })) as never as { id: string }
    answers.refuse = (a) => {
      const end = (a as unknown as { grant: { endsAt?: string } }).grant.endsAt
      return end && Date.parse(end) > Date.now() + 30 * DAY ? 'Too long.' : null
    }
    expect(await refused(update(g.id, { endsAt: iso(400 * DAY) }))).toBe('Too long.')
    expect(await refused(update(g.id, { endsAt: null }))).toBeNull() // no end: the veto reads no endsAt, as written
    await update(g.id, { endsAt: iso(20 * DAY) })
  })

  it('lets only the host’s canReadPrivate decide who reads notes and history, narrowed by scope', async () => {
    const scoped = await make('scoped@example.com', { level: 'scoped' })
    await grant({ ...base(), notes: 'inside' })
    await grant({ ...base(), scopeId: 'p-2', notes: 'outside' })
    const read = (u: U) => payload.find({ collection: 'position-grants' as never, user: as(u), overrideAccess: false, sort: 'scopeId' })
    const notes = ((await read(scoped)).docs as never as { notes?: string }[]).map((d) => d.notes ?? null)
    expect(notes).toEqual(['inside', null]) // the granter sees every grant, but notes only for their scope
    const hist = await payload.find({ collection: 'position-grant-history' as never, user: as(scoped), overrideAccess: false })
    expect((hist.docs as never as { snapshot: { scopeId: string } }[]).map((h) => h.snapshot.scopeId)).toEqual(['p-1'])
    expect((await read(staff)).docs.map((d) => (d as never as { notes: string }).notes).sort()).toEqual(['inside', 'outside'])
  })

  it('reads no notes and no history when the host gave no canReadPrivate, even to those who can grant', async () => {
    const site = await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri('noprivate'), transactionOptions: false }),
      collections: [{ slug: 'users', auth: true, fields: [] }],
      plugins: [positions({ positionTypes: [{ value: 'editor' }], scopeKinds: [{ value: 'project' }], refuseGrant: false, allowWithoutTransactions: true, canGrant: () => true })],
    })
    const p = await getPayload({ config: site, key: 'noprivate' })
    const u = (await p.create({ collection: 'users', data: { email: 'a@example.com', password: PW } as never })) as unknown as U
    const h = (await p.create({ collection: 'users', data: { email: 'b@example.com', password: PW } as never })) as unknown as U
    await p.create({ collection: 'position-grants' as never, data: { holder: h.id, position: 'editor', scopeKind: 'project', scopeId: 'a', notes: 'secret' } as never, user: as(u), overrideAccess: false })
    const found = (await p.find({ collection: 'position-grants' as never, user: as(u), overrideAccess: false })).docs[0] as never as Record<string, unknown>
    expect(found.position).toBe('editor')
    expect('notes' in found).toBe(false)
    expect(await refused(p.find({ collection: 'position-grant-history' as never, user: as(u), overrideAccess: false }))).toBeTruthy()
    await p.db.destroy?.()
  })

  it('undoes a grant when its history row can’t be written', async () => {
    const real = payload.create.bind(payload)
    const spy = vi.spyOn(payload, 'create').mockImplementation(((args: { collection: string }) =>
      args.collection === 'position-grant-history' ? Promise.reject(new Error('history store down')) : real(args as never)) as never)
    try {
      expect(await refused(grant(base()))).toBeTruthy()
    } finally {
      spy.mockRestore()
    }
    expect((await grants()).totalDocs).toBe(0)
    const g = (await grant(base())) as never as { id: string }
    const spy2 = vi.spyOn(payload, 'create').mockImplementation(((args: { collection: string }) =>
      args.collection === 'position-grant-history' ? Promise.reject(new Error('history store down')) : real(args as never)) as never)
    try {
      expect(await refused(update(g.id, { status: 'paused' }))).toBeTruthy()
    } finally {
      spy2.mockRestore()
    }
    expect(((await payload.findByID({ collection: 'position-grants' as never, id: g.id })) as never as { status: string }).status).toBe('active')
    expect((await history()).length).toBe(1)
  })

  const noTxSite = (name: string, allow: boolean) =>
    buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri(name), transactionOptions: false }),
      collections: [{ slug: 'users', auth: true, fields: [] }],
      plugins: [positions({ positionTypes: [{ value: 'editor' }], scopeKinds: [{ value: 'project' }], refuseGrant: false, canGrant: () => true, allowWithoutTransactions: allow })],
    })

  it('refuses to start when the database has no transactions, unless the host accepts that', async () => {
    const refusedConfig = await noTxSite('notx', false)
    const okConfig = await noTxSite('notx-ok', true)
    try {
      await expect(getPayload({ config: refusedConfig, key: 'notx' })).rejects.toThrow(/transactions off/)
      const p = await getPayload({ config: okConfig, key: 'notx-ok' })
      expect(p.db).toBeTruthy()
    } finally {
      await close(refusedConfig, 'notx')
      await close(okConfig, 'notx-ok')
    }
  })

  it('still refuses each change on a database with no transactions when start-up was skipped', async () => {
    // getPayload({ disableOnInit: true }) skips the start-up check, so the per-request check is what stands behind it.
    const config = await noTxSite('notx-req', false)
    try {
      const p = await getPayload({ config, key: 'notx-req', disableOnInit: true })
      const u = (await p.create({ collection: 'users', data: { email: 'a@example.com', password: PW } as never })) as unknown as U
      const h = (await p.create({ collection: 'users', data: { email: 'b@example.com', password: PW } as never })) as unknown as U
      const data = { holder: h.id, position: 'editor', scopeKind: 'project', scopeId: 'a' } as never
      expect(await refused(p.create({ collection: 'position-grants' as never, data, user: as(u), overrideAccess: false }))).toMatch(/can’t be done right now/)
      expect((await p.find({ collection: 'position-grants' as never, overrideAccess: true })).totalDocs).toBe(0)
    } finally {
      await close(config, 'notx-req')
    }
  })

  it('checks the adapter for a real transaction: null or undefined refuses, an id is rolled back', async () => {
    // Shaped like db-mongodb with transactionOptions false: beginTransaction is a no-op that returns null.
    const off = { db: { beginTransaction: vi.fn(async () => null), rollbackTransaction: vi.fn(async () => undefined) } }
    await expect(checkTransactions(off as never)).rejects.toThrow(/transactions off/)
    expect(off.db.rollbackTransaction).not.toHaveBeenCalled()
    const undef = { db: { beginTransaction: vi.fn(async () => undefined), rollbackTransaction: vi.fn() } }
    await expect(checkTransactions(undef as never)).rejects.toThrow(/transactions off/)
    const throws = { db: { beginTransaction: vi.fn(async () => { throw new Error('nope') }), rollbackTransaction: vi.fn() } }
    await expect(checkTransactions(throws as never)).rejects.toThrow(/transactions off/)
    await expect(checkTransactions(off as never, true)).resolves.toBeUndefined()
    expect(off.db.beginTransaction).toHaveBeenCalledTimes(1) // the opt-in doesn't even ask
    const on = { db: { beginTransaction: vi.fn(async () => 'tx-1'), rollbackTransaction: vi.fn(async () => undefined) } }
    await expect(checkTransactions(on as never)).resolves.toBeUndefined()
    expect(on.db.rollbackTransaction).toHaveBeenCalledWith('tx-1')
  })
})

describe('follow-ups', () => {
  const update = (id: string, data: Record<string, unknown>, user: U | null = staff) =>
    payload.update({ collection: 'position-grants' as never, id, data: data as never, user: (user ? as(user) : undefined) as never, overrideAccess: false })

  it('passes canReadPrivate no grant for the history, and doesn’t let anyone filter on notes they can’t read', async () => {
    const calls: unknown[] = []
    const site = await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri('nogrant'), ensureIndexes: true }),
      collections: [{ slug: 'users', auth: true, fields: [] }],
      plugins: [
        positions({
          positionTypes: [{ value: 'editor' }],
          scopeKinds: [{ value: 'project' }],
          refuseGrant: false,
          canGrant: () => true,
          // A host rule written for notes: yes unless the scope is p-9.
          canReadPrivate: ({ grant }) => {
            calls.push(grant)
            return grant?.scopeId !== 'p-9'
          },
        }),
      ],
    })
    try {
      const p = await getPayload({ config: site, key: 'nogrant' })
      await settle(p)
      const u = (await p.create({ collection: 'users', data: { email: 'a@example.com', password: PW } as never })) as unknown as U
      const h = (await p.create({ collection: 'users', data: { email: 'b@example.com', password: PW } as never })) as unknown as U
      await p.create({ collection: 'position-grants' as never, data: { holder: h.id, position: 'editor', scopeKind: 'project', scopeId: 'p-9', notes: 'x' } as never, user: as(u), overrideAccess: false })
      calls.length = 0
      await p.find({ collection: 'position-grant-history' as never, user: as(u), overrideAccess: false })
      expect(calls).toEqual([undefined]) // not a blank grant such as { holder: undefined, ... }
      // Filtering on notes would show which rows match, so with no document the answer for notes is no, and the rule isn't asked.
      calls.length = 0
      const filtered = await refused(p.find({ collection: 'position-grants' as never, where: { notes: { contains: 'x' } }, user: as(u), overrideAccess: false }))
      const hits = filtered === null ? (await p.find({ collection: 'position-grants' as never, where: { notes: { contains: 'x' } }, user: as(u), overrideAccess: false })).totalDocs : 0
      expect(hits).toBe(0)
      expect(calls).not.toContain(undefined)
    } finally {
      await close(site, 'nogrant')
    }
  })

  it('looks for a duplicate grant without a page count, so no count races the find to start the transaction', async () => {
    // With a count, Payload's Mongo adapter sends find and countDocuments at once as the first queries in the
    // transaction, and now and then the server sees the second one first (NoSuchTransaction).
    const spy = vi.spyOn(payload.db, 'find')
    try {
      await grant(base())
      const dup = spy.mock.calls.map((c) => c[0] as { collection: string; pagination?: boolean }).filter((a) => a.collection === 'position-grants')
      expect(dup.length).toBeGreaterThan(0)
      for (const a of dup) expect(a.pagination).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('refuses dates that don’t exist and times with no zone, and accepts zoned times', async () => {
    for (const bad of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-04-31', '2099-01-01T10:00', '2099-01-01 10:00:00', '2099-01-01T24:00:00Z', '2099-01-01T10:60Z', '2099-01-01T10:00:00+25:00']) {
      expect(await refused(grant({ ...base(), endsAt: bad })), bad).toMatch(/dates aren’t valid/)
      expect(await refused(grant({ ...base(), startsAt: bad })), bad).toMatch(/dates aren’t valid/)
    }
    const g = (await grant({ ...base(), endsAt: iso(DAY) })) as never as { id: string }
    for (const bad of ['2099-02-30', '2099-01-01T10:00']) expect(await refused(update(g.id, { endsAt: bad })), bad).toMatch(/isn’t valid/)
    await grant({ ...base(), scopeId: 'p-2', endsAt: '2099-01-01T10:00:00Z' })
    await grant({ ...base(), scopeId: 'p-3', endsAt: '2099-01-01T10:00:00+02:00' })
    await grant({ ...base(), scopeId: 'p-4', endsAt: '2096-02-29' }) // a real leap day
    expect((await grants()).totalDocs).toBe(4)
  })

  it('shows the veto a null end date when an extension removes the end', async () => {
    const g = (await grant({ ...base(), endsAt: iso(5 * DAY) })) as never as { id: string }
    const seenEnds: unknown[] = []
    answers.refuse = (a) => {
      seenEnds.push((a as unknown as { grant: { endsAt?: unknown } }).grant.endsAt)
      return null
    }
    await update(g.id, { endsAt: null })
    expect(seenEnds).toHaveLength(1)
    expect(seenEnds[0]).toBeNull()
    seenEnds.length = 0
    await grant({ ...base(), scopeId: 'p-2' }) // an open-ended grant, too
    expect(seenEnds).toHaveLength(1)
    expect(seenEnds[0]).toBeNull()
  })

  describe('with no canReadPrivate, over REST and GraphQL', () => {
    let p: Payload
    let granter: U & { email: string }
    let gid: string
    let siteConfig: Awaited<ReturnType<typeof buildConfig>> | undefined
    beforeAll(async () => {
      const site = await buildConfig({
        secret: 'test-secret-not-for-production',
        telemetry: false,
        typescript: { autoGenerate: false },
        db: mongooseAdapter({ url: mongo.getUri('noprivate-api'), ensureIndexes: true }),
        collections: [{ slug: 'users', auth: true, fields: [] }],
        plugins: [positions({ positionTypes: [{ value: 'editor' }], scopeKinds: [{ value: 'project' }], refuseGrant: false, canGrant: () => true })],
      })
      siteConfig = site
      p = await getPayload({ config: site, key: 'noprivate-api' })
      await settle(p)
      granter = (await p.create({ collection: 'users', data: { email: 'g@example.com', password: PW } as never })) as never
      const h = (await p.create({ collection: 'users', data: { email: 'h@example.com', password: PW } as never })) as unknown as U
      const g = (await p.create({ collection: 'position-grants' as never, data: { holder: h.id, position: 'editor', scopeKind: 'project', scopeId: 'a', notes: 'secret note' } as never, user: as(granter), overrideAccess: false })) as never as { id: string }
      gid = String(g.id)
    })
    afterAll(async () => {
      if (siteConfig) await close(siteConfig, 'noprivate-api')
    })

    it('hides notes and history over REST', async () => {
      const token = (await p.login({ collection: 'users', data: { email: granter.email, password: PW } })).token!
      const call = async (path: string) => {
        const res = await handleEndpoints({
          config: p.config as never,
          payloadInstanceCacheKey: 'noprivate-api',
          request: new Request(`https://site.example/api${path}`, { method: 'GET', headers: { Authorization: `JWT ${token}` } }),
        })
        return { status: res.status, text: await res.text() }
      }
      const one = await call(`/position-grants/${gid}`)
      expect(one.status).toBe(200)
      expect(one.text).toContain('editor')
      expect(one.text).not.toContain('secret note')
      const list = await call('/position-grants')
      expect(list.text).not.toContain('secret note')
      const hist = await call('/position-grant-history')
      expect(hist.status).toBeGreaterThanOrEqual(400)
      expect(hist.text).not.toContain('"snapshot"')
    })

    it('hides notes and history over GraphQL', async () => {
      const { schema } = configToSchema(p.config)
      const run = async (source: string) => {
        const req = await createLocalReq({ user: as(granter) }, p)
        req.user = as(granter)
        return graphql({ schema, source, contextValue: { req } })
      }
      const grantsRes = await run('{ PositionGrants { docs { id position notes } } }')
      expect(JSON.stringify(grantsRes)).not.toContain('secret note')
      expect((grantsRes.data as never as { PositionGrants: { docs: { position: string }[] } }).PositionGrants.docs[0]!.position).toBe('editor')
      const histRes = await run('{ PositionGrantHistories { docs { id event } } }')
      expect(histRes.errors?.length ?? 0).toBeGreaterThan(0)
      expect(JSON.stringify(histRes.data ?? null)).not.toContain('"event"')
    })
  })
})

describe('third review fixes', () => {
  const update = (id: string, data: Record<string, unknown>, user: U | null = staff) =>
    payload.update({ collection: 'position-grants' as never, id, data: data as never, user: (user ? as(user) : undefined) as never, overrideAccess: false })

  it('refuses a self-grant when the holder is sent as { id }', async () => {
    expect(await refused(grant({ ...base(), holder: { id: staff.id } }))).toMatch(/your own account/)
    expect((await grants()).totalDocs).toBe(0)
  })

  it('records who acted with their auth collection, and leaves grantedBy empty for a user outside the users collection', async () => {
    const g = (await payload.create({
      collection: 'position-grants' as never,
      data: base() as never,
      user: { id: 'x1', collection: 'admins' } as never,
      overrideAccess: true,
    })) as never as { id: string; grantedBy?: unknown }
    expect(g.grantedBy ?? null).toBeNull()
    const rows = (await payload.find({ collection: 'position-grant-history' as never, overrideAccess: true })).docs as never as { by: string }[]
    expect(rows[0]!.by).toBe('admins:x1')
  })

  it('stops someone who can’t read the notes from overwriting them', async () => {
    const g = (await grant({ ...base(), notes: 'for staff' })) as never as { id: string }
    expect(await refused(update(g.id, { notes: 'wiped' }, revoker))).toMatch(/can’t change these notes/)
    await update(g.id, { status: 'paused' }, revoker) // other edits are fine, and an unchanged note is fine
    await update(g.id, { notes: 'for staff' }, revoker)
    await update(g.id, { notes: 'edited' })
    const read = (await payload.findByID({ collection: 'position-grants' as never, id: g.id, user: as(staff), overrideAccess: false })) as never as { notes: string }
    expect(read.notes).toBe('edited')
  })

  it('treats only ISO dates as dates: "1", words, numbers and 0 are refused, not read as no date', async () => {
    for (const bad of ['1', 'tomorrow', 0, 5, '2026', true]) {
      expect(await refused(grant({ ...base(), endsAt: bad }))).toMatch(/dates aren’t valid/)
      expect(await refused(grant({ ...base(), startsAt: bad }))).toMatch(/dates aren’t valid/)
    }
    const g = (await grant({ ...base(), endsAt: iso(DAY) })) as never as { id: string }
    for (const bad of ['1', 0, 'soon']) expect(await refused(update(g.id, { endsAt: bad }))).toMatch(/isn’t valid/)
    await grant({ ...base(), scopeId: 'p-2', endsAt: '' }) // empty means none
    await grant({ ...base(), scopeId: 'p-3', startsAt: new Date(Date.now() - DAY).toISOString().slice(0, 10) }) // a plain date is fine
  })

  it('refuses bulk update and bulk delete of the history, even with access skipped', async () => {
    const g = (await grant(base())) as never as { id: string }
    await payload.update({ collection: 'position-grants' as never, id: g.id, data: { status: 'paused' } as never, user: as(staff), overrideAccess: false })
    const before = (await history()).length
    const bulkUp = (await payload.update({ collection: 'position-grant-history' as never, where: { event: { exists: true } }, data: { event: 'revoke' } as never, overrideAccess: true }).catch(() => ({ docs: [], errors: [1] }))) as never as { docs: unknown[]; errors: unknown[] }
    const bulkDel = (await payload.delete({ collection: 'position-grant-history' as never, where: { event: { exists: true } }, overrideAccess: true }).catch(() => ({ docs: [], errors: [1] }))) as never as { docs: unknown[]; errors: unknown[] }
    expect(bulkUp.docs).toHaveLength(0)
    expect(bulkDel.docs).toHaveLength(0)
    expect(bulkUp.errors.length + bulkDel.errors.length).toBeGreaterThan(0)
    const asStaff = (u: U) => ({ user: as(u), overrideAccess: false })
    expect(await refused(payload.update({ collection: 'position-grant-history' as never, where: { event: { exists: true } }, data: { event: 'revoke' } as never, ...asStaff(staff) }))).toBeTruthy()
    expect(await refused(payload.delete({ collection: 'position-grant-history' as never, where: { event: { exists: true } }, ...asStaff(staff) }))).toBeTruthy()
    const rows = await history()
    expect(rows.length).toBe(before)
    expect((rows as never as { event: string }[]).map((r) => r.event).sort()).toEqual(['grant', 'pause'])
  })
})

describe('plugin', () => {
  it('leaves a config alone when turned off, and adds one collection otherwise', () => {
    const config = { collections: [], secret: 'made-up' } as never
    const off = positions({ enabled: false, positionTypes: [], scopeKinds: [], refuseGrant: false })
    expect(off(config)).toBe(config)
    const on = positions({ positionTypes: [], scopeKinds: [], refuseGrant: false })(config) as { collections: { slug: string }[] }
    expect(on.collections.map((c) => c.slug)).toEqual(['position-grants', 'position-grant-history'])
    expect(() => positions({ positionTypes: [], scopeKinds: [] } as never)(config)).toThrow(/refuseGrant is required/)
  })
})
