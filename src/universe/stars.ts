import { Rng } from '../core/rng';

export interface StarData {
  id: number;
  name: string;
  /** Galactic position, light years. */
  x: number;
  y: number;
  z: number;
  /** Effective temperature, kelvin. */
  temp: number;
  /** Solar units. */
  radius: number;
  lum: number;
  mass: number;
  /** Spectral classification such as "G2V". */
  cls: string;
  kind: 'main' | 'giant' | 'supergiant' | 'dwarf';
  level: number;
  isSol?: boolean;
  /** A place, not a star: the centre of a galaxy, used to aim and fly at it. Never has planets. */
  virtual?: boolean;
  /** A black hole's companion (see blackHoles.ts): its system has no planets. */
  noPlanets?: boolean;
}

export const SOL_ID = 0x50150150;

export function makeSol(x: number, y: number, z: number): StarData {
  return {
    id: SOL_ID, name: 'Sol', x, y, z,
    temp: 5772, radius: 1, lum: 1, mass: 1, cls: 'G2V', kind: 'main', level: 0, isSol: true,
  };
}

export function makeStar(id: number, level: number, x: number, y: number, z: number): StarData {
  const rng = new Rng(id);
  const boost = Math.pow(16, level);
  let lum = Math.pow(10, rng.gauss() * 0.85 - 1.5) * boost;
  lum = Math.min(Math.max(lum, 0.0004), 900000);

  let kind: StarData['kind'] = 'main';
  let temp: number;
  let mass: number;

  if (level === 0 && rng.chance(0.04)) {
    // White dwarf: tiny, hot, faint.
    kind = 'dwarf';
    temp = rng.logRange(6000, 32000);
    const radius = rng.range(0.008, 0.016);
    lum = radius * radius * Math.pow(temp / 5772, 4);
    mass = rng.range(0.5, 1.1);
    return finish(id, level, x, y, z, temp, radius, lum, mass, kind, rng);
  }

  if (lum > 25 && rng.chance(0.45)) {
    // Evolved star: cool and enormous.
    kind = lum > 6000 ? 'supergiant' : 'giant';
    temp = rng.range(3100, 5300);
    mass = kind === 'supergiant' ? rng.range(9, 28) : rng.range(0.9, 6);
  } else {
    mass = Math.pow(lum, 1 / 3.7);
    temp = Math.max(2400, 5772 * Math.pow(mass, 0.54) * rng.range(0.95, 1.05));
    temp = Math.min(temp, 48000);
  }
  const radius = Math.sqrt(lum) / Math.pow(temp / 5772, 2);
  return finish(id, level, x, y, z, temp, radius, lum, mass, kind, rng);
}

function finish(
  id: number, level: number, x: number, y: number, z: number,
  temp: number, radius: number, lum: number, mass: number, kind: StarData['kind'], rng: Rng,
): StarData {
  return { id, name: starName(rng, id), x, y, z, temp, radius, lum, mass, kind, level, cls: spectralClass(temp, kind) };
}

const CLASS_BOUNDS: [string, number, number][] = [
  ['O', 30000, 50000], ['B', 10000, 30000], ['A', 7500, 10000], ['F', 6000, 7500],
  ['G', 5200, 6000], ['K', 3700, 5200], ['M', 2400, 3700],
];

export function spectralClass(temp: number, kind: StarData['kind']): string {
  if (kind === 'dwarf') return temp > 12000 ? 'DA' : 'DC';
  let letter = 'M';
  let digit = 9;
  for (const [l, lo, hi] of CLASS_BOUNDS) {
    if (temp >= lo) {
      letter = l;
      digit = Math.min(9, Math.max(0, Math.floor((9.99 * (hi - temp)) / (hi - lo))));
      break;
    }
  }
  const suffix = kind === 'supergiant' ? 'Ia' : kind === 'giant' ? 'III' : 'V';
  return `${letter}${digit}${suffix}`;
}

const SYL_A = ['Al', 'Be', 'Ca', 'De', 'El', 'Fo', 'Ga', 'He', 'Ix', 'Ka', 'Lu', 'Me', 'Na', 'Or', 'Pra', 'Qua', 'Ri', 'Sa', 'Te', 'Ul', 'Ve', 'Xi', 'Ya', 'Zu', 'Thu', 'Sha', 'Ke', 'Mi', 'No', 'Ty'];
const SYL_B = ['ra', 'ni', 'ph', 'lo', 'ta', 'mi', 'ru', 'se', 'xa', 'do', 'vi', 'ko', 'the', 'nu', 'li', 'ga', 'ze', 'ba', 'ry', 'sha'];
const SYL_C = ['n', 'r', 's', 'x', 'th', 'l', 'm', 'k', 'ris', 'on', 'ar', 'us', 'is', 'ia', 'el', 'um', 'a', 'e', 'os', 'ae'];
const CATALOGS = ['HD', 'SE', 'GL', 'KOI', 'TYC', 'HIP'];

function starName(rng: Rng, id: number): string {
  if (rng.chance(0.55)) {
    return `${rng.pick(CATALOGS)} ${(id % 900000) + 100000}`;
  }
  let name = rng.pick(SYL_A) + rng.pick(SYL_B);
  if (rng.chance(0.7)) name += rng.pick(SYL_C);
  return name;
}

/** Approximate blackbody colour, linear RGB normalised so the max channel is 1. */
export function temperatureToRgb(kelvin: number): [number, number, number] {
  const t = Math.min(Math.max(kelvin, 1000), 40000) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.47 * Math.log(t) - 161.12;
    b = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
  } else {
    r = 329.7 * Math.pow(t - 60, -0.1332);
    g = 288.12 * Math.pow(t - 60, -0.0755);
    b = 255;
  }
  const lin = (v: number) => Math.pow(Math.min(Math.max(v, 0), 255) / 255, 2.2);
  const out: [number, number, number] = [lin(r), lin(g), lin(b)];
  const m = Math.max(out[0], out[1], out[2]);
  return [out[0] / m, out[1] / m, out[2] / m];
}
