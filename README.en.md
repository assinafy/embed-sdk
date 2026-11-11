# Assinafy Embed SDK

*[Leia em português](README.md) · English*

Show Assinafy's signing screen inside your own app, in an iframe, so your signers never leave your product. The SDK mounts the iframe, runs the security handshake with Assinafy, fits the iframe height to its content, and notifies your page with typed events when the signer signs, declines, or something goes wrong.

## How it works

1. Your **backend** asks the Assinafy API for a one-use session URL, valid for 5 minutes.
2. Your **frontend** receives only that URL and hands it to the SDK, which shows the signing screen in an iframe.
3. The SDK notifies your page with events: `ready`, `signed`, `declined`, and `error`.
4. Your **backend** confirms the outcome through a webhook before unlocking anything.

The API key never reaches the browser.

## Before you start

- Your plan must include the **Embed** feature. Without it, the calls below answer `403` with code `PlanRestricted`. Ask your account manager to enable it.
- You need an Assinafy **API key**, used only on your backend.
- The full API reference is the [embedded signing guide](https://api.assinafy.com.br/v1/docs#tag/embedded-signing-guide).

## Step 1: register your site's origins

Do this once for each origin. Assinafy only shows the signing screen inside pages whose origin is registered:

```bash
curl -X POST "https://api.assinafy.com.br/v1/accounts/{accountId}/embed-origins" \
  -H "X-Api-Key: $ASSINAFY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"origin": "https://app.yourcompany.com"}'
```

- An origin is exactly `https://host[:port]`, with no path, query, or wildcard. `http` is accepted only for `localhost` and `127.0.0.1`, for local development.
- Each account can have up to 10 origins. Use `GET` on the same path to list them, and `PUT` or `DELETE` on `/embed-origins/{originId}` to change or remove one.

## Step 2: mark the signer as embedded

When you create the document's assignment, set `"embedded": true` on each signer who will sign inside your app:

```json
{
  "method": "virtual",
  "signers": [
    {
      "id": "{signerId}",
      "verification_method": "Email",
      "notification_methods": ["Email"],
      "embedded": true
    }
  ]
}
```

- Embedded signers use the `Email` or `Whatsapp` verification method. They receive the normal invitation, which carries the 6-digit code they type in the iframe.
- The invitation also works on its own: if the signer finishes from it, outside your app, an open iframe receives `signed` with `via: "external"`.
- In `signing_urls`, an embedded signer has `"url": null`. Their link is always created in step 3.

## Step 3: create a session on your backend every time you show the frame

Whenever the signer reaches the signing step in your app, your backend creates a new session URL and returns **only the URL** to the browser:

```ts
// Backend (Node.js 18+). The API key stays here.
export async function createSigningSession(documentId: string, assignmentId: string, signerId: string) {
  const response = await fetch(
    `https://api.assinafy.com.br/v1/documents/${documentId}/assignments/${assignmentId}/signers/${signerId}/embed-sessions`,
    { method: "POST", headers: { "X-Api-Key": process.env.ASSINAFY_API_KEY! } },
  );
  if (!response.ok) throw new Error(`Assinafy answered ${response.status}`);
  const { data } = await response.json();
  return data.url as string; // one use, valid for 5 minutes (data.expires_at)
}
```

Expose this function through an authenticated route in your app, for example `POST /api/signing-session`. Before creating the session, confirm that the signed-in user really is that signer.

- Each URL works **once** and expires after **5 minutes**. Create a new one every time you show the iframe, including after a page reload. Never store or reuse it.
- The limit is 30 sessions per signer per hour.

If the API refuses:

| Status | Code | What to do |
|---|---|---|
| `400` | `embed_not_enabled_for_signer` | Set `"embedded": true` on the signer (step 2) |
| `403` | `PlanRestricted` | Ask to have the Embed feature enabled |
| `404` | | Check the document, assignment, and signer IDs |
| `409` | `already_signed` | The signer already signed: show the final state |
| `409` | `document_not_ready` | The document is still being processed: try again in a few seconds |
| `409` | `document_unavailable` | The document can no longer be signed, or it is not this signer's turn yet (sequential signing) |
| `409` | `embed_origins_missing` | Register an origin (step 1) |
| `429` | | Too many sessions for this signer: wait before trying again |

## Step 4: show the signing screen in the browser

```bash
npm install @assinafy/embed-sdk
```

```ts
import { create } from "@assinafy/embed-sdk";

// Ask YOUR backend for a fresh URL (step 3).
const { url } = await fetch("/api/signing-session", { method: "POST" }).then((r) => r.json());

const signing = create({ sessionUrl: url });

signing.on("ready", () => {
  // The iframe verified your origin and is showing the signing screen.
});
signing.on("signed", ({ document_id }) => {
  signing.destroy();
  showSuccess(document_id); // confirm on your backend before unlocking anything (step 5)
});
signing.on("declined", () => {
  signing.destroy();
  showDeclined();
});
signing.on("error", ({ code, message }) => {
  signing.destroy();
  handleError(code, message); // see "Errors and what to do"
});

signing.mount("#signing"); // CSS selector or HTML element
```

The SDK creates a full-width iframe inside the element. It starts 600 px high and follows the content's height (200 px minimum). Call `destroy()` when the flow ends or the user leaves the screen: it removes the iframe, listeners, and timers.

## Step 5: confirm the outcome on your backend

Browser events are UI signals. The signer can close the tab, lose connection, or finish from the invitation. Before unlocking anything in your system, confirm the status through Assinafy webhooks or by reading the document from the API.

## Events

| Event | Payload | When |
|---|---|---|
| `ready` | `{ document_id, signer_id }` | The iframe verified your origin and shows the code or signing screen. Fires again if the iframe reloads |
| `signed` | `{ document_id, signer_id, via }` | The signer signed. `via` is `"embed"` (in the iframe) or `"external"` (elsewhere, such as from the invitation) |
| `declined` | `{ document_id, signer_id, via }` | The signer declined, or someone else declined the document |
| `resize` | `{ height }` | The content height changed. The SDK already resizes the iframe |
| `error` | `{ code, message }` | Something stopped the signing. See below |

`signed` and `declined` arrive once per document, even if the iframe re-sends them after a reload.

## Errors and what to do

Errors are final: call `destroy()` and, if it makes sense, start again with a new session.

| `code` | Meaning | What to do |
|---|---|---|
| `session_expired` | The URL expired or was already used, or the signer's e-mail or phone changed | Create a new session (step 3) and a new instance |
| `origin_not_allowed` | The page's origin is not registered | Register the exact origin, including the port if any (step 1) |
| `already_signed` | The signer already signed | Show the final state |
| `document_unavailable` | The document was cancelled, declined, or expired, or is not ready yet | Check the document on your backend |
| `not_embedded` | The signer is not marked as embedded | Fix the assignment (step 2) |
| `access_closed` | The signer's access was closed | Check the document on your backend |
| `handshake_timeout` | The iframe did not answer within 12.5 seconds (emitted by the SDK) | Check the connection and whether something blocks the iframe, then try again with a new session |

Decide what to do from `code`. `message` is descriptive text and can be empty. New codes may appear: treat unknown ones as a generic error.

## React and Next.js

Create the session inside the effect, so every mount uses a fresh URL:

```tsx
"use client"; // Next.js App Router

import { useEffect, useRef } from "react";
import { create, type Signing } from "@assinafy/embed-sdk";

export function SigningFrame({ onSigned }: { onSigned: (documentId: string) => void }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let signing: Signing | undefined;
    let active = true;

    fetch("/api/signing-session", { method: "POST" })
      .then((r) => r.json())
      .then(({ url }) => {
        if (!active || !container.current) return;
        signing = create({ sessionUrl: url });
        signing.on("signed", ({ document_id }) => onSigned(document_id));
        signing.on("error", ({ code }) => console.warn("Assinafy:", code));
        signing.mount(container.current);
      });

    return () => {
      active = false;
      signing?.destroy();
    };
  }, []);

  return <div ref={container} />;
}
```

Other frameworks follow the same pattern: create and mount in the mount hook, and call `destroy()` in the cleanup. In Vue, use `onMounted` and `onUnmounted`; in Angular, `ngAfterViewInit` and `ngOnDestroy`; in Svelte, `onMount` (returning the cleanup).

## Plain HTML (CDN)

```html
<div id="signing"></div>
<script
  src="https://cdn.jsdelivr.net/npm/@assinafy/embed-sdk@1.0.1/dist/index.global.js"
  integrity="sha384-lSSpERrUWuEMJPmEUUdpk4LPI2V3JvcOAYpipt/Sboxw3yDkxbD1Rk3BZxd3Rho0"
  crossorigin="anonymous"
></script>
<script>
  fetch("/api/signing-session", { method: "POST" })
    .then((r) => r.json())
    .then(({ url }) => {
      const signing = Assinafy.create({ sessionUrl: url });
      signing.on("signed", ({ document_id }) => {
        signing.destroy();
        // show success
      });
      signing.on("error", ({ code, message }) => {
        signing.destroy();
        // handle the error
      });
      signing.mount("#signing");
    });
</script>
```

The `integrity` attribute makes the browser run only the exact published file.

## Mobile apps

For React Native, Swift, or Kotlin, host your own HTTPS page with the SDK, register its origin (step 1), and open it in a WebView. From that page, pass only the validated result to the app through the WebView bridge. The API key and session creation stay on your backend.

## Good to know

- **6-digit code:** it arrives in the invitation (e-mail or WhatsApp), not in the iframe, and the iframe has no resend button. To resend it, call `PUT /v1/documents/{documentId}/assignments/{assignmentId}/signers/{signerId}/resend` from your backend. The same code is resent, so an open iframe keeps working.
- **E-mail or phone changes:** changing the signer's contact before they verify issues a new code. The open iframe receives `session_expired`, and you create a new session.
- **Iframe reloads:** the SDK runs the handshake again by itself, and `ready` fires again.
- **Envelopes:** create the session on any document of the envelope that still waits for the signer. The iframe lists all of their pending documents.
- **Environments:** the SDK takes the origin from the session URL itself, so it works in production and sandbox with no configuration.
- **Security:** the SDK accepts messages only from its own iframe and the Assinafy origin, and refuses session URLs that are not HTTPS.

## Reference

**`create({ sessionUrl })`** returns a `Signing` instance for one session URL. It throws `TypeError` if the URL is not an absolute HTTPS URL or carries credentials.

**`signing.on(event, handler)`** registers a handler; you can register several per event. If a handler throws, the others are still called, and the error is rethrown asynchronously so your error reporting sees it.

**`signing.mount(target)`** inserts the iframe into a CSS selector or `HTMLElement`, once per instance.

**`signing.destroy()`** removes the iframe, listeners, timers, and handlers. It is safe to call more than once. A destroyed instance cannot be reused.

Exported types: `Signing`, `CreateOptions`, `SigningEventName`, `SigningEventPayloads`, `AssinafyErrorCode`, and `SigningVia`. The package ships ESM, a browser bundle that exposes `window.Assinafy`, and TypeScript declarations.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
