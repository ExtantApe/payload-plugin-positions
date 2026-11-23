import type { Config, Plugin } from 'payload'

import { positionCollections } from './collection.js'
import type { PositionsOptions } from './types.js'

export { expireGrants } from './expire.js'
export { hasPosition, inForce, positionsOf, type HeldPosition, type HelperOptions } from './helpers.js'
export * from './types.js'

/**
 * Positions for Payload. A position is a scoped grant held in one collection, `position-grants`. The plugin knows
 * nothing about the host's records: the host names the position types and scope kinds, and decides who may grant.
 * With no `canGrant`, nobody can.
 */
export const positions =
  (options: PositionsOptions): Plugin =>
  (config: Config): Config => {
    if (options.enabled === false) return config
    const users = options.users ?? config.admin?.user ?? 'users'
    if (options.refuseGrant === undefined)
      throw new Error('positions: refuseGrant is required. Pass a function, or false to say there is no veto.')
    const added = positionCollections({ ...options, users, positionTypes: options.positionTypes ?? [], scopeKinds: options.scopeKinds ?? [] })
    return {
      ...config,
      collections: [...(config.collections ?? []), ...added],
      custom: { ...config.custom, positionsUsers: users },
    }
  }
