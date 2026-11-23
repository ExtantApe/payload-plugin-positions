# Test audit

Kept by this repo's owning session, per `~/Code/CLAUDE.md`, "Test self-audits". Newest first.

## 2026-11-23: seventh review fixes

- Promises checked: a refused accept leaves nothing behind, in any update path; a failing history write can't commit a grant change; a host where on a field a collection lacks gives no rows, not a 500; interface labels end with no period.
- Added: bulk accept refused over the Local API (minor, adult, staff, server code) and REST, with status, `updatedAt`, history and audit unchanged; a single accept by a minor leaves no bump; a failing history write for a single and a bulk update leaves the grant as it was; dotted and unknown fields in host wheres for grants and history; a label check (98 tests). Two older tests changed from expecting per-row errors to expecting the bulk refusal. Checked by reverting the fix: 6 tests fail.
- Skipped: the admin's edit-selected action in a browser (none here), SQL adapters. A client's own where on an unknown field already gets a 4xx from Payload, so it has a small test and no fix.

## 2026-11-23: sixth review fixes

- Promises checked: a grant only changes status to one of the five values, over every API, for users and server code, single and bulk; a history read with a host where on a missing field returns no rows; the create form doesn't offer a status.
- Added: null, empty, unknown and non-string status (Local API with users and server code, bulk Local API, REST single and bulk, GraphQL) with the grant, history and audit unchanged and the grant still revocable; the create form condition; a history where on a field the history lacks, and where on its own fields (91 tests). Checked by reverting the fix: 4 of the new tests fail.
- Skipped: the admin form in a browser (none here), SQL adapters.

## 2026-11-23: fifth review fixes

- Promises checked: only the plugin sets pending; a pause can't be lifted without `canGrant`, the self-grant check and the veto; a host `where` uses Payload's operators only.
- Added: both repros (revoke-only user, paused self-holder), active to pending (no history row, no audit event), create with pending for a user and server code, REST and GraphQL, a pending grant re-saved as pending, resume and extension still going to pending, and bogus operators for grants and history (87 tests). Checked by reverting the fix: 7 of the new tests fail.
- Test hygiene: the shared server stops with `doCleanup` and `force` in a `finally`; extra instances close in a `finally`.
- Skipped: the admin form with no default on `status` (no browser here).

## 2026-11-23: fourth review fixes

- Promises checked: an extension never undoes a pause; two changes at once give one winner and a clean 403, not a 500; read answers count only as `true`, `false` or a real `where`; the accept hooks run around an accept; the test run leaves no Mongo behind.
- Added: extending a paused grant (later date, then none), `beforeAccept` and `afterAccept` (order, refused accept, failing hook), four concurrent accepts and accept against revoke over five rounds each, and a wider list of bad read answers (79 tests). Checked by removing the lock: the two concurrency tests fail on a Mongo write conflict.
- Test hygiene: every extra instance closes in a `finally`; the shared server stops with `doCleanup` and `force` even when closing Payload throws. After two full runs, no `mongod` was left and no `mongo-mem-*` folder from this repo.
- Skipped: a write conflict on a SQL adapter (no SQL adapter in this repo's tests).

## 2026-11-23: pending grants and the veto at accept

- Promises: every grant is pending and identical for any holder; the veto runs only at accept and its answer doesn't reach the granter; only the holder or server code accepts; `refuseGrant` is a function or exactly `false`; `{}` and `[]` read answers are no; the revoke-only refusal is Forbidden.
- Covered: each, in `test/plugin.test.ts` (74 tests), including local API and REST comparisons of a grant to a minor and to an adult on create, resume and extension.
- Gaps skipped (and why): timing differences between vetoed and unvetoed accepts (no promise made).

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

## 2026-11-22: first version

- Promises: fails closed without `canGrant`; host veto; scope and date validation; helpers respect dates; revoke and expiry are final and audited; no deletes; holders read only their own.
- Covered: each of those, in `test/plugin.test.ts` (31 tests).
- Gaps skipped (and why): large tables (no promise made); admin screens (no browser test yet).

## 2026-11-22: first audit (starter kit)

- Promises: none yet.
- Covered: none yet.
- Gaps added: none.
- Gaps skipped (and why): none.
