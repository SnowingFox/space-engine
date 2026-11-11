// Drive the running dev server in headless Chrome and save screenshots.
// Usage: node scripts/shot.mjs <name> [js to eval before the shot] [wait ms]
import puppeteer from 'puppeteer-core';

const [name = 'shot', script = '', wait = '2500'] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1440,900'],
  defaultViewport: { width: Number(process.env.W ?? 1440), height: Number(process.env.H ?? 900), deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(process.env.URL ?? 'http://localhost:5173/', { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 1500));
await page.evaluate(() => document.querySelector('.intro')?.classList.add('gone'));
if (script) {
  const out = await page.evaluate(script);
  if (out !== undefined) console.log('eval →', JSON.stringify(out));
}
await new Promise((r) => setTimeout(r, Number(wait)));
await page.screenshot({ path: `shots/${name}.png` });
console.log(logs.slice(0, 40).join('\n'));
await browser.close();
