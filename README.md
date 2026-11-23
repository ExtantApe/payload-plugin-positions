# payload-plugin-positions

Positions for Payload: named roles people hold in an organization, for business accounts.

**Status:** a skeleton, and the scope is still to come from Captive Origins. The plugin does nothing yet; its pieces land as separate pull requests once the scope is agreed. One test checks the empty plugin leaves a config alone.

## What it does

Nothing yet. A position will never grant access by itself: what each one allows is whatever the host passes in, and each defaults to nothing.

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
