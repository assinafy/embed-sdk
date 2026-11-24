# SDK reference

The package has no runtime dependencies. It ships ES2022 ESM, an IIFE exposing `window.Assinafy`, declarations and source maps. Use a modern browser supporting ES2022, private fields, `URL`, `postMessage` and `queueMicrotask`. Node.js is used for development and backend examples, not signing UI execution.

## Public request and event types

```ts
export type AssinafyErrorCode =
  | "origin_not_allowed"
  | "session_expired"
  | "not_embedded"
  | "document_unavailable"
  | "already_signed"
  | "access_closed"
  | "handshake_timeout"
  | (string & {});

export type SigningVia = "embed" | "external" | (string & {});

export interface SigningEventPayloads {
  ready: {
    readonly document_id: string;
    readonly signer_id: string;
  };
  signed: {
    readonly document_id: string;
    readonly signer_id: string;
    readonly via: SigningVia;
  };
  declined: {
    readonly document_id: string;
    readonly signer_id: string;
    readonly via: SigningVia;
  };
  resize: {
    readonly height: number;
  };
  error: {
    readonly code: AssinafyErrorCode;
    readonly message: string;
  };
}

export type SigningEventName = keyof SigningEventPayloads;

export interface CreateOptions {
  /** Fresh, single-use HTTPS URL minted by your backend. Never an API key or OAuth token. */
  readonly sessionUrl: string;
}

export interface Signing {
  /** Register a typed event handler. Returns void; duplicate handlers are registered once. */
  on<Name extends SigningEventName>(
    event: Name,
    handler: (payload: SigningEventPayloads[Name]) => void,
  ): void;
  /** Append the signing iframe to a CSS selector or element. Mount once per instance. */
  mount(target: string | HTMLElement): void;
  /** Remove the iframe, timers and handlers. Safe to call repeatedly; the instance cannot be reused. */
  destroy(): void;
}

export function create(options: CreateOptions): Signing;
```

`create` returns an unmounted instance. It does not fetch the URL. Invalid, relative, non-HTTPS or credential-bearing URLs throw `TypeError`. Only accept session URLs from your trusted backend: HTTPS validation does not identify the service on its own.

`on` returns `void`, accepts multiple handlers and deduplicates the same handler function. Unknown event names or non-function handlers throw `TypeError`; registering after destruction throws `Error`. Callbacks receive exactly the typed payload above. Unknown error codes and future `via` strings remain compatible. Error messages missing from older frames are normalized to an empty string. Exceptions from one callback are rethrown asynchronously without preventing the other callbacks from receiving the current event. Handler changes during delivery apply to subsequent events.

`mount` returns `void`, creates an accessible titled iframe with clipboard/fullscreen permissions, 100% width and 600 px initial height. It accepts a CSS selector or an element, including an element in another browser window. Missing document/container/window, repeat mounts and mounts after destruction throw; invalid selector syntax throws the browser's `DOMException`. If insertion throws, listeners are released and mounting can be retried. Resize events apply a 200 px minimum; non-finite heights are ignored.

`destroy` returns `void`. It removes the frame, load/message listeners, timers and handlers; repeated calls are harmless. Create another instance with a fresh URL to restart.

## Protocol and lifecycle

The parent sends `{ "v": 1, "type": "assinafy:hello" }` to the session URL's exact origin. After each iframe load it sends at most 20 hellos, 500 ms apart. A valid ready/error or signing outcome stops the handshake; resize alone does not. If unanswered, the SDK emits `{ "code": "handshake_timeout", "message": "Assinafy signing iframe did not become ready." }` after 12.5 seconds, allowing time for the frame's own origin check. An error received before load suppresses a later handshake timeout.

Incoming messages use `{ "v": 1, "type": "assinafy:<event>", "payload": ... }`. Both the origin and the mounted iframe's `contentWindow` must match. Invalid versions, unknown event names and malformed payloads are ignored. The frame validates the registered parent origin; API/session validation remains the server's responsibility.

`ready` can repeat on reload. `signed` and `declined` are deduplicated independently by document ID, including across reloads. Each envelope document can therefore emit its own outcome. The SDK does not decide when the entire envelope is complete. Errors require application cleanup and, where appropriate, a new session. Confirm signing outcomes on the backend.

See the README for every error code and recovery action, and [backend integration](backend.md) for authentication, notifications, envelopes and contracts.
