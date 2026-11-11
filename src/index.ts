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
  readonly sessionUrl: string;
}

export interface Signing {
  on<Name extends SigningEventName>(
    event: Name,
    handler: (payload: SigningEventPayloads[Name]) => void,
  ): void;
  mount(target: string | HTMLElement): void;
  destroy(): void;
}

type ParsedMessage = {
  [Name in SigningEventName]: {
    readonly name: Name;
    readonly payload: SigningEventPayloads[Name];
  };
}[SigningEventName];

const VALIDATORS: {
  readonly [Name in SigningEventName]: (payload: Record<string, unknown>) => boolean;
} = {
  ready: (p) => typeof p.document_id === "string" && typeof p.signer_id === "string",
  signed: (p) => VALIDATORS.ready(p) && typeof p.via === "string",
  declined: (p) => VALIDATORS.signed(p),
  resize: (p) => Number.isFinite(p.height),
  // Tolerate a missing message: until 2026-11-11 the live frame sent origin_not_allowed without one.
  error: (p) => typeof p.code === "string" && (p.message === undefined || typeof p.message === "string"),
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseMessage(value: unknown): ParsedMessage | null {
  if (!isObject(value) || value.v !== 1 || typeof value.type !== "string" || !isObject(value.payload)) {
    return null;
  }

  const name = value.type.startsWith("assinafy:") ? value.type.slice("assinafy:".length) : "";
  if (!Object.hasOwn(VALIDATORS, name) || !VALIDATORS[name as SigningEventName](value.payload)) {
    return null;
  }

  const payload = name === "error" ? { ...value.payload, message: value.payload.message ?? "" } : value.payload;
  return { name, payload } as ParsedMessage;
}

class SigningClient implements Signing {
  readonly #sessionUrl: string;
  readonly #origin: string;
  readonly #handlers: Record<
    SigningEventName,
    Set<(payload: unknown) => void>
  > = {
    ready: new Set(),
    signed: new Set(),
    declined: new Set(),
    resize: new Set(),
    error: new Set(),
  };

  readonly #delivered = new Set<string>();
  #destroyed = false;
  #frameFailed = false;
  #frame: HTMLIFrameElement | null = null;
  #hostWindow: Window | null = null;
  #helloTimer: number | null = null;

  constructor(options: CreateOptions) {
    let url: URL | undefined;
    try {
      url = new URL(options.sessionUrl);
    } catch {
      // Unparseable input falls through to the single error below.
    }

    if (
      typeof options?.sessionUrl !== "string" ||
      !url ||
      url.protocol !== "https:" ||
      url.username ||
      url.password
    ) {
      throw new TypeError("sessionUrl must be an absolute HTTPS URL without credentials.");
    }

    this.#sessionUrl = url.href;
    this.#origin = url.origin;
  }

  on<Name extends SigningEventName>(
    event: Name,
    handler: (payload: SigningEventPayloads[Name]) => void,
  ): void {
    if (this.#destroyed) throw new Error("This signing instance has been destroyed.");
    if (!Object.hasOwn(this.#handlers, event)) throw new TypeError(`Unsupported event "${event}".`);
    if (typeof handler !== "function") throw new TypeError("handler must be a function.");
    this.#handlers[event].add(handler as (payload: unknown) => void);
  }

  mount(target: string | HTMLElement): void {
    if (this.#destroyed) throw new Error("This signing instance has been destroyed.");
    if (this.#frame) throw new Error("This signing instance is already mounted.");

    const documentRef =
      typeof target === "string"
        ? globalThis.document
        : target?.ownerDocument;
    if (!documentRef) throw new Error("mount() requires a browser document.");

    const container =
      typeof target === "string"
        ? documentRef.querySelector<HTMLElement>(target)
        : target;
    if (!container) throw new Error(`No element matches "${target}".`);

    const hostWindow = documentRef.defaultView;
    if (!hostWindow) throw new Error("The target is not attached to a browser window.");

    const frame = documentRef.createElement("iframe");
    frame.src = this.#sessionUrl;
    frame.title = "Assinafy signing";
    frame.allow = "clipboard-write; fullscreen";
    frame.style.border = "0";
    frame.style.display = "block";
    frame.style.height = "600px";
    frame.style.width = "100%";

    frame.addEventListener("load", this.#startHello);
    hostWindow.addEventListener("message", this.#onMessage);
    this.#frame = frame;
    this.#hostWindow = hostWindow;
    container.appendChild(frame);
  }

  destroy(): void {
    if (this.#destroyed) return;

    this.#stopHello();
    this.#hostWindow?.removeEventListener("message", this.#onMessage);
    this.#frame?.removeEventListener("load", this.#startHello);
    this.#frame?.remove();
    this.#frame = null;
    this.#hostWindow = null;
    for (const handlers of Object.values(this.#handlers)) handlers.clear();
    this.#destroyed = true;
  }

  readonly #startHello = (): void => {
    // Frame errors are terminal and can arrive before load: nothing would answer a hello.
    if (this.#destroyed || this.#frameFailed) return;

    this.#stopHello();
    let attempts = 0;

    // Hello every 500 ms for 10 s, as documented; give up at 12.5 s so the frame's own
    // 10 s origin check (origin_not_allowed) arrives before handshake_timeout.
    const hello = (): void => {
      attempts += 1;
      if (attempts <= 20) {
        this.#frame?.contentWindow?.postMessage(
          { v: 1, type: "assinafy:hello" },
          this.#origin,
        );
      } else if (attempts > 25) {
        this.#stopHello();
        this.#emit("error", {
          code: "handshake_timeout",
          message: "Assinafy signing iframe did not become ready.",
        });
      }
    };

    hello();
    this.#helloTimer = this.#hostWindow!.setInterval(hello, 500);
  };

  readonly #stopHello = (): void => {
    if (this.#helloTimer !== null) {
      this.#hostWindow!.clearInterval(this.#helloTimer);
      this.#helloTimer = null;
    }
  };

  readonly #onMessage = (event: MessageEvent): void => {
    if (event.origin !== this.#origin) return;
    if (event.source !== this.#frame?.contentWindow) return;

    const message = parseMessage(event.data);
    if (!message) return;

    // Any valid reply proves the frame is listening.
    this.#stopHello();
    if (message.name === "error") this.#frameFailed = true;

    if (message.name === "resize" && this.#frame) {
      this.#frame.style.height = `${Math.max(message.payload.height, 200)}px`;
    }

    // signed/declined may repeat: deliver each outcome once per document.
    if (message.name === "signed" || message.name === "declined") {
      const key = `${message.name}:${message.payload.document_id}`;
      if (this.#delivered.has(key)) return;
      this.#delivered.add(key);
    }

    this.#emit(message.name, message.payload);
  };

  readonly #emit = <Name extends SigningEventName>(
    name: Name,
    payload: SigningEventPayloads[Name],
  ): void => {
    // Snapshot so a handler calling destroy() or on() can't change who hears this
    // event, and isolate errors so one failing handler can't swallow it for the rest.
    for (const handler of [...this.#handlers[name]]) {
      try {
        handler(payload);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  };
}

export function create(options: CreateOptions): Signing {
  return new SigningClient(options);
}
