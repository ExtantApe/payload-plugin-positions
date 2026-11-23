# Changelog

## Unreleased

- The repo, with the standard Payload plugin kit and an empty plugin. Nothing to install yet. Public since 2026-11-22.
- **Core.** The `position-grants` collection (holder, position, scope kind and id, start and end, granted by, status, revoke stamp, notes), host options for position types and scope kinds, `canGrant`, `canRevoke`, `canRead` and `refuseGrant`, audit hooks before and after grant, revoke and expiry, the `hasPosition` and `positionsOf` helpers, and `expireGrants` for a scheduled sweep. Without a `canGrant` that answers exactly `true`, nobody can grant. For K5225.

Tested: 31 tests against a real Payload and an in-memory MongoDB. They cover grant and refusal paths, scope and date validation, duplicates, a host veto (also for server code and on resume), fail-closed access with six wrong kinds of answer, reading, no deletes, date windows, revoke, pause, final states, expiry and the audit order. One mutation check (a loose `canGrant`) fails a test.
Also: a unique `liveKey` index makes the one-live-grant rule hold under concurrent requests (six at once, one wins); an ended-but-unswept grant is expired when a new one is made.
Not tested: a real app or the admin in a browser; a very large number of grants.
