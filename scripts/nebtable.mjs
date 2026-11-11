// Each catalogued nebula seen from Sol: angular size, and its peak brightness against the Milky Way's glow behind it,
// read from the linear background target with the nebulae on and off. node scripts/nebtable.mjs
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'], defaultViewport: { width: 1000, height: 700, deviceScaleFactor: 1 }, protocolTimeout: 600000 });
const page = await browser.newPage();
await page.goto(process.env.URL ?? 'http://localhost:5173/', { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 3000));
const rows = await page.evaluate(`(async () => {
  const p = se.player, LY = 9.4607e12, pl = se.pipeline, r = pl.renderer;
  document.querySelectorAll('body > *:not(canvas)').forEach((e) => { e.style.display = 'none'; });
  const g = { x: 0, y: 0, z: 0 }; p.galactic(g); p.local.x += (26000.8 - g.x) * LY; p.local.y += (18 - g.y) * LY; p.local.z += (900 - g.z) * LY;
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));
  const half = (v) => { const e = (v >> 10) & 31, m = v & 1023; return e === 0 ? m / 1024 * Math.pow(2, -14) : (1 + m / 1024) * Math.pow(2, e - 15); };
  const read = (R) => { const t = pl.bgTarget, B = Math.min(2 * R, t.height - 2) | 0, x0 = (t.width / 2 - B / 2) | 0, y0 = (t.height / 2 - B / 2) | 0;
    const buf = new Uint16Array(B * B * 4); r.readRenderTargetPixels(t, x0, y0, B, B, buf); const out = [];
    for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) { if ((i - B / 2) ** 2 + (j - B / 2) ** 2 > (B / 2) ** 2) continue; const k = (j * B + i) * 4;
      out.push(0.2126 * half(buf[k]) + 0.7152 * half(buf[k + 1]) + 0.0722 * half(buf[k + 2])); } return out; };
  const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(q * (s.length - 1))]; };
  const out = [];
  for (const it of se.nebulae.items) {
    const n = it.n; p.galactic(g);
    const v = p.local.clone().set(n.x - g.x, n.y - g.y, n.z - g.z); const d = v.length(); v.normalize();
    p.quat.setFromUnitVectors(p.local.clone().set(0, 0, -1), v);
    const ang = Math.asin(n.radius / d);
    const H = pl.bgTarget.height, R = Math.min(120, H / 2.4);
    se.settings.fov = 2 * Math.atan(ang * H / (2 * R)) * 180 / Math.PI; se.pipeline.autoExposure = false;
    se.nebulae.enabled = true; await wait(1800); const on = read(R);
    se.nebulae.enabled = false; await wait(900); const off = read(R);
    const diff = on.map((x, i) => Math.max(x - off[i], 0));
    out.push([n.name, 2 * Math.atan(n.radius / n.dist) * 180 / Math.PI * 60, pct(diff, 0.995), pct(off, 0.5), n.sb]);
  }
  se.nebulae.enabled = true;
  return out;
})()`);
// Linear frame values to mag/arcsec^2 with the zero point of render/nebulae.ts (SB21: 21 mag/arcsec^2).
const SB21 = 729 * 2.6 * Math.pow(10, -0.4 * 14);
const mu = (v) => (v > 0 ? 21 - 2.5 * Math.log10(v / SB21) : Infinity);
console.log('nebula | model diameter (arcmin) | published peak (mag/arcsec^2) | model peak | Milky Way behind it (median) | peak / glow behind');
for (const [name, size, peak, mw, sb] of rows) console.log(`${name} | ${size.toFixed(1)} | ${sb.toFixed(1)} | ${mu(peak).toFixed(1)} | ${mu(mw).toFixed(1)} | ${(peak / mw).toFixed(2)}`);
await browser.close();
