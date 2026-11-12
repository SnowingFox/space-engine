import { Rng } from '../core/rng';
import { gnoise } from './galaxyNoise';

// The universe is a box of galaxies around the Milky Way, which sits at the origin
// with its disc in the XZ plane. Units: light years.

export type GalaxyKind = 'spiral' | 'barred spiral' | 'elliptical' | 'lenticular' | 'irregular';

export interface GalaxyData {
  /** Index in GALAXIES for the catalogued ones; generated ones (cosmos.ts) have ids of their own above them. */
  id: number;
  name: string;
  kind: GalaxyKind;
  x: number; y: number; z: number;
  /** Rows: the galaxy's own X, Y (disc normal) and Z axes in universe coordinates. */
  axes: number[];
  radius: number;
  /** Exponential scale length of the disc, scale height of its stars, scale of the bulge. */
  discScale: number;
  height: number;
  bulgeScale: number;
  /** How much the bulge is squashed along the disc normal. */
  bulgeFlat: number;
  arms: number;
  /** 1 / tan(pitch angle) of the spiral arms. */
  pitchK: number;
  /** 0: smooth disc, 1: grand-design arms. */
  armContrast: number;
  dust: number;
  /** Light per light year at the centre of the bulge / of the disc. */
  bulgeLum: number;
  discLum: number;
  /** How blue the young stars in the arms are, 0..1. */
  blue: number;
  /** 0: orderly, 1: ragged star clouds. */
  irregular: number;
  seed: number;
  /** Elongation of the bulge into a bar (1: round); unset, 1.8 for barred spirals. */
  bar?: number;
  /** Giant star-forming regions (its own frame): x, z, radius (ly), brightness relative to the disc. */
  knots?: [number, number, number, number][];
  /** Where the bar's centre sits off the disc's (its own frame, x and z, ly). */
  barShift?: [number, number];
  /** Direction of the bar's long axis in the galaxy's own plane, atan2(z, x) (radians); unset, along X. */
  barAngle?: number;
  /** Colour of its old stars where not the usual warm one (with barShift set). */
  tint?: [number, number, number];
  /** How its arms depart from a clean pattern, 0..1 each (unset: drawn from its seed; the Milky Way's are 0). */
  flocculent?: number;
  spurs?: number;
  lopsided?: number;
  /** How much its disc is drawn out along the bar (1: round). */
  elongation?: number;
  /** Luminosity, in the Milky Way's (generated galaxies, cosmos.ts). */
  lum?: number;
  /**
   * A ring: radius (fraction of the radius), brightness of its young stars relative to the disc there (above 1, the
   * disc inside it and beyond it is cleared, as in a collisional or Hoag-type ring), spokes (count; negative: the
   * ring is polar, round the disc's axis), and a ring of dust at the same radius (the Sombrero's).
   */
  ring?: [number, number, number, number];
  /** Tidal tails (an interacting galaxy's, out to its radius), shells (an elliptical's), a starburst's outflow. */
  tails?: number;
  shells?: number;
  outflow?: number;
  /** How far its disc is warped: the plane's height at the edge, in radii, up on one side and down on the other. */
  warp?: number;
  /** What it is, in words, where its kind says too little (a ring galaxy, a polar ring, a dwarf spheroidal...). */
  type?: string;
}

/** Fractional part of a hash of a galaxy's seed: a value of its own that draws nothing from the generator. */
function seeded(seed: number, k: number): number {
  const v = Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

/** How a galaxy's arms depart from a clean spiral, as the march reads it (galaxyShader gArmStructure). */
export function armStructureOf(g: GalaxyData): { flocculent: number; spurs: number; lopsided: number; elongation: number } {
  const spiral = g.kind === 'spiral' || g.kind === 'barred spiral';
  // Grand-design spirals keep long arms with spurs; the less contrast, the more flocculent.
  const floc = spiral ? 0.15 + 0.6 * (1 - g.armContrast) + 0.25 * seeded(g.seed, 1) : g.kind === 'irregular' ? 0.7 : 0;
  return {
    flocculent: g.flocculent ?? Math.min(floc, 1),
    spurs: g.spurs ?? (spiral ? 0.35 + 0.5 * seeded(g.seed, 2) : 0),
    lopsided: g.lopsided ?? (spiral ? 0.4 * seeded(g.seed, 3) : g.kind === 'irregular' ? 0.5 : 0),
    elongation: g.elongation ?? 1,
  };
}

export const MILKY_WAY_RADIUS = 52000;
const DEG = Math.PI / 180;
/** Where Sol sits in the Milky Way; directions on its sky are given in galactic longitude and latitude. */
export const SOL = { x: 26000, y: 18, z: 900 };

export function randomAxes(rng: Rng): number[] {
  // A random orthonormal frame: pick the disc normal, then spin around it.
  const u = rng.range(-1, 1), ph = rng.range(0, Math.PI * 2), s = Math.sqrt(1 - u * u);
  return axesFromNormal(s * Math.cos(ph), u, s * Math.sin(ph), rng.range(0, Math.PI * 2));
}

function axesFromNormal(nx: number, ny: number, nz: number, spin: number): number[] {
  const l = Math.hypot(nx, ny, nz);
  nx /= l; ny /= l; nz /= l;
  // Any vector not parallel to the normal gives a first in-plane axis.
  let ax = Math.abs(ny) < 0.9 ? 0 : 1, ay = Math.abs(ny) < 0.9 ? 1 : 0, az = 0;
  const d = ax * nx + ay * ny + az * nz;
  ax -= d * nx; ay -= d * ny; az -= d * nz;
  const al = Math.hypot(ax, ay, az);
  ax /= al; ay /= al; az /= al;
  const bx = ny * az - nz * ay, by = nz * ax - nx * az, bz = nx * ay - ny * ax;
  const c = Math.cos(spin), sn = Math.sin(spin);
  const xx = ax * c + bx * sn, xy = ay * c + by * sn, xz = az * c + bz * sn;
  // Z = X x Y keeps the frame right-handed.
  return [xx, xy, xz, nx, ny, nz, xy * nz - xz * ny, xz * nx - xx * nz, xx * ny - xy * nx];
}

export function shape(kind: GalaxyKind, radius: number, rng: Rng): Omit<GalaxyData, 'id' | 'name' | 'kind' | 'x' | 'y' | 'z' | 'axes' | 'radius'> {
  const seed = rng.range(0, 50);
  if (kind === 'elliptical') {
    const bulgeScale = radius * rng.range(0.1, 0.16);
    return {
      discScale: radius * 0.2, height: radius * 0.02, bulgeScale, bulgeFlat: rng.range(1, 1.7),
      arms: 2, pitchK: 4, armContrast: 0, dust: 0, bulgeLum: rng.range(0.5, 0.9) / bulgeScale, discLum: 0, blue: 0, irregular: 0, seed,
    };
  }
  if (kind === 'lenticular') {
    const bulgeScale = radius * rng.range(0.05, 0.08);
    return {
      discScale: radius * 0.2, height: radius * 0.018, bulgeScale, bulgeFlat: 1.5,
      arms: 2, pitchK: 4, armContrast: 0, dust: rng.range(0.1, 0.5), bulgeLum: 0.8 / bulgeScale, discLum: 3.2e-4, blue: 0.1, irregular: 0.1, seed,
    };
  }
  if (kind === 'irregular') {
    return {
      discScale: radius * 0.3, height: radius * 0.05, bulgeScale: radius * 0.05, bulgeFlat: 1.3,
      arms: 1, pitchK: 2.5, armContrast: rng.range(0.1, 0.35), dust: rng.range(0.4, 0.9), bulgeLum: 0.12 / (radius * 0.05),
      discLum: 2.6e-4, blue: rng.range(0.8, 1), irregular: rng.range(0.7, 1), seed,
    };
  }
  const bulgeScale = radius * rng.range(0.025, 0.05);
  return {
    discScale: radius * rng.range(0.16, 0.21), height: radius * rng.range(0.011, 0.016), bulgeScale, bulgeFlat: rng.range(1.4, 1.9),
    arms: rng.pick([2, 2, 2, 3, 4]), pitchK: 1 / Math.tan(rng.range(11, 24) * DEG), armContrast: rng.range(0.55, 1),
    dust: rng.range(0.7, 1.3), bulgeLum: rng.range(0.9, 1.5) / bulgeScale, discLum: rng.range(2.2e-4, 3.2e-4), blue: rng.range(0.5, 1),
    irregular: rng.range(0.15, 0.45), seed,
  };
}

/**
 * Galactic coordinates (x towards the centre, y towards l = 90 deg, z to the north galactic pole) to the
 * universe's axes, a proper rotation (determinant +1, the real sky, not its mirror image): l = 0 points from
 * Sol exactly at the Milky Way's centre, l = 90 deg along the direction the disc turns at Sol, the pole is
 * the disc's normal. Row-major, universe = GAL_TO_APP * galactic.
 */
const SOL_TURN = Math.atan2(SOL.z, SOL.x);
export const GAL_TO_APP: readonly number[] = [
  -Math.cos(SOL_TURN), -Math.sin(SOL_TURN), 0,
  0, 0, 1,
  -Math.sin(SOL_TURN), Math.cos(SOL_TURN), 0,
];

/** Galactic longitude / latitude (degrees) and distance from Sol to universe coordinates. */
export function fromSky(l: number, b: number, dist: number): [number, number, number] {
  const cb = Math.cos(b * DEG);
  const gx = cb * Math.cos(l * DEG), gy = cb * Math.sin(l * DEG), gz = Math.sin(b * DEG);
  const m = GAL_TO_APP;
  return [
    SOL.x + dist * (m[0] * gx + m[1] * gy + m[2] * gz),
    SOL.y + dist * (m[3] * gx + m[4] * gy + m[5] * gz),
    SOL.z + dist * (m[6] * gx + m[7] * gy + m[8] * gz),
  ];
}

/** Axes for a galaxy at (l, b) on Sol's sky whose disc is seen `tilt` degrees from face-on from Sol. */
function facing(l: number, b: number, tilt: number, spin: number): number[] {
  const [x, y, z] = fromSky(l, b, 1);
  const ux = x - SOL.x, uy = y - SOL.y, uz = z - SOL.z;
  // Tipped about a horizontal line across the sight line.
  let px = -uz, pz = ux;
  const pl = Math.hypot(px, pz);
  px /= pl; pz /= pl;
  const c = Math.cos(tilt * DEG), s = Math.sin(tilt * DEG);
  return axesFromNormal(-ux * c + px * s, -uy * c, -uz * c + pz * s, spin);
}

/** Equatorial (J2000, degrees) to galactic longitude and latitude (degrees). */
function galacticOf(ra: number, dec: number): [number, number] {
  const a = ra * DEG, d = dec * DEG;
  const x = Math.cos(d) * Math.cos(a), y = Math.cos(d) * Math.sin(a), z = Math.sin(d);
  // (The IAU rotation from equatorial to galactic axes.)
  const gx = -0.0548755604 * x - 0.8734370902 * y - 0.4838350155 * z;
  const gy = 0.4941094279 * x - 0.44482963 * y + 0.7469822445 * z;
  const gz = -0.867666149 * x - 0.1980763734 * y + 0.4559837762 * z;
  return [(Math.atan2(gy, gx) / DEG + 360) % 360, Math.asin(gz) / DEG];
}

/** Right ascension and declination (J2000, degrees) and distance from Sol (ly) to universe coordinates. */
function fromRaDec(ra: number, dec: number, dist: number): [number, number, number] {
  return fromSky(...galacticOf(ra, dec), dist);
}

/** A point `d` ly from `c`, across the line of sight from Sol, at an angle `angle` round it. */
function offsetFrom(c: [number, number, number], d: number, angle: number): [number, number, number] {
  const u = [c[0] - SOL.x, c[1] - SOL.y, c[2] - SOL.z];
  const l = Math.hypot(u[0], u[1], u[2]);
  const f = u.map((v) => v / l);
  const e1 = [-f[2], 0, f[0]].map((v, _, a) => v / Math.hypot(a[0], a[1], a[2]));
  const e2 = [f[1] * e1[2] - f[2] * e1[1], f[2] * e1[0] - f[0] * e1[2], f[0] * e1[1] - f[1] * e1[0]];
  return [0, 1, 2].map((i) => c[i] + d * (Math.cos(angle) * e1[i] + Math.sin(angle) * e2[i])) as [number, number, number];
}

function build(): GalaxyData[] {
  const list: GalaxyData[] = [];
  const rng = new Rng(20260411);
  const add = (name: string, kind: GalaxyKind, pos: [number, number, number], radius: number, axes?: number[], tweak?: Partial<GalaxyData>): void => {
    list.push({ id: list.length, name, kind, x: pos[0], y: pos[1], z: pos[2], axes: axes ?? randomAxes(rng), radius, ...shape(kind, radius, rng), ...tweak });
  };

  add('Milky Way', 'barred spiral', [0, 0, 0], MILKY_WAY_RADIUS, [1, 0, 0, 0, 1, 0, 0, 0, 1], {
    // The arms trail the disc's turn (which at Sol is towards l = 90 deg, +Z): seen from the north galactic
    // pole the Galaxy turns clockwise and its arms wind out anticlockwise, hence the negative pitch. The bar's
    // near end is at l = +27 deg (Wegg, Gerhard & Portail 2015).
    discScale: 9500, height: 700, bulgeScale: 1900, bulgeFlat: 1.7, arms: 2, pitchK: -1 / Math.tan(13.5 * DEG), armContrast: 1,
    dust: 1, bulgeLum: 6.0e-4, discLum: 2.7e-4, blue: 0.8, irregular: 0.3, seed: 3.7,
    barShift: [0, 0], barAngle: Math.atan2(SOL.z, SOL.x) + 27 * DEG,
    // (Its arms as they were: the sky from Sol is tuned on them.)
    flocculent: 0, spurs: 0, lopsided: 0,
  });
  // The Local Group and the famous neighbours, roughly where they are on Sol's sky.
  // The Magellanic Clouds. The LMC: a disc seen ~35 deg from face-on with a bar and one ragged arm, some
  // 10 deg across on Sol's sky, and 30 Doradus, the brightest star-forming region of the Local Group, at the
  // bar's end (van der Marel & Kallivayalil 2014). The SMC: a lumpy elongated bar of young blue stars, ~5 x 3 deg.
  // (The LMC's axes are set, but random ones are still drawn: every generated galaxy stays as it was.)
  randomAxes(rng);
  add('Large Magellanic Cloud', 'irregular', fromSky(280.5, -32.9, 163e3), 15000, facing(280.5, -32.9, 35, 0.9), {
    // (30 Doradus, the largest; N11 and N44 smaller. The bar sits some 1.5 kly off the disc's centre.)
    // A barred Magellanic spiral, as the wide-field photographs show it: a bright bar of star clouds off the
    // disc's centre, one arm wound out from its end (to the north-east, 30 Doradus on it), a faint patchy disc.
    // (Two arms, one of them all but gone: a single arm of the width real ones have.)
    // (Wound tightly enough to sweep half round the disc, from 3 to 12 kly out.)
    arms: 2, pitchK: 2.2, armContrast: 1.6, bar: 3.5, bulgeScale: 1400, bulgeFlat: 2.5, bulgeLum: 0.22 / 750, discLum: 0.6e-4,
    discScale: 4500, height: 650, irregular: 0.62, blue: 0.95, dust: 0.5, barShift: [-800, 1200], tint: [0.84, 0.82, 1.0],
    flocculent: 0.25, spurs: 0, lopsided: 1,
    knots: [[3200, 2400, 1800, 3.2], [-5200, -2600, 900, 1.5], [1200, -3600, 700, 1.2]],
  });
  // (Its light as a whole is the one matched to the survey's LMC from Sol, scripts/textures/pano_spot.py, with
  // the disc and bar of then: only its share between them has changed.)
  {
    const lmc = list[list.length - 1];
    // (And 0.7: with more of it in the bar and the arm, less is lost in its dust; so it is as bright from Sol as before.)
    const k = 0.7 * lightOf({ ...lmc, discLum: 0.6e-4, bulgeLum: 0.16 / 750 }) / lightOf(lmc);
    lmc.discLum *= k;
    lmc.bulgeLum *= k;
    // 30 Doradus on the arm some 5 kly out, beyond the bar's end: the arm's brightest point at that distance.
    // (With the march's wobble of the arms' angle, gDiscPolar.)
    const d30 = lmc.knots![0], r30 = 5000;
    let best = -1, bestTh = 0;
    for (let i = 0; i < 360; i++) {
      const th = (i / 360) * Math.PI * 2;
      const warped = th + 0.2 * Math.sin(r30 / (lmc.radius * 0.1) + lmc.seed) + 0.08 * Math.sin(3 * th + r30 / (lmc.radius * 0.048));
      const a = armStrengthOf(lmc, r30 * Math.cos(th), r30 * Math.sin(th), warped);
      if (a > best) { best = a; bestTh = th; }
    }
    d30[0] = r30 * Math.cos(bestTh);
    d30[1] = r30 * Math.sin(bestTh);
  }
  add('Small Magellanic Cloud', 'irregular', fromSky(302.8, -44.3, 200e3), 9000, undefined, {
    // (NGC 346, its brightest star-forming region, and the Wing of young stars reaching towards the LMC.)
    // Lumpy and drawn out along its bar, the Wing of young stars off one end.
    arms: 1, armContrast: 0.15, bar: 2.6, bulgeScale: 1000, bulgeFlat: 1.6, bulgeLum: 0.012 / 450, discLum: 0.8e-4,
    barShift: [0, 0], tint: [0.82, 0.82, 1.0], flocculent: 0.9, lopsided: 0.8, elongation: 1.9,
    discScale: 2800, height: 900, irregular: 0.9, blue: 1, dust: 0.3,
    knots: [[600, 300, 700, 2], [3500, 1500, 1600, 1]],
  });
  add('Andromeda (M31)', 'spiral', fromSky(121.2, -21.6, 2.54e6), 76000, undefined, { arms: 2, armContrast: 0.85, blue: 0.7, flocculent: 0.45, spurs: 0.5, lopsided: 0.3 });
  add('Triangulum (M33)', 'spiral', fromSky(133.6, -31.3, 2.73e6), 30000, undefined, { arms: 3, armContrast: 0.5, blue: 1, irregular: 0.5, flocculent: 0.85, spurs: 0.3 });
  add('NGC 6822', 'irregular', fromSky(25.3, -18.4, 1.6e6), 3500);
  add('IC 10', 'irregular', fromSky(119, -3.3, 2.2e6), 2500);
  add('M32', 'elliptical', fromSky(121.1, -22, 2.49e6), 4000);
  add('M110', 'elliptical', fromSky(120.7, -21.1, 2.69e6), 8500);
  add('Sculptor (NGC 253)', 'spiral', fromSky(97.4, -88, 11.4e6), 45000);
  add("Bode's Galaxy (M81)", 'spiral', fromSky(142.1, 40.9, 11.8e6), 48000, undefined, { arms: 2, armContrast: 1 });
  // A starburst: red filaments of hot gas blown out along its axis.
  add('Cigar Galaxy (M82)', 'irregular', fromSky(141.4, 40.6, 11.5e6), 18500, undefined, { outflow: 1.2, type: 'Starburst galaxy' });
  // A giant elliptical with a warped disc of dust across it (from a spiral it swallowed).
  // (Its disc seen some 15 deg from edge-on, the lane across the middle as in the photographs.)
  randomAxes(rng);
  add('Centaurus A', 'lenticular', fromSky(309.5, 19.4, 12.4e6), 48000, facing(309.5, 19.4, 75, 2.0), {
    dust: 5, bulgeLum: 1.8 / 4800, bulgeScale: 4800, bulgeFlat: 1.1, discLum: 0.35e-4, discScale: 6000, ring: [0.22, 0, 0, 2.5], warp: 1.2, blue: 0.7, type: 'Elliptical galaxy with a dust lane',
  });
  add('Southern Pinwheel (M83)', 'barred spiral', fromSky(314.6, 32, 15e6), 27500, undefined, { arms: 2, armContrast: 1, blue: 1 });
  add('Pinwheel (M101)', 'spiral', fromSky(102, 59.8, 21e6), 85000, undefined, {
    // (Its bulge small and faint, its disc flocculent nearly to the centre.)
    arms: 4, armContrast: 0.9, blue: 1, flocculent: 0.7, spurs: 0.6, lopsided: 0.7, pitchK: 1 / Math.tan(28 * DEG), bulgeScale: 1800, bulgeLum: 0.25e-4,
  });
  add('Whirlpool (M51)', 'spiral', fromSky(104.9, 68.6, 28e6), 38000, undefined, { arms: 2, armContrast: 1, blue: 0.9, flocculent: 0.2, spurs: 0.8, lopsided: 0.35 });
  // The Sombrero: a great bright bulge and halo, a thin disc seen 6 deg from edge-on, and a crisp dark ring of
  // dust round it. (Random axes are still drawn, so that every galaxy after it stays as it was.)
  randomAxes(rng);
  add('Sombrero (M104)', 'lenticular', fromSky(298.5, 51.1, 31e6), 25000, facing(298.5, 51.1, 84, 0.3), {
    dust: 0, bulgeScale: 3200, bulgeFlat: 1.3, bulgeLum: 1.6 / 3200, discLum: 2.6e-4, discScale: 7000, height: 260,
    ring: [0.62, 0.15, 0, 3.2], type: 'Spiral galaxy (Sa), edge-on',
  });
  add('Phantom (M74)', 'spiral', fromSky(138.6, -45.7, 30e6), 47500, undefined, { arms: 2, armContrast: 1 });
  add('Virgo A (M87)', 'elliptical', fromSky(283.8, 74.5, 53.5e6), 66000);
  add('NGC 1300', 'barred spiral', fromSky(213.7, -55.5, 61e6), 55000, undefined, { arms: 2, armContrast: 1 });

  // Peculiar galaxies, at their real positions (J2000) and distances.
  // The Cartwheel: a smaller galaxy plunged through its disc 200-300 million years ago; the wave of star formation
  // it set off is the bright blue ring, with spokes back to the small yellow core, and the intruder is near.
  add('Cartwheel Galaxy', 'spiral', fromRaDec(9.421, -33.716, 500e6), 75000, facing(...galacticOf(9.421, -33.716), 30, 1.2), {
    arms: 2, armContrast: 0, bulgeScale: 2600, bulgeLum: 0.5 / 2600, discLum: 2.2e-4, discScale: 26000, dust: 0.4, blue: 1,
    ring: [0.82, 3, 10, 0.4], flocculent: 0, spurs: 0, lopsided: 0.3, type: 'Ring galaxy (collisional)',
  });
  add('Cartwheel companion (G2)', 'elliptical', offsetFrom(fromRaDec(9.421, -33.716, 500e6), 160000, 0.7), 11000);
  // Hoag's Object: a near-perfect ring of young blue stars round a round yellow core, a dark gap between.
  add("Hoag's Object", 'lenticular', fromRaDec(229.31, 21.586, 612.8e6), 50000, facing(...galacticOf(229.31, 21.586), 8, 0), {
    bulgeScale: 2300, bulgeFlat: 1.05, bulgeLum: 1.4 / 2300, discLum: 2.0e-4, discScale: 22000, dust: 0, blue: 1,
    ring: [0.72, 2.4, 0, 0], type: 'Ring galaxy (Hoag-type)',
  });
  // The Antennae: two spirals in collision, their long tidal tails like an insect's antennae.
  {
    const c = fromRaDec(180.47, -18.869, 45e6);
    const tails = { arms: 2, armContrast: 0.6, discScale: 7000, height: 700, blue: 1, irregular: 0.7, flocculent: 0.8, tails: 1.6, type: 'Interacting galaxy' };
    const [l, b] = galacticOf(180.47, -18.869);
    add('Antennae (NGC 4038)', 'spiral', offsetFrom(c, 14000, 0), 110000, facing(l, b, 35, 0.4), tails);
    add('Antennae (NGC 4039)', 'spiral', offsetFrom(c, 14000, Math.PI), 95000, facing(l, b, 50, 2.6), tails);
  }
  // The Mice: a pair caught in their first passage, each with one long straight tail.
  {
    const c = fromRaDec(191.54, 30.732, 290e6);
    const tails = { arms: 2, armContrast: 0.7, discScale: 9000, height: 900, blue: 0.8, irregular: 0.4, tails: 1.3, lopsided: 1, type: 'Interacting galaxy' };
    const [l, b] = galacticOf(191.54, 30.732);
    add('Mice (NGC 4676A)', 'spiral', offsetFrom(c, 50000, 0.4), 120000, facing(l, b, 70, 1.0), tails);
    add('Mice (NGC 4676B)', 'spiral', offsetFrom(c, 50000, 0.4 + Math.PI), 100000, facing(l, b, 45, 2.2), tails);
  }
  // (The rest of the universe is generated where the camera goes: cosmos.ts.)
  catalogued = list.length;
  return list;
}

let catalogued = 0;
export const GALAXIES: GalaxyData[] = build();
/** GALAXIES holds the real, catalogued galaxies (ids 0 .. NAMED_GALAXIES - 1); the rest of the universe is generated (cosmos.ts, ids above). */
export const NAMED_GALAXIES = catalogued;
export const MILKY_WAY = GALAXIES[0];

/** Universe position to a galaxy's own frame. */
export function toGalaxy(g: GalaxyData, x: number, y: number, z: number, out: { x: number; y: number; z: number }): void {
  const dx = x - g.x, dy = y - g.y, dz = z - g.z;
  const a = g.axes;
  out.x = a[0] * dx + a[1] * dy + a[2] * dz;
  out.y = a[3] * dx + a[4] * dy + a[5] * dz;
  out.z = a[6] * dx + a[7] * dy + a[8] * dz;
}

/** A galaxy-frame position back to universe coordinates. */
export function fromGalaxy(g: GalaxyData, x: number, y: number, z: number, out: { x: number; y: number; z: number }): void {
  const a = g.axes;
  out.x = g.x + a[0] * x + a[3] * y + a[6] * z;
  out.y = g.y + a[1] * x + a[4] * y + a[7] * z;
  out.z = g.z + a[2] * x + a[5] * y + a[8] * z;
}

// Galaxies are sparse, so finding the ones near a point goes through a coarse grid.
const CELL = 600000;
const grid = new Map<string, GalaxyData[]>();
for (const g of GALAXIES) {
  const reach = g.radius * 1.3;
  for (let ix = Math.floor((g.x - reach) / CELL); ix <= Math.floor((g.x + reach) / CELL); ix++)
    for (let iy = Math.floor((g.y - reach) / CELL); iy <= Math.floor((g.y + reach) / CELL); iy++)
      for (let iz = Math.floor((g.z - reach) / CELL); iz <= Math.floor((g.z + reach) / CELL); iz++) {
        const key = `${ix},${iy},${iz}`;
        const cell = grid.get(key);
        if (cell) cell.push(g); else grid.set(key, [g]);
      }
}
const NONE: GalaxyData[] = [];

/** Catalogued galaxies whose stars can reach the grid cell around a point (a superset). */
export function catalogueAround(x: number, y: number, z: number): GalaxyData[] {
  return grid.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`) ?? NONE;
}

/**
 * Galaxies whose stars can reach the grid cell around a point (a superset: test the radius yourself): the
 * catalogue's and the generated ones (made there now if they were not yet, cosmos.ts).
 */
export function galaxiesAround(x: number, y: number, z: number): GalaxyData[] {
  const cat = catalogueAround(x, y, z);
  const gen = cosmosAround(x, y, z);
  return gen.length === 0 ? cat : cat.length === 0 ? gen : [...cat, ...gen];
}

/** The galaxy whose centre is closest to a point, measured in galaxy radii (of the catalogue and of those generated so far). */
export function nearestGalaxy(x: number, y: number, z: number): GalaxyData {
  let best = GALAXIES[0];
  let bestD = Infinity;
  const test = (g: GalaxyData): void => {
    const d = Math.hypot(g.x - x, g.y - y, g.z - z) / g.radius;
    if (d < bestD) { bestD = d; best = g; }
  };
  for (const g of GALAXIES) test(g);
  cosmosNear(x, y, z, 1.5e6, test);
  return best;
}

/**
 * Hooks of the generated universe (set by cosmos.ts, which imports this module): the galaxies around a point,
 * generated if need be, and those already generated within a distance.
 */
let cosmosAround: (x: number, y: number, z: number) => GalaxyData[] = () => NONE;
let cosmosNear: (x: number, y: number, z: number, r: number, each: (g: GalaxyData) => void) => void = () => {};
export function setCosmos(around: typeof cosmosAround, near: typeof cosmosNear): void {
  cosmosAround = around;
  cosmosNear = near;
}

/** Light of a galaxy in the units its glow and march are drawn in (disc and bulge as galaxyCloud's glowOf weighs them). */
export function lightOf(g: GalaxyData): number {
  return 2.4 * g.discLum * 2 * g.height * 0.6 * g.discScale * g.discScale + (0.6 * g.bulgeLum * 4 * g.bulgeScale ** 3) / g.bulgeFlat;
}

function smooth(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** 0..1, how strongly a point of a galaxy's disc (its own frame) belongs to a spiral arm (galaxyShader gArm, gArmStructure). */
export function armStrengthOf(g: GalaxyData, x: number, z: number, warped?: number): number {
  const st = armStructureOf(g);
  const qz = st.elongation > 1 ? z * st.elongation : z;
  const r = Math.hypot(x, qz);
  if (r < 1) return 1;
  let theta = warped ?? Math.atan2(qz, x);
  if (st.flocculent > 0) {
    const sc = 0.5 * r + g.radius * 0.03;
    theta += st.flocculent * 1.4 * (gnoise(x / sc + g.seed + 23, g.seed + 23, z / sc + g.seed + 23) - 0.5);
  }
  const logr = Math.log(r / (g.radius * 0.077));
  const phase = g.arms * (theta - g.pitchK * logr);
  const major = Math.pow(0.5 + 0.5 * Math.cos(phase), 3 * Math.max(g.armContrast, 1));
  const minor = Math.pow(0.5 + 0.5 * Math.cos(2 * phase + 1.3), 4) * 0.35 * (1 - 0.8 * st.flocculent);
  const core = Math.min(1, Math.max(0, (r - g.radius * 0.048) / (g.radius * 0.096)));
  let a = (1 - core) + core * (0.45 + (Math.min(1, major + minor) - 0.45) * Math.min(g.armContrast, 1));
  if (st.spurs > 0) {
    const side = Math.pow(0.5 + 0.5 * Math.cos(phase - 0.9), 3);
    const spur = Math.pow(0.5 + 0.5 * Math.cos(7 * (theta - Math.sign(g.pitchK) * 0.8 * logr) + g.seed), 4);
    a = Math.max(a, a + (0.35 + 0.65 * spur - a) * st.spurs * side * core);
  }
  if (st.flocculent > 0) {
    const patch = gnoise(x / (g.radius * 0.07) + g.seed + 41, g.seed + 41, z / (g.radius * 0.07) + g.seed + 41);
    const t = Math.min(1, Math.max(0, (patch - 0.25) / 0.45));
    const inner = Math.min(1, Math.max(0, (r - g.radius * 0.012) / (g.radius * 0.03)));
    a += (a * t * t * (3 - 2 * t) * 1.5 - a) * st.flocculent * Math.max(core, inner);
  }
  if (st.lopsided > 0) a *= 1 + st.lopsided * 0.6 * Math.cos(theta + g.seed) * core;
  return Math.max(a, 0);
}

/** Stellar density at a point in a galaxy's own frame, relative to the solar neighbourhood (arms false: averaged over them). */
export function densityOf(g: GalaxyData, x: number, y: number, z: number, arms = true): number {
  const r = Math.hypot(x, z);
  const ay = Math.abs(y);
  const rb = Math.hypot(r, y * g.bulgeFlat);
  if (rb > g.radius * 1.15) return 0;
  // Scaled so the Milky Way's numbers give a density of 1 around Sol: every galaxy shares one light-to-stars scale.
  const bulge = 28 * (g.bulgeLum / 6.0e-4) * Math.exp(-rb / g.bulgeScale);
  if (g.discLum <= 0 || ay > g.height * 13) return bulge;
  const edge = 1 - smooth(g.radius * 0.8, g.radius * 1.1, r);
  const disc = 15.44 * (g.discLum / 2.7e-4) * Math.exp(-r / g.discScale) * edge;
  const vertical = 0.9 * Math.exp(-ay / (g.height * 0.46)) + 0.1 * Math.exp(-ay / (g.height * 1.85));
  return disc * vertical * (0.22 + 1.25 * (arms ? armStrengthOf(g, x, z) : 0.5)) + bulge;
}
