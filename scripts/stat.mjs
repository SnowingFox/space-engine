// Measure frame rate in a given situation. Usage: node scripts/stat.mjs "<js to set up>" [deviceScaleFactor]
import puppeteer from 'puppeteer-core';

const [script = '', scale = '1'] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: Number(scale) },
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push(e.message));
await page.goto(process.env.URL ?? 'http://localhost:5173/', { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 1500));
if (script) await page.evaluate(script);
await new Promise((r) => setTimeout(r, 2500));
const frames = await page.evaluate(() => new Promise((resolve) => {
  let n = 0;
  const t0 = performance.now();
  const tick = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(tick); else resolve(n / 3); };
  requestAnimationFrame(tick);
}));
console.log('fps', frames.toFixed(1), JSON.stringify(await page.evaluate('se.stats()')));
if (logs.length) console.log(logs.slice(0, 10).join('\n'));
await browser.close();
