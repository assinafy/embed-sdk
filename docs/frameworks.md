# Framework and WebView integration

The SDK needs a browser only when `mount()` is called. Importing it during server rendering is safe. Keep API credentials and session creation on your backend.

## React and Next.js

Create a fresh session inside each effect. This also handles React Strict Mode's extra setup/cleanup cycle. Check HTTP errors, ignore a response after unmount, and keep the callback in the effect dependencies. Stabilize callbacks in the parent with `useCallback` if needed.

```tsx
"use client";

import { useEffect, useRef } from "react";
import { create, type Signing } from "@assinafy/embed-sdk";

type Props = {
  onSigned: (documentId: string) => void;
  onError: (message: string) => void;
};

export function SigningFrame({ onSigned, onError }: Props) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    let signing: Signing | undefined;

    async function mount() {
      try {
        const response = await fetch("/api/signing-session", {
          method: "POST",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Session: HTTP ${response.status}`);
        const { url } = await response.json();
        if (controller.signal.aborted || !container.current) return;
        signing = create({ sessionUrl: url });
        signing.on("signed", ({ document_id }) => onSigned(document_id));
        signing.on("error", ({ code, message }) => {
          signing?.destroy();
          onError(message || code);
        });
        signing.mount(container.current);
      } catch (error) {
        signing?.destroy();
        if (!controller.signal.aborted) {
          onError(error instanceof Error ? error.message : String(error));
        }
      }
    }

    void mount();
    return () => {
      controller.abort();
      signing?.destroy();
    };
  }, [onSigned, onError]);

  return <div ref={container} />;
}
```

`onSigned` should refresh backend state. For envelopes, keep the frame mounted until all expected documents are complete; one event only describes one document. Handle `declined` if your UI needs a separate refusal state. Destroy the instance when leaving the signing screen.

## Other frameworks

| Framework | Mount | Cleanup |
|---|---|---|
| Vue | `onMounted` | `onUnmounted` |
| Angular | `ngAfterViewInit` | `ngOnDestroy` |
| Svelte | `onMount` | Return a synchronous cleanup function from `onMount` |

Use the same cancellation guard as the React example when session creation is asynchronous. A cancelled request may still mint a session on the server; discard its URL and request a new one on the next mount.

## Mobile WebViews

For React Native, Swift or Kotlin, host your own HTTPS page with the SDK, register its origin, and open it in a WebView. Pass only the backend-confirmed result to the native app through its WebView bridge. API credentials and session creation remain on your backend. The SDK itself is a browser library, not a native signing or OAuth library.
