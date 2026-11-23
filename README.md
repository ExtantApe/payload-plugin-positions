# payload-plugin-positions

Positions for Payload: scoped, dated grants people hold on a site, an organization or a project, with host-defined types, grant rules and an audit trail.

**Status:** early, 0.x, not on npm yet. The 56 tests run against a real Payload with an in-memory MongoDB. It hasn't been tried in a real app, and the admin screens haven't been looked at in a browser.

## Agreed scope

The scope agreed with Captive Origins:

- **A position is a scoped, dated grant** that opens tools or portals: on a site, an organization or a project.
- **One grant table** holds the person, the position type, the scope, start and end dates, who granted it, and an audit trail.
- **The host passes in** the position types, the scope kinds and who may grant each. Each defaults to nobody.
- **A hook can refuse a grant.** A host uses it so minors never hold positions.

## What it does

- A **grant** holds a user, a position type, a scope (a kind and an id, such as `project` and `p-1`), a start and end date (ISO dates only. `0`, `1`, words and dates that don't exist, such as `2026-02-30`, are refused. A time needs a zone, `Z` or an offset like `+02:00`, because a time with none would be read in the server's zone. A plain date is read as midnight UTC), who granted it, a status and notes. A position with no scope, such as one for a whole site, is a type marked `unscoped`.
- **Statuses:** active, paused, revoked, expired. Revoked and expired are final; grant again to renew. Grants can't be deleted, not even by server code that skips access.
- **History.** Every grant, pause, resume, end-date change, revoke and expiry adds a row to `position-grant-history`: what changed, who did it (as `collection:id`), and a copy of the grant (without its notes). Only the plugin can add rows, and rows can't be changed or deleted through Payload. Someone with direct database access can still change anything.
- **`canRead` and `canReadPrivate`:** any object `canRead` returns, and any object `canReadPrivate` returns for the history, counts as a Payload `where`, and `{}` is a `where` that matches every row. For notes, `canReadPrivate` must answer exactly `true`; an object there is a no. Return `false` for no access, and only return an object you mean as a filter. For the history `canReadPrivate` is called with `grant: undefined`, so a rule like "true unless the scope is X" is also true for the history. Check for the grant before you say yes. A `where` on notes is always refused, because which rows match would tell the asker what the notes say.
- **Notes and history** are read through their own option, `canReadPrivate`, not `canGrant`, so a granter limited to one scope doesn't read everything. Without it, nobody reads them through the API. For notes it is asked per grant and must answer exactly `true`. For the history it may also answer with a Payload `where` on the rows, such as `{ 'snapshot.scopeId': { equals: 'p-1' } }`. Holders can't read their own notes, and someone who can't read a grant's notes can't overwrite them either. Notes are capped at 2000 characters and scope ids at 200.
- **Transactions.** At startup the plugin asks the database adapter for a transaction and rolls it straight back. If the adapter hands none out (Mongo with `transactionOptions: false`, for one), startup fails, because a history failure couldn't undo its change. Set `allowWithoutTransactions` to accept that. The probe only asks the adapter: a standalone Mongo with default options passes it and then fails closed on each write, because every change also checks that its own request has a transaction. That per-request check is what stands behind the startup one. The startup check can be skipped, because Payload 3.92 doesn't run `onInit` on `getPayload({ disableOnInit: true })`, and after a failed start the next `getPayload` call with the same key gets the cached instance without running it. Don't rely on startup alone.
- **Fails closed.** Without a `canGrant` that answers exactly `true`, nobody can grant. A throw or any other answer is a no. `canRevoke` (default: the same as `canGrant`) covers revoking, pausing and shortening an end date. Resuming a paused grant, or moving an end date later or to none, is a grant, so it needs `canGrant`, the veto, and can't be done for your own account.
- **Self-grants refused.** Nobody grants, resumes or extends a position for their own account unless the host sets `allowSelfGrant: true`.
- **Host veto.** `refuseGrant` is required: pass a function, or `false` for no veto. It can block a grant for any reason. It also runs on resume and on extension, and for server code that skips access. On an extension it sees the grant with the new end date already in it. **Its reason is shown to the person who tried**, so keep it general. A reason like "under 18" would tell them a child's age.
- **Audit hooks** before and after grant, revoke, expiry, pause, resume and end-date change. A failing `before` hook stops the change. A failing `after` hook is logged.
- **Helpers** that respect start and end dates: `hasPosition` and `positionsOf`.
- One live grant per holder, position and scope, enforced by a unique index on a `liveKey` field, so two requests at once can't both get in. **The index has to exist.** On Mongo, set `ensureIndexes: true` on `mongooseAdapter` (it is off by default). On SQL adapters, run a migration that adds a unique index on `position_grants.live_key`.
- **Needs database transactions.** The history row is written in the same transaction as the change, so if it fails the change is undone. Without transactions (a standalone Mongo, or `transactionOptions: false`) the plugin refuses every change. Set `allowWithoutTransactions: true` only if you accept a grant that can be saved without its history row.

## Install or build

Not on npm yet. To work on it:

```
npm install
npm test
npm run build
```

## Use

```ts
import { positions, hasPosition, expireGrants } from '@extantape/payload-plugin-positions'

positions({
  users: 'users', // default
  positionTypes: [
    { value: 'editor', label: 'Editor' },
    { value: 'steward', unscoped: true },
  ],
  scopeKinds: [{ value: 'project' }, { value: 'group' }],
  canGrant: ({ user }) => user.role === 'staff',
  refuseGrant: ({ holder }) => (holder.restricted ? 'Not available for this account.' : null), // or false
  audit: { afterGrant: (e) => console.log(e.event, e.grant.id) },
})

await hasPosition(payload, user, 'editor', { kind: 'project', id: 'p-1' }) // true or false
await positionsOf(payload, user) // [{ id, position, scope, startsAt, endsAt }]
await expireGrants(payload) // run from a job: marks ended grants expired and runs the expiry hooks
```

Pass `req.user` or a user id. A user document is only accepted when its `collection` is the plugin's users collection, so an id from another collection can't match. `hasPosition` answers for exactly the scope you give. Leave the scope out to ask about an unscoped position. No user, a paused, revoked or expired grant, a date outside the window, or an error reading grants all give `false`. `positionsOf` throws if grants can't be read. Pass `{ at }` to check another moment and `{ req }` to stay in a transaction.

By default staff who pass `canGrant` read every grant and everyone else reads their own. `canRevoke` and `canRead` can change who revokes and who reads.

## Limits

Invites, codes, contact addresses, a verification step, expiry reminders and syncing a user's role list are not built. Expiry runs when the host calls `expireGrants`; until then the helpers already refuse an ended grant.

## License

MIT. Copyright (c) 2026 EXTANT APE. See `LICENSE`.

Contributions arrive as pull requests from `co/` branches in this repo. Only the owner merges.
