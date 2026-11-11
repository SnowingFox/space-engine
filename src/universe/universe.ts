import { Rng } from '../core/rng';

// The universe is a box of galaxies around the Milky Way, which sits at the origin
// with its disc in the XZ plane. Units: light years.

export type GalaxyKind = 'spiral' | 'barred spiral' | 'elliptical' | 'lenticular' | 'irregular';

export interface GalaxyData {
  /** Index in GALAXIES. */
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
  /** A giant star-forming region (its own frame): x, z, radius (ly), brightness relative to the disc. */
  knot?: [number, number, number, number];
}

export const MILKY_WAY_RADIUS = 52000;
export const UNIVERSE_RADIUS = 1.1e8;
const DEG = Math.PI / 180;
/** Where Sol sits in the Milky Way; directions on its sky are given in galactic longitude and latitude. */
export const SOL = { x: 26000, y: 18, z: 900 };

function randomAxes(rng: Rng): number[] {
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

function shape(kind: GalaxyKind, radius: number, rng: Rng): Omit<GalaxyData, 'id' | 'name' | 'kind' | 'x' | 'y' | 'z' | 'axes' | 'radius'> {
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

/** Galactic longitude / latitude (degrees) and distance from Sol to universe coordinates. */
function fromSky(l: number, b: number, dist: number): [number, number, number] {
  const cb = Math.cos(b * DEG);
  return [SOL.x - dist * cb * Math.cos(l * DEG), SOL.y + dist * Math.sin(b * DEG), SOL.z - dist * cb * Math.sin(l * DEG)];
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

function build(): GalaxyData[] {
  const list: GalaxyData[] = [];
  const rng = new Rng(20260411);
  const add = (name: string, kind: GalaxyKind, pos: [number, number, number], radius: number, axes?: number[], tweak?: Partial<GalaxyData>): void => {
    list.push({ id: list.length, name, kind, x: pos[0], y: pos[1], z: pos[2], axes: axes ?? randomAxes(rng), radius, ...shape(kind, radius, rng), ...tweak });
  };

  add('Milky Way', 'barred spiral', [0, 0, 0], MILKY_WAY_RADIUS, [1, 0, 0, 0, 1, 0, 0, 0, 1], {
    discScale: 9500, height: 700, bulgeScale: 1900, bulgeFlat: 1.7, arms: 2, pitchK: 1 / Math.tan(13.5 * DEG), armContrast: 1,
    dust: 1, bulgeLum: 6.0e-4, discLum: 2.7e-4, blue: 0.8, irregular: 0.3, seed: 3.7,
  });
  // The Local Group and the famous neighbours, roughly where they are on Sol's sky.
  // The Magellanic Clouds. The LMC: a disc seen ~35 deg from face-on with a bar and one ragged arm, some
  // 10 deg across on Sol's sky, and 30 Doradus, the brightest star-forming region of the Local Group, at the
  // bar's end (van der Marel & Kallivayalil 2014). The SMC: a lumpy elongated bar of young blue stars, ~5 x 3 deg.
  // (The LMC's axes are set, but random ones are still drawn: every generated galaxy stays as it was.)
  randomAxes(rng);
  add('Large Magellanic Cloud', 'irregular', fromSky(280.5, -32.9, 163e3), 15000, facing(280.5, -32.9, 35, 2.4), {
    arms: 1, pitchK: 2.2, armContrast: 0.35, bar: 3.5, bulgeScale: 1400, bulgeFlat: 2.5, bulgeLum: 0.35 / 750,
    discScale: 7000, height: 650, irregular: 0.6, blue: 0.9, dust: 0.5, knot: [3200, 2400, 1700, 12],
  });
  add('Small Magellanic Cloud', 'irregular', fromSky(302.8, -44.3, 200e3), 9000, undefined, {
    arms: 1, armContrast: 0.15, bar: 2.6, bulgeScale: 1000, bulgeFlat: 1.6, bulgeLum: 0.04 / 450, discScale: 2800, height: 900, irregular: 0.9, blue: 1, dust: 0.3,
  });
  add('Andromeda (M31)', 'spiral', fromSky(121.2, -21.6, 2.54e6), 76000, undefined, { arms: 2, armContrast: 0.85, blue: 0.7 });
  add('Triangulum (M33)', 'spiral', fromSky(133.6, -31.3, 2.73e6), 30000, undefined, { arms: 3, armContrast: 0.5, blue: 1, irregular: 0.5 });
  add('NGC 6822', 'irregular', fromSky(25.3, -18.4, 1.6e6), 3500);
  add('IC 10', 'irregular', fromSky(119, -3.3, 2.2e6), 2500);
  add('M32', 'elliptical', fromSky(121.1, -22, 2.49e6), 4000);
  add('M110', 'elliptical', fromSky(120.7, -21.1, 2.69e6), 8500);
  add('Sculptor (NGC 253)', 'spiral', fromSky(97.4, -88, 11.4e6), 45000);
  add("Bode's Galaxy (M81)", 'spiral', fromSky(142.1, 40.9, 11.8e6), 48000, undefined, { arms: 2, armContrast: 1 });
  add('Cigar Galaxy (M82)', 'irregular', fromSky(141.4, 40.6, 11.5e6), 18500);
  add('Centaurus A', 'lenticular', fromSky(309.5, 19.4, 12.4e6), 48000, undefined, { dust: 2.2 });
  add('Southern Pinwheel (M83)', 'barred spiral', fromSky(314.6, 32, 15e6), 27500, undefined, { arms: 2, armContrast: 1, blue: 1 });
  add('Pinwheel (M101)', 'spiral', fromSky(102, 59.8, 21e6), 85000, undefined, { arms: 4, armContrast: 0.9, blue: 1 });
  add('Whirlpool (M51)', 'spiral', fromSky(104.9, 68.6, 28e6), 38000, undefined, { arms: 2, armContrast: 1, blue: 0.9 });
  add('Sombrero (M104)', 'lenticular', fromSky(298.5, 51.1, 31e6), 25000, undefined, { dust: 1.8 });
  add('Phantom (M74)', 'spiral', fromSky(138.6, -45.7, 30e6), 47500, undefined, { arms: 2, armContrast: 1 });
  add('Virgo A (M87)', 'elliptical', fromSky(283.8, 74.5, 53.5e6), 66000);
  add('NGC 1300', 'barred spiral', fromSky(213.7, -55.5, 61e6), 55000, undefined, { arms: 2, armContrast: 1 });

  catalogued = list.length;
  const kinds: GalaxyKind[] = ['spiral', 'spiral', 'spiral', 'barred spiral', 'elliptical', 'lenticular', 'irregular', 'irregular'];
  const place = (cx: number, cy: number, cz: number, spread: number, clusterKind: GalaxyKind | null): void => {
    const x = cx + rng.gauss() * spread, y = cy + rng.gauss() * spread, z = cz + rng.gauss() * spread;
    const far = Math.hypot(x, y, z);
    if (far < 3.5e6 || far > UNIVERSE_RADIUS) return;
    const kind = clusterKind && rng.chance(0.5) ? clusterKind : rng.pick(kinds);
    const radius = kind === 'irregular' ? rng.logRange(3000, 16000)
      : kind === 'elliptical' ? rng.logRange(8000, 110000) : rng.logRange(18000, 80000);
    for (const g of list) {
      if (Math.hypot(g.x - x, g.y - y, g.z - z) < (g.radius + radius) * 3) return;
    }
    const cat = rng.chance(0.7) ? 'NGC' : rng.chance(0.5) ? 'IC' : 'UGC';
    add(`${cat} ${rng.int(1, 9999)}`, kind, [x, y, z], radius);
  };
  // Groups and clusters, where ellipticals are common, and a thin field between them.
  for (let c = 0; c < 46; c++) {
    const u = rng.range(-1, 1), ph = rng.range(0, Math.PI * 2), s = Math.sqrt(1 - u * u);
    const d = UNIVERSE_RADIUS * Math.cbrt(rng.range(0.001, 0.8));
    const rich = rng.chance(0.2);
    const members = rich ? rng.int(40, 90) : rng.int(5, 26);
    const spread = rich ? rng.range(2.5e6, 5e6) : rng.range(0.8e6, 2.2e6);
    for (let i = 0; i < members; i++) place(d * s * Math.cos(ph), d * u, d * s * Math.sin(ph), spread, rich ? 'elliptical' : null);
  }
  for (let i = 0; i < 900; i++) {
    const u = rng.range(-1, 1), ph = rng.range(0, Math.PI * 2), s = Math.sqrt(1 - u * u);
    const d = UNIVERSE_RADIUS * Math.cbrt(rng.next());
    place(d * s * Math.cos(ph), d * u, d * s * Math.sin(ph), 1, null);
  }
  return list;
}

let catalogued = 0;
export const GALAXIES: GalaxyData[] = build();
/** The real, catalogued galaxies come first in GALAXIES; the generated ones follow. */
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

/** Galaxies whose stars can reach the grid cell around a point (a superset: test the radius yourself). */
export function galaxiesAround(x: number, y: number, z: number): GalaxyData[] {
  return grid.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`) ?? NONE;
}

/** The galaxy whose centre is closest to a point, measured in galaxy radii. */
export function nearestGalaxy(x: number, y: number, z: number): GalaxyData {
  let best = GALAXIES[0];
  let bestD = Infinity;
  for (const g of GALAXIES) {
    const d = Math.hypot(g.x - x, g.y - y, g.z - z) / g.radius;
    if (d < bestD) { bestD = d; best = g; }
  }
  return best;
}

function smooth(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** 0..1, how strongly a point of a galaxy's disc (its own frame) belongs to a spiral arm. */
export function armStrengthOf(g: GalaxyData, x: number, z: number): number {
  const r = Math.hypot(x, z);
  if (r < 1) return 1;
  const phase = g.arms * (Math.atan2(z, x) - g.pitchK * Math.log(r / (g.radius * 0.077)));
  const major = Math.pow(0.5 + 0.5 * Math.cos(phase), 3);
  const minor = Math.pow(0.5 + 0.5 * Math.cos(2 * phase + 1.3), 4) * 0.35;
  const core = Math.min(1, Math.max(0, (r - g.radius * 0.048) / (g.radius * 0.096)));
  return (1 - core) + core * (0.45 + (Math.min(1, major + minor) - 0.45) * g.armContrast);
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
