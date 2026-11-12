// Drives the running dev server with real mouse and keyboard input and checks the
// SpaceEngine-style controls. Usage: node scripts/uitest.mjs
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(process.env.URL ?? 'http://localhost:5173/', { waitUntil: 'load' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2000);

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
};
const ev = (js) => page.evaluate(js);
const state = () => ev('se.state()');
const press = async (key, shift = false) => {
  if (shift) await page.keyboard.down('ShiftLeft');
  await page.keyboard.press(key, { delay: 40 });
  if (shift) await page.keyboard.up('ShiftLeft');
  await sleep(80);
};
const pose = () => ev(`(() => { const p = se.player, e = se.getView().bodies.find((b) => b.body.name === 'Earth').pos;
  const f = new (p.local.constructor)(0, 0, -1).applyQuaternion(p.quat); const r = e.clone().sub(p.local);
  return { dist: r.length(), aim: f.angleTo(r), q: p.quat.toArray(), rel: r.toArray() }; })()`);
const drag = async (button, dx, dy) => {
  await page.mouse.move(900, 300);
  await page.mouse.down({ button });
  for (let i = 1; i <= 10; i++) { await page.mouse.move(900 + (dx * i) / 10, 300 + (dy * i) / 10); await sleep(16); }
  await page.mouse.up({ button });
  await sleep(400);
};

// --- Velocity: hold S, distance = setting x time, no growth with hold time.
const v0 = (await state()).speedSetting;
const p0 = await pose();
const t0 = Date.now();
await page.keyboard.down('KeyS');
await sleep(3000);
const mid = await state();
await page.keyboard.up('KeyS');
const held = (Date.now() - t0) / 1000;
await sleep(900);
const p1 = await pose();
const moved = p1.dist - p0.dist;
check('hold S 3 s: distance = velocity x time', Math.abs(moved / (v0 * held) - 1) < 0.04, `${moved.toFixed(0)} km vs ${(v0 * held).toFixed(0)} km`);
check('speed while holding equals the setting', Math.abs(mid.speed / v0 - 1) < 0.01, `${mid.speed.toFixed(1)} of ${v0.toFixed(1)} km/s`);
check('setting unchanged by holding', (await state()).speedSetting === v0);
check('stops after release', (await state()).speed === 0);

// --- Wheel: one notch = x1.3, Shift = x10.
await page.mouse.move(900, 300);
await page.mouse.wheel({ deltaY: -100 });
await sleep(100);
check('wheel up one notch = x1.3', Math.abs((await state()).speedSetting / v0 - 1.3) < 1e-6);
await page.mouse.wheel({ deltaY: 100 });
await page.mouse.wheel({ deltaY: 100 });
await sleep(100);
check('wheel down two notches = /1.3', Math.abs((await state()).speedSetting / v0 - 1 / 1.3) < 1e-6);
await page.mouse.wheel({ deltaY: -100 });
await sleep(100);

// --- Mouse: left drag looks (position fixed), right drag orbits (distance + aim fixed).
await ev('se.placeAt(se.earth); se.select(se.earth)');
await sleep(300);
const a0 = await pose();
await drag('left', 120, 40);
const a1 = await pose();
check('left drag turns the camera', a1.aim > 0.1, `aim ${a0.aim.toFixed(3)} -> ${a1.aim.toFixed(3)} rad`);
check('left drag does not move', Math.abs(a1.dist - a0.dist) < 1);
await ev('se.placeAt(se.earth)');
await sleep(300);
const b0 = await pose();
await drag('right', 160, 60);
const b1 = await pose();
const swing = Math.acos((b0.rel[0] * b1.rel[0] + b0.rel[1] * b1.rel[1] + b0.rel[2] * b1.rel[2]) / (b0.dist * b1.dist));
check('right drag orbits the selection', swing > 0.2, `${swing.toFixed(2)} rad around Earth`);
check('right drag keeps the distance', Math.abs(b1.dist / b0.dist - 1) < 1e-6);
check('right drag keeps it centred', b1.aim < 0.01, `aim ${b1.aim.toFixed(4)} rad`);

// --- C centres, T tracks.
await drag('left', 200, 0);
await press('KeyC');
await sleep(1500);
check('C centres the selection', (await pose()).aim < 0.01);
await press('KeyT');
check('T tracks', (await state()).mode === 'Tracking Earth');
await press('KeyT');
check('T again stops tracking', (await state()).mode === 'Free mode');

// --- Click selects, Esc deselects, double-click goes.
await press('Escape');
check('Esc deselects', (await state()).selected === null);
await page.mouse.click(720, 450);
await sleep(150);
check('click selects the object under the cursor', (await state()).selected === 'Earth');
await ev(`se.placeAt({ kind: 'body', star: se.earth.star, body: se.earth.body.moons[0] }); se.select(null)`);
await sleep(500);
await page.mouse.click(720, 450, { count: 2 });
await sleep(200);
check('double-click = select + go to', (await state()).mode === 'Landing: Moon' || (await state()).mode === 'Go to: Moon', (await state()).mode);
await press('KeyZ');
check('Z = full stop', (await state()).mode === 'Free mode');

// --- G, G G, Shift+G, H.
await ev('se.select(se.earth)');
await press('KeyG');
check('G = go to', (await state()).mode === 'Go to: Earth');
for (let i = 0; i < 100 && (await state()).mode !== 'Free mode'; i++) await sleep(100);
const arrived = await state();
const alt = await ev('se.player.altitude');
check('arrival resets the velocity setting to the surroundings', arrived.speedSetting > alt / 20 && arrived.speedSetting < alt, `${arrived.speedSetting.toFixed(0)} km/s at ${alt.toFixed(0)} km`);
await press('KeyG');
check('G again = land', (await state()).mode === 'Landing: Earth');
await press('Escape');
check('Esc cancels the autopilot', (await state()).mode === 'Free mode');
await ev('se.placeAt(se.earth)');
await press('KeyG', true);
check('Shift+G = land', (await state()).mode === 'Landing: Earth');
await press('KeyX');
await ev('se.placeAt(se.earth)');

// --- Time.
await press('KeyL'); await press('KeyL');
check('L L = 100x', (await state()).timeRate === 100);
await press('KeyJ');
check('J = reverse', (await state()).timeRate === -100);
await press('KeyK');
check('K = 10x slower', (await state()).timeRate === -10);
await press('Space');
check('Space = pause', (await state()).paused === true);
await press('Backslash');
const rt = await state();
check('\\ = real time', rt.timeRate === 1 && rt.paused === false);

// --- Interface.
const open = (name) => ev(`se.hud.isOpen('${name}')`);
await press('F3');
check('F3 opens search', await open('search'));
await page.keyboard.type('mars');
await sleep(100);
await press('Enter');
check('search + Enter selects', (await state()).selected === 'Mars' && !(await open('search')));
await press('F3');
await page.keyboard.type('jup');
await press('Enter', true);
check('search + Shift+Enter goes', (await state()).mode === 'Go to: Jupiter');
await press('KeyZ');
await press('F2');
check('F2 opens the system browser', await open('browser'));
await press('F1');
check('F1 opens help', await open('help'));
await press('Escape');
check('Esc closes help first', !(await open('help')) && (await open('browser')));
await press('Escape');
check('Esc closes the browser next', !(await open('browser')) && (await state()).selected === 'Jupiter');
await press('F4');
check('F4 opens settings', await open('settings'));
await press('F4');
await press('KeyO');
check('O toggles orbits', (await ev('se.settings.orbits')) === false && (await ev('se.getView().showOrbits')) === false);
await press('KeyO');
await press('KeyL', true);
// (Labels are off by default.)
check('Shift+L toggles labels, not time', (await ev('se.settings.labels')) === true && (await state()).timeRate === 1);
await press('KeyL', true);
await press('Backquote');
check('` hides the interface', await ev(`getComputedStyle(document.getElementById('hud')).display === 'none' && getComputedStyle(document.getElementById('labels')).display === 'none'`));
await press('Backquote');
await press('KeyH');
check('H = go home', (await state()).mode === 'Go to: Earth' || (await state()).selected === 'Earth', (await state()).mode);

// --- Object panel, context menu, music.
await press('KeyZ');
await ev('se.placeAt(se.earth); se.select(se.earth)');
await sleep(300);
const infoRows = () => ev(`document.querySelectorAll('#hud .info .kv .k').length`);
const compact = await infoRows();
check('the object panel is compact by default', compact <= 4 && (await ev(`document.querySelector('#hud .info').getBoundingClientRect().height < innerHeight * 0.25`)), `${compact} rows`);
await press('KeyI');
check('I shows the full property list', (await infoRows()) > 8);
await press('KeyI');
check('I again goes back to the summary', (await infoRows()) === compact);
await page.mouse.click(720, 450, { button: 'right' });
await sleep(150);
check('right-click on an object opens its menu', await ev(`!document.querySelector('#hud .ctx').classList.contains('hidden') && document.querySelector('#hud .ctx .hd').textContent === 'Earth'`));
await press('Escape');
check('Esc closes the menu, keeps the selection', await ev(`document.querySelector('#hud .ctx').classList.contains('hidden')`) && (await state()).selected === 'Earth');
await page.mouse.click(720, 450, { button: 'right' });
await sleep(150);
await page.click('#hud .ctx .item:nth-child(3)');
check('menu Go to flies there', (await state()).mode.endsWith(': Earth'), (await state()).mode);
await press('KeyZ');
const musicOn = await ev('se.hud.music.on');
await press('KeyM');
check('M toggles music', (await ev('se.hud.music.on')) === !musicOn);
await press('KeyM');

// --- Scenic spots: the panel, exact and repeatable poses, free flight afterwards.
await press('KeyZ');
await press('F6');
check('F6 opens the scenic panel', await open('scenic'));
check('one card per spot', (await ev(`document.querySelectorAll('.dialog.scenic .card').length === se.scenicSpots.length`)));
await page.click('.dialog.scenic .card:nth-child(4)');
await sleep(2500);
const sc = await state();
check('a card click jumps there and closes the panel', sc.selected === 'Mars' && sc.nearBody === 'Mars' && sc.mode === 'Free mode' && !(await open('scenic')), JSON.stringify(sc));
const marsAlt = (await ev('se.stats().altitude'));
check('surface spots settle at the pose altitude above the terrain', !sc.settling && Math.abs(marsAlt - 0.6) < 0.02, `${marsAlt.toFixed(3)} km`);
const jump = (id) => ev(`(() => { se.scenic('${id}'); const b = se.getView().bodies.find((b) => b.body.name === se.state().selected);
  return [...se.player.local.clone().sub(b.pos).toArray(), ...se.player.quat.toArray(), se.state().simTime, se.settings.fov]; })()`);
const j1 = await jump('saturn-rings');
await ev(`se.time('faster'), se.time('faster'), se.time('faster'), se.time('faster'), se.time('faster')`);
await page.keyboard.down('KeyW');
await sleep(1200);
await page.keyboard.up('KeyW');
await ev(`se.scenic('milky-way-above')`);
await sleep(1500);
const gal = await ev(`(() => { const g = {}; se.player.galactic(g); return [g.x, g.y, g.z, se.getView() === null, se.state().selected]; })()`);
check('space spots put the camera at the galactic position', Math.hypot(gal[0] - 26000, gal[1] - 60000, gal[2] - 34000) < 1 && gal[3] && gal[4] === null, JSON.stringify(gal));
const j2 = await jump('saturn-rings');
const worst = Math.max(...j1.map((v, i) => Math.abs(v - j2[i]) / Math.max(1, Math.abs(v))));
check('a body spot reproduces the same body-relative pose every time', worst < 1e-9, `max relative difference ${worst.toExponential(1)}`);
check('a jump resets the time rate', (await state()).timeRate === 1 && !(await state()).paused);
const before = await ev('se.player.local.toArray()');
await page.keyboard.down('KeyW');
await sleep(800);
await page.keyboard.up('KeyW');
const after = await ev('se.player.local.toArray()');
check('free flight after a jump', Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]) > 100 && (await state()).mode === 'Free mode');
check('unknown spot ids are refused', (await ev(`se.scenic('nowhere')`)) === false);

// --- Black holes: Go to parks at a safe distance, the lens draws it, and flying at it stops short of the horizon.
await ev(`se.go(se.blackHole('Cygnus X-1'))`);
// (Some 7,000 light years: the autopilot takes 15 s or so; wait for it to arrive.)
for (let i = 0; i < 60 && (await state()).mode !== 'Free mode'; i++) await sleep(500);
await sleep(500);
const bh = await ev(`(() => { const t = se.blackHole('Cygnus X-1'); const d = se.targetPos(t).distanceTo(se.player.local) / t.bh.rs;
  return { d, mode: se.state().mode, lens: se.pipeline.lens.enabled, near: se.holes.near && se.holes.near.bh.name }; })()`);
check('G parks 40 Schwarzschild radii from Cygnus X-1', Math.abs(bh.d - 40) < 2 && bh.mode === 'Free mode' && bh.near === 'Cygnus X-1', JSON.stringify(bh));
check('the lens pass runs with the hole in view', bh.lens);
await page.keyboard.down('KeyW');
await sleep(4000);
await page.keyboard.up('KeyW');
const closest = await ev(`(() => { const t = se.blackHole('Cygnus X-1'); return se.targetPos(t).distanceTo(se.player.local) / t.bh.rs; })()`);
check('flying at a black hole stops outside 3 r_s', closest >= 2.99 && closest < 40, `${closest.toFixed(2)} r_s`);

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
await browser.close();
process.exit(failed ? 1 : 0);
