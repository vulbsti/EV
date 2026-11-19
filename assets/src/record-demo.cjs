// Records assets/demo.gif from the interface mockup (ev-interface.html with its ev.css):
//   node assets/src/record-demo.cjs path/to/ev-interface.html   (writes frames to ./fr)
//   then build the GIF from fr/ with ffmpeg (fps=10, scale=960, palettegen/paletteuse),
//   giving each frame the gap recorded in fr/times.txt.
const { chromium } = require('playwright');
const page = require('path').resolve(process.argv[2] || 'ev-interface.html');
(async()=>{
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
const p = await ctx.newPage();
await p.goto('file://' + page);
await p.waitForTimeout(1500);
await p.addStyleTag({ content: '#cur{position:fixed;z-index:99999;width:22px;height:22px;border-radius:50%;background:rgba(255,255,255,.85);box-shadow:0 0 0 3px rgba(0,0,0,.25);pointer-events:none;transform:translate(-50%,-50%);transition:left .7s ease,top .7s ease, transform .15s} #cur.down{transform:translate(-50%,-50%) scale(.7)}' });
await p.evaluate(() => { const c = document.createElement('div'); c.id = 'cur'; c.style.left = '900px'; c.style.top = '600px'; document.body.appendChild(c); });
async function click(sel) {
  const el = p.locator(sel).filter({ visible: true }).first();
  const bx = await el.boundingBox();
  await p.evaluate(([x, y]) => { const c = document.getElementById('cur'); c.style.left = x + 'px'; c.style.top = y + 'px'; }, [bx.x + bx.width / 2, bx.y + bx.height / 2]);
  await p.waitForTimeout(850);
  await p.evaluate(() => document.getElementById('cur').classList.add('down'));
  await p.waitForTimeout(150);
  await el.click();
  await p.evaluate(() => document.getElementById('cur').classList.remove('down'));
}
let n=0, on=true; const fs=require('fs'); fs.mkdirSync('fr',{recursive:true});
const loop=(async()=>{while(on){const t=Date.now(); await p.screenshot({path:`fr/${String(n++).padStart(4,'0')}.png`}); fs.appendFileSync('fr/times.txt', t+'\n');}})();
await p.waitForTimeout(1800);
await click('[data-set="live:open"]'); await p.waitForTimeout(2600);
await click('[data-set="live:out"]'); await p.waitForTimeout(2800);
await click('[data-set="sheet:you"]'); await p.waitForTimeout(2000);
await click('[data-set="why:s1|none"]'); await p.waitForTimeout(3200);
on=false; await loop;
await ctx.close(); await b.close();
})();
