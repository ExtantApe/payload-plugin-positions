# payload-plugin-positions

Positions for Payload: scoped grants that open tools or portals, held in one `position-grants` collection. The host names the position types and scope kinds and decides who may grant. Nobody can grant until it does.

**Status:** early, 0.x, not on npm yet. The 29 tests run against a real Payload with an in-memory MongoDB. It hasn't been tried in a real app, and the admin screens haven't been looked at in a browser.

## What it does

- A **grant** holds a user, a position type, a scope (a kind and an id, such as `project` and `p-1`), a start and end date, who granted it, a status and notes. A position with no scope, such as one for a whole site, is a type marked `unscoped`.
- **Statuses:** active, paused, revoked, expired. Revoked and expired are final; grant again to renew. Grants are never deleted, so the record stays.
- **Fails closed.** Without a `canGrant` that answers exactly `true`, nobody can grant, revoke or edit. A throw or any other answer is a no.
- **Host veto.** `refuseGrant` can block a grant for any reason (the host decides). It also runs when a paused grant is switched back on, and for server code that skips access.
- **Audit hooks** before and after grant, revoke and expiry. A failing `before` hook stops the change. A failing `after` hook is logged.
- **Helpers** that respect start and end dates: `hasPosition` and `positionsOf`.
- One live grant per holder, position and scope.

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
  refuseGrant: ({ holder }) => (holder.underage ? 'Not available for this account.' : null),
  audit: { afterGrant: (e) => console.log(e.event, e.grant.id) },
})

await hasPosition(payload, user, 'editor', { kind: 'project', id: 'p-1' }) // true or false
await positionsOf(payload, user) // [{ id, position, scope, startsAt, endsAt }]
await expireGrants(payload) // run from a job: marks ended grants expired and runs the expiry hooks
```

`hasPosition` answers for exactly the scope you give. Leave the scope out to ask about an unscoped position. No user, a paused, revoked or expired grant, a date outside the window, or an error reading grants all give `false`. `positionsOf` throws if grants can't be read. Pass `{ at }` to check another moment and `{ req }` to stay in a transaction.

By default staff who pass `canGrant` read every grant and everyone else reads their own. `canRevoke` and `canRead` can change who revokes and who reads.

## Limits

Invites, codes, contact addresses, a verification step, expiry reminders and syncing a user's role list are not built. Expiry runs when the host calls `expireGrants`; until then the helpers already refuse an ended grant.

## License

MIT. Copyright (c) 2026 EXTANT APE. See `LICENSE`.

Contributions arrive as pull requests from `co/` branches in this repo. Only the owner merges.
