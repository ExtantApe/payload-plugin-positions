# payload-plugin-positions

Positions for Payload: scoped grants that open tools or portals, held in one `position-grants` collection. The host names the position types and scope kinds and decides who may grant. Nobody can grant until it does.

**Status:** early, 0.x, not on npm yet. The 46 tests run against a real Payload with an in-memory MongoDB. It hasn't been tried in a real app, and the admin screens haven't been looked at in a browser.

## What it does

- A **grant** holds a user, a position type, a scope (a kind and an id, such as `project` and `p-1`), a start and end date, who granted it, a status and notes. A position with no scope, such as one for a whole site, is a type marked `unscoped`.
- **Statuses:** active, paused, revoked, expired. Revoked and expired are final; grant again to renew. Grants can't be deleted, not even by server code that skips access.
- **History.** Every grant, pause, resume, end-date change, revoke and expiry adds a row to `position-grant-history`: what changed, who did it, and a copy of the grant (without its notes). Only the plugin can add rows, and rows can't be changed or deleted through Payload. Someone with direct database access can still change anything.
- **Notes** are only readable by people who pass `canGrant`. Holders can't read them. Notes are capped at 2000 characters and scope ids at 200.
- **Fails closed.** Without a `canGrant` that answers exactly `true`, nobody can grant. A throw or any other answer is a no. `canRevoke` (default: the same as `canGrant`) covers revoking, pausing and shortening an end date. Resuming a paused grant, or moving an end date later or to none, is a grant, so it needs `canGrant`, the veto, and can't be done for your own account.
- **Self-grants refused.** Nobody grants, resumes or extends a position for their own account unless the host sets `allowSelfGrant: true`.
- **Host veto.** `refuseGrant` is required: pass a function, or `false` for no veto. It can block a grant for any reason. It also runs on resume and on extension, and for server code that skips access. **Its reason is shown to the person who tried**, so keep it general. A reason like "under 18" would tell them a child's age.
- **Audit hooks** before and after grant, revoke, expiry, pause, resume and end-date change. A failing `before` hook stops the change. A failing `after` hook is logged.
- **Helpers** that respect start and end dates: `hasPosition` and `positionsOf`.
- One live grant per holder, position and scope, enforced by a unique index, so two requests at once can't both get in. The database needs to build indexes (Payload's default).

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
