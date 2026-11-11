// Opens EV's own page in a headless browser, for the few behaviours that only
// exist on screen. Checks that use it are skipped where no browser is installed.
import { createRequire } from "node:module";

export async function openPage(ev, { conversation = "main", skip, viewport = { width: 900, height: 640 } } = {}) {
  let chromium;
  try { ({ chromium } = createRequire(import.meta.url)("playwright")); }
  catch { skip("Playwright is not installed, so there is no browser to look at the page with"); }
  let browser;
  try { browser = await chromium.launch(); }
  catch (error) { skip(`The browser could not start: ${error.message.split("\n")[0]}`); }
  const page = await browser.newPage({ viewport });
  await page.goto(`${ev.baseUrl}/?conversation=${encodeURIComponent(conversation)}`);
  return {
    page,
    /** True when the element showing this text is fully inside the visible part of the page. */
    async inView(text) {
      const element = page.getByText(text, { exact: false }).last();
      await element.waitFor({ state: "attached", timeout: 8_000 });
      return element.evaluate((node) => { const box = node.getBoundingClientRect(); return box.height > 0 && box.top >= 0 && box.bottom <= window.innerHeight; });
    },
    close: () => browser.close()
  };
}
