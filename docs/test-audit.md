# Test audit

Kept by this repo's owning session, per `~/Code/CLAUDE.md`, "Test self-audits". Newest first.

## 2026-11-23: after the veto change

- Promise checked: a granter can't tell a vetoed grantee from a grant they may not make.
- Added: same message and status through the local API and REST, for a veto reason, a throwing veto, a resume and an extension; nothing written and no history row; server code still sees the reason (66 tests).
- Skipped: timing differences (a vetoed grant does a few more queries); a plugin can't make the host's veto constant-time.

## 2026-11-23: after the follow-ups

- Promises checked: the plugin refuses to start without transactions and every change still checks its own request; `canReadPrivate` is given no grant when there is no document and can't be used to filter on notes; dates must be real and zoned; the veto sees a null end date; notes and history stay closed over REST and GraphQL when the host gave no `canReadPrivate`.
- Added: the startup check against a mock shaped like the adapter and against a real adapter with transactions off; the per-request check with start-up skipped; a `where` on notes refused; impossible dates and zoneless times; null end date seen by the veto; REST and GraphQL with `canReadPrivate` unset (63 tests).
- Test hygiene: every instance a test builds is closed in a `finally`, including one whose start-up failed.
- Fixed: a flaky NoSuchTransaction (about 1 in 7) came from the duplicate lookup's page count racing its find to start the transaction; the lookup now has no count, with a test that pins `pagination: false`.
- Skipped: a standalone Mongo that passes the probe (needs a second server setup; the per-request test covers the same refusal).

## 2026-11-22: after review

- Added: resume and extend gates, self-grants, delete refusal, notes access and limits, collection-keyed helpers, history, bulk, REST and GraphQL refusals (46 tests).
- Skipped: GraphQL and REST success paths (framework behavior).

## 2026-11-23: pending grants and the veto at accept

- Promises: every grant is pending and identical for any holder; the veto runs only at accept and its answer doesn't reach the granter; only the holder or server code accepts; `refuseGrant` is a function or exactly `false`; `{}` and `[]` read answers are no; the revoke-only refusal is Forbidden.
- Covered: each, in `test/plugin.test.ts` (74 tests), including local API and REST comparisons of a grant to a minor and to an adult on create, resume and extension.
- Gaps skipped (and why): timing differences between vetoed and unvetoed accepts (no promise made).

## 2026-11-22: first version

- Promises: fails closed without `canGrant`; host veto; scope and date validation; helpers respect dates; revoke and expiry are final and audited; no deletes; holders read only their own.
- Covered: each of those, in `test/plugin.test.ts` (31 tests).
- Gaps skipped (and why): large tables (no promise made); admin screens (no browser test yet).

## 2026-11-22: first audit (starter kit)

- Promises: none yet.
- Covered: none yet.
- Gaps added: none.
- Gaps skipped (and why): none.
