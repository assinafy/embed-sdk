// Checks whether third parties loaded by the embed page receive its URL, which carries the signer's
// access code. Uses a fake 64-char code; needs no credentials. Expected: carriesCode 0 for every host.
// Usage: node live-test/leak.mjs
import { chromium } from "playwright";
const FAKE = "FAKEcode" + "x".repeat(56); // 64 chars, not a real access code
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const hits = [];
page.on("request", (r) => { const u = r.url(); if (!/assinafy\.com\.br/.test(new URL(u).host)) hits.push({ host: new URL(u).host, carriesCode: u.includes(FAKE) || (r.postData() ?? "").includes(FAKE), referer: (r.headers().referer ?? "").includes(FAKE) }); });
await page.route("http://localhost:5174/**", (route) => route.fulfill({ contentType: "text/html", body: `<iframe src="https://app.assinafy.com.br/embed/sign/${FAKE}/confirm-data/${"0".repeat(28)}" style="width:900px;height:700px"></iframe>` }));
await page.goto("http://localhost:5174/");
await page.waitForTimeout(12000);
const agg = {};
for (const h of hits) { const k = h.host; agg[k] ??= { requests: 0, carriesCode: 0, refererHasCode: 0 }; agg[k].requests++; agg[k].carriesCode += h.carriesCode; agg[k].refererHasCode += h.referer; }
console.log(JSON.stringify(agg, null, 1));
await browser.close();
