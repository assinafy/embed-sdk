// Drives a real embedded Bypass signing through the SDK, then reloads the frame on the done screen.
// Signs the fixture's document for real; run setup.py for a fresh fixture first.
// Docs: signed {via: "embed"}; after the done-screen reload, signed again; minting afterwards → 409 already_signed.
// Usage: npm run build && node live-test/sign.mjs
import { chromium } from "playwright";
import { dir, mint, runCase, mask } from "./matrix.mjs";

const LABELS = /^(confirmar dados|ver documento|adotar e assinar|concluir|assinar( documento)?|assinar e finalizar|finalizar|concordo|aceitar|continuar|próximo|confirmar|enviar)$/i;
const browser = await chromium.launch({ headless: true });
const s = await mint();
console.log("mint:", s.status, s.code ?? "");

const result = await runCase(browser, {
  name: "sign", parentOrigin: "http://localhost:5174", sessionUrl: s.url,
  act: async (page) => {
    await page.waitForFunction(() => events.some(([, n]) => n === "ready"), null, { timeout: 15000 });
    const frame = () => page.frames().find((f) => f !== page.mainFrame());
    for (let step = 1; step <= 12; step++) {
      await page.waitForTimeout(2500);
      if (await page.evaluate(() => events.some(([, n]) => n === "signed" || n === "declined"))) break;
      const f = frame();
      for (const cb of await f.locator('input[type=checkbox]:not(:checked), [role=checkbox][aria-checked=false]').all()) await cb.check({ force: true }).catch(() => cb.click({ force: true }).catch(() => {}));
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${dir}/sign-step-${step}.png` });
      const clickables = await f.locator("button:visible, a:visible, [role=button]:visible").all();
      const texts = await Promise.all(clickables.map((c) => c.innerText().then((t) => t.trim()).catch(() => "")));
      console.log(`step ${step} path=${mask(new URL(f.url()).pathname)} clickables=${JSON.stringify(texts.filter(Boolean))}`);
      if (f.url().endsWith("/sign-document") && !globalThis.drawn) {
        const box = await f.locator("canvas:visible").first().boundingBox();
        await page.mouse.move(box.x + 40, box.y + box.height * 0.6);
        await page.mouse.down();
        for (let k = 1; k <= 20; k++) await page.mouse.move(box.x + 40 + k * 12, box.y + box.height * (0.6 - 0.25 * Math.sin(k / 3)));
        await page.mouse.up();
        globalThis.drawn = true;
        console.log("  drew signature stroke");
      }
      const i = texts.findIndex((t) => LABELS.test(t));
      if (i < 0) { console.log("no known action; stopping"); break; }
      console.log(`  click "${texts[i]}"`);
      await clickables[i].click();
    }
    // Reload the frame on the done screen: docs say signed may be re-delivered.
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${dir}/sign-done.png` });
    await page.evaluate(() => events.push(["--- frame reload ---"]));
    await frame().evaluate(() => location.reload());
    await page.waitForTimeout(13000);
  },
});
console.log(JSON.stringify({ events: result.events, raw: result.raw.map(([t, o, src, d]) => [t, o, src, d]) }, null, 1));
const after = await mint();
console.log("mint after signing:", after.status, after.code ?? "", after.message ?? "");
await browser.close();
