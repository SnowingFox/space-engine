import { Rng } from '../core/rng';
import { SECONDS_PER_DAY } from '../core/units';
import { EPOCH_TT, basisQuaternion, type BodyData, type PlanetType, type Rgb, type SystemData } from './bodies';
import { iauRotation, orbitNormal, planetOrbit, poleFrame, raDecToApp, satelliteOrbit, type Orbit } from './ephemeris';
import { makeBody } from './system';
import type { StarData } from './stars';

interface Spec {
  name: string;
  type: PlanetType;
  radius: number; // km
  mass: number; // Earth masses
  au: number;
  temp: number;
  tilt: number; // degrees
  day: number; // days
  palette?: [Rgb, Rgb, Rgb, Rgb];
  sea?: number;
  clouds?: number;
  atmo?: { color: Rgb; density: number } | null;
  rings?: { inner: number; outer: number; color: Rgb } | null;
  moons?: { name: string; type: PlanetType; radius: number; mass: number; km: number; palette?: [Rgb, Rgb, Rgb, Rgb]; atmo?: { color: Rgb; density: number } }[];
}

const GREY: [Rgb, Rgb, Rgb, Rgb] = [[0.03, 0.03, 0.03], [0.12, 0.115, 0.11], [0.3, 0.29, 0.28], [0.5, 0.5, 0.5]];

const PLANETS: Spec[] = [
  { name: 'Mercury', type: 'barren', radius: 2440, mass: 0.055, au: 0.387, temp: 440, tilt: 0.03, day: 58.6, palette: [[0.04, 0.035, 0.03], [0.13, 0.12, 0.11], [0.27, 0.25, 0.23], [0.45, 0.43, 0.4]], atmo: null },
  { name: 'Venus', type: 'desert', radius: 6052, mass: 0.815, au: 0.723, temp: 737, tilt: 177, day: 243, palette: [[0.35, 0.2, 0.07], [0.6, 0.42, 0.17], [0.8, 0.68, 0.4], [0.3, 0.17, 0.07]], clouds: 1, atmo: { color: [1.0, 0.8, 0.45], density: 2.4 } },
  { name: 'Earth', type: 'terran', radius: 6371, mass: 1, au: 1, temp: 288, tilt: 23.4, day: 1, palette: [[0.004, 0.03, 0.12], [0.035, 0.1, 0.02], [0.3, 0.22, 0.1], [0.14, 0.12, 0.1]], sea: 0.7, clouds: 0.5, atmo: { color: [0.23, 0.48, 1.0], density: 1 },
    moons: [{ name: 'Moon', type: 'barren', radius: 1737, mass: 0.0123, km: 384400, palette: GREY }] },
  { name: 'Mars', type: 'desert', radius: 3390, mass: 0.107, au: 1.524, temp: 210, tilt: 25.2, day: 1.03, palette: [[0.1, 0.035, 0.015], [0.42, 0.14, 0.05], [0.62, 0.3, 0.13], [0.16, 0.07, 0.04]], clouds: 0.04, atmo: { color: [1.0, 0.55, 0.3], density: 0.18 } },
  { name: 'Jupiter', type: 'gas', radius: 69911, mass: 317.8, au: 5.203, temp: 165, tilt: 3.1, day: 0.41, palette: [[0.72, 0.56, 0.38], [0.45, 0.24, 0.12], [0.86, 0.8, 0.68], [0.3, 0.14, 0.07]], atmo: { color: [0.95, 0.78, 0.55], density: 0.9 }, rings: null,
    moons: [
      { name: 'Io', type: 'lava', radius: 1822, mass: 0.015, km: 421700, palette: [[1.0, 0.45, 0.05], [0.42, 0.36, 0.08], [0.72, 0.62, 0.18], [1.0, 0.8, 0.2]] },
      { name: 'Europa', type: 'ice', radius: 1561, mass: 0.008, km: 671100, palette: [[0.3, 0.16, 0.08], [0.6, 0.56, 0.48], [0.86, 0.85, 0.8], [0.35, 0.2, 0.1]] },
      { name: 'Ganymede', type: 'barren', radius: 2634, mass: 0.025, km: 1070400, palette: [[0.07, 0.06, 0.05], [0.2, 0.18, 0.16], [0.4, 0.38, 0.35], [0.62, 0.62, 0.6]] },
      { name: 'Callisto', type: 'barren', radius: 2410, mass: 0.018, km: 1882700, palette: [[0.03, 0.025, 0.02], [0.09, 0.08, 0.07], [0.2, 0.18, 0.15], [0.5, 0.48, 0.45]] },
    ] },
  { name: 'Saturn', type: 'gas', radius: 58232, mass: 95.2, au: 9.537, temp: 134, tilt: 26.7, day: 0.44, palette: [[0.8, 0.68, 0.44], [0.62, 0.5, 0.3], [0.9, 0.82, 0.62], [0.5, 0.38, 0.22]], atmo: { color: [0.95, 0.85, 0.6], density: 0.8 }, rings: { inner: 1.2794, outer: 2.4076, color: [0.82, 0.74, 0.6] },
    moons: [
      { name: 'Enceladus', type: 'ice', radius: 252, mass: 0.00002, km: 238000 },
      { name: 'Titan', type: 'desert', radius: 2575, mass: 0.0225, km: 1221870, palette: [[0.3, 0.17, 0.04], [0.55, 0.36, 0.1], [0.7, 0.5, 0.18], [0.25, 0.14, 0.04]], atmo: { color: [1.0, 0.65, 0.25], density: 2.2 } },
    ] },
  { name: 'Uranus', type: 'icegiant', radius: 25362, mass: 14.5, au: 19.19, temp: 76, tilt: 97.8, day: 0.72, palette: [[0.45, 0.72, 0.76], [0.4, 0.68, 0.74], [0.52, 0.78, 0.8], [0.36, 0.62, 0.7]], atmo: { color: [0.45, 0.8, 0.95], density: 0.9 }, rings: { inner: 1.6, outer: 2.0, color: [0.3, 0.32, 0.35] } },
  { name: 'Neptune', type: 'icegiant', radius: 24622, mass: 17.1, au: 30.07, temp: 72, tilt: 28.3, day: 0.67, palette: [[0.12, 0.25, 0.7], [0.08, 0.18, 0.58], [0.25, 0.42, 0.82], [0.05, 0.12, 0.45]], atmo: { color: [0.25, 0.45, 1.0], density: 1 }, rings: null,
    moons: [{ name: 'Triton', type: 'ice', radius: 1353, mass: 0.0036, km: 354800 }] },
];

export function makeSolSystem(star: StarData): SystemData {
  const rng = new Rng(20261110);
  const planets = PLANETS.map((s, i) => {
    const p = makeBody(rng, 0x5010 + i, s.name, s.type, s.temp);
    apply(p, s);
    p.maps = s.name.toLowerCase();
    rng.range(-0.03, 0.03); // (was a made-up inclination: still drawn so the moons keep their seeds)
    setOrbit(p, planetOrbit(s.name)!);
    p.seaLevel = s.sea ?? 0;
    p.clouds = s.clouds ?? 0;
    if (s.rings !== undefined) p.rings = s.rings ? { ...s.rings, seed: 7.3 + i } : null;
    for (const [m, ms] of (s.moons ?? []).entries()) {
      const moon = makeBody(rng, 0x5100 + i * 16 + m, ms.name, ms.type, s.temp);
      apply(moon, ms);
      moon.maps = ms.name.toLowerCase();
      moon.rings = null;
      moon.clouds = ms.atmo ? 1 : 0;
      moon.seaLevel = 0;
      rng.range(-0.08, 0.08);
      setOrbit(moon, satelliteOrbit(ms.name)!);
      moon.parent = p;
      p.moons.push(moon);
    }
    return p;
  });
  for (const p of planets) {
    setRotation(p);
    for (const m of p.moons) setRotation(m);
  }
  return { star, planets };
}

/** Elements to the body's fields: size, period, phase at the app's epoch, and the plane for the readouts. */
function setOrbit(b: BodyData, o: Orbit): void {
  b.orbit = o;
  b.orbitRadius = o.a;
  b.orbitPeriod = (2 * Math.PI) / o.n;
  const m = o.m0 + o.n * EPOCH_TT;
  b.orbitPhase = m - 2 * Math.PI * Math.floor(m / (2 * Math.PI));
  b.inclination = o.i;
  b.node = o.node;
}

const v = { x: 0, y: 0, z: 0 };

/** IAU pole and prime meridian at the app's epoch. */
function setRotation(b: BodyData): void {
  const r = iauRotation(b.name, EPOCH_TT)!;
  const f = poleFrame(r.ra, r.dec);
  const node = { x: f[0], y: f[3], z: f[6] };
  const pole = raDecToApp(r.ra, r.dec);
  b.orientation = basisQuaternion(node, pole);
  b.spinPhase = (((r.w % 360) + 360) % 360) * (Math.PI / 180);
  b.rotationPeriod = (360 / r.rate) * SECONDS_PER_DAY;
  // Obliquity: against the pole of the orbit as it stands at the epoch (the nodes of the Moon and
  // Triton turn by degrees per decade). A body turning backwards about its IAU north pole spins
  // about the opposite one (Venus: 177 degrees).
  const o = b.orbit!;
  const ref = orbitNormal({ ...o, i: o.i + o.iDot * EPOCH_TT, node: o.node + o.nodeDot * EPOCH_TT }, v);
  const tilt = Math.acos(Math.max(-1, Math.min(1, pole.x * ref.x + pole.y * ref.y + pole.z * ref.z)));
  b.axialTilt = r.rate < 0 ? Math.PI - tilt : tilt;
}

function apply(b: BodyData, s: { radius: number; mass: number; palette?: [Rgb, Rgb, Rgb, Rgb]; atmo?: { color: Rgb; density: number } | null }): void {
  b.radius = s.radius;
  b.mass = s.mass;
  if (s.palette) b.palette = s.palette;
  if (s.atmo !== undefined) b.atmosphere = s.atmo ? { ...s.atmo, height: 0.022 } : null;
}
