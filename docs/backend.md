# Backend integration

The browser package exports `create`, `Signing.on`, `Signing.mount` and `Signing.destroy`. It makes no account API requests. Your backend uploads documents, selects signers, creates assignments or envelopes, tracks contracts, sends reminders and confirms results. Use the [production reference](https://api.assinafy.com.br/v1/docs) or [staging reference](https://api.angry-pisco.stage.assinafy.com.br/v1/docs) for the complete REST schemas and optional fields.

Use one environment throughout a flow. Production API base: `https://api.assinafy.com.br/v1`; staging: `https://api.angry-pisco.stage.assinafy.com.br/v1`. Always use the returned session URL unchanged; do not construct an iframe URL from an access code.

## Authentication

Own-workspace integrations use `X-Api-Key: <server-secret>` or a user token in `Authorization: Bearer <token>`. Never put these credentials in browser code, URLs, logs, examples or source control. Authenticate your own session route, protect it against CSRF, and verify that the logged-in user may sign the requested document as that signer.

Marketplace applications use OAuth authorization code flow with PKCE S256. Discover the endpoints from `https://auth.assinafy.com.br/.well-known/oauth-authorization-server`. Store a fresh verifier and random `state` in the user's server session; validate both returned `state` and `iss` before exchanging the code. Redirect URIs must be registered HTTPS URLs with exact matching. Use the environment's discovery metadata, not a production/staging mix.

The server sends `POST /v1/oauth/token` as `application/x-www-form-urlencoded`:

```text
grant_type=authorization_code&code=CODE&redirect_uri=https%3A%2F%2Fapp.example.com%2Foauth%2Fcallback&client_id=CLIENT_ID&client_secret=CLIENT_SECRET&code_verifier=VERIFIER&resource=https%3A%2F%2Fapi.assinafy.com.br
```

Public applications omit `client_secret`. A successful response is a plain object, without the usual `data` wrapper:

```json
{"access_token":"ACCESS_TOKEN","token_type":"Bearer","expires_in":3600,"scope":"documents:read documents:write","refresh_token":"REFRESH_TOKEN","id_token":"ID_TOKEN"}
```

`refresh_token` exists only with `offline_access`; `id_token` only with `openid`. The access token belongs to the single workspace returned by `GET /v1/accounts`. Send it only as `Authorization: Bearer`; inspect the granted scopes. Refresh with `grant_type=refresh_token`, `refresh_token`, `client_id` and, for confidential apps, `client_secret` at the same endpoint. Serialize refreshes and atomically save the rotated refresh token; replaying an old one revokes the connection. Revoke on disconnect with `POST /v1/oauth/revoke` using form fields `token`, `client_id` and the confidential client secret.

**OAuth application tokens cannot manage embed origins or mint embed sessions.** `documents:write` does not lift that restriction. An OAuth-only marketplace integration must use the supported external invitation flow; embedded signing requires an authorized backend API key or user bearer token. This browser SDK does not authenticate to the API or change its authorization rules.

## Request and response conventions

Ordinary JSON responses use `{ "status": 200, "message": "", "data": ... }`. The examples below show complete request bodies for the illustrated operation; displayed assignment fields are the subset the embed integration consumes. The linked OpenAPI schemas define every response property. Check the HTTP status before reading `data`. Errors can include `code` and `errors: [{ field, code, message }]`; do not branch on translated `message` text. Respect `Retry-After` on `429`. Do not blindly retry a write after a timeout: read the resource first or reuse its supported idempotency key.

## 1. Register an origin

`POST /v1/accounts/{accountId}/embed-origins`, JSON request:

```json
{"origin":"https://app.example.com"}
```

Response:

```json
{"status":200,"message":"","data":{"id":"ORIGIN_ID","origin":"https://app.example.com","created_at":"2026-11-24T12:00:00Z"}}
```

`GET` lists origins in `data: []`. `PUT /v1/accounts/{accountId}/embed-origins/{originId}` accepts the same request body; `DELETE` removes that origin. There are at most ten. Only exact HTTPS origins are allowed, except HTTP localhost/127.0.0.1. Do not send a path, query, fragment, credentials or wildcard. A missing Embed entitlement returns `403 PlanRestricted`.

## 2. Upload and select the signer

Upload a PDF with `POST /v1/accounts/{accountId}/documents`, `multipart/form-data` field `file`. Let your HTTP client set the multipart boundary. Save `data.id` as `documentId`. `GET /v1/documents/{documentId}` returns status, pages and assignment; wait for `metadata_ready` when placing fields or creating an envelope. A virtual assignment may be created earlier, but a session can return `409 document_not_ready` until processing finishes.

Create a signer with `POST /v1/accounts/{accountId}/signers`:

```json
{"full_name":"Example Signer","email":"signer@example.com"}
```

Save `data.id`. If that email already exists, find the exact signer with the paginated signer list instead of creating duplicates or changing unrelated contacts.

## 3. Create an assignment

`POST /v1/documents/{documentId}/assignments`:

```json
{"method":"virtual","signers":[{"id":"SIGNER_ID","verification_method":"Email","notification_methods":["Email"],"embedded":true}]}
```

Save `data.id` as `assignmentId`. In `data.signing_urls`, an embedded signer's entry is:

```json
{"signer_id":"SIGNER_ID","url":null,"embedded":true}
```

The response also contains the assignment's signers, items, summary and copy receivers. `notification_methods` always takes exactly one channel. Omitting verification and notification defaults both to Email.

| Verification | Notification | Embedded | Additional requirements |
|---|---|---|---|
| `Email` | `["Email"]` | Yes | Signer email |
| `Whatsapp` | `["Whatsapp"]` | Yes | Signer `whatsapp_phone_number`, enabled paid feature |
| `DigitalCertificate` | `["Email"]` or `["Whatsapp"]` | No | ICP-Brasil certificate, government ID, enabled feature, `virtual`, alone in the signing step |
| `IdDocumentFaceMatchBasic` | `["Email"]` or `["Whatsapp"]` | No | Valid CPF, full name, enabled identity verification feature |

Invitation-free embedded signing requires account-specific enablement; do not assume it is available or substitute an undocumented verification method.

For placed fields, create/select field definitions with `/v1/accounts/{accountId}/fields`, read page IDs from the prepared document, and send:

```json
{"method":"collect","signers":[{"id":"SIGNER_ID","verification_method":"Email","notification_methods":["Email"],"embedded":true}],"entries":[{"page_id":"PAGE_ID","fields":[{"signer_id":"SIGNER_ID","field_id":"FIELD_ID","display_settings":{"left":72,"top":72,"width":240,"height":80}}]}]}
```

Each signer must own at least one placed field. Digital certificates cannot sign `collect` assignments. For sequential signing, every signer must provide `step`, contiguous from 1; later steps cannot mint a usable session until activated. Use `POST .../assignments/estimate-cost` with the assignment body, then send the returned `total_credits` as `max_total_credits` when creating it to cap spending.

## 4. Mint and mount

`POST /v1/documents/{documentId}/assignments/{assignmentId}/signers/{signerId}/embed-sessions` has no request body. Successful response:

```json
{"status":200,"message":"","data":{"url":"https://app.assinafy.com.br/embed/SESSION_TOKEN","expires_at":"2026-11-24T12:05:00Z"}}
```

Return only `{ "url": "..." }` from your authenticated application route, with `Cache-Control: no-store`. The URL is a bearer credential, expires in five minutes and is consumed once. Request a fresh URL for each new SDK instance. The signing frame exchanges the token; your application must not prefetch or exchange it first. Limit: 30 sessions per signer per hour.

Use `create({ sessionUrl: url })`, register handlers, then `mount(target)` as in the README. Destroy on leaving the screen. A frame resize is not handshake completion; wait for `ready`. For errors and all event payload types, see [the SDK reference](sdk.md).

## Envelopes

Prepare each document to `metadata_ready` without an assignment, then `POST /v1/accounts/{accountId}/envelopes`:

```json
{"name":"Example agreement and attachment","signers":[{"id":"SIGNER_ID","verification_method":"Email","notification_methods":["Email"],"embedded":true}],"documents":[{"id":"DOCUMENT_1","method":"virtual","signer_ids":["SIGNER_ID"]},{"id":"DOCUMENT_2","method":"virtual","signer_ids":["SIGNER_ID"]}]}
```

Send a stable `Idempotency-Key` header when retrying this creation. The response's `data` is a `DocumentEnvelope` with its ID, ordered documents, statuses, signers and counts. Each document has its own assignment, certificate and final status. Read its assignment ID from the document. Estimate first with `POST /v1/accounts/{accountId}/envelopes/estimate-cost`; creation accepts `max_total_credits`.

Mint on any pending document for this signer. One invitation code verifies the signer across the envelope. Keep the SDK instance alive while the signer completes its documents. `signed` identifies one document and may repeat at the protocol level; the SDK delivers each document's outcome once. Confirm all expected documents on the backend before closing the iframe. Do not infer envelope completion from the first `signed` event.

Envelopes allow up to 20 documents and 20 signers, with no sequential `step`. Documents can also use `collect` with `entries` and exact matching `signer_ids`. Add a prepared document through `POST /v1/accounts/{accountId}/envelopes/{envelopeId}/documents`; it inherits the envelope signers' embedded setting. Manage the envelope through its documented read, rename, activities, download, document-removal, cancel and delete endpoints. Deletion requires all documents to be closed and leaves the documents intact.

## Contracts

Contract tracking attaches business terms to a document; it does not change the iframe protocol or signing method. `PUT /v1/accounts/{accountId}/documents/{documentId}/contract`:

```json
{"status":"draft","counterparty_name":"Example Company","value":1200,"currency":"BRL","start_date":"2026-11-24","end_date":"2027-11-24","auto_renew":false}
```

`GET` on the same path returns `data.resource: "document_contract"`, the saved terms, `document_id`, `term`, `created_at` and `updated_at`. Send the returned `updated_at` with subsequent writes to detect concurrent changes (`409 ContractChanged`). Omitted attributes stay unchanged; nullable attributes can be cleared with `null`. Renew and terminate through their dedicated `/contract/renew` and `/contract/terminate` endpoints. An amendment can instead return `document_contract_amendment`; inspect the discriminator rather than assuming every response holds root contract terms. The complete term, amendment and lifecycle schemas are in the [Contracts reference](https://api.assinafy.com.br/v1/docs#tag/contracts).

## Notifications and completion

Invitations and reminders are backend operations, not SDK events. A successful assignment/envelope response does not prove notification delivery. Read notification history using `GET /v1/documents/{documentId}/notification-history` and inspect each signer's recorded delivery status.

- Resend one document's invitation with `PUT /v1/documents/{documentId}/assignments/{assignmentId}/signers/{signerId}/resend` (no body).
- Remind an envelope signer with `PUT /v1/accounts/{accountId}/envelopes/{envelopeId}/signers/{signerId}/resend` (no body).
- Both resend the existing code; changing signer email/phone before verification changes the access code and invalidates an open session.
- Changing contact details is a separate backend operation; the SDK reports `session_expired` and needs a newly minted session.
- Invitations also work outside the iframe. An open frame can report `signed` with `via: "external"`.

Verify webhook authenticity using the API's webhook signing contract, handle duplicate deliveries idempotently, and reconcile by reading document/assignment state. Treat browser events only as UI signals. A signer can close their browser before any event reaches your application. Contract business status, signer completion and document certification are distinct states.
