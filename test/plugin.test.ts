import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { expireGrants, hasPosition, positions, positionsOf, type AuditEvent } from '../src/index.js'

/**
 * A made-up site: users with a level (staff may grant), two position types and two scope kinds, a host veto for anyone
 * flagged `underage`, and an audit log in memory.
 */
const PW = 'correct-horse-battery'
let payload: Payload
let mongo: MongoMemoryReplSet
const log: string[] = []
const answers: { canGrant?: () => unknown; refuse?: () => unknown; beforeGrant?: () => void } = {}
const DAY = 86_400_000
const iso = (offset: number) => new Date(Date.now() + offset).toISOString()

type U = { id: string | number; level?: string }
let staff: U, other: U, alice: U, kid: U

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
        canGrant: ({ user }) => (answers.canGrant ? (answers.canGrant() as boolean) : (user as U).level === 'staff'),
        refuseGrant: ({ holder }) => {
          if (answers.refuse) return answers.refuse() as string | null
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
  await payload.delete({ collection: 'position-grants' as never, where: { id: { exists: true } }, overrideAccess: true })
  await payload.delete({ collection: 'users', where: { id: { exists: true } }, overrideAccess: true })
  staff = await make('staff@example.com', { level: 'staff' })
  other = await make('other@example.com', { level: 'member' })
  alice = await make('alice@example.com', { level: 'member' })
  kid = await make('kid@example.com', { underage: true })
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
    expect(await hasPosition(payload, alice, 'steward')).toBe(true)
    expect(await hasPosition(payload, alice, 'steward', { kind: 'project', id: 'p-1' })).toBe(false)
  })

  it('refuses a second live grant for the same holder, position and scope, but not a different scope', async () => {
    await grant(base())
    expect(await refused(grant(base()))).toMatch(/already holds/)
    await grant({ ...base(), scopeId: 'p-2' })
    await grant({ holder: alice.id, position: 'steward' })
    expect(await refused(grant({ holder: alice.id, position: 'steward' }))).toMatch(/already holds/)
    expect((await grants()).totalDocs).toBe(3)
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
      plugins: [positions({ positionTypes: [{ value: 'editor' }], scopeKinds: [{ value: 'project' }] })],
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
    expect(await hasPosition(payload, alice, 'editor', scope)).toBe(false)
    expect(await hasPosition(payload, alice, 'editor', scope, { at: new Date(Date.now() + 2 * DAY) })).toBe(true)
    await grant({ ...base(), scopeId: 'p-2', endsAt: iso(DAY) })
    const p2 = { kind: 'project', id: 'p-2' }
    expect(await hasPosition(payload, alice, 'editor', p2)).toBe(true)
    expect(await hasPosition(payload, alice, 'editor', p2, { at: new Date(Date.now() + 2 * DAY) })).toBe(false)
    expect(await hasPosition(payload, alice, 'editor', p2, { at: new Date(Date.now() + DAY) })).toBe(false) // the end moment is out
  })

  it('answers for exactly the position and scope asked', async () => {
    await grant(base())
    expect(await hasPosition(payload, alice, 'editor', { kind: 'project', id: 'p-1' })).toBe(true)
    expect(await hasPosition(payload, alice, 'editor', { kind: 'project', id: 'p-2' })).toBe(false)
    expect(await hasPosition(payload, alice, 'editor', { kind: 'group', id: 'p-1' })).toBe(false)
    expect(await hasPosition(payload, alice, 'reviewer', { kind: 'project', id: 'p-1' })).toBe(false)
    expect(await hasPosition(payload, alice, 'editor')).toBe(false)
    expect(await hasPosition(payload, other, 'editor', { kind: 'project', id: 'p-1' })).toBe(false)
    expect(await hasPosition(payload, null, 'editor', { kind: 'project', id: 'p-1' })).toBe(false)
  })

  it('lists what a user holds now, with scopes and dates, and takes a request or a user id', async () => {
    await grant(base())
    await grant({ ...base(), scopeId: 'p-2', startsAt: iso(DAY) })
    await grant({ holder: alice.id, position: 'steward', endsAt: iso(DAY) })
    const held = await positionsOf({ payload } as never, alice.id)
    expect(held.map((h) => [h.position, h.scope?.id ?? null]).sort()).toEqual([['editor', 'p-1'], ['steward', null]])
    expect(held.find((h) => h.position === 'steward')?.endsAt).toBeTruthy()
    expect(await positionsOf(payload, other)).toEqual([])
  })

  it('treats a read error as no for hasPosition', async () => {
    const broken = { find: () => Promise.reject(new Error('db down')) } as never
    expect(await hasPosition(broken, alice, 'editor', { kind: 'project', id: 'p-1' })).toBe(false)
    await expect(positionsOf(broken, alice)).rejects.toThrow()
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
    expect(await hasPosition(payload, alice, 'editor', scope)).toBe(false)
  })

  it('makes a revoked grant final, and lets the same position be granted again', async () => {
    const g = (await grant(base())) as never as { id: string }
    await update(g.id, { status: 'revoked' })
    expect(await refused(update(g.id, { status: 'active' }))).toMatch(/final/)
    expect(await refused(update(g.id, { endsAt: iso(DAY) }))).toMatch(/final/)
    await grant(base())
    expect(await hasPosition(payload, alice, 'editor', scope)).toBe(true)
  })

  it('refuses revoking by someone who may not, and edits to who, what or where', async () => {
    const g = (await grant(base())) as never as { id: string }
    expect(await refused(update(g.id, { status: 'revoked' }, other))).toBeTruthy()
    expect(await refused(update(g.id, { status: 'revoked' }, null))).toBeTruthy()
    expect(await refused(update(g.id, { holder: other.id }))).toMatch(/Only the status/)
    expect(await refused(update(g.id, { position: 'reviewer' }))).toMatch(/Only the status/)
    expect(await refused(update(g.id, { scopeId: 'p-2' }))).toMatch(/Only the status/)
    expect(await hasPosition(payload, alice, 'editor', scope)).toBe(true)
  })

  it('pauses and resumes, and a paused grant gives nothing', async () => {
    const g = (await grant(base())) as never as { id: string }
    await update(g.id, { status: 'paused' })
    expect(await hasPosition(payload, alice, 'editor', scope)).toBe(false)
    await update(g.id, { status: 'active' })
    expect(await hasPosition(payload, alice, 'editor', scope)).toBe(true)
  })

  it('does not let a client set revokedAt or revokedBy on a plain edit', async () => {
    const g = (await grant(base())) as never as { id: string }
    const r = (await update(g.id, { notes: 'hello', revokedAt: iso(0), revokedBy: other.id })) as never as Record<string, unknown>
    expect(r.revokedAt ?? null).toBeNull()
  })

  it('lets staff change an end date, and refuses an end before the start', async () => {
    const g = (await grant({ ...base(), startsAt: iso(-DAY) })) as never as { id: string }
    await update(g.id, { endsAt: iso(DAY) })
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
    expect(await hasPosition(payload, alice, 'editor', { kind: 'project', id: 'p-2' })).toBe(true)
  })

  it('refuses to expire a grant before its end date', async () => {
    const g = (await grant({ ...base(), endsAt: iso(DAY) })) as never as { id: string }
    expect(await refused(update(g.id, { status: 'expired' }))).toMatch(/end date has passed/)
  })
})

describe('plugin', () => {
  it('leaves a config alone when turned off, and adds one collection otherwise', () => {
    const config = { collections: [], secret: 'made-up' } as never
    const off = positions({ enabled: false, positionTypes: [], scopeKinds: [] })
    expect(off(config)).toBe(config)
    const on = positions({ positionTypes: [], scopeKinds: [] })(config) as { collections: { slug: string }[] }
    expect(on.collections.map((c) => c.slug)).toEqual(['position-grants'])
  })
})
