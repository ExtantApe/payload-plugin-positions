# Test audit

Kept by this repo's owning session, per `~/Code/CLAUDE.md`, "Test self-audits". Newest first.

## 2026-11-22: first version (K5225)

- Promises: fails closed without `canGrant`; host veto; scope and date validation; helpers respect dates; revoke and expiry are final and audited; no deletes; holders read only their own.
- Covered: each of those, in `test/plugin.test.ts` (31 tests).
- Gaps skipped (and why): large tables (no promise made); admin screens (no browser test yet).

## 2026-11-22: first audit (starter kit)

- Promises: none yet.
- Covered: none yet.
- Gaps added: none.
- Gaps skipped (and why): none.
