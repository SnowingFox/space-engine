// Batch bench.html runs in one browser. Usage: [SCALE=2] [FPS=1] [WAIT=3000] node scripts/bset.mjs name=query ...
import puppeteer from 'puppeteer-core';

const scale = Number(process.env.SCALE ?? 1);
const wait = Number(process.env.WAIT ?? 3000);
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: scale },
});
for (const arg of process.argv.slice(2)) {
  const i = arg.indexOf('=');
  const name = arg.slice(0, i), query = arg.slice(i + 1);
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text().slice(0, 600)); });
  page.on('pageerror', (e) => logs.push(e.message));
  try {
    await page.goto(`http://localhost:5173/bench.html?${query}`, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, wait));
    let fps = '';
    if (process.env.FPS) {
      const f = await page.evaluate(() => new Promise((resolve) => {
        let n = 0;
        const t0 = performance.now();
        const tick = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(tick); else resolve(n / 3); };
        requestAnimationFrame(tick);
      }));
      fps = `fps ${f.toFixed(1)} `;
    } else if (process.env.COST) {
      const a = await page.evaluate('se.cost(60)'), b = await page.evaluate('se.cost(60)');
      fps = `ms ${Math.min(a, b).toFixed(2)} `;
    } else {
      await page.screenshot({ path: `shots/${name}.png` });
    }
    console.log(name, fps + JSON.stringify(await page.evaluate('se.stats()')));
  } catch (e) {
    console.log(name, 'FAILED', e.message);
  }
  const shown = logs.filter((l) => !l.includes('404'));
  if (shown.length) console.log(shown.slice(0, 6).join('\n'));
  await page.close();
}
await browser.close();
