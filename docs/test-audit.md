# Test audit

Kept by this repo's owning session, per `~/Code/CLAUDE.md`, "Test self-audits". Newest first.

## 2026-11-23: after the follow-ups

- Promises checked: the plugin refuses to start without transactions and every change still checks its own request; `canReadPrivate` is given no grant when there is no document and can't be used to filter on notes; dates must be real and zoned; the veto sees a null end date; notes and history stay closed over REST and GraphQL when the host gave no `canReadPrivate`.
- Added: the startup check against a mock shaped like the adapter and against a real adapter with transactions off; the per-request check with start-up skipped; a `where` on notes refused; impossible dates and zoneless times; null end date seen by the veto; REST and GraphQL with `canReadPrivate` unset (63 tests).
- Test hygiene: every instance a test builds is closed in a `finally`, including one whose start-up failed.
- Skipped: a standalone Mongo that passes the probe (needs a second server setup; the per-request test covers the same refusal).

## 2026-11-22: after review

- Added: resume and extend gates, self-grants, delete refusal, notes access and limits, collection-keyed helpers, history, bulk, REST and GraphQL refusals (46 tests).
- Skipped: GraphQL and REST success paths (framework behavior).

## 2026-11-22: first version

- Promises: fails closed without `canGrant`; host veto; scope and date validation; helpers respect dates; revoke and expiry are final and audited; no deletes; holders read only their own.
- Covered: each of those, in `test/plugin.test.ts` (31 tests).
- Gaps skipped (and why): large tables (no promise made); admin screens (no browser test yet).

## 2026-11-22: first audit (starter kit)

- Promises: none yet.
- Covered: none yet.
- Gaps added: none.
- Gaps skipped (and why): none.
