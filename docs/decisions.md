# Decisions

Dated decisions for this repo, newest last.

- 2026-11-22: created from the ops starter kit, area `co-plugins`.
- 2026-11-22: created as a skeleton on our side (owner, via Simon: "Do you need to create repos for Garfunkel? If so, please do so"). Scope to come from Captive Origins. npm name @extantape/payload-plugin-positions (D131). MIT, EXTANT APE. Contributions from co/ branches; only the owner merges (D256).
- 2026-11-22: description and scope from Captive Origins (via Simon): scoped, dated grants with host-defined types, grant rules and an audit trail; a refuse-grant hook so a host can keep minors from holding positions.
- 2026-11-22: first version built for Captive Origins' account model (positions are scoped grants in one table, in an agnostic plugin). Design choices: `canGrant` fails closed on anything but exactly `true`; `refuseGrant` is a host veto that also binds server code that skips access; revoked and expired are final; grants are never deleted; helpers take `payload` first because they have to read the table.
- 2026-11-22: review fixes from EXTANT APE (bottle 115). Giving more is a grant: resume and extension need `canGrant` and the veto. `refuseGrant` is required, with `false` as the opt-out. History is append-only and written only by the plugin. Notes are staff-only. Self-grants are off unless the host opts in.
- 2026-11-22: second review from EXTANT APE (bottle 118). Notes and history have their own read option, `canReadPrivate`, closed by default. History is written in the grant's transaction and the plugin refuses to run without one unless the host opts out.
- 2026-11-23: the host veto no longer shows its reason to a signed-in granter (owner, relayed: "Fix in 0.1.1 (Recommended)"). The veto's answer at grant time told a granter whether the grantee was a minor. A vetoed grant, resume or extension now looks identical to one the granter may not make, with nothing written and no event. Server code with no user still sees the reason. There is no acceptance step to move the decision to.
