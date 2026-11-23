# payload-plugin-positions

Positions for Payload: scoped, dated grants people hold on a site, an organization or a project, with host-defined types, grant rules and an audit trail.

**Status:** a skeleton. The plugin does nothing yet; its pieces land as separate pull requests from Captive Origins. One test checks the empty plugin leaves a config alone.

## What it does

Nothing yet. The agreed scope:

- **A position is a scoped, dated grant** that opens tools or portals: on a site, an organization or a project.
- **One grant table** holds the person, the position type, the scope, start and end dates, who granted it, and an audit trail.
- **The host passes in** the position types, the scope kinds and who may grant each. Each defaults to nobody.
- **A hook can refuse a grant.** A host uses it so minors never hold positions.

## Install or build

Not on npm yet. To work on it:

```
npm install
npm test
npm run build
```

## License

MIT. Copyright (c) 2026 EXTANT APE. See `LICENSE`.

Contributions arrive as pull requests from `co/` branches in this repo. Only the owner merges.
