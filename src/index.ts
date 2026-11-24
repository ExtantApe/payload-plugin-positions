import type { Config, Payload, Plugin } from 'payload'

import { claimLast, mapDuplicateGrant, positionCollections } from './collection.js'
import type { PositionsOptions } from './types.js'

export { expireGrants } from './expire.js'
export { hasPosition, inForce, positionsOf, type HeldPosition, type HelperOptions } from './helpers.js'
export * from './types.js'

/**
 * Positions for Payload. A position is a scoped grant held in one collection, `position-grants`. The plugin knows
 * nothing about the host's records: the host names the position types and scope kinds, and decides who may grant.
 * With no `canGrant`, nobody can.
 */
/**
 * Asks the database for a transaction. An adapter with transactions off (such as Mongo with `transactionOptions: false`)
 * swaps `beginTransaction` for a no-op that returns null, so the answer is the only reliable test. A transaction that
 * was opened is rolled back at once.
 */
export async function checkTransactions(payload: Pick<Payload, 'db'>, allowWithoutTransactions?: boolean): Promise<void> {
  if (allowWithoutTransactions) return
  let id: unknown
  try {
    id = await payload.db.beginTransaction()
  } catch {
    id = null
  }
  if (id === null || id === undefined || id === false) {
    throw new Error(
      'positions: the database has transactions off, so a grant and its history row can’t stand or fall together. Turn transactions on, or set allowWithoutTransactions.',
    )
  }
  await payload.db.rollbackTransaction(id as never)
}

export const positions =
  (options: PositionsOptions): Plugin =>
  (config: Config): Config => {
    if (options.enabled === false) return config
    const users = options.users ?? config.admin?.user ?? 'users'
    if (typeof options.refuseGrant !== 'function' && options.refuseGrant !== false)
      throw new Error('positions: refuseGrant must be a function, or exactly false to say there is no veto. Nothing else turns it off.')
    const added = positionCollections({ ...options, users, positionTypes: options.positionTypes ?? [], scopeKinds: options.scopeKinds ?? [] })
    return {
      ...config,
      collections: [...(config.collections ?? []), ...added],
      custom: { ...config.custom, positionsUsers: users },
      onInit: async (payload) => {
        await config.onInit?.(payload)
        mapDuplicateGrant(payload)
        claimLast(payload as never)
        await checkTransactions(payload, options.allowWithoutTransactions)
      },
    }
  }
