// Evaluate in the running app with the black-hole placement helpers loaded: node scripts/bhq.mjs "<setup js>" "<result js>" [wait ms]
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
const place = readFileSync(new URL('./bhplace.js', import.meta.url), 'utf8');
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 400)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 400)));
await page.goto('http://localhost:5173/', { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 2500));
await page.evaluate(place);
await page.evaluate(process.argv[2]);
await new Promise((r) => setTimeout(r, Number(process.argv[4] ?? 1500)));
console.log(await page.evaluate(process.argv[3]));
await browser.close();
