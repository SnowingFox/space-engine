// Screenshots of the sky without the HUD: node scripts/gshot.mjs <name> <js setting up the view> [wait ms]
// In the script, `at(x, y, z)` puts the camera at a universe position (ly) and `look(x, y, z)` aims it along a direction.
import puppeteer from 'puppeteer-core';

const [name = 'gshot', script = '', wait = '5000'] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1440,900'],
  defaultViewport: { width: Number(process.env.W ?? 1440), height: Number(process.env.H ?? 900), deviceScaleFactor: Number(process.env.DPR ?? 1) },
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(process.env.URL ?? 'http://localhost:5173/', { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 1500));
const out = await page.evaluate(`(() => {
  const p = se.player;
  const LY = 9.4607e12;
  const at = (x, y, z) => { const g = { x: 0, y: 0, z: 0 }; p.galactic(g); p.local.x += (x - g.x) * LY; p.local.y += (y - g.y) * LY; p.local.z += (z - g.z) * LY; };
  const look = (x, y, z) => { const l = Math.hypot(x, y, z); const f = p.local.clone().set(x / l, y / l, z / l); p.quat.setFromUnitVectors(p.local.clone().set(0, 0, -1), f); };
  if (${JSON.stringify(process.env.HUD ?? '')} === '') document.querySelectorAll('body > *:not(canvas)').forEach((e) => { e.style.display = 'none'; });
  ${script};
  return 1;
})()`);
await new Promise((r) => setTimeout(r, Number(wait)));
const stats = await page.evaluate('JSON.stringify({ ...se.stats(), exposure: se.pipeline.exposure, ratio: se.pipeline.pixelRatio, state: se.state().anchor })');
await page.screenshot({ path: `shots/${name}.png` });
console.log(name, stats, logs.slice(0, 12).join('\n'));
await browser.close();
