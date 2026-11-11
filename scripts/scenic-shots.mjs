// Render the thumbnails of the scenic spots (src/game/scenic.ts) from the running dev server.
// Usage: node scripts/scenic-shots.mjs            every spot → public/scenic/<id>.jpg
//        node scripts/scenic-shots.mjs <id> ...   only these spots
//        POSE='{"kind":"body","star":"sol","planet":3,"alt":1,"sun":1.4,"az":0.4,"turn":3.14,"pitch":0}' \
//          node scripts/scenic-shots.mjs try      an ad-hoc pose → shots/try.jpg (for curating)
// Env: URL (default http://localhost:5173/), SETTLE (extra ms to wait once the view is stable, default 1500).
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const WIDTH = 960;
const HEIGHT = 540;
const url = process.env.URL ?? 'http://localhost:5173/';
const settle = Number(process.env.SETTLE ?? 1500);
const adhoc = process.env.POSE ? JSON.parse(process.env.POSE) : null;
const args = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', `--window-size=${WIDTH},${HEIGHT}`],
  defaultViewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 },
});

async function open() {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.se?.scenic, { timeout: 20000 });
  await sleep(800);
  return page;
}

/** Jump, hide every overlay, wait until the terrain has stopped refining, then save a JPEG. */
async function shoot(page, target, path) {
  const started = Date.now();
  // The dev server reloads the page whenever a source file is saved; if that happens
  // mid-wait the jump is lost, so check at the end and start over.
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.waitForFunction(() => window.se?.scenic, { timeout: 20000 });
    const ok = await page.evaluate((t) => {
      document.body.classList.add('ui-hidden');
      se.settings.orbits = false;
      se.hud.syncSettings(true);
      return se.scenic(t);
    }, target);
    if (!ok) throw new Error('no such spot or body');
    try {
      // Settled = the ground height has been applied and the terrain patch count has held still for a while.
      const from = Date.now();
      let last = -1;
      let stableSince = Date.now();
      while (Date.now() - from < 45000) {
        await sleep(250);
        const s = await page.evaluate(() => ({ settling: se.state().settling, patches: se.stats().patches }));
        if (s.settling || s.patches !== last) {
          last = s.patches;
          stableSince = Date.now();
        } else if (Date.now() - stableSince > 1200 && Date.now() - from > 2500) break;
      }
      await sleep(settle);
      if (await page.evaluate(() => document.body.classList.contains('ui-hidden'))) {
        await page.screenshot({ path, type: 'jpeg', quality: 88 });
        return Date.now() - started;
      }
    } catch {
      // Execution context destroyed by a reload: fall through and retry.
    }
    console.log('  page reloaded, retrying');
    await sleep(1500);
  }
  throw new Error('the page kept reloading');
}

if (adhoc) {
  mkdirSync('shots', { recursive: true });
  const page = await open();
  const path = `shots/${args[0] ?? 'pose'}.jpg`;
  const ms = await shoot(page, adhoc, path);
  console.log(`${path}  (${(ms / 1000).toFixed(1)} s)`);
} else {
  mkdirSync('public/scenic', { recursive: true });
  const probe = await open();
  const all = await probe.evaluate(() => se.scenicSpots.map((s) => s.id));
  await probe.close();
  const ids = args.length ? args : all;
  for (const id of ids) {
    if (!all.includes(id)) {
      console.log(`${id}: unknown spot (known: ${all.join(', ')})`);
      continue;
    }
    // A fresh page per spot, so no view depends on the one before it.
    const page = await open();
    try {
      const path = `public/scenic/${id}.jpg`;
      const ms = await shoot(page, id, path);
      console.log(`${path}  (${(ms / 1000).toFixed(1)} s)`);
    } catch (e) {
      console.log(`${id}: failed — ${e.message}`);
    }
    await page.close();
    // Vite reloads open pages when a file under public/ changes; let that pass before the next spot.
    await sleep(800);
  }
}
await browser.close();
