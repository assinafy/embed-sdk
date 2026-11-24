# Contributing

Notes for maintainers of `@assinafy/embed-sdk`. The READMEs are the integration guide for customers (`README.md` in Portuguese, `README.en.md` in English); keep them user-facing and in sync.

## Development

Use the Node.js version in `.nvmrc` and the npm version in `packageManager`.

```bash
nvm use
npm ci
npx playwright install chromium
npm run verify
```

`npm run verify` typechecks, builds, runs the unit and real-browser tests with 100% coverage, and dry-runs the package.

When the browser bundle or the version changes, `npm test` fails until the CDN snippet in both READMEs carries the new version and `integrity` hash; the failure message prints the value to paste.

## Releasing

GitHub Actions publishes to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, with provenance); no npm token is stored anywhere. npm trusts only `.github/workflows/release.yml` running in the `release` environment, and only `v*` tags can deploy to that environment.

1. Set the version: `npm version <x.y.z> --no-git-tag-version`.
2. Update the CDN snippet in both READMEs (`npm test` prints the hash).
3. Commit with the configured project identity and merge to `main`.
4. Tag and push:

   ```bash
   git tag -a vX.Y.Z -m vX.Y.Z
   git push origin vX.Y.Z
   ```

`release.yml` checks that the tag matches `package.json`, runs `npm run verify`, publishes to npm, and creates the GitHub release.

## Live verification

Run live verification separately from `npm test`, using an explicitly authorized workspace and disposable documents. Keep scripts, state, credentials and screenshots local and ignored. Record created IDs and remove only those resources after testing. Email verification requires the recipient's code; WhatsApp, certificate and identity verification require their respective account features and inputs.

`npm audit` checks dependency advisories; `git diff --check` checks whitespace. Strict TypeScript checks syntax and types; there is no separate lint configuration. Use a temporary Playwright browser/cache directory when testing and clean up only task-created resources.

## Package contents

- `dist/index.js`: ESM for npm and modern bundlers;
- `dist/index.global.js`: browser IIFE exposed as `window.Assinafy`;
- `dist/index.d.ts`: TypeScript declarations;
- source maps for both JavaScript bundles.

Both READMEs, CONTRIBUTING.md and the linked `docs/` guides are included in the package. Local maintainer instructions and live verification scripts are excluded.
