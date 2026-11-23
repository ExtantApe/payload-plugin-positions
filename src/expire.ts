import type { PayloadRequest } from 'payload'

import { GRANTS, type PayloadLike } from './types.js'

/**
 * Marks every active or paused grant whose end date has passed as expired, running the expiry audit hooks for each.
 * Call it from a job or a schedule. The helpers already ignore a grant past its end date, so a late sweep only delays
 * the record and its audit entry, never the refusal. Returns how many grants were expired; a grant that fails is
 * left for the next run.
 */
export async function expireGrants(payload: PayloadLike, options: { at?: Date; req?: PayloadRequest } = {}): Promise<number> {
  const p = 'payload' in payload ? payload.payload : payload
  const at = (options.at ?? new Date()).toISOString()
  const due = await p.find({
    collection: GRANTS as never,
    where: { and: [{ status: { in: ['active', 'paused'] } }, { endsAt: { less_than_equal: at } }] },
    pagination: false,
    depth: 0,
    overrideAccess: true,
    req: options.req,
  })
  let done = 0
  for (const grant of due.docs as unknown as { id: string | number }[]) {
    try {
      await p.update({ collection: GRANTS as never, id: grant.id, data: { status: 'expired' } as never, overrideAccess: true, req: options.req })
      done += 1
    } catch (error) {
      p.logger.error(`positions: couldn't expire grant ${String(grant.id)}: ${(error as Error).message}`)
    }
  }
  return done
}
