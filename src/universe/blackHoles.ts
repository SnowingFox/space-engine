import { Rng } from '../core/rng';
import { KM_PER_AU, SECONDS_PER_DAY } from '../core/units';
import type { StarData } from './stars';
// (Positions on Sol's sky go through universe.ts's fromSky, the one galactic-coordinate convention.)
import { GALAXIES, NAMED_GALAXIES, SOL, fromSky, type GalaxyData } from './universe';

// Black holes: Sagittarius A* at the centre of the Milky Way (the universe origin), a central one in
// most other galaxies (catalogued masses for the named ones, generated from size for the rest), and
// the real stellar-mass ones near Sol with their companion stars, at their real galactic coordinates.
// Units: positions in light years (universe axes), sizes in km unless noted.

/** Schwarzschild radius per solar mass, km (2GM/c^2). */
export const RS_PER_MSUN = 2.95325;
const DEG = Math.PI / 180;
const SIGMA = 5.670374e-8;
const G = 6.6743e-11;
const C = 2.99792458e8;
const M_SUN = 1.98847e30;
/** Eddington luminosity per solar mass, W. */
const L_EDD = 1.26e31;
const L_SUN = 3.828e26;

export interface DiscData {
  /** Inner and outer radius, Schwarzschild radii (inner: the ISCO, or where a faint disc is truncated). */
  rIn: number;
  rOut: number;
  /** Accretion rate as a fraction of the Eddington rate. */
  mdot: number;
  /** Peak effective temperature of the Shakura-Sunyaev profile, K. */
  tMax: number;
  /** Surface brightness at the peak in the HDR frame (a star's photosphere is about 4). */
  peak: number;
  /** How much of the light behind it the flow stops: a thin disc is opaque, a hot starved flow mostly transparent. */
  opacity: number;
}

export interface JetData {
  /** Length, Schwarzschild radii. */
  length: number;
  /** Bulk Lorentz factor. */
  gamma: number;
  /** Surface brightness scale at the base. */
  power: number;
  /** Bright knots: distance along the jet (fraction of its length) and relative brightness. */
  knots: [number, number][];
}

export interface BlackHoleData {
  id: number;
  name: string;
  kind: 'stellar' | 'supermassive';
  /** Solar masses. */
  mass: number;
  /** Dimensionless spin a* (null where unmeasured). The renderer's geodesics are Schwarzschild. */
  spin: number | null;
  /** Schwarzschild radius, km. */
  rs: number;
  /** Position, ly: the companion's for a binary (the hole orbits it), else the hole's own. */
  x: number; y: number; z: number;
  /** Spin / disc / jet axis, unit vector in universe axes. */
  axis: [number, number, number];
  disc: DiscData | null;
  jet: JetData | null;
  /** In words, for the info panel. */
  state: string;
  /** The star it orbits, for X-ray binaries. */
  companion: StarData | null;
  /** Relative orbit around the companion: separation (km), period (s), phase at t = 0. */
  orbit: { a: number; period: number; phase: number } | null;
  galaxy: GalaxyData | null;
  /** Visual luminosity of the accretion flow and jet, L☉ (what a distant point of light carries). */
  lumVis: number;
}

function norm(v: number[]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** An axis seen `incl` degrees from the line of sight from Sol, tipped `pa` degrees around it. */
function axisSeenFromSol(x: number, y: number, z: number, incl: number, pa: number): [number, number, number] {
  const u = norm([SOL.x - x, SOL.y - y, SOL.z - z]);
  // Two directions across the sight line: one in the galactic plane, one towards the north galactic pole.
  const e = norm([-u[2], 0, u[0]]);
  const n = norm([u[1] * e[2] - u[2] * e[1], u[2] * e[0] - u[0] * e[2], u[0] * e[1] - u[1] * e[0]]);
  const c = Math.cos(incl * DEG), s = Math.sin(incl * DEG);
  const cp = Math.cos(pa * DEG), sp = Math.sin(pa * DEG);
  return norm([0, 1, 2].map((i) => u[i] * c + s * (e[i] * cp + n[i] * sp)));
}

/** Peak temperature of a Shakura-Sunyaev disc (K): T^4 = 3GMMdot/(8 pi sigma r^3) (1 - sqrt(rIn/r)), maximal at r = 49/36 rIn. */
function peakTemperature(mass: number, mdot: number, rIn: number): number {
  const eta = 0.057;
  const mDot = (mdot * L_EDD * mass) / (eta * C * C);
  const rInM = rIn * RS_PER_MSUN * mass * 1000;
  const t4 = ((3 * G * mass * M_SUN * mDot) / (8 * Math.PI * SIGMA * rInM ** 3)) * (1 / 7) * (36 / 49) ** 3;
  return Math.pow(t4, 0.25);
}

/** Fraction of a blackbody's light that falls between 400 and 700 nm. */
function visibleFraction(t: number): number {
  const c2 = 0.014388; // m K
  let sum = 0;
  for (let i = 0; i < 30; i++) {
    const lam = (400 + (i + 0.5) * 10) * 1e-9;
    sum += (1 / lam ** 5 / (Math.exp(c2 / (lam * t)) - 1)) * 10e-9;
  }
  const total = (SIGMA * t ** 4) / Math.PI / (2 * 6.62607e-34 * C * C);
  return Math.min(sum / total, 1);
}

function makeDisc(mass: number, mdot: number, rIn: number, rOut: number): DiscData {
  const tMax = peakTemperature(mass, mdot, rIn);
  // A brightness scale, not a photometric one: the peak grows with the fourth root of the temperature, so a
  // ten-million-kelvin X-ray disc is dazzling next to a photosphere (about 4) without being 10^4 times over the
  // frame's range, and its structure still shows once the eye has adapted to it.
  const peak = Math.min(Math.max(4 * Math.pow(tMax / 5772, 0.25), 0.25), 9);
  return { rIn, rOut, mdot, tMax, peak, opacity: mdot < 1e-3 ? 0.45 : 1 };
}

function discLuminosity(bh: { mass: number; disc: DiscData | null }): number {
  if (!bh.disc) return 0;
  // Below ~1% of Eddington the flow is radiatively inefficient: it keeps most of its heat and falls in with it.
  const eta = 0.057 * Math.min(1, Math.sqrt(bh.disc.mdot / 0.01));
  const lBol = eta * bh.disc.mdot * L_EDD * bh.mass / L_SUN;
  // Most of a disc's light comes from a few times its inner radius, a little cooler than the peak.
  return lBol * visibleFraction(bh.disc.tMax * 0.7);
}

export const BLACK_HOLES: BlackHoleData[] = [];
/** Stars that belong to the black-hole binaries; the star sectors include them (see galaxy.ts). */
export const COMPANION_STARS: StarData[] = [];

let nextStarId = 0x7b1ac000;

function companionStar(name: string, pos: [number, number, number], cls: string, kind: StarData['kind'], mass: number, radius: number, temp: number): StarData {
  const lum = radius * radius * (temp / 5772) ** 4;
  // A level whose stars are about as luminous, so it streams in from as far as its kind are seen.
  const level = lum > 1e4 ? 4 : lum > 300 ? 3 : lum > 20 ? 2 : lum > 0.5 ? 1 : 0;
  const star: StarData = { id: nextStarId++, name, x: pos[0], y: pos[1], z: pos[2], temp, radius, lum, mass, cls, kind, level, noPlanets: true };
  COMPANION_STARS.push(star);
  return star;
}

function add(bh: Omit<BlackHoleData, 'id' | 'rs' | 'lumVis'>): BlackHoleData {
  const full: BlackHoleData = { ...bh, id: BLACK_HOLES.length, rs: RS_PER_MSUN * bh.mass, lumVis: 0 };
  full.lumVis = discLuminosity(full) + (bh.jet ? 0.01 * bh.mass * bh.jet.power : 0);
  BLACK_HOLES.push(full);
  return full;
}

interface BinarySpec {
  name: string; l: number; b: number; dist: number; mass: number; spin: number | null; incl: number; pa: number;
  periodDays: number; aAu: number; state: string; disc: [number, number, number] | null;
  star: [string, string, StarData['kind'], number, number, number];
}

function addBinary(s: BinarySpec): void {
  const pos = fromSky(s.l, s.b, s.dist);
  const [sName, cls, kind, sMass, sRadius, sTemp] = s.star;
  const companion = companionStar(sName, pos, cls, kind, sMass, sRadius, sTemp);
  add({
    name: s.name, kind: 'stellar', mass: s.mass, spin: s.spin, x: pos[0], y: pos[1], z: pos[2],
    axis: axisSeenFromSol(pos[0], pos[1], pos[2], s.incl, s.pa),
    disc: s.disc ? makeDisc(s.mass, s.disc[0], s.disc[1], s.disc[2]) : null, jet: null, state: s.state, companion,
    orbit: { a: s.aAu * KM_PER_AU, period: s.periodDays * SECONDS_PER_DAY, phase: (s.l * 7.3) % (2 * Math.PI) },
    galaxy: GALAXIES[0],
  });
}

function build(): void {
  const mw = GALAXIES[0];
  // Sgr A*: 4.15 million solar masses (GRAVITY Collaboration 2019); EHT 2022 favours a spin axis within ~50 deg
  // of our line of sight. Its inflow is ~1e-7 of the Eddington rate and radiatively inefficient (it shines at
  // ~1e-9 Eddington): a compact, mostly transparent hot flow, drawn with the thin-disc temperature profile.
  add({
    name: 'Sagittarius A*', kind: 'supermassive', mass: 4.15e6, spin: 0.9, x: mw.x, y: mw.y, z: mw.z,
    axis: axisSeenFromSol(mw.x, mw.y, mw.z, 40, 70),
    disc: makeDisc(4.15e6, 1e-7, 3, 60), jet: null,
    state: 'Hot, radiatively inefficient flow (~10⁻⁷ Eddington inflow)', companion: null, orbit: null, galaxy: mw,
  });

  // Stellar-mass black holes near Sol, with their companions.
  // Cygnus X-1: 21.2 M☉, a* > 0.9985, 2.22 kpc, i = 27.5 deg (Miller-Jones et al. 2021); HDE 226868 O9.7 Iab, 40.6 M☉.
  addBinary({
    name: 'Cygnus X-1', l: 71.33, b: 3.07, dist: 7240, mass: 21.2, spin: 0.9985, incl: 27.5, pa: 20,
    periodDays: 5.5998, aAu: 0.244, state: 'Persistent X-ray source: disc fed by its companion’s wind (~2% Eddington)',
    disc: [0.02, 3, 800], star: ['HDE 226868', 'O9.7Iab', 'supergiant', 40.6, 22.3, 31000],
  });
  // V404 Cygni: 9 M☉, 2.39 kpc, i = 67 deg (Miller-Jones et al. 2009, Khargharia et al. 2010); K3 III donor. Quiescent between outbursts.
  addBinary({
    name: 'V404 Cygni', l: 73.12, b: -2.09, dist: 7800, mass: 9, spin: null, incl: 67, pa: -30,
    periodDays: 6.473, aAu: 0.145, state: 'Quiescent X-ray nova (outbursts 1938, 1989, 2015); disc truncated inside',
    disc: [3e-6, 40, 3000], star: ['V404 Cygni K', 'K3III', 'giant', 0.7, 6.0, 4274],
  });
  // Gaia BH1: 9.62 M☉ around a Sun-like star, P = 185.6 d, a = 1.4 AU, 480 pc (El-Badry et al. 2023). Dormant: no disc.
  addBinary({
    name: 'Gaia BH1', l: 22.63, b: 18.05, dist: 1566, mass: 9.62, spin: null, incl: 126.6, pa: 50,
    periodDays: 185.6, aAu: 1.4, state: 'Dormant: no accretion', disc: null,
    star: ['Gaia BH1 star', 'G2V', 'main', 0.93, 0.99, 5850],
  });
  // A0620-00 (V616 Mon): 6.6 M☉, a* = 0.12, 1.06 kpc, P = 7.75 h, i = 51 deg (Cantrell et al. 2010, Gou et al. 2010).
  addBinary({
    name: 'A0620-00', l: 209.96, b: -6.54, dist: 3460, mass: 6.6, spin: 0.12, incl: 51, pa: 10,
    periodDays: 0.323, aAu: 0.0176, state: 'Quiescent X-ray nova (outburst 1975); faint truncated disc',
    disc: [1e-6, 30, 1200], star: ['V616 Monocerotis', 'K5V', 'main', 0.4, 0.67, 4400],
  });

  // Central black holes of the other galaxies.
  const NAMED: Record<string, [string, number, number?]> = {
    'Andromeda (M31)': ['M31*', 1.4e8, 1e-6], 'M32': ['M32*', 2.5e6], "Bode's Galaxy (M81)": ['M81*', 7e7, 1e-5],
    'Cigar Galaxy (M82)': ['M82*', 3e7], 'Sculptor (NGC 253)': ['NGC 253*', 1e7], 'Centaurus A': ['Centaurus A*', 5.5e7, 1e-4],
    'Southern Pinwheel (M83)': ['M83*', 1e7], 'Pinwheel (M101)': ['M101*', 2.5e6], 'Whirlpool (M51)': ['M51*', 1e6, 1e-4],
    'Sombrero (M104)': ['M104*', 1e9, 1e-6], 'Virgo A (M87)': ['M87*', 6.5e9, 3e-4], 'NGC 1300': ['NGC 1300*', 7.3e7],
  };
  for (const g of GALAXIES) {
    if (g.id === 0) continue;
    const rng = new Rng(9100 + g.id);
    const named = g.id < NAMED_GALAXIES ? NAMED[g.name] : undefined;
    if (g.id < NAMED_GALAXIES && !named) continue;
    if (!named && g.kind === 'irregular') continue;
    const normal: [number, number, number] = [g.axes[3], g.axes[4], g.axes[5]];
    let axis = norm(normal.map((v) => v + rng.gauss() * 0.3));
    let mass: number, mdot: number;
    if (named) {
      mass = named[1];
      mdot = named[2] ?? 1e-7;
    } else {
      const base = g.kind === 'elliptical' ? 1.5e8 : g.kind === 'lenticular' ? 6e7 : 2e7;
      mass = base * Math.pow(g.radius / 50000, 2.5) * Math.pow(10, rng.gauss() * 0.35);
      // Most nuclei are starved; a few shine as quasars.
      mdot = rng.chance(0.03) ? rng.range(0.05, 0.4) : Math.pow(10, rng.range(-8.5, -3.5));
    }
    let jet: JetData | null = null;
    let state = mdot > 0.01 ? 'Quasar: luminous thin disc' : mdot > 1e-5 ? 'Low-luminosity active nucleus' : 'Starved: hot, faint flow';
    if (g.name === 'Virgo A (M87)') {
      // M87*: 6.5e9 M☉ (EHT 2019), jet ~17 deg from our line of sight, bulk Lorentz factor ~ 3-6 (HST-1 superluminal).
      axis = axisSeenFromSol(g.x, g.y, g.z, 17, 108);
      // Knots along the deprojected ~5 kpc jet: HST-1, D, E, F, I, A, B, C.
      const kpc = 3.086e16 / RS_PER_MSUN / mass;
      jet = {
        length: 5 * kpc, gamma: 3.2, power: 1.1,
        knots: [[0.046, 2.5], [0.19, 1.2], [0.32, 0.8], [0.48, 1.0], [0.6, 0.9], [0.68, 2.6], [0.76, 1.8], [0.94, 0.9]],
      };
      state = 'Low-luminosity active nucleus with a relativistic jet';
    } else if (g.name === 'Centaurus A') {
      axis = axisSeenFromSol(g.x, g.y, g.z, 55, 55);
      const kpc = 3.086e16 / RS_PER_MSUN / mass;
      jet = { length: 4 * kpc, gamma: 1.6, power: 0.5, knots: [[0.1, 1.5], [0.3, 1.2], [0.55, 0.8]] };
      state = 'Active nucleus with a relativistic jet';
    }
    const quasar = mdot > 0.01;
    add({
      name: named ? named[0] : `${g.name}*`, kind: 'supermassive', mass, spin: named ? null : Math.round(rng.range(0.2, 0.98) * 100) / 100,
      x: g.x, y: g.y, z: g.z, axis, disc: makeDisc(mass, mdot, 3, quasar ? 600 : 80), jet, state, companion: null, orbit: null, galaxy: g,
    });
  }
}
build();

/** The hole's offset from its catalogue position (its companion) at a simulation time, km. */
export function blackHoleOffset(bh: BlackHoleData, simTime: number, out: { x: number; y: number; z: number }): void {
  out.x = out.y = out.z = 0;
  const o = bh.orbit;
  if (!o) return;
  const [nx, ny, nz] = bh.axis;
  // Two axes in the orbital plane.
  let ex = -nz, ey = 0, ez = nx;
  let l = Math.hypot(ex, ey, ez);
  if (l < 1e-6) { ex = 1; ez = 0; l = 1; }
  ex /= l; ey /= l; ez /= l;
  const fx = ny * ez - nz * ey, fy = nz * ex - nx * ez, fz = nx * ey - ny * ex;
  const ph = o.phase + (2 * Math.PI * simTime) / o.period;
  const c = Math.cos(ph) * o.a, s = Math.sin(ph) * o.a;
  out.x = ex * c + fx * s;
  out.y = ey * c + fy * s;
  out.z = ez * c + fz * s;
}

/** The black hole at the centre of a galaxy, if it has one. */
export function centralBlackHole(g: GalaxyData): BlackHoleData | null {
  return BLACK_HOLES.find((b) => b.galaxy === g && b.kind === 'supermassive') ?? null;
}
