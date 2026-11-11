// Screenshots of the render-only bench page: node scripts/benchshot.mjs <name> "<query>" [waitMs]
// e.g. node scripts/benchshot.mjs desert20 "seed=236488&body=0&alt=0.02&sun=0.7&pitch=-1.5" 6000
import puppeteer from 'puppeteer-core';

const [name = 'bench', query = '', wait = '6000'] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  defaultViewport: { width: Number(process.env.W ?? 2000), height: Number(process.env.H ?? 1144), deviceScaleFactor: Number(process.env.DPR ?? 2) },
});
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
await page.goto(`${process.env.BASE ?? 'http://localhost:5173'}/bench.html?${query}`, { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, Number(wait)));
if (process.env.LOCK) await page.evaluate('(() => { const p = se.pipeline; p.resScale = 1; p.resCheck = Infinity; p.applyScale(); })()');
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: `shots/${name}.png` });
console.log(name, await page.evaluate('JSON.stringify(se.stats())'), errors.slice(0, 3).join(' | '));
await browser.close();
