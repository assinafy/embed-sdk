import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { create } from "../dist/index.js";

function browserFixture() {
  const windowListeners = new Map();
  const intervals = new Map();
  let nextInterval = 1;

  const hostWindow = {
    addEventListener(name, handler) {
      windowListeners.set(name, handler);
    },
    removeEventListener(name, handler) {
      if (windowListeners.get(name) === handler) windowListeners.delete(name);
    },
    setInterval(handler) {
      const id = nextInterval++;
      intervals.set(id, handler);
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
  };

  const frameListeners = new Map();
  let loadHandler;
  const posted = [];
  const contentWindow = {
    postMessage(message, origin) {
      posted.push({ message, origin });
    },
  };
  const frame = {
    allow: "",
    contentWindow,
    removed: false,
    src: "",
    style: {},
    title: "",
    addEventListener(name, handler) {
      frameListeners.set(name, handler);
      if (name === "load") loadHandler = handler;
    },
    removeEventListener(name, handler) {
      if (frameListeners.get(name) === handler) frameListeners.delete(name);
    },
    remove() {
      this.removed = true;
    },
  };

  const container = {
    child: null,
    ownerDocument: null,
    appendChild(child) {
      this.child = child;
    },
  };
  const document = {
    defaultView: hostWindow,
    createElement(name) {
      assert.equal(name, "iframe");
      return frame;
    },
    querySelector(selector) {
      return selector === "#signing-container" ? container : null;
    },
  };
  container.ownerDocument = document;

  return {
    container,
    contentWindow,
    dispatchMessage(event) {
      windowListeners.get("message")?.(event);
    },
    document,
    emitLoad() {
      frameListeners.get("load")?.();
    },
    frame,
    intervals,
    loadHandler() {
      return loadHandler;
    },
    posted,
    windowListeners,
  };
}

const SESSION_URL = "https://app.assinafy.com.br/embed/session-token";
const SESSION_ORIGIN = "https://app.assinafy.com.br";

function messageEvent(fixture, data, overrides = {}) {
  return {
    data,
    origin: SESSION_ORIGIN,
    source: fixture.contentWindow,
    ...overrides,
  };
}

test("mounts the iframe and completes the documented handshake", () => {
  const fixture = browserFixture();
  const originalDocument = globalThis.document;
  globalThis.document = fixture.document;

  try {
    const signing = create({ sessionUrl: SESSION_URL });
    const ready = [];
    signing.on("ready", (payload) => ready.push(payload));
    signing.mount("#signing-container");

    assert.equal(fixture.container.child, fixture.frame);
    assert.equal(fixture.frame.src, SESSION_URL);
    assert.equal(fixture.frame.title, "Assinafy signing");
    assert.equal(fixture.frame.allow, "clipboard-write; fullscreen");
    assert.deepEqual(fixture.frame.style, {
      border: "0",
      display: "block",
      height: "600px",
      width: "100%",
    });

    fixture.emitLoad();
    assert.deepEqual(fixture.posted, [
      {
        message: { v: 1, type: "assinafy:hello" },
        origin: SESSION_ORIGIN,
      },
    ]);
    assert.equal(fixture.intervals.size, 1);

    const payload = { document_id: "document-id", signer_id: "signer-id" };
    fixture.dispatchMessage(messageEvent(fixture, {
      v: 1,
      type: "assinafy:ready",
      payload,
    }));

    assert.deepEqual(ready, [payload]);
    assert.equal(fixture.intervals.size, 0);

    signing.destroy();
    assert.equal(fixture.frame.removed, true);
    assert.equal(fixture.windowListeners.size, 0);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("sends 20 hellos, then times out only after the frame's own 10 s origin check", () => {
  const fixture = browserFixture();
  const signing = create({ sessionUrl: SESSION_URL });
  const errors = [];
  signing.on("error", (payload) => errors.push(payload));
  signing.mount(fixture.container);
  fixture.emitLoad();

  const tick = [...fixture.intervals.values()][0];
  for (let attempt = 2; attempt <= 25; attempt += 1) tick();
  assert.equal(fixture.posted.length, 20);
  assert.deepEqual(errors, []);

  tick(); // 12.5 s after load
  assert.equal(fixture.intervals.size, 0);
  assert.deepEqual(errors, [{
    code: "handshake_timeout",
    message: "Assinafy signing iframe did not become ready.",
  }]);
  signing.destroy();
});

test("accepts messages only from the mounted iframe and emits each outcome once per document", () => {
  const fixture = browserFixture();
  const signing = create({ sessionUrl: SESSION_URL });
  const signed = [];
  const declined = [];
  signing.on("signed", (payload) => signed.push(payload));
  signing.on("declined", (payload) => declined.push(payload));
  signing.mount(fixture.container);

  const payload = {
    document_id: "document-id",
    signer_id: "signer-id",
    via: "embed",
  };
  const message = { v: 1, type: "assinafy:signed", payload };
  fixture.dispatchMessage(messageEvent(fixture, message, { origin: "https://attacker.example" }));
  fixture.dispatchMessage(messageEvent(fixture, message, { source: {} }));
  fixture.dispatchMessage(messageEvent(fixture, message));
  fixture.dispatchMessage(messageEvent(fixture, message));
  const otherDocument = { ...payload, document_id: "other-document-id" };
  fixture.dispatchMessage(messageEvent(fixture, { v: 1, type: "assinafy:signed", payload: otherDocument }));
  const declinedByOther = { ...payload, via: "external" };
  fixture.dispatchMessage(messageEvent(fixture, { v: 1, type: "assinafy:declined", payload: declinedByOther }));
  fixture.dispatchMessage(messageEvent(fixture, { v: 1, type: "assinafy:declined", payload: declinedByOther }));

  assert.deepEqual(signed, [payload, otherDocument]);
  assert.deepEqual(declined, [declinedByOther]);
  signing.destroy();
});

test("accepts the live frame's origin_not_allowed, which has no message", () => {
  const fixture = browserFixture();
  const signing = create({ sessionUrl: SESSION_URL });
  const errors = [];
  signing.on("error", (payload) => errors.push(payload));
  signing.mount(fixture.container);
  fixture.emitLoad();

  fixture.dispatchMessage(messageEvent(fixture, {
    v: 1,
    type: "assinafy:error",
    payload: { code: "origin_not_allowed" },
  }));

  assert.deepEqual(errors, [{ code: "origin_not_allowed", message: "" }]);
  assert.equal(fixture.intervals.size, 0);
  signing.destroy();
});

test("a frame error before iframe load suppresses the handshake and its timeout", () => {
  const fixture = browserFixture();
  const signing = create({ sessionUrl: SESSION_URL });
  const errors = [];
  signing.on("error", (payload) => errors.push(payload));
  signing.mount(fixture.container);

  // The live frame posts session_expired before its load event fires.
  const expired = { code: "session_expired", message: "Session expired." };
  fixture.dispatchMessage(messageEvent(fixture, { v: 1, type: "assinafy:error", payload: expired }));
  fixture.emitLoad();

  assert.deepEqual(fixture.posted, []);
  assert.equal(fixture.intervals.size, 0);
  assert.deepEqual(errors, [expired]);
  signing.destroy();
});

test("any valid frame message stops the hello", () => {
  const fixture = browserFixture();
  const signing = create({ sessionUrl: SESSION_URL });
  signing.mount(fixture.container);
  fixture.emitLoad();

  fixture.dispatchMessage(messageEvent(fixture, {
    v: 1,
    type: "assinafy:resize",
    payload: { height: 300 },
  }));

  assert.equal(fixture.intervals.size, 0);
  signing.destroy();
});

test("emits frame errors and follows finite resize messages", () => {
  const fixture = browserFixture();
  const signing = create({ sessionUrl: SESSION_URL });
  const errors = [];
  const resizes = [];
  signing.on("error", (payload) => errors.push(payload));
  signing.on("resize", (payload) => resizes.push(payload));
  signing.mount(fixture.container);
  fixture.emitLoad();

  const error = { code: "session_expired", message: "Session expired." };
  fixture.dispatchMessage(messageEvent(fixture, {
    v: 1,
    type: "assinafy:error",
    payload: error,
  }));
  assert.deepEqual(errors, [error]);
  assert.equal(fixture.intervals.size, 0);

  fixture.dispatchMessage(messageEvent(fixture, {
    v: 1,
    type: "assinafy:resize",
    payload: { height: 5_000 },
  }));
  assert.equal(fixture.frame.style.height, "5000px");
  fixture.dispatchMessage(messageEvent(fixture, {
    v: 1,
    type: "assinafy:resize",
    payload: { height: 100 },
  }));
  assert.equal(fixture.frame.style.height, "200px");
  assert.deepEqual(resizes, [{ height: 5_000 }, { height: 100 }]);
  signing.destroy();
});

test("rejects malformed and unsupported frame messages", () => {
  const fixture = browserFixture();
  const signing = create({ sessionUrl: SESSION_URL });
  const received = [];
  for (const event of ["ready", "signed", "declined", "resize", "error"]) {
    signing.on(event, (payload) => received.push(payload));
  }
  signing.mount(fixture.container);

  for (const data of [
    null,
    [],
    { v: 2, type: "assinafy:ready", payload: {} },
    { v: 1, type: "other:ready", payload: {} },
    { v: 1, type: "assinafy:unknown", payload: {} },
    { v: 1, type: "assinafy:ready" },
    { v: 1, type: "assinafy:ready", payload: { document_id: 1, signer_id: "s" } },
    { v: 1, type: "assinafy:signed", payload: { document_id: "d", signer_id: "s" } },
    { v: 1, type: "assinafy:declined", payload: { document_id: "d", via: "embed" } },
    { v: 1, type: "assinafy:resize", payload: { height: Number.NaN } },
    { v: 1, type: "assinafy:error", payload: { message: "no code" } },
    { v: 1, type: "assinafy:error", payload: { code: "session_expired", message: 1 } },
  ]) {
    fixture.dispatchMessage(messageEvent(fixture, data));
  }

  assert.deepEqual(received, []);
  signing.destroy();
});

test("validates public inputs and mount lifecycle", () => {
  const invalidUrl = /sessionUrl must be an absolute HTTPS URL without credentials/;
  assert.throws(() => create(), invalidUrl);
  for (const sessionUrl of [
    undefined,
    new URL(SESSION_URL),
    "not a URL",
    "/embed/token",
    "http://app.assinafy.com.br/embed/token",
    "https://user:password@app.assinafy.com.br/embed/token",
  ]) {
    assert.throws(() => create({ sessionUrl }), invalidUrl, String(sessionUrl));
  }
  create({ sessionUrl: "https://stage-main.assinafy-app.pages.dev/embed/token" }).destroy();
  create({ sessionUrl: "https://app-sandbox.assinafy.com.br/embed/token" }).destroy();
  create({ sessionUrl: "https://APP.assinafy.com.br:443/embed/token" }).destroy();
  create({ sessionUrl: "https://app.assinafy.com.br:8443/embed/token" }).destroy();

  const signing = create({ sessionUrl: SESSION_URL });
  assert.throws(() => signing.on("unknown", () => {}), /Unsupported event/);
  assert.throws(() => signing.on("signed", null), /handler must be a function/);
  assert.throws(() => signing.mount(null), /browser document/);
  assert.throws(() => signing.mount("#signing-container"), /browser document/);

  const fixture = browserFixture();
  const originalDocument = globalThis.document;
  globalThis.document = fixture.document;
  try {
    assert.throws(() => signing.mount("#missing"), /No element matches/);
    signing.mount(fixture.container);
    assert.throws(() => signing.mount(fixture.container), /already mounted/);
    signing.destroy();
    signing.destroy();
    assert.throws(() => signing.on("signed", () => {}), /destroyed/);
    assert.throws(() => signing.mount(fixture.container), /destroyed/);
  } finally {
    globalThis.document = originalDocument;
  }

  const detached = browserFixture();
  detached.document.defaultView = null;
  const detachedSigning = create({ sessionUrl: SESSION_URL });
  assert.throws(() => detachedSigning.mount(detached.container), /not attached/);
  detachedSigning.destroy();
});

test("the CDN bundle exposes Assinafy.create", async () => {
  const source = await readFile(new URL("../dist/index.global.js", import.meta.url), "utf8");
  const context = vm.createContext({ URL });
  vm.runInContext(source, context);
  assert.deepEqual(Object.keys(context.Assinafy), ["create"]);
  assert.equal(typeof context.Assinafy.create, "function");
});

test("every handler sees the terminal event even if one destroys or throws", () => {
  const fixture = browserFixture();
  const signing = create({ sessionUrl: SESSION_URL });
  const calls = [];
  signing.on("signed", () => {
    calls.push("app");
    signing.destroy();
  });
  signing.on("signed", () => {
    calls.push("analytics");
    throw new Error("boom");
  });
  signing.on("signed", () => calls.push("audit"));
  signing.mount(fixture.container);

  const rethrown = [];
  const originalQueueMicrotask = globalThis.queueMicrotask;
  globalThis.queueMicrotask = (task) => {
    try {
      task();
    } catch (error) {
      rethrown.push(error.message);
    }
  };
  try {
    fixture.dispatchMessage(messageEvent(fixture, {
      v: 1,
      type: "assinafy:signed",
      payload: { document_id: "d", signer_id: "s", via: "embed" },
    }));
  } finally {
    globalThis.queueMicrotask = originalQueueMicrotask;
  }

  assert.deepEqual(calls, ["app", "analytics", "audit"]);
  assert.deepEqual(rethrown, ["boom"]);
});

test("a second iframe load restarts the handshake without leaking an interval", () => {
  const fixture = browserFixture();
  const signing = create({ sessionUrl: SESSION_URL });
  signing.mount(fixture.container);
  fixture.emitLoad();
  fixture.emitLoad();
  assert.equal(fixture.intervals.size, 1);
  signing.destroy();
  assert.equal(fixture.intervals.size, 0);
});

test("destroy before iframe load detaches the pending load handler", () => {
  const fixture = browserFixture();
  const signing = create({ sessionUrl: SESSION_URL });
  signing.mount(fixture.container);
  const queuedLoad = fixture.loadHandler();
  signing.destroy();

  assert.doesNotThrow(() => fixture.emitLoad());
  assert.doesNotThrow(() => queuedLoad());
  assert.equal(fixture.intervals.size, 0);
});

test("both README CDN snippets pin this version with a matching SRI hash", async () => {
  const [packageJson, bundle, ...readmes] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../dist/index.global.js", import.meta.url)),
    ...["README.md", "README.en.md"].map((name) => readFile(new URL(`../${name}`, import.meta.url), "utf8")),
  ]);
  const { version } = JSON.parse(packageJson);
  const integrity = `sha384-${createHash("sha384").update(bundle).digest("base64")}`;

  for (const readme of readmes) {
    assert.ok(
      readme.includes(`npm/@assinafy/embed-sdk@${version}/dist/index.global.js"`),
      `README CDN snippet must load @assinafy/embed-sdk@${version}`,
    );
    assert.ok(readme.includes(`integrity="${integrity}"`), `README CDN snippet needs integrity="${integrity}"`);
  }
});
