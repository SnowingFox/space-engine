import * as THREE from 'three';
import { KM_PER_LY } from './core/units';
import { formatDistance } from './game/format';
import { Hud, type Settings, type TimeCommand } from './game/hud';
import { Input } from './game/input';
import { buildLabels, labelAt, type LabelLayout } from './game/labels';
import { Player, type Obstacle, type OrbitPivot } from './game/player';
import { SCENIC_SPOTS, type BodyPose, type ScenicPose } from './game/scenic';
import { aimPose, galacticToLocal, resolveBodyPose, spaceQuat } from './game/scenicPose';
import { galaxyTarget, parkingDistance, sameTarget, targetName, targetPosition, targetRadius, type Target } from './game/target';
import { GALAXIES, NAMED_GALAXIES, nearestGalaxy, type GalaxyData } from './universe/universe';
import { COSMOS, findGalaxy, forEachGalaxy, visibleAt } from './universe/cosmos';
import { GalaxyCloud } from './render/galaxyCloud';
import { Nebulae } from './render/nebulae';
import { DARK_ADAPTED, Pipeline } from './render/pipeline';
import { BlackHoles } from './render/blackHole';
import { blackHoleTarget, nebulaTarget } from './game/target';
import { NEBULAE, nebulaAt, skyDirection, type NebulaData } from './universe/nebulae';
import type { LabelSource } from './game/labels';
import { BLACK_HOLES, findBlackHole } from './universe/blackHoles';
import { initProbe } from './render/probe';
import { Starfield } from './render/starfield';
import { SystemView, type BodyState } from './render/systemView';
import { EPOCH_MS, simClock, simTimeAt, type SystemData } from './universe/bodies';
import { GALAXY_RADIUS, SOL_POS } from './universe/galaxy';
import { makeSol, type StarData } from './universe/stars';
import { generateSystem } from './universe/system';

const SYSTEM_LOAD_KM = 0.4 * KM_PER_LY;
const SYSTEM_UNLOAD_KM = 0.6 * KM_PER_LY;
const MAX_TIME_RATE = 1e10;
const MIN_TIME_RATE = 1e-3;
const MIN_FOV = 10;
const MAX_FOV = 120;

const canvas = document.getElementById('view') as HTMLCanvasElement;
const pipeline = new Pipeline(canvas);
initProbe(pipeline.renderer);
const input = new Input(canvas);
const starfield = new Starfield(pipeline.pixelRatio);
const cloud = new GalaxyCloud();
const nebulae = new Nebulae();
// (Every point of light drawn is a real, selectable star or galaxy: no decorative star field.)
pipeline.bgScene.add(cloud.group, nebulae.group, starfield.group);
/** Where the camera was last frame (galactic, ly), for motion blur. */
const lastGal = new THREE.Vector3(NaN, 0, 0);
const travel = new THREE.Vector3();
/** Straight up from the camera on the nearest world, for the air the starlight crosses. */
const zenith = new THREE.Vector3();
/** Smoothed camera velocity, ly/s. */
const flight = new THREE.Vector3();
/** Motion blur: the stars streak over the path they cross during one exposure, seconds. */
const EXPOSURE = 1 / 30;

const sol = makeSol(SOL_POS.x, SOL_POS.y, SOL_POS.z);
const earth: Target = { kind: 'body', star: sol, body: generateSystem(sol).planets[2] };
const player = new Player(sol);
/** Black holes: lensing, discs and jets (lensPass.ts), distant ones as points, and the keep-out zone. */
const holes = new BlackHoles(pipeline.bgScene, pipeline.lens, pipeline.pixelRatio);
pipeline.lens.warm(pipeline.renderer);

/** The bloom pass, if the pipeline has one that can be switched. */
const bloomPass = (pipeline as unknown as { bloom?: { enabled: boolean } }).bloom ?? null;
const PHOTO_KEY = 'se.milkyWayPhoto';
const settings: Settings = {
  labels: false, orbits: true, fov: 60, mouseSensitivity: 1, bloom: bloomPass ? bloomPass.enabled : null,
  // Remembered, so comparing the photo with the model survives reloads.
  milkyWayPhoto: localStorage.getItem(PHOTO_KEY) === '1',
};
cloud.survey = settings.milkyWayPhoto;

let view: SystemView | null = null;
let selected: Target | null = null;
/** Shift+F: ride along with this object wherever it goes. */
let follow: Target | null = null;
let nearBody: BodyState | null = null;
let simTime = 0;
/** Simulated seconds per real second; negative runs time backwards. Pausing keeps the rate. */
let timeRate = 1;
let paused = false;
let fps = 60;
let last = performance.now();
let layout: LabelLayout = { items: [], marker: null };
/** Debug: height above the terrain to snap to once the ground under the camera is known. */
let hoverAlt: number | null = null;
const epoch = EPOCH_MS;

const hud = new Hud(document.getElementById('hud')!, document.getElementById('labels')!, {
  select: (t) => select(t),
  go: (t) => go(t),
  land: (t) => land(t),
  center: (t) => { select(t); player.aim = { target: t, hold: false }; },
  track: (t) => { select(t); player.aim = { target: t, hold: true }; },
  follow: (t) => { select(t); follow = t.kind === 'body' ? t : null; },
  home: () => home(),
  time: (cmd) => timeCommand(cmd),
  settingsChanged: () => applySettings(),
  scenic: (id) => scenic(id),
  searchSource: (q) => searchObjects(q),
}, settings);

function applySettings(): void {
  settings.fov = THREE.MathUtils.clamp(settings.fov, MIN_FOV, MAX_FOV);
  if (view) view.showOrbits = settings.orbits;
  if (bloomPass && settings.bloom !== null) bloomPass.enabled = settings.bloom;
  cloud.survey = settings.milkyWayPhoto;
  try { localStorage.setItem(PHOTO_KEY, settings.milkyWayPhoto ? '1' : '0'); } catch { /* blocked: not remembered */ }
}

function select(t: Target | null): void {
  selected = t;
  if (!t || (player.aim && !sameTarget(player.aim.target, t))) player.aim = null;
  hud.setSelected(t);
}

const canLand = (t: Target) => t.kind === 'body' && t.body.type !== 'gas' && t.body.type !== 'icegiant';

/** Fly to a target. Asking again once already there ("GG") goes down and lands on it. */
function go(t: Target): void {
  select(t);
  const near = targetPosition(t, player.anchor, simTime, tmp).distanceTo(player.local) < parkingDistance(t) * 1.3;
  player.goTo(t, near && canLand(t));
}

/** Shift+G: descend to the surface of a solid body. */
function land(t: Target): void {
  select(t);
  if (!canLand(t)) {
    hud.toast(`${targetName(t)} has no solid surface to land on`);
    player.goTo(t, false);
    return;
  }
  player.goTo(t, true);
}

function home(): void {
  select(earth);
  player.goTo(earth, false);
}

function timeCommand(cmd: TimeCommand): void {
  if (cmd === 'pause') paused = !paused;
  else if (cmd === 'real') { timeRate = 1; paused = false; }
  else if (cmd === 'reverse') timeRate = -timeRate;
  else {
    const mag = Math.abs(timeRate) * (cmd === 'faster' ? 10 : 0.1);
    // Snap to exact powers of ten so repeated steps never drift.
    const snapped = Math.pow(10, Math.round(Math.log10(mag)));
    timeRate = Math.sign(timeRate) * THREE.MathUtils.clamp(snapped, MIN_TIME_RATE, MAX_TIME_RATE);
    paused = false;
  }
}

const gal = { x: 0, y: 0, z: 0 };
const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const qSpin = new THREE.Quaternion();
const pivot: OrbitPivot = { center: new THREE.Vector3(), radius: 0 };

/** Park the camera on the sunlit side of a body, looking at it. */
function placeAt(t: Target): void {
  if (player.anchor.id !== t.star.id) player.reanchor(t.star);
  const tp = targetPosition(t, player.anchor, simTime, tmp);
  const toSun = tmp2.copy(tp).negate().normalize();
  const side = new THREE.Vector3().crossVectors(toSun, new THREE.Vector3(0, 1, 0)).normalize();
  const dir = toSun.multiplyScalar(0.72).addScaledVector(side, 0.6).add(new THREE.Vector3(0, 0.2, 0)).normalize();
  player.local.copy(tp).addScaledVector(dir, parkingDistance(t));
  player.quat.setFromRotationMatrix(new THREE.Matrix4().lookAt(player.local, tp, new THREE.Vector3(0, 1, 0)));
  player.velocity.set(0, 0, 0);
  player.autopilot = null;
  player.setSpeedFor(parkingDistance(t) - targetRadius(t));
}

/**
 * Jump straight to a scenic spot (by id) or to an ad-hoc pose, reproducing it exactly:
 * body poses are rebuilt from the body and sun direction at the pose's own sim time.
 * Afterwards the player is in ordinary free flight.
 */
function scenic(which: string | ScenicPose): boolean {
  const spot = typeof which === 'string' ? SCENIC_SPOTS.find((s) => s.id === which) : undefined;
  const pose = typeof which === 'string' ? spot?.pose : which;
  if (!pose) return false;

  if (pose.kind === 'body') {
    const r = resolveBodyPose(pose, sol);
    if (!r) {
      hud.toast('This place no longer exists');
      return false;
    }
    simTime = r.simTime;
    if (view && view.system.star.id !== r.star.id) unloadSystem();
    if (player.anchor.id !== r.star.id) player.reanchor(r.star);
    if (!view) loadSystem(r.star);
    view?.advance(simTime);
    player.local.copy(r.local);
    player.quat.copy(r.quat);
    // Near the ground the exact height waits for the terrain probe, as in hover().
    hoverAlt = r.groundAlt;
    player.setSpeedFor(pose.alt);
    select({ kind: 'body', star: r.star, body: r.body });
  } else {
    galacticToLocal(pose.pos, player.anchor, player.local);
    player.quat.copy(spaceQuat(pose));
    hoverAlt = null;
    // Out here distances are galactic: scale the velocity setting to the height over the disc.
    player.speedSetting = THREE.MathUtils.clamp(Math.abs(pose.pos[1]) / 20, 1, 5000) * KM_PER_LY;
    select(null);
  }
  player.stop();
  player.aim = null;
  follow = null;
  // The ground height known so far belongs to wherever we were before.
  nearBody = null;
  timeRate = 1;
  paused = false;
  settings.fov = pose.fov ?? 60;
  hud.syncSettings(true);
  hud.close('scenic');
  if (spot) hud.toast(spot.title);
  return true;
}

function pickAt(x: number, y: number): Target | null {
  const label = labelAt(layout, x, y);
  if (label) return label;
  const cam = pipeline.camera;
  const tanY = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
  const dir = new THREE.Vector3(
    ((x / window.innerWidth) * 2 - 1) * tanY * cam.aspect,
    (1 - (y / window.innerHeight) * 2) * tanY,
    -1,
  ).normalize().applyQuaternion(player.quat);

  if (view) {
    let best: Target | null = null;
    let bestDist = Infinity;
    const test = (rel: THREE.Vector3, radius: number, t: Target) => {
      const dist = rel.length();
      const ang = Math.acos(THREE.MathUtils.clamp(rel.dot(dir) / dist, -1, 1));
      if (ang < Math.max(Math.asin(Math.min(radius / dist, 1)), 0.014) && dist < bestDist) {
        bestDist = dist;
        best = t;
      }
    };
    const star = view.system.star;
    test(tmp.copy(player.local).negate(), view.star.radiusKm, { kind: 'star', star });
    for (const s of view.bodies) test(s.rel, s.body.radius, { kind: 'body', star, body: s.body });
    if (best) return best;
  }
  player.galactic(gal);
  const hole = holes.pick(dir, gal);
  if (hole) return hole;
  // Nebulae are in front of the other galaxies; over either, only a star clicked squarely wins.
  const nebula = pickNebula(dir);
  const galaxy = nebula ? null : pickGalaxy(dir);
  const star = starfield.pick(gal, dir, galaxy || nebula ? 0.004 : 0.014);
  if (star) return { kind: 'star', star };
  if (nebula) return nebulaTarget(nebula);
  return galaxy ? galaxyTarget(galaxy) : null;
}

/** The nebula under a view direction, if any (not one the camera is inside). */
function pickNebula(dir: THREE.Vector3): NebulaData | null {
  let best: NebulaData | null = null;
  let bestScore = 1;
  for (const n of NEBULAE) {
    const score = Nebulae.hit(n, gal, dir);
    if (score < bestScore) { bestScore = score; best = n; }
  }
  return best;
}

/** The galaxy under a view direction, if any (not the one the camera is inside). */
/** A black hole of a generated galaxy (only listed in search on a match). */
function generatedHole(b: { galaxy: GalaxyData | null; kind: string }): boolean {
  return b.kind === 'supermassive' && !!b.galaxy && b.galaxy.id >= NAMED_GALAXIES;
}

function pickGalaxy(dir: THREE.Vector3): GalaxyData | null {
  let best: GalaxyData | null = null;
  let bestScore = Infinity;
  // (The catalogue and every galaxy generated around the camera: each point of light on the sky is one.)
  forEachGalaxy((g) => {
    const dx = g.x - gal.x, dy = g.y - gal.y, dz = g.z - gal.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < g.radius * 1.1 || !visibleAt(g, d)) return;
    const apparent = Math.asin(Math.min(g.radius / d, 1));
    const ang = Math.acos(THREE.MathUtils.clamp((dx * dir.x + dy * dir.y + dz * dir.z) / d, -1, 1));
    const reach = Math.max(apparent * 0.7, 0.012);
    if (ang < reach && ang / reach < bestScore) { bestScore = ang / reach; best = g; }
  });
  return best;
}

input.onClick = (x, y, double) => {
  const t = pickAt(x, y);
  if (!t) return;
  if (double) go(t);
  else select(t);
};
input.onContext = (x, y) => {
  const t = pickAt(x, y);
  if (t) hud.contextMenu(t, x, y);
  else hud.closeContext();
};

/** Search: the current system first, then the home system, then loaded stars by name. */
function searchObjects(query: string): Target[] {
  const q = query.toLowerCase();
  const out: Target[] = [];
  const seen = new Set<number>();
  const rank = (name: string) => (q === '' ? 1 : name.toLowerCase().startsWith(q) ? 0 : name.toLowerCase().includes(q) ? 1 : -1);
  const addSystem = (system: SystemData) => {
    if (seen.has(system.star.id)) return;
    seen.add(system.star.id);
    const star = system.star;
    const all: Target[] = [{ kind: 'star', star }];
    for (const p of system.planets) {
      all.push({ kind: 'body', star, body: p });
      for (const m of p.moons) all.push({ kind: 'body', star, body: m });
    }
    const hits = all.map((t) => ({ t, r: rank(targetName(t)) })).filter((h) => h.r >= 0);
    hits.sort((a, b) => a.r - b.r);
    for (const h of hits) out.push(h.t);
  };
  if (view) addSystem(view.system);
  if (q !== '' || !view) addSystem(generateSystem(sol));
  if (selected && q !== '' && !selected.star.virtual) addSystem(generateSystem(selected.star));
  // Nebulae, by name or catalogue number (M42, NGC 2237...): all listed before anything is typed.
  const rankNebula = (n: NebulaData) => Math.min(...[n.name, ...n.aliases].map(rank).map((r) => (r < 0 ? 9 : r)));
  const nebs = NEBULAE.map((n) => ({ n, r: rankNebula(n) })).filter((h) => h.r < 9);
  nebs.sort((a, b) => a.r - b.r || a.n.id - b.n.id);
  for (const h of nebs) out.push(nebulaTarget(h.n));
  // Galaxies: the catalogued ones are listed even before anything is typed.
  const galaxies = GALAXIES.map((g) => ({ g, r: rank(g.name) })).filter((h) => h.r >= 0 && (q !== '' || h.g.id < NAMED_GALAXIES));
  // (And, on a match, the generated ones around the camera, by their catalogue number.)
  if (q !== '') COSMOS.forEach((g) => { const r = rank(g.name); if (r >= 0 && galaxies.length < 200) galaxies.push({ g, r }); });
  // (A generated galaxy by its number, generated now if it was not yet.)
  const byNumber = /^pgc\s*\d+$/.test(q.trim()) ? findGalaxy(q) : null;
  if (byNumber && !galaxies.some((h) => h.g === byNumber)) galaxies.push({ g: byNumber, r: 0 });
  galaxies.sort((a, b) => a.r - b.r || a.g.id - b.g.id);
  for (const h of galaxies.slice(0, q === '' ? NAMED_GALAXIES : 20)) out.push(galaxyTarget(h.g));
  // Black holes: the real ones are listed before anything is typed, the generated ones (named after their galaxy) on a match.
  const bhs = BLACK_HOLES.map((b) => ({ b, r: rank(b.name) })).filter((h) => h.r >= 0 && (q !== '' || !generatedHole(h.b)));
  bhs.sort((a, b) => a.r - b.r || a.b.id - b.b.id);
  for (const h of bhs.slice(0, 20)) out.push(blackHoleTarget(h.b));
  // (A generated galaxy's hole by its number, listed or not.)
  const pgc = /^pgc\s*\d+\s*\*?$/.test(q.trim()) ? findBlackHole(q) : null;
  if (pgc && !bhs.some((h) => h.b === pgc)) out.push(blackHoleTarget(pgc));

  if (q !== '') {
    // The starfield has no public listing yet; read its streamed levels directly.
    const levels = (starfield as unknown as { levels?: { stars: StarData[] }[] }).levels ?? [];
    player.galactic(gal);
    const stars: { s: StarData; r: number; d: number }[] = [];
    for (const lv of levels) {
      for (const s of lv.stars) {
        if (seen.has(s.id)) continue;
        const r = rank(s.name);
        if (r >= 0) stars.push({ s, r, d: (s.x - gal.x) ** 2 + (s.y - gal.y) ** 2 + (s.z - gal.z) ** 2 });
      }
    }
    stars.sort((a, b) => a.r - b.r || a.d - b.d);
    for (const h of stars.slice(0, 40)) {
      if (seen.has(h.s.id)) continue;
      seen.add(h.s.id);
      out.push({ kind: 'star', star: h.s });
    }
  }
  return out.slice(0, 60);
}

function handleKeys(): void {
  for (const { code, shift, ctrl } of input.takePressed()) {
    switch (code) {
      case 'KeyG':
        if (!selected) hud.toast('Nothing selected');
        else if (shift || ctrl) land(selected);
        else go(selected);
        break;
      case 'KeyC':
        if (selected) player.aim = { target: selected, hold: shift };
        break;
      case 'KeyT':
        if (selected) player.aim = player.aim?.hold ? null : { target: selected, hold: true };
        break;
      case 'KeyF':
        if (shift) follow = follow || !selected || selected.kind !== 'body' ? null : selected;
        break;
      case 'KeyH': home(); break;
      case 'KeyZ':
      case 'KeyX': player.stop(); break;
      case 'Space': timeCommand('pause'); break;
      case 'KeyL':
        if (shift) hud.flip('labels');
        else timeCommand('faster');
        break;
      case 'KeyK': timeCommand('slower'); break;
      case 'KeyJ': timeCommand('reverse'); break;
      case 'Backslash': timeCommand('real'); break;
      case 'Slash':
        if (shift) hud.toggle('help');
        else timeCommand('real');
        break;
      case 'KeyO': hud.flip('orbits'); break;
      case 'KeyI': hud.toggleInfo(); break;
      case 'KeyM': hud.music.toggle(); break;
      case 'F1': hud.toggle('help'); break;
      case 'F2': hud.toggle('browser'); break;
      case 'F3': hud.toggle('search'); break;
      case 'F4': hud.toggle('settings'); break;
      case 'F6': hud.toggle('scenic'); break;
      case 'F10':
      case 'Backquote': document.body.classList.toggle('ui-hidden'); break;
      case 'Home':
        settings.fov = 60;
        hud.syncSettings(true);
        break;
      case 'Escape':
        if (hud.closeTop()) break;
        if (player.autopilot) player.autopilot = null;
        else if (player.aim || follow) { player.aim = null; follow = null; }
        else select(null);
        break;
    }
  }
}

/** Held keys: zoom the field of view. */
function handleZoom(dt: number): void {
  const zoom = input.axis(['PageDown', 'BracketLeft'], ['PageUp', 'BracketRight']);
  if (zoom === 0) return;
  settings.fov = THREE.MathUtils.clamp(settings.fov * Math.exp(zoom * dt * 1.2), MIN_FOV, MAX_FOV);
  hud.syncSettings(false);
}

function updateAnchor(): void {
  player.galactic(gal);
  starfield.update(gal);
  const nearest = starfield.nearest(gal);
  if (nearest && nearest.id !== player.anchor.id) {
    const dNew = Math.hypot(nearest.x - gal.x, nearest.y - gal.y, nearest.z - gal.z) * KM_PER_LY;
    // Hysteresis keeps the anchor from flapping between two equidistant stars.
    if (dNew < player.local.length() * 0.9) player.reanchor(nearest);
  }

  const dist = player.local.length();
  if (view && (view.system.star.id !== player.anchor.id || dist > SYSTEM_UNLOAD_KM)) unloadSystem();
  if (!view && dist < SYSTEM_LOAD_KM && !player.anchor.virtual) loadSystem(player.anchor);
}

function loadSystem(star: StarData): void {
  view = new SystemView(generateSystem(star));
  pipeline.scene.add(view.group);
  view.showOrbits = settings.orbits;
  starfield.setHidden(star);
  hud.setSystem(view.system);
}

function unloadSystem(): void {
  if (!view) return;
  pipeline.scene.remove(view.group);
  view.dispose();
  view = null;
  nearBody = null;
  starfield.setHidden(null);
  hud.setSystem(null);
}

/** Where the right mouse button orbits: the selection (or tracked object), else the nearest body. */
function orbitPivot(): OrbitPivot | null {
  const t = player.aim?.hold ? player.aim.target : selected;
  if (t) {
    targetPosition(t, player.anchor, simTime, pivot.center);
    const state = t.kind === 'body' && view ? view.bodies.find((s) => s.body === t.body) : undefined;
    pivot.radius = state?.view.ground ?? targetRadius(t);
    return pivot;
  }
  if (nearBody) {
    pivot.center.copy(nearBody.pos);
    pivot.radius = nearBody.view.ground ?? nearBody.body.radius;
    return pivot;
  }
  return null;
}

function flightMode(): string {
  const ap = player.autopilot;
  if (ap) return `${ap.land ? 'Landing' : 'Go to'}: ${targetName(ap.target)}`;
  if (follow) return `Following ${targetName(follow)}`;
  if (player.aim?.hold) return `Tracking ${targetName(player.aim.target)}`;
  return 'Free mode';
}

function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (dt > 0) fps += (1 / dt - fps) * 0.05;
  handleKeys();
  handleZoom(dt);
  canvas.classList.toggle('dragging', input.dragging);

  const simDt = paused ? 0 : dt * timeRate;
  const prevSimTime = simTime;
  simTime += simDt;
  simClock.t = simTime;
  holes.rideAlong(player, prevSimTime, simTime);

  let obstacles: Obstacle[] = [];
  if (view) {
    // Ride along with the body we are close to, so it does not orbit out from under us.
    const before = nearBody ? tmp.copy(nearBody.pos) : null;
    obstacles = view.advance(simTime);
    if (nearBody && before) {
      player.local.add(tmp2.copy(nearBody.pos).sub(before));
      // Close to the ground, turn with the planet too: the landscape stays put under us.
      const b = nearBody.body;
      const weight = 1 - THREE.MathUtils.smoothstep(player.altitude / b.radius, 0.02, 0.3);
      const angle = (weight * Math.PI * 2 * simDt) / b.rotationPeriod;
      if (angle !== 0) {
        const axis = nearBody.view.axis;
        player.local.sub(nearBody.pos).applyAxisAngle(axis, angle).add(nearBody.pos);
        player.quat.premultiply(qSpin.setFromAxisAngle(axis, angle));
      }
    }
  }
  if (follow && follow.kind === 'body') {
    // Near some other body the ride-along above wins; following two things at once makes no sense.
    if (nearBody && nearBody.body !== follow.body && !player.autopilot) follow = null;
    else if (!nearBody && !player.autopilot && simDt !== 0) {
      targetPosition(follow, player.anchor, prevSimTime, tmp);
      player.local.add(targetPosition(follow, player.anchor, simTime, tmp2).sub(tmp));
    }
  }

  obstacles = obstacles.concat(holes.obstacles(player, simTime));
  player.update(dt, input, obstacles, simTime, { pivot: orbitPivot(), fov: settings.fov, sensitivity: settings.mouseSensitivity });
  // Wait for the real height map too, or the ground would move once it arrives.
  if (hoverAlt !== null && nearBody?.view.ground != null && nearBody.view.ready) {
    tmp.copy(player.local).sub(nearBody.pos).setLength(nearBody.view.ground + hoverAlt);
    player.local.copy(nearBody.pos).add(tmp);
    hoverAlt = null;
  }
  updateAnchor();

  const fov = settings.fov;
  nearBody = null;
  if (view) {
    const aspect = pipeline.camera.aspect;
    const halfAngle = Math.atan(Math.tan(THREE.MathUtils.degToRad(fov) / 2) * Math.hypot(1, aspect)) + 0.05;
    view.update(player.local, simTime, now / 1000, tmp.set(0, 0, -1).applyQuaternion(player.quat), halfAngle);
    let bestRatio = 40;
    for (const s of view.bodies) {
      const ratio = s.rel.length() / s.body.radius;
      if (ratio < bestRatio) { bestRatio = ratio; nearBody = s; }
    }
  }

  pipeline.setView(player.quat, fov);
  // (The loaded system's star sits at the anchor: if it stands in front of a hole it hides it, unlensed.)
  holes.update(player, simTime, simDt, fov, pipeline.camera.aspect, pipeline.pixelsPerRadian, pipeline.pixelRatio,
    view ? { pos: tmp2.set(0, 0, 0), radius: view.star.radiusKm } : null,
    Math.floor(window.innerWidth * pipeline.pixelRatio), Math.floor(window.innerHeight * pipeline.pixelRatio));
  pipeline.minExposure = holes.minExposure;
  // Eyes adapt to the dark on a night side, at dusk and in open space: the light meter takes the exposure
  // up as far as this when nothing bright is in view, and down at once for a sun or a lit world.
  pipeline.maxExposure = DARK_ADAPTED;
  // Inside or next to a nebula the eye adapts to its faint light.
  // (And between the galaxies to their faint light, galaxyCloud.ts.)
  pipeline.darkAdapt = Math.max(nebulae.adapt, cloud.adapt);
  const low = nearBody as BodyState | null;

  player.galactic(gal);
  cloud.update(gal, pipeline.pixelsPerRadian, 1, pipeline.bgCamera);
  nebulae.update(gal, pipeline.bgCamera, pipeline.renderer, pipeline.pixelsPerRadian, pipeline.pixelRatio);
  travel.set(gal.x - lastGal.x, gal.y - lastGal.y, gal.z - lastGal.z);
  lastGal.set(gal.x, gal.y, gal.z);
  // (A jump, e.g. to a scenic spot or after a reload, is not a flight: no blur from it.)
  if (!Number.isFinite(travel.x) || dt <= 0 || travel.length() > Math.max(player.speed / KM_PER_LY, 1) * dt * 20) travel.set(0, 0, 0);
  else travel.divideScalar(dt);
  flight.lerp(travel, 1 - Math.exp(-dt / 0.08));
  starfield.setMotion(travel.copy(flight).multiplyScalar(EXPOSURE), pipeline.pixelsPerRadian);
  // With a sun in the field of view, eyes and cameras stop down and the stars are gone.
  let dazzle = 0;
  if (view) {
    const light = view.starlight;
    const off = tmp.set(0, 0, -1).applyQuaternion(player.quat).angleTo(tmp2.copy(player.local).negate());
    const edge = Math.atan(Math.tan(THREE.MathUtils.degToRad(fov) / 2) * Math.hypot(1, pipeline.camera.aspect));
    // Even from Neptune the Sun is a thousand times brighter than the full Moon: in view, or just
    // outside it (its glare still reaches into the frame), the eye stops down and the Milky Way all but goes.
    const inView = 1 - THREE.MathUtils.smoothstep(off, 1.0 * edge, 1.8 * edge);
    const power = Math.min(Math.pow(view.star.brightness, 0.3), 1) * Math.min(0.3 * light.x + 0.6 * light.y + 0.1 * light.z, 1);
    dazzle = 0.93 * inView * THREE.MathUtils.smoothstep(power, 0.02, 0.2);
  }
  const air = low?.body.atmosphere;
  const depth = air ? 1 - THREE.MathUtils.smoothstep(player.altitude / low!.body.radius, 0, low!.view.atmoTop - 1) : 0;
  starfield.setTwinkle(air ? Math.min(air.density, 1.5) * depth * depth : 0, now / 1000,
    air ? Math.min(air.density, 1.5) * depth : 0, air ? pipeline.daylight * depth : 0,
    air ? zenith.copy(player.local).sub(low!.pos).normalize() : undefined);
  // So they do next to a world in full daylight.
  dazzle = Math.max(dazzle, 0.8 * pipeline.daylight);
  pipeline.skyDim += (dazzle - pipeline.skyDim) * (1 - Math.exp(-dt / 0.4));

  layout = buildLabels(view, player, selected, simTime, pipeline.camera, window.innerWidth, window.innerHeight, settings.labels, hud.occupied(now), [...holes.labels(), ...nebulaLabels()]);
  hud.setLabels(layout);

  const near = nearBody as BodyState | null;
  const galCenterDist = Math.hypot(gal.x, gal.y, gal.z);
  let place: string;
  let placeDetail: string;
  const hole = holes.near && holes.near.ro < 2e4 ? holes.near : null;
  if (hole) {
    place = hole.bh.name;
    placeDetail = `${formatDistance(hole.dist)} from centre (${hole.ro < 100 ? hole.ro.toFixed(1) : Math.round(hole.ro).toLocaleString('en-US')} r_s)`;
  } else if (near) {
    place = near.body.name;
    const surface = near.view.ground ?? near.body.radius;
    placeDetail = `Altitude ${formatDistance(Math.max(near.rel.length() - surface, 0))}`;
  } else if (view) {
    place = player.anchor.name;
    placeDetail = `Distance ${formatDistance(Math.max(player.local.length() - view.star.radiusKm, 0))}`;
  } else if (nebulaAt(gal.x, gal.y, gal.z)) {
    const n = nebulaAt(gal.x, gal.y, gal.z)!;
    place = n.name;
    placeDetail = `${formatDistance(Math.hypot(n.x - gal.x, n.y - gal.y, n.z - gal.z) * KM_PER_LY)} from centre`;
  } else {
    // In or near a galaxy, name it; out between them, say how far home is.
    const g = nearestGalaxy(gal.x, gal.y, gal.z);
    const fromG = Math.hypot(g.x - gal.x, g.y - gal.y, g.z - gal.z);
    if (fromG < g.radius * 3) {
      place = g.name;
      placeDetail = `${formatDistance(fromG * KM_PER_LY)} from centre`;
    } else {
      place = 'Intergalactic space';
      placeDetail = `${formatDistance(galCenterDist * KM_PER_LY)} from Milky Way`;
    }
  }
  hud.frame({
    mode: flightMode(),
    auto: !!player.autopilot,
    speed: player.speed,
    speedSetting: player.speedSetting,
    limited: player.limited,
    cap: player.cap,
    place,
    placeDetail,
    timeRate,
    paused,
    dateMs: epoch + simTime * 1000,
    selected,
    // (A galaxy has no surface: the distance is to its centre.)
    selectedDist: selected
      ? Math.max(targetPosition(selected, player.anchor, simTime, tmp).distanceTo(player.local) - (selected.kind === 'galaxy' || selected.kind === 'nebula' ? 0 : targetRadius(selected)), 0)
      : 0,
  }, now);

  pipeline.render();
  requestAnimationFrame(frame);
}

/** Names on the sky for the nebulae big enough to see as more than a speck (and not filling the view). */
const nebulaSources: LabelSource[] = NEBULAE.map((n) => ({ target: nebulaTarget(n), rel: new THREE.Vector3(), radius: n.radius * KM_PER_LY, fade: 0 }));
function nebulaLabels(): LabelSource[] {
  player.galactic(gal);
  const ppr = window.innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(settings.fov) / 2));
  for (const src of nebulaSources) {
    const n = (src.target as { nebula: NebulaData }).nebula;
    src.rel.set((n.x - gal.x) * KM_PER_LY, (n.y - gal.y) * KM_PER_LY, (n.z - gal.z) * KM_PER_LY);
    const d = Math.hypot(n.x - gal.x, n.y - gal.y, n.z - gal.z);
    const px = d > n.radius ? Math.asin(n.radius / d) * ppr : Infinity;
    src.fade = THREE.MathUtils.smoothstep(px, 3, 7);
  }
  return nebulaSources;
}

/** Debug: hover above a body's sunlit side at a given altitude (km), facing the horizon. */
function hover(t: Target, alt: number, pitch = -0.1, lon = 0.5, lat = 0.2, turn = 0): void {
  placeAt(t);
  const tp = targetPosition(t, player.anchor, simTime, tmp);
  const toSun = tp.clone().negate().normalize();
  const side = new THREE.Vector3().crossVectors(toSun, new THREE.Vector3(0, 1, 0)).normalize();
  const up = toSun.clone().addScaledVector(side, lon).add(new THREE.Vector3(0, lat, 0)).normalize();
  player.local.copy(tp).addScaledVector(up, targetRadius(t) + alt);
  const ahead = side.clone().addScaledVector(up, -side.dot(up)).normalize().applyAxisAngle(up, turn).addScaledVector(up, pitch);
  player.quat.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), ahead, up));
  hoverAlt = alt;
  nearBody = null;
  player.setSpeedFor(alt);
}

// A reload (or a code change during development) picks up where the flight left off.
const SAVE_KEY = 'se.view';
function saveView(): void {
  try {
    sessionStorage.setItem(SAVE_KEY, JSON.stringify({
      anchor: player.anchor, local: player.local.toArray(), quat: player.quat.toArray(),
      speed: player.speedSetting, simTime, timeRate, paused,
    }));
  } catch { /* storage full or blocked: nothing to restore next time */ }
}
function restoreView(): boolean {
  try {
    const raw = sessionStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw) as {
      anchor: StarData; local: number[]; quat: number[]; speed: number; simTime: number; timeRate: number; paused: boolean;
    };
    player.anchor = s.anchor.isSol ? sol : s.anchor;
    player.local.fromArray(s.local);
    player.quat.fromArray(s.quat).normalize();
    player.speedSetting = s.speed;
    simTime = s.simTime;
    timeRate = s.timeRate;
    paused = s.paused;
    return player.local.toArray().every(Number.isFinite);
  } catch {
    return false;
  }
}
window.addEventListener('pagehide', saveView);
setInterval(saveView, 1000);

if (!restoreView()) {
  placeAt(earth);
  select(earth);
}
requestAnimationFrame(frame);

// Handy for debugging and automated screenshots from the console.
Object.assign(window, {
  se: {
    player, pipeline, starfield, cloud, nebulae, input, hud, settings, go, land, home, select, placeAt, hover, earth, scenic, cosmos: COSMOS,
    scenicSpots: SCENIC_SPOTS,
    /** Curation: turn/pitch that centre another body (planet index, moon index; -1 = the star) from a body pose. */
    scenicAim: (pose: BodyPose, planet: number, moon?: number) => aimPose(pose, sol, planet, moon),
    getView: () => view,
    /** A black hole's target by (part of) its name, for go / select. */
    blackHole: (name: string) => {
      const b = findBlackHole(name);
      return b ? blackHoleTarget(b) : null;
    },
    holes,
    /** A target's position now, km relative to the camera's anchor star. */
    targetPos: (t: Target) => targetPosition(t, player.anchor, simTime, new THREE.Vector3()),
    /** A galaxy's target by (part of) its name, for go / select. */
    /** A nebula's target by (part of) its name or a catalogue number, for go / select. */
    nebula: (name: string) => {
      const q = name.toLowerCase();
      const n = NEBULAE.find((x) => [x.name, ...x.aliases].some((a) => a.toLowerCase() === q))
        ?? NEBULAE.find((x) => [x.name, ...x.aliases].some((a) => a.toLowerCase().includes(q)));
      return n ? nebulaTarget(n) : null;
    },
    /** Debug: the direction (universe axes) of galactic longitude / latitude on Sol's sky, degrees. */
    skyDir: (l: number, b: number) => skyDirection(l, b),
    galaxy: (name: string) => {
      const g = findGalaxy(name);
      return g ? galaxyTarget(g) : null;
    },
    stats: () => ({ fps, patches: nearBody?.view.patchCount ?? 0, altitude: player.altitude }),
    generateSystem,
    /** Flight and time state, for scripted checks. */
    state: () => ({
      mode: flightMode(), speed: player.speed, speedSetting: player.speedSetting, limited: player.limited,
      timeRate, paused, simTime, selected: selected ? targetName(selected) : null,
      anchor: player.anchor.name, nearBody: nearBody?.body.name ?? null,
      /** A hover or scenic jump is still waiting for the ground height. */
      settling: hoverAlt !== null,
    }),
    time: timeCommand,
    /** Debug: jump the clock to a moment (ISO string or Unix ms); the HUD shows that date. */
    date: (when: string | number) => { simTime = simTimeAt(typeof when === 'number' ? when : Date.parse(when)); },
  },
});
