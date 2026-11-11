import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { chromium } from "playwright";

const PARENT_ORIGIN = "http://parent.assinafy.test";
const FRAME_ORIGIN = "https://frame.assinafy.test";

test("the built CDN SDK works across a real cross-origin iframe", { timeout: 30_000 }, async (t) => {
  const bundle = await readFile(new URL("../dist/index.global.js", import.meta.url), "utf8");
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === `${PARENT_ORIGIN}/`) {
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html>
          <div id="signing"></div>
          <script src="/index.global.js"></script>
          <script>
            window.events = [];
            window.signing = Assinafy.create({ sessionUrl: "${FRAME_ORIGIN}/embed/token" });
            for (const name of ["ready", "resize", "signed", "declined", "error"]) {
              signing.on(name, (payload) => events.push({ name, payload }));
            }
            signing.mount("#signing");
          </script>`,
      });
      return;
    }
    if (url === `${PARENT_ORIGIN}/index.global.js`) {
      await route.fulfill({ contentType: "application/javascript", body: bundle });
      return;
    }
    if (url === `${FRAME_ORIGIN}/embed/token`) {
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><script>
          addEventListener("message", ({ data }) => {
            if (data?.v !== 1 || data?.type !== "assinafy:hello") return;
            const send = (type, payload) => parent.postMessage({ v: 1, type, payload }, "${PARENT_ORIGIN}");
            send("assinafy:ready", { document_id: "document-id", signer_id: "signer-id" });
            send("assinafy:resize", { height: 684 });
            send("assinafy:signed", { document_id: "document-id", signer_id: "signer-id", via: "embed" });
          });
        </script>`,
      });
      return;
    }
    await route.fulfill({ status: 404, body: "not found" });
  });

  await page.goto(`${PARENT_ORIGIN}/`);
  await page.waitForFunction(() => window.events.some(({ name }) => name === "signed"));

  const result = await page.evaluate(() => ({
    events: window.events,
    iframeHeight: document.querySelector("iframe")?.style.height,
  }));
  assert.deepEqual(result.events.map(({ name }) => name), ["ready", "resize", "signed"]);
  assert.equal(result.iframeHeight, "684px");

  await page.evaluate(() => window.signing.destroy());
  assert.equal(await page.locator("iframe").count(), 0);
  assert.deepEqual(pageErrors, []);
});
