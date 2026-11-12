// The model's whole sky from a point, in the projection of the NASA survey maps (galactic plate carree), as raw floats:
//   node scripts/gpano.mjs <out.f32> [x y z (ly, default Sol)] [width 1024] [passes 12] [galaxy ids, default 0,1,2]
// Compare with the survey: .texvenv/bin/python -I scripts/textures/pano_compare.py <out.f32> <survey.exr> <out.png>
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const [out = 'shots/pano.f32', x = '26000', y = '18', z = '900', width = '1024', passes = '12', ids = '0,1,2'] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 800, height: 500 },
  protocolTimeout: 600000,
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[error]', m.text().slice(0, 400)); });
await page.goto(process.env.URL ?? 'http://localhost:5173/', { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 2500));
const t0 = Date.now();
const b64 = await page.evaluate(`(() => {
  const f = se.cloud.panorama({ x: ${Number(x)}, y: ${Number(y)}, z: ${Number(z)} }, ${Number(width)}, ${Number(passes)}, [${ids}]);
  const bytes = new Uint8Array(f.buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
})()`);
fs.writeFileSync(out, Buffer.from(b64, 'base64'));
console.log(out, width, 'x', Number(width) / 2, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
await browser.close();
