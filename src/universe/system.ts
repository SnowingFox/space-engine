import { Rng, hash32 } from '../core/rng';
import { EARTH_RADIUS_KM, KM_PER_AU, SECONDS_PER_DAY } from '../core/units';
import { GM_EARTH, GM_SUN, keplerPeriod, type Atmosphere, type BodyData, type PlanetType, type SystemData } from './bodies';
import { hsl, makePalette } from './palette';
import { makeSolSystem } from './sol';
import type { StarData } from './stars';

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

const cache = new Map<number, SystemData>();

/** Deterministic: the same star always yields the same planets. Recent results are cached. */
export function generateSystem(star: StarData): SystemData {
  let system = cache.get(star.id);
  if (!system) {
    system = star.isSol ? makeSolSystem(star) : buildSystem(star);
    if (cache.size > 48) cache.delete(cache.keys().next().value!);
    cache.set(star.id, system);
  }
  return system;
}

function buildSystem(star: StarData): SystemData {

  const rng = new Rng(hash32(star.id, 0xbeef));
  const maxPlanets = star.kind === 'dwarf' ? 3 : star.kind === 'main' ? 9 : 5;
  const count = rng.int(star.kind === 'main' ? 2 : 0, maxPlanets);
  const lumRoot = Math.sqrt(star.lum);
  const frostLine = 2.7 * lumRoot;
  // Keep the first orbit clear of the stellar surface.
  const minOrbitAu = Math.max(0.12 * lumRoot, (star.radius * 695700 * 3) / KM_PER_AU);
  let au = minOrbitAu * rng.range(1, 3);

  const planets: BodyData[] = [];
  for (let i = 0; i < count; i++) {
    const temp = (278 * Math.pow(star.lum, 0.25)) / Math.sqrt(au);
    const type = pickType(rng, temp, au > frostLine);
    const p = makeBody(rng, hash32(star.id, i, 0xa11), `${star.name} ${ROMAN[i]}`, type, temp);
    p.orbitRadius = au * KM_PER_AU;
    p.orbitPeriod = keplerPeriod(p.orbitRadius, GM_SUN * star.mass);
    p.inclination = rng.range(-0.06, 0.06);
    addMoons(rng, p, star.id, i);
    planets.push(p);
    au *= rng.range(1.45, 2.1);
  }
  return { star, planets };
}

function pickType(rng: Rng, temp: number, beyondFrost: boolean): PlanetType {
  const r = rng.next();
  if (beyondFrost) return r < 0.5 ? 'gas' : r < 0.75 ? 'icegiant' : 'ice';
  if (temp > 1000) return r < 0.8 ? 'lava' : 'barren';
  if (temp > 330) return r < 0.5 ? 'desert' : r < 0.9 ? 'barren' : 'gas';
  if (temp > 235) return r < 0.42 ? 'terran' : r < 0.6 ? 'ocean' : r < 0.85 ? 'desert' : 'barren';
  return r < 0.45 ? 'barren' : r < 0.75 ? 'desert' : 'ice';
}

export function makeBody(rng: Rng, id: number, name: string, type: PlanetType, temp: number): BodyData {
  const giant = type === 'gas' || type === 'icegiant';
  const earthRadii = type === 'gas' ? rng.range(6, 13) : type === 'icegiant' ? rng.range(3, 5) : rng.logRange(0.3, 1.9);
  const mass = type === 'gas' ? rng.logRange(50, 1500) : type === 'icegiant' ? rng.range(8, 25) : Math.pow(earthRadii, 3.7);
  return {
    id, name, type,
    radius: earthRadii * EARTH_RADIUS_KM,
    mass,
    orbitRadius: 0,
    orbitPeriod: 1,
    orbitPhase: rng.range(0, Math.PI * 2),
    inclination: 0,
    node: rng.range(0, Math.PI * 2),
    axialTilt: rng.range(0, 0.5),
    rotationPeriod: (giant ? rng.range(0.35, 0.8) : rng.range(0.6, 3)) * SECONDS_PER_DAY,
    temp,
    atmosphere: makeAtmosphere(rng, type, earthRadii),
    rings: giant && rng.chance(type === 'gas' ? 0.5 : 0.3)
      ? { inner: rng.range(1.25, 1.6), outer: rng.range(1.9, 2.7), color: hsl(rng.range(0.05, 0.13), rng.range(0.1, 0.4), rng.range(0.5, 0.75)), seed: rng.range(0, 100) }
      : null,
    palette: makePalette(type, rng),
    seed: rng.range(0, 500),
    seaLevel: type === 'ocean' ? rng.range(0.85, 0.97) : type === 'terran' ? rng.range(0.45, 0.72) : 0,
    clouds: type === 'terran' || type === 'ocean' ? rng.range(0.35, 0.65) : type === 'desert' ? rng.range(0, 0.15) : 0,
    moons: [],
    parent: null,
  };
}

function makeAtmosphere(rng: Rng, type: PlanetType, earthRadii: number): Atmosphere | null {
  switch (type) {
    case 'terran':
    case 'ocean':
      return { color: [0.23, 0.48, 1.0], density: rng.range(0.8, 1.3), height: 0.022 };
    case 'desert':
      return rng.chance(0.8) ? { color: [1.0, 0.56, 0.3], density: rng.range(0.25, 0.7), height: 0.02 } : null;
    case 'lava':
      return { color: [1.0, 0.35, 0.15], density: rng.range(0.3, 0.6), height: 0.02 };
    case 'ice':
      return rng.chance(0.5) ? { color: [0.5, 0.75, 1.0], density: rng.range(0.2, 0.6), height: 0.02 } : null;
    case 'gas':
      return { color: [0.95, 0.75, 0.5], density: 0.9, height: 0.018 };
    case 'icegiant':
      return { color: [0.35, 0.7, 1.0], density: 1.0, height: 0.02 };
    default:
      return earthRadii > 5 ? { color: [0.6, 0.7, 1], density: 0.5, height: 0.02 } : null;
  }
}

function addMoons(rng: Rng, p: BodyData, starId: number, index: number): void {
  const giant = p.type === 'gas' || p.type === 'icegiant';
  const n = giant ? rng.int(1, 5) : rng.chance(0.45) ? rng.int(1, 2) : 0;
  let orbit = p.radius * rng.range(giant ? 3.2 : 12, giant ? 6 : 40);
  for (let m = 0; m < n; m++) {
    const type: PlanetType = p.temp < 200 ? (rng.chance(0.6) ? 'ice' : 'barren') : rng.chance(0.85) ? 'barren' : 'desert';
    const moon = makeBody(rng, hash32(starId, index, m + 1, 0x300), `${p.name}${String.fromCharCode(97 + m)}`, type, p.temp);
    moon.radius = Math.min(rng.logRange(300, 2800), p.radius * 0.3);
    moon.mass = Math.pow(moon.radius / EARTH_RADIUS_KM, 3.5);
    if (moon.radius < 1500) moon.atmosphere = null;
    moon.clouds = 0;
    moon.rings = null;
    moon.orbitRadius = orbit;
    moon.orbitPeriod = keplerPeriod(orbit, GM_EARTH * p.mass);
    moon.inclination = rng.range(-0.12, 0.12);
    moon.rotationPeriod = moon.orbitPeriod; // tidally locked
    moon.parent = p;
    p.moons.push(moon);
    orbit *= rng.range(1.5, 2.2);
  }
}
