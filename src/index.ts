import type { Config, Plugin } from 'payload'

/**
 * Positions for Payload. A skeleton for now: the pieces land in their own pull requests. What a position grants is always
 * the host's to pass in; nothing here grants anything by default.
 */
export type PositionsOptions = {
  /** Turn the plugin off without removing it. Default true. */
  enabled?: boolean
}

export const positions =
  (options: PositionsOptions = {}): Plugin =>
  (config: Config): Config => {
    if (options.enabled === false) return config
    return config
  }
