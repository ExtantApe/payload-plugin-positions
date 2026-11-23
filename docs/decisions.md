# Decisions

Dated decisions for this repo, newest last.

- 2026-11-22: created from the ops starter kit, area `co-plugins`.
- 2026-11-22: created as a skeleton on our side (owner, via Simon: "Do you need to create repos for Garfunkel? If so, please do so"). Scope to come from Captive Origins. npm name @extantape/payload-plugin-positions (D131). MIT, EXTANT APE. Contributions from co/ branches; only the owner merges (D256).
- 2026-11-22: description and scope from Captive Origins (via Simon): scoped, dated grants with host-defined types, grant rules and an audit trail; a refuse-grant hook so a host can keep minors from holding positions.
- 2026-11-22: first version built for Captive Origins' account model (K5225, D5225 and D5228: positions are scoped grants in one table, in an agnostic plugin). Design choices: `canGrant` fails closed on anything but exactly `true`; `refuseGrant` is a host veto that also binds server code that skips access; revoked and expired are final; grants are never deleted; helpers take `payload` first because they have to read the table.
- 2026-11-22: review fixes from EXTANT APE (bottle 115). Giving more is a grant: resume and extension need `canGrant` and the veto. `refuseGrant` is required, with `false` as the opt-out. History is append-only and written only by the plugin. Notes are staff-only. Self-grants are off unless the host opts in.
- 2026-11-22: second review from EXTANT APE (bottle 118). Notes and history have their own read option, `canReadPrivate`, closed by default. History is written in the grant's transaction and the plugin refuses to run without one unless the host opts out.
