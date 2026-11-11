// Live handshake and error-path matrix against the real Assinafy frame, using the built SDK.
// Needs ASSINAFY_API_KEY and ASSINAFY_ACCOUNT_ID (optional ASSINAFY_BASE_URL) and a fixture from setup.py.
// Never prints the API key or tokens. Usage: npm run build && node live-test/matrix.mjs
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

export const dir = new URL(".", import.meta.url).pathname;
const env = {
  ASSINAFY_API_KEY: process.env.ASSINAFY_API_KEY,
  BASE: process.env.ASSINAFY_BASE_URL ?? "https://api.assinafy.com.br/v1",
};
if (!env.ASSINAFY_API_KEY) throw new Error("Set ASSINAFY_API_KEY.");
const st = JSON.parse(readFileSync(`${dir}/state.json`, "utf8"));
const sdk = readFileSync(new URL("../dist/index.global.js", import.meta.url), "utf8");
export const mask = (s) => String(s).replace(/[A-Za-z0-9_-]{40,}/g, (t) => `<${t.length}ch>`);

export async function mint() {
  const r = await fetch(`${env.BASE}/documents/${st.document_id}/assignments/${st.assignment_id}/signers/${st.signer_id}/embed-sessions`,
    { method: "POST", headers: { "X-Api-Key": env.ASSINAFY_API_KEY, Accept: "application/json", "User-Agent": "embed-sdk-live-test/0.1" } });
  const body = await r.json();
  return { status: r.status, url: body.data?.url, code: body.code, message: body.message };
}

export async function runCase(browser, { name, parentOrigin, sessionUrl, waitMs = 16000, act }) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const failed = [];
  page.on("requestfailed", (r) => failed.push(`${r.failure()?.errorText} ${mask(r.url())}`));
  await page.route(`${parentOrigin}/**`, (route) => route.request().url().endsWith("/sdk.js")
    ? route.fulfill({ contentType: "application/javascript", body: sdk })
    : route.fulfill({ contentType: "text/html", body: `<!doctype html><div id="c"></div><script src="/sdk.js"></script><script>
        window.events=[]; window.raw=[]; const t0=performance.now(); const ts=()=>+((performance.now()-t0)/1000).toFixed(1);
        addEventListener("message", e => raw.push([ts(), e.origin, e.source===document.querySelector("iframe")?.contentWindow, JSON.stringify(e.data)]));
        window.s=Assinafy.create({sessionUrl:${JSON.stringify(sessionUrl)}});
        for (const n of ["ready","resize","signed","declined","error"]) s.on(n,p=>events.push([ts(),n,p]));
        s.mount("#c");</script>` }));
  await page.goto(`${parentOrigin}/`);
  if (act) await act(page);
  else await page.waitForTimeout(waitMs);
  await page.screenshot({ path: `${dir}/case-${name}.png` });
  const out = await page.evaluate(() => ({ events: window.events, raw: window.raw, height: document.querySelector("iframe")?.style.height }));
  await page.close();
  return { name, parentOrigin, ...JSON.parse(mask(JSON.stringify(out))), frameUrls: undefined, failed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await chromium.launch({ headless: true });
  const a = await mint(), b = await mint(), c = await mint();
  console.log("mints:", a.status, b.status, c.status);
  // Docs: registered → ready + resize, no error; reused URL → session_expired;
  // unregistered origin → origin_not_allowed {code, message}, no document data.
  const results = [await runCase(browser, { name: "registered", parentOrigin: "http://localhost:5174", sessionUrl: c.url })];
  results.push(...await Promise.all([
    runCase(browser, { name: "reused-url", parentOrigin: "http://localhost:5174", sessionUrl: c.url }),
    runCase(browser, { name: "unregistered-127", parentOrigin: "http://127.0.0.1:5174", sessionUrl: a.url }),
    runCase(browser, { name: "unregistered-https", parentOrigin: "https://not-registered.example", sessionUrl: b.url }),
  ]));
  for (const r of results) console.log(JSON.stringify(r, null, 1));
  await browser.close();
}
