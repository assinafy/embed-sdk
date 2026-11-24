# Assinafy Embed SDK

*[Leia em português](README.md) · English*

Show Assinafy's signing screen inside your own app, in an iframe, so your signers never leave your product. The SDK mounts the iframe, runs the security handshake with Assinafy, fits the iframe height to its content, and notifies your page with typed events when the signer signs, declines, or something goes wrong.

## How it works

1. Your **backend** asks the Assinafy API for a one-use session URL, valid for 5 minutes.
2. Your **frontend** receives only that URL and hands it to the SDK, which shows the signing screen in an iframe.
3. The SDK notifies your page with events: `ready`, `signed`, `declined`, and `error`.
4. Your **backend** confirms the outcome through a webhook before unlocking anything.

The API key never reaches the browser. This package handles the iframe; your backend manages documents, assignments, envelopes, contracts and notifications. See [backend requests and responses](docs/backend.md).

## Before you start

- Your plan must include the **Embed** feature. Without it, the calls below answer `403` with code `PlanRestricted`. Ask your account manager to enable it.
- Use an **API key** or user bearer token on your backend. **OAuth application tokens cannot manage embed origins or mint embed sessions**, even with `documents:write`; OAuth for other API operations is covered in the [backend guide](docs/backend.md#authentication).
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

Upload a PDF with `POST /v1/accounts/{accountId}/documents` (multipart `file`) and create or select a signer with `/v1/accounts/{accountId}/signers`. Then `POST /v1/documents/{documentId}/assignments`; set `"embedded": true` on each signer who will sign inside your app:

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

- Embedded signers use `Email` + `["Email"]` or `Whatsapp` + `["Whatsapp"]`, exactly one notification channel. `DigitalCertificate` and `IdDocumentFaceMatchBasic` are not embedded methods. Both `virtual` and `collect` assignments are supported; see [payloads and requirements](docs/backend.md). They receive the normal invitation, which carries the 6-digit code they type in the iframe.
- The invitation also works on its own: if the signer finishes from it, outside your app, an open iframe receives `signed` with `via: "external"`.
- In `signing_urls`, an embedded signer has `"url": null`. Their link is always created in step 3.

## Step 3: create a session on your backend every time you show the frame

Whenever the signer reaches the signing step in your app, your backend creates a new session URL and returns **only the URL** to the browser:

```ts
// Backend (Node.js 26 LTS). The API key stays here.
export async function createSigningSession(documentId: string, assignmentId: string, signerId: string) {
  const response = await fetch(
    `https://api.assinafy.com.br/v1/documents/${documentId}/assignments/${assignmentId}/signers/${signerId}/embed-sessions`,
    { method: "POST", signal: AbortSignal.timeout(15_000), headers: { "X-Api-Key": process.env.ASSINAFY_API_KEY! } },
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
const response = await fetch("/api/signing-session", { method: "POST" });
if (!response.ok) throw new Error(`Session: HTTP ${response.status}`);
const { url } = await response.json();

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

**Step 5: confirm the outcome on your backend.** Browser events are UI signals. The signer can close the tab, lose connection, or finish from the invitation. Before unlocking anything in your system, confirm the status through Assinafy webhooks or by reading the document from the API.

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

## Frameworks and mobile

See the [React, Next.js and WebView examples](docs/frameworks.md). Each mount needs a fresh session; destroy the instance during cleanup.

## Plain HTML (CDN)

```html
<div id="signing"></div>
<script
  src="https://cdn.jsdelivr.net/npm/@assinafy/embed-sdk@1.0.2/dist/index.global.js"
  integrity="sha384-fHEEbD029qjCN+kRU4bVjfAw5ep4t1gqyrUU5UCc4I2cD/dxM4P23FlepX3mTu4D"
  crossorigin="anonymous"
></script>
```

Use `Assinafy.create({ sessionUrl: url })` with the handlers above. `integrity` verifies the published file.

## Good to know

- **6-digit code:** it arrives in the invitation (e-mail or WhatsApp), not in the iframe, and the iframe has no resend button. To resend it, call `PUT /v1/documents/{documentId}/assignments/{assignmentId}/signers/{signerId}/resend` from your backend. The same code is resent, so an open iframe keeps working.
- **E-mail or phone changes:** changing the signer's contact before they verify issues a new code. The open iframe receives `session_expired`, and you create a new session.
- **Iframe reloads:** the SDK runs the handshake again by itself, and `ready` fires again.
- **Envelopes:** create the session on a pending document. Keep the iframe mounted after an individual `signed` event; destroy it only after your backend confirms every expected document is complete. The single-document example above destroys on the first signature.
- **Contracts:** contract tracking is backend metadata on the document and uses the same signing session. See [envelopes and contracts](docs/backend.md).
- **Environments:** the SDK takes the origin from the session URL itself, so it works in production and sandbox with no configuration.
- **Security:** the SDK accepts messages only from its own iframe and the Assinafy origin, and refuses session URLs that are not HTTPS.

## Reference

**`create({ sessionUrl })`** returns a `Signing` instance for one session URL. It throws `TypeError` if the URL is not an absolute HTTPS URL or carries credentials.

**`signing.on(event, handler)`** registers a handler; you can register several per event. If a handler throws, the others are still called, and the error is rethrown asynchronously so your error reporting sees it.

**`signing.mount(target)`** returns `void` and inserts the iframe into a CSS selector or `HTMLElement`, once per instance. Failed insertion releases listeners and permits retrying.

**`signing.destroy()`** removes the iframe, listeners, timers, and handlers. It is safe to call more than once. A destroyed instance cannot be reused.

Exported types: `Signing`, `CreateOptions`, `SigningEventName`, `SigningEventPayloads`, `AssinafyErrorCode`, and `SigningVia`. The package ships ESM, a browser bundle that exposes `window.Assinafy`, and TypeScript declarations.

[Contributing](CONTRIBUTING.md) · [MIT](LICENSE)
