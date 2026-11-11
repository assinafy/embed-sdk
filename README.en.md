# Assinafy Embed SDK

*[Leia em português](README.md) · English*

Framework-independent browser SDK for Assinafy embedded signing. It mounts the one-use signing session in an iframe and exposes typed completion events without putting an API key or session creation in browser code.

The integration contract is the [Assinafy embedded signing guide](https://api.assinafy.com.br/v1/docs#tag/embedded-signing-guide).

## Install

```bash
npm install @assinafy/embed-sdk
```

```ts
import * as Assinafy from "@assinafy/embed-sdk";

const signing = Assinafy.create({ sessionUrl });

signing.on("ready", ({ document_id }) => {
  console.log("Ready", document_id);
});
signing.on("signed", ({ document_id, via }) => {
  console.log("Signed", document_id, via);
  signing.destroy();
});
signing.on("declined", ({ document_id, via }) => {
  console.log("Declined", document_id, via);
  signing.destroy();
});
signing.on("error", ({ code, message }) => {
  console.error(code, message);
});

signing.mount("#signing-container");
```

`destroy()` removes the iframe, message listener, retry timer, and handlers. Call it when the flow ends. An instance serves one session URL, so on `session_expired` (which can also arrive mid-session, after the signer's e-mail or phone changes) call `destroy()`, mint a new URL on your backend, and create a new instance. If the frame reloads, `ready` fires again; after a reload on the done screen the frame re-sends `signed` or `declined`, which the SDK ignores as a repeat.

The same module works in React, Next.js, Vue, Angular, and Svelte. Create and mount it in the framework's browser lifecycle hook, then call `destroy()` from that hook's cleanup.

## CDN / plain HTML

```html
<div id="signing-container"></div>
<script
  src="https://cdn.jsdelivr.net/npm/@assinafy/embed-sdk@1.0.0/dist/index.global.js"
  integrity="sha384-lSSpERrUWuEMJPmEUUdpk4LPI2V3JvcOAYpipt/Sboxw3yDkxbD1Rk3BZxd3Rho0"
  crossorigin="anonymous"
></script>
<script>
  const signing = Assinafy.create({ sessionUrl });
  signing.on("ready", handleReady);
  signing.on("signed", handleSigned);
  signing.on("declined", handleDeclined);
  signing.on("error", handleError);
  signing.mount("#signing-container");
</script>
```

## Server boundary

Create the short-lived session on your authenticated backend as the embedded signing guide describes, then return only its URL to the browser. Each URL works once and expires after 5 minutes, so mint a new one every time you show the frame. Register each parent-page origin first, as step 1 of the guide describes (`http` works only for `localhost` and `127.0.0.1`). Never expose an Assinafy API key in this SDK, client-side environment variables, HTML, analytics, or logs.

The SDK:

- accepts absolute HTTPS session URLs without URL credentials, including stage, sandbox, and production hosts;
- accepts messages only from that origin and from its own iframe window;
- performs the documented `assinafy:hello` handshake, stopping at the frame's first valid message;
- follows `resize` messages automatically, with the documented 200 px minimum;
- emits typed `ready`, `signed`, `declined`, `resize`, and `error` payloads;
- delivers each `signed` and `declined` once per document, ignoring repeats;
- still calls every handler when one throws or calls `destroy()`, and rethrows the error asynchronously so your error reporting sees it.

Documented frame error codes are `origin_not_allowed`, `session_expired`, `not_embedded`, `document_unavailable`, `already_signed`, and `access_closed`. Frame errors are terminal. `message` is an empty string if the frame omits it. The SDK also emits `handshake_timeout` when the frame sends nothing within 12.5 seconds of loading: 20 hellos over 10 seconds, then a grace period so the frame's own `origin_not_allowed` arrives first. Unknown future string codes are still delivered for forward compatibility.

Treat browser events as UI signals. Confirm signed or declined status with an authenticated backend webhook or API read before changing durable application state.

## Mobile

Load this browser SDK inside a hosted HTTPS wrapper page, validate its events there, and forward only the small validated result through the React Native, Swift, or Kotlin bridge. The API key and session creation remain on your backend.

## Development and releases

Development uses the Node.js version in `.nvmrc` and the npm version in `packageManager`.

```bash
nvm use
npm ci
npx playwright install chromium
npm run verify
```

When the browser bundle changes, `npm test` fails until the CDN snippet in both READMEs carries the new `integrity` hash; the failure message prints the value to paste.

GitHub Actions publishes releases to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, with provenance); no npm token is stored anywhere. To release, set the new version (`npm version <x.y.z> --no-git-tag-version`), update both CDN snippets, merge to `main`, then push the matching tag:

```bash
git tag -a v1.0.1 -m v1.0.1
git push origin v1.0.1
```

`release.yml` checks that the tag matches `package.json`, runs `npm run verify`, publishes to npm, and creates the GitHub release.

`live-test/` runs the built SDK against the real Assinafy frame. It is not part of `npm test` and needs an Embed-enabled workspace in `ASSINAFY_API_KEY` and `ASSINAFY_ACCOUNT_ID`. `setup.py` creates a test document and signer, `matrix.mjs` covers the handshake and error paths, `sign.mjs` signs for real, and `leak.mjs` checks the embed page's third-party requests:

```bash
npm run build
python3 -I live-test/setup.py
node live-test/matrix.mjs
node live-test/sign.mjs
node live-test/leak.mjs
```

The package publishes:

- `dist/index.js`: ESM for npm and modern bundlers;
- `dist/index.global.js`: browser IIFE exposed as `window.Assinafy`;
- `dist/index.d.ts`: TypeScript declarations;
- source maps for both JavaScript bundles.
