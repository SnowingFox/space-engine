import { SOL, GALAXIES, fromGalaxy, fromSky } from './universe';

// The famous nebulae of the Milky Way (and 30 Doradus in the Large Magellanic Cloud), where they really are.
// Positions are the catalogue coordinates (J2000 right ascension / declination, as in SIMBAD), turned into
// galactic longitude and latitude with the IAU (Hipparcos) rotation and placed at their published distances.
// Directions go through universe.ts's fromSky, as the galaxies' and the stars' do. Sizes, distances and surface
// brightnesses: published values. Each one's structures are placed as photographs of it from Earth show them.

export type NebulaKind = 'emission' | 'planetary' | 'remnant' | 'reflection' | 'dark';

/** The shader family that draws a nebula. */
export type NebulaModel = 'hii' | 'pn' | 'snr' | 'refl';

export interface NebulaStar {
  name: string;
  /** Offset from the nebula's centre in its sight frame (ly): X right and Y up as seen from Sol, Z towards Sol. */
  x: number; y: number; z: number;
  temp: number;
  /** Solar luminosities. */
  lum: number;
  cls: string;
}

/**
 * A structure of an H II region: a round cone from a (radius ra) to b (radius rb), in the shape frame (radii).
 *   cloud: dark, dusty neutral gas whose face towards the stars glows ('glow' times as brightly as the region's cloud);
 *   solid: the same but sharp, drawn live (pillars, trunks, globules: their lit skins are the bright rims and tips);
 *   reflect: dust scattering the stars' light (blue);  bright: a part where the ionised gas is denser;
 *   cavity: a part cleared of gas.
 */
export interface NebulaPrim {
  kind: 'cloud' | 'solid' | 'reflect' | 'bright' | 'cavity';
  a: [number, number, number]; ra: number;
  b?: [number, number, number]; rb?: number;
  density?: number;
  /** How ragged its edge is, 0..1. */
  rough?: number;
  glow?: number;
}

/** A small bright knot (a Gaussian of size sigma, radii), integrated exactly along each ray. */
export interface NebulaGlow {
  at: [number, number, number];
  sigma: number;
  color: [number, number, number];
  amount: number;
}

/** Shape and light, for the renderer; all lengths in units of the nebula's radius, in its shape frame. */
export interface NebulaLook {
  model: NebulaModel;
  /** Variant of the model (see nebulaShader.ts). */
  variant: number;
  /** Semi-axes of the envelope (fractions of the radius). */
  scale: [number, number, number];
  /** Shape frame relative to the sight frame: rotations about X, Y, Z, degrees (applied in that order). */
  tilt?: [number, number, number];
  /** Free parameters of the model, four per slot (see nebulaShader.ts for their meaning). */
  p: number[][];
  seed: number;
  prims?: NebulaPrim[];
  glows?: NebulaGlow[];
}

export interface NebulaData {
  id: number;
  name: string;
  /** Catalogue numbers and other names, for search. */
  aliases: string[];
  kind: NebulaKind;
  /** Short description of the type, for the info panel. */
  type: string;
  /** Galactic longitude / latitude, degrees, and distance from Sol, ly. */
  l: number; b: number; dist: number;
  /** Universe position (ly). */
  x: number; y: number; z: number;
  /** Bounding radius, ly. */
  radius: number;
  /** Rows: the shape frame's X, Y, Z axes in universe coordinates. */
  axes: number[];
  /** Rows: the sight frame (as a photograph of it from Sol: X right = west, Y up = celestial north, Z towards Sol). */
  sight: number[];
  /** Peak surface brightness seen from Sol (through the dust in front), V mag / arcsec^2 (published values). */
  sb: number;
  /** Visual extinction between Sol and the nebula, magnitudes. */
  av: number;
  stars: NebulaStar[];
  look: NebulaLook;
  /** One line about it. */
  note: string;
}

const DEG = Math.PI / 180;

/** J2000 equatorial to galactic: the rows of the IAU rotation matrix. */
const EQ_TO_GAL = [
  -0.0548755604, -0.8734370902, -0.4838350155,
  0.4941094279, -0.4448296300, 0.7469822445,
  -0.8676661490, -0.1980763734, 0.4559837762,
];

/** Galactic (l, b) in degrees from "hh mm ss" and "±dd mm ss". */
export function galactic(ra: string, dec: string): [number, number] {
  const [h, m, s] = ra.split(' ').map(Number);
  const neg = dec.trim().startsWith('-');
  const [d, dm, ds] = dec.replace('-', '').replace('+', '').split(' ').map(Number);
  const a = (h + (m ?? 0) / 60 + (s ?? 0) / 3600) * 15 * DEG;
  const de = (neg ? -1 : 1) * (d + (dm ?? 0) / 60 + (ds ?? 0) / 3600) * DEG;
  const e = [Math.cos(de) * Math.cos(a), Math.cos(de) * Math.sin(a), Math.sin(de)];
  const g = [0, 1, 2].map((r) => EQ_TO_GAL[r * 3] * e[0] + EQ_TO_GAL[r * 3 + 1] * e[1] + EQ_TO_GAL[r * 3 + 2] * e[2]);
  let l = Math.atan2(g[1], g[0]) / DEG;
  if (l < 0) l += 360;
  return [l, Math.asin(g[2]) / DEG];
}

/** Unit vector on Sol's sky (universe axes) for galactic (l, b), by universe.ts's conversion (the galaxies' and stars'). */
export function skyDirection(l: number, b: number): [number, number, number] {
  const p = fromSky(l, b, 1);
  return normalize([p[0] - SOL.x, p[1] - SOL.y, p[2] - SOL.z]) as [number, number, number];
}

/** The north celestial pole in galactic coordinates (IAU). */
const NCP: [number, number] = [122.932, 27.128];

function normalize(v: number[]): number[] {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}
function cross(a: number[], b: number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * The sight frame of a direction from Sol, as a photograph of it is oriented: Z back towards Sol, Y towards
 * celestial north, X = Y x Z to the right (west), as seen from Sol.
 */
function sightFrame(dir: number[]): number[] {
  const z = [-dir[0], -dir[1], -dir[2]];
  const n = skyDirection(NCP[0], NCP[1]);
  const d = n[0] * z[0] + n[1] * z[1] + n[2] * z[2];
  const y = normalize([n[0] - d * z[0], n[1] - d * z[1], n[2] - d * z[2]]);
  const x = cross(y, z);
  return [...x, ...y, ...z];
}

/** Rows of the shape frame: the sight frame turned by tilt (degrees about X, then Y, then Z of the sight frame). */
function tilted(sight: number[], tilt: [number, number, number]): number[] {
  // Rotation matrix R = Rz * Ry * Rx; the shape axes in sight coordinates are its columns.
  const [ax, ay, az] = tilt.map((t) => t * DEG);
  const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
  const r = [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
  const out: number[] = [];
  for (let col = 0; col < 3; col++) {
    for (let k = 0; k < 3; k++) out.push(r[col] * sight[k] + r[3 + col] * sight[3 + k] + r[6 + col] * sight[6 + k]);
  }
  return out;
}

interface Entry {
  name: string;
  aliases: string[];
  kind: NebulaKind;
  type: string;
  ra: string; dec: string;
  dist: number;
  radius: number;
  /** Peak surface brightness from Sol, V mag / arcsec^2. */
  sb: number;
  av: number;
  /** Stars by sky position and depth along the sight line (ly, + towards Sol), or by an offset in the sight frame. */
  stars?: StarEntry[];
  look: NebulaLook;
  note: string;
  /** Place it in another galaxy's frame instead (the model of that galaxy, e.g. 30 Doradus in the LMC). */
  host?: { galaxy: string; at: [number, number, number] };
}

type StarEntry = { name: string; temp: number; lum: number; cls: string } & ({ ra: string; dec: string; depth: number } | { at: [number, number, number] });

const s = (name: string, ra: string, dec: string, depth: number, temp: number, lum: number, cls: string): StarEntry => ({ name, ra, dec, depth, temp, lum, cls });
const sAt = (name: string, at: [number, number, number], temp: number, lum: number, cls: string): StarEntry => ({ name, at, temp, lum, cls });

// Model parameters, by family (see nebulaShader.ts). Shape frames are those of a photograph from Sol (X right =
// west, Y up = north, Z towards Sol) unless tilted; lengths in radii.
// hii  p[0] = cavity radius, cavity softness, outer radius, concentration towards the main star
//      p[1] = dust, [O III], scattered starlight (blue), ionising power
//      p[2] = warp, noise frequency, density contrast (log-normal sigma), stretch along the stars' rays
//      p[3] = molecular cloud behind: normal xyz (out of the cloud), offset;  p[4] = its curvature, density, softness, glow
//      p[5] = filaments, opening towards the poles (Z), 1: a sheet seen face on, dust lit by the nebula (brown)
//      prims: the structures that make each one itself (dark clouds, pillars, cavities, reflection dust, brighter parts)
//      glows: small bright knots
// pn   p[0] = radius of [O III], H-alpha, [N II] shells, shell width
//      p[1] = equatorial ring, knots, halo, lobes
//      p[2] = second shell: tilt about X, about Z (degrees), its weight, rings in the halo
// snr  p[0] = shell radius, wrinkle amplitude, sheet width, patchiness
//      p[1] = [O III] share, synchrotron, filaments, two-sided arcs
// refl p[0] = density, striation, frequency, forward scattering g
// sb: peak surface brightness from Sol, V mag/arcsec^2 (from the catalogued integrated magnitudes over the bright
// parts, and published surface photometry: M42's Huygens region ~17, M8's core ~18.5, the Rosette ~21.5, the Veil's
// filaments ~23, Vela ~24).
const ENTRIES: Entry[] = [
  {
    name: 'Orion Nebula', aliases: ['M42', 'NGC 1976', 'M43', 'NGC 1982', "De Mairan's Nebula", 'Great Orion Nebula'],
    kind: 'emission', type: 'H II region (blister)', ra: '05 35 17.3', dec: '-05 23 28', dist: 1344, radius: 12,
    sb: 16.8, av: 0.3,
    note: 'The nearest large star-forming region: the Trapezium stars light the near face of the Orion molecular cloud.',
    stars: [
      s('θ1 Orionis C', '05 35 16.46', '-05 23 22.8', 0.2, 39000, 2.0e5, 'O7V'),
      s('θ1 Orionis A', '05 35 15.83', '-05 23 14.3', 0.25, 30000, 1.6e4, 'B0.5V'),
      s('θ1 Orionis B', '05 35 16.13', '-05 23 06.8', 0.3, 17000, 2.0e3, 'B3V'),
      s('θ1 Orionis D', '05 35 17.26', '-05 23 16.6', 0.15, 32000, 2.5e4, 'B0.5V'),
      s('θ2 Orionis A', '05 35 22.90', '-05 24 57.8', 0.6, 34000, 5.0e4, 'O9.5V'),
      s('NU Orionis', '05 35 31.36', '-05 16 02.6', -0.4, 30000, 2.0e4, 'B0.5V'),
    ],
    look: {
      // A blister: the Trapezium a fraction of a light year in front of the bowl-shaped face of the Orion molecular
      // cloud, which it lights; the Bright Bar to the south-east, the dark Fish's Mouth reaching in from the east,
      // M43 round NU Ori to the north behind its own dark lane, the "wings" spreading east and west.
      model: 'hii', variant: 0, scale: [1, 0.9, 0.7], seed: 3.1,
      p: [[0, 0.3, 1.0, 9], [1.3, 1.3, 0.45, 1.2], [0.36, 2.4, 1.1, 0.3], [0, 0, 1, -0.02], [0.7, 2.6, 0.05, 1.3], [1.3, 0, 0, 1]],
      prims: [
        { kind: 'solid', a: [-0.125, 0.005, 0.0], ra: 0.02, b: [0.015, -0.112, 0.01], rb: 0.018, density: 0.7, rough: 0.6, glow: 3 },
        { kind: 'cloud', a: [-0.4, 0.12, 0.16], ra: 0.1, b: [-0.05, 0.035, 0.14], rb: 0.022, density: 3, rough: 0.45, glow: 0.25 },
        { kind: 'cloud', a: [-0.22, 0.15, 0.08], ra: 0.04, b: [-0.02, 0.2, 0.06], rb: 0.028, density: 2.5, rough: 0.45, glow: 0.4 },
        { kind: 'cloud', a: [0.35, -0.25, 0.15], ra: 0.14, b: [0.15, -0.45, 0.12], rb: 0.1, density: 1.2, rough: 0.6, glow: 0.3 },
        { kind: 'bright', a: [-0.114, 0.242, -0.03], ra: 0.05, density: 3.5, rough: 0.25 },
        { kind: 'bright', a: [-0.11, 0.235, -0.03], ra: 0.035, b: [-0.045, 0.165, -0.02], rb: 0.014, density: 2.5, rough: 0.25 },
        { kind: 'cavity', a: [0.0, 0.0, 0.5], ra: 0.42, density: 0.85, rough: 0.4 },
        { kind: 'bright', a: [-0.1, -0.02, -0.04], ra: 0.035, b: [-0.34, -0.09, -0.06], rb: 0.04, density: 3.5, rough: 0.45 },
        { kind: 'bright', a: [-0.34, -0.09, -0.06], ra: 0.04, b: [-0.5, -0.32, -0.06], rb: 0.03, density: 3.2, rough: 0.45 },
        { kind: 'bright', a: [0.09, -0.02, -0.04], ra: 0.035, b: [0.32, -0.11, -0.06], rb: 0.04, density: 3.5, rough: 0.45 },
        { kind: 'bright', a: [0.32, -0.11, -0.06], ra: 0.04, b: [0.44, -0.34, -0.06], rb: 0.03, density: 3.2, rough: 0.45 },
      ],
      glows: [{ at: [0.007, 0.003, 0.0], sigma: 0.025, color: [0.75, 1.0, 0.9], amount: 25 }],
    },
  },
  {
    name: 'Rosette Nebula', aliases: ['NGC 2237', 'NGC 2238', 'NGC 2239', 'NGC 2246', 'NGC 2244', 'Caldwell 49', 'Caldwell 50'],
    kind: 'emission', type: 'H II region around NGC 2244', ra: '06 32 00', dec: '+04 54 00', dist: 5200, radius: 65,
    sb: 21.5, av: 1.5,
    note: "The winds of the cluster NGC 2244 have blown a hole some 30 light years across in the nebula's centre.",
    stars: [
      s('HD 46223', '06 32 09.31', '+04 49 24.7', 3, 43000, 4.0e5, 'O4V'),
      s('HD 46150', '06 31 55.52', '+04 56 34.3', -4, 40000, 2.8e5, 'O5V'),
      s('HD 46149', '06 31 52.53', '+05 01 59.2', 6, 36000, 8.0e4, 'O8.5V'),
      s('HD 46056', '06 31 20.86', '+04 50 03.9', -2, 35000, 6.0e4, 'O8V'),
      s('HD 46202', '06 32 10.47', '+04 57 59.8', 1, 34000, 5.0e4, 'O9V'),
    ],
    look: {
      // A thick ring (open towards and away from Sol) round the hole; [O III] on its inner wall; the elephant
      // trunks and globules of its north-western rim point in at the cluster.
      model: 'hii', variant: 0, scale: [1, 0.92, 0.88], seed: 7.7,
      p: [[0.34, 0.06, 0.95, 0], [1.0, 1.1, 0.05, 1.0], [0.28, 2.6, 1.1, 0], [0, 0, 1, -2], [0, 0, 0.1, 1], [1.2, 0.75, 0, 1]],
      prims: [
        { kind: 'solid', a: [0.36, 0.42, 0.02], ra: 0.03, b: [0.24, 0.27, 0.0], rb: 0.016, density: 3, rough: 0.35, glow: 1 },
        { kind: 'solid', a: [0.5, 0.25, -0.03], ra: 0.026, b: [0.33, 0.16, -0.02], rb: 0.014, density: 3, rough: 0.35, glow: 1 },
        { kind: 'solid', a: [0.2, 0.52, 0.04], ra: 0.024, b: [0.12, 0.35, 0.03], rb: 0.012, density: 3, rough: 0.35, glow: 1 },
        { kind: 'solid', a: [0.31, 0.33, 0.06], ra: 0.011, density: 3, rough: 0.2, glow: 1 },
        { kind: 'solid', a: [0.42, 0.3, -0.06], ra: 0.008, density: 3, rough: 0.2, glow: 1 },
        { kind: 'solid', a: [-0.48, -0.2, 0.0], ra: 0.024, b: [-0.33, -0.13, 0.0], rb: 0.012, density: 3, rough: 0.35, glow: 1 },
        { kind: 'cloud', a: [0.62, 0.42, 0.0], ra: 0.14, b: [0.3, 0.7, 0.0], rb: 0.12, density: 1.6, rough: 0.6, glow: 0.8 },
        { kind: 'cloud', a: [-0.62, -0.25, 0.05], ra: 0.09, b: [-0.5, 0.25, 0.08], rb: 0.06, density: 1.4, rough: 0.6, glow: 0.7 },
      ],
    },
  },
  {
    name: 'Lagoon Nebula', aliases: ['M8', 'NGC 6523', 'NGC 6530', 'Hourglass Nebula'],
    kind: 'emission', type: 'H II region around NGC 6530', ra: '18 03 37', dec: '-24 23 12', dist: 4100, radius: 55,
    sb: 18.5, av: 1.0,
    note: 'Its brightest part, the Hourglass, is lit by the young O star Herschel 36; a dark lane crosses the nebula.',
    stars: [
      s('Herschel 36', '18 03 40.33', '-24 22 42.7', 2, 40000, 2.0e5, 'O7.5V'),
      s('9 Sagittarii', '18 03 52.45', '-24 21 38.6', -3, 42000, 3.0e5, 'O4V'),
      s('HD 165052', '18 05 10.55', '-24 23 54.8', 5, 37000, 1.2e5, 'O6V'),
    ],
    look: {
      // Long east to west: the bright western half with the Hourglass round Herschel 36, the dark "lagoon" curving
      // north to south across the middle, the cluster NGC 6530 and Bok globules in the fainter eastern half.
      model: 'hii', variant: 0, scale: [1, 0.45, 0.5], seed: 13.3,
      p: [[0, 0.3, 0.95, 1.5], [1.0, 1.0, 0.25, 1.6], [0.14, 2.2, 0.75, 0], [0, 0, 1, -2], [0, 0, 0.1, 1], [0.6, 0, 0, 1]],
      prims: [
        { kind: 'cloud', a: [-0.32, -0.04, 0.06], ra: 0.02, density: 4, rough: 0.3, glow: 0.5 },
        { kind: 'cloud', a: [-0.38, 0.06, 0.02], ra: 0.016, density: 4, rough: 0.3, glow: 0.5 },
        { kind: 'cloud', a: [-0.27, 0.1, 0.04], ra: 0.014, density: 4, rough: 0.3, glow: 0.5 },
        { kind: 'cloud', a: [-0.1, 0.36, 0.12], ra: 0.06, b: [-0.17, 0.02, 0.12], rb: 0.07, density: 2.2, rough: 0.35, glow: 0.5 },
        { kind: 'cloud', a: [-0.17, 0.02, 0.12], ra: 0.07, b: [-0.11, -0.34, 0.12], rb: 0.06, density: 2.2, rough: 0.35, glow: 0.5 },
        { kind: 'bright', a: [-0.016, 0.011, 0.03], ra: 0.05, density: 3, rough: 0.3 },
        { kind: 'bright', a: [-0.04, 0.0, 0.0], ra: 0.17, b: [0.3, 0.0, 0.0], rb: 0.15, density: 1.6, rough: 0.35 },
      ],
      glows: [
        { at: [-0.016, 0.024, 0.036], sigma: 0.011, color: [0.9, 1.0, 0.95], amount: 45 },
        { at: [-0.016, -0.002, 0.036], sigma: 0.011, color: [0.9, 1.0, 0.95], amount: 45 },
      ],
    },
  },
  {
    name: 'Trifid Nebula', aliases: ['M20', 'NGC 6514'],
    kind: 'emission', type: 'H II region and reflection nebula', ra: '18 02 23', dec: '-23 01 48', dist: 4100, radius: 21,
    sb: 20.0, av: 1.0,
    note: 'Three dark lanes divide its red glow; to the north, dust scatters blue starlight.',
    stars: [s('HD 164492 A', '18 02 23.55', '-23 01 51.1', 0, 37000, 1.5e5, 'O7.5III')],
    look: {
      // The round red H II region split into three lobes by dark lanes meeting near its star; north of it, a
      // separate cloud of dust shining blue.
      model: 'hii', variant: 0, scale: [1, 1, 0.9], seed: 21.9,
      p: [[0, 0.3, 0.9, 0.2], [0.7, 0.9, 0.3, 1.6], [0.18, 2.4, 0.5, 0], [0, 0, 1, -2], [0, 0, 0.1, 1], [0.5, 0, 0, 0.3]],
      prims: [
        { kind: 'cloud', a: [0.05, 0.06, 0.06], ra: 0.012, b: [0.2, 0.3, 0.06], rb: 0.04, density: 1.3, rough: 0.4, glow: 0.8 },
        { kind: 'cloud', a: [-0.05, 0.01, 0.06], ra: 0.012, b: [-0.36, 0.07, 0.05], rb: 0.045, density: 1.3, rough: 0.4, glow: 0.8 },
        { kind: 'cloud', a: [0.02, -0.06, 0.06], ra: 0.012, b: [0.08, -0.36, 0.05], rb: 0.04, density: 1.3, rough: 0.4, glow: 0.8 },
        { kind: 'reflect', a: [-0.04, 0.64, -0.05], ra: 0.3, density: 0.5, rough: 0.6 },
      ],
    },
  },
  {
    name: 'Eagle Nebula', aliases: ['M16', 'NGC 6611', 'Pillars of Creation', 'Star Queen Nebula'],
    kind: 'emission', type: 'H II region around NGC 6611', ra: '18 18 48', dec: '-13 49 00', dist: 5700, radius: 35,
    sb: 20.0, av: 2.5,
    note: 'The Pillars of Creation, columns of cold gas light years long, are being eaten away by the light of NGC 6611.',
    stars: [
      s('HD 168076', '18 18 36.42', '-13 47 36.5', 4, 41000, 6.0e5, 'O4III'),
      s('HD 168075', '18 18 36.06', '-13 47 46.8', 3, 38000, 2.0e5, 'O7V'),
      s('BD-13 4923', '18 18 32.73', '-13 45 11.9', -2, 36000, 1.2e5, 'O4V'),
    ],
    look: {
      // The three Pillars of Creation stand south-east of the cluster, rising out of the cloud they are carved
      // from and pointing at it, the tallest on the left, evaporating globules at their tips; the Spire to the east.
      model: 'hii', variant: 0, scale: [1, 0.85, 0.8], seed: 31.4,
      p: [[0.15, 0.3, 0.9, 1.5], [1.1, 1.1, 0.2, 1.0], [0.3, 2.5, 1.0, 0.35], [0, 0, 1, -2], [0, 0, 0.1, 1], [1.0, 0, 0, 1]],
      prims: [
        { kind: 'solid', a: [-0.1, -0.27, 0.0], ra: 0.034, b: [0.045, -0.06, 0.02], rb: 0.018, density: 6, rough: 0.2, glow: 1.4 },
        { kind: 'solid', a: [-0.01, -0.27, 0.01], ra: 0.027, b: [0.07, -0.155, 0.02], rb: 0.015, density: 6, rough: 0.2, glow: 1.4 },
        { kind: 'solid', a: [0.06, -0.28, -0.01], ra: 0.022, b: [0.11, -0.205, 0.0], rb: 0.013, density: 6, rough: 0.2, glow: 1.4 },
        { kind: 'solid', a: [-0.4, -0.38, 0.02], ra: 0.036, b: [-0.24, -0.15, 0.03], rb: 0.012, density: 6, rough: 0.25, glow: 1.2 },
        { kind: 'solid', a: [0.055, -0.045, 0.025], ra: 0.007, density: 6, rough: 0.15, glow: 1.5 },
        { kind: 'solid', a: [0.12, -0.19, 0.005], ra: 0.006, density: 6, rough: 0.15, glow: 1.5 },
        { kind: 'cloud', a: [-0.25, -0.38, 0.0], ra: 0.16, b: [0.18, -0.36, 0.0], rb: 0.13, density: 2.5, rough: 0.5, glow: 0.8 },
        { kind: 'cavity', a: [0.0, -0.1, 0.5], ra: 0.42, density: 0.9, rough: 0.4 },
        { kind: 'cloud', a: [0.45, -0.35, 0.05], ra: 0.12, b: [0.6, 0.05, 0.05], rb: 0.1, density: 1.5, rough: 0.6, glow: 0.6 },
      ],
    },
  },
  {
    name: 'Omega Nebula', aliases: ['M17', 'NGC 6618', 'Swan Nebula'],
    kind: 'emission', type: 'H II region (blister)', ra: '18 20 26', dec: '-16 10 36', dist: 5500, radius: 20,
    sb: 18.5, av: 3.0,
    note: 'One of the brightest and most massive star-forming regions of the Galaxy, shaped like a swan.',
    stars: [s('CEN 1', '18 20 29.9', '-16 10 45', 0, 42000, 3.0e5, 'O4V')],
    look: {
      // The swan's body: a bright bar running east to west, its western end bending north (the neck), the
      // giant molecular cloud M17 SW behind and to the south-west.
      model: 'hii', variant: 0, scale: [1, 0.55, 0.6], seed: 41.2,
      p: [[0, 0.3, 0.9, 2], [1.1, 1.0, 0.1, 1.0], [0.3, 2.6, 1.0, 0.2], [-0.5, 0.45, 0.74, -0.12], [0.3, 1.0, 0.1, 1.0], [1.0, 0, 0, 0.2]],
      prims: [
        { kind: 'bright', a: [-0.45, -0.02, 0], ra: 0.09, b: [0.2, 0.02, 0], rb: 0.11, density: 4, rough: 0.4 },
        { kind: 'bright', a: [0.2, 0.02, 0], ra: 0.1, b: [0.35, 0.35, 0], rb: 0.07, density: 3, rough: 0.4 },
        { kind: 'cloud', a: [0.15, -0.3, 0.05], ra: 0.15, b: [0.55, -0.15, 0.05], rb: 0.14, density: 2, rough: 0.5, glow: 1.2 },
      ],
    },
  },
  {
    name: 'Carina Nebula', aliases: ['NGC 3372', 'Eta Carinae Nebula', 'Keyhole Nebula', 'Trumpler 14', 'Trumpler 16'],
    kind: 'emission', type: 'Giant H II region', ra: '10 44 30', dec: '-59 40 00', dist: 7500, radius: 130,
    sb: 18.5, av: 1.3,
    note: 'Four times the size of the Orion Nebula; home of Eta Carinae, one of the most luminous stars known.',
    stars: [
      s('Eta Carinae', '10 45 03.59', '-59 41 04.26', 0, 30000, 5.0e6, 'LBV'),
      s('HD 93129 A', '10 43 57.46', '-59 32 51.3', 8, 42500, 1.5e6, 'O2If'),
      s('WR 25', '10 44 10.39', '-59 43 11.1', -6, 50000, 2.4e6, 'O2.5If/WN6'),
      s('HD 93250', '10 44 45.03', '-59 33 54.7', 4, 46000, 1.0e6, 'O4III'),
    ],
    look: {
      // Bright and hot round Trumpler 14 and 16, cut by a broad V of dark dust; the Keyhole, a small dark cloud
      // with bright edges, just north-west of Eta Carinae, and the Homunculus, the bipolar shell Eta Car threw off
      // in 1843, round the star itself; Mystic Mountain's pillars to the south.
      model: 'hii', variant: 0, scale: [1, 0.85, 0.7], seed: 55.5,
      p: [[0, 0.3, 0.95, 1.2], [1.2, 1.2, 0.15, 0.4], [0.36, 3.0, 1.1, 0.35], [0, 0, 1, -2], [0, 0, 0.1, 1], [1.2, 0, 0, 1]],
      prims: [
        { kind: 'solid', a: [-0.05, -0.36, 0.0], ra: 0.016, b: [-0.065, -0.29, 0.0], rb: 0.009, density: 4, rough: 0.4, glow: 1.3 },
        { kind: 'solid', a: [-0.02, -0.37, 0.01], ra: 0.013, b: [-0.035, -0.31, 0.01], rb: 0.007, density: 4, rough: 0.4, glow: 1.3 },
        { kind: 'solid', a: [-0.1, -0.37, -0.01], ra: 0.012, b: [-0.09, -0.32, -0.01], rb: 0.007, density: 4, rough: 0.4, glow: 1.3 },
        { kind: 'cloud', a: [-0.085, 0.01, 0.02], ra: 0.022, b: [-0.075, -0.012, 0.02], rb: 0.012, density: 5, rough: 0.3, glow: 2.2 },
        { kind: 'cloud', a: [-0.55, -0.12, 0.08], ra: 0.08, b: [0.0, -0.08, 0.08], rb: 0.05, density: 2.5, rough: 0.55, glow: 0.8 },
        { kind: 'cloud', a: [0.0, -0.08, 0.08], ra: 0.05, b: [0.5, 0.25, 0.08], rb: 0.08, density: 2.5, rough: 0.55, glow: 0.8 },
        { kind: 'cloud', a: [-0.1, -0.5, 0.0], ra: 0.15, b: [0.25, -0.55, 0.0], rb: 0.12, density: 1.8, rough: 0.6, glow: 0.9 },
        { kind: 'bright', a: [0.069, 0.12, 0.06], ra: 0.12, density: 2.5, rough: 0.4 },
      ],
      glows: [
        { at: [-0.0725, -0.0165, 0.001], sigma: 0.0012, color: [1.0, 0.72, 0.48], amount: 900 },
        { at: [-0.0695, -0.0195, -0.001], sigma: 0.0012, color: [1.0, 0.72, 0.48], amount: 900 },
      ],
    },
  },
  {
    name: 'North America Nebula', aliases: ['NGC 7000', 'Pelican Nebula', 'IC 5070', 'Caldwell 20', 'Lynds 935'],
    kind: 'emission', type: 'H II region (with the Pelican)', ra: '20 55 30', dec: '+44 25 00', dist: 2590, radius: 60,
    sb: 21.0, av: 1.5,
    note: 'With the Pelican Nebula one H II region; the dark cloud L935 in front of it draws the "Gulf of Mexico".',
    stars: [s('Bajamar Star', '20 55 51.25', '+43 52 24.6', -10, 45000, 4.0e5, 'O3.5III')],
    look: {
      // The "continent" to the east, the Pelican to the west, and between them the dark cloud L935 in front:
      // the "Atlantic" and, bulging into the continent's south, the "Gulf of Mexico", whose rim facing the
      // Bajamar star behind it is the bright Cygnus Wall.
      model: 'hii', variant: 0, scale: [1, 0.8, 0.5], seed: 61.7,
      p: [[0, 0.3, 0.95, 0.5], [1.3, 0.5, 0.1, 1.2], [0.34, 2.2, 1.0, 0.2], [0, 0, 1, -2], [0, 0, 0.1, 1], [1.3, 0, 0, 1]],
      prims: [
        { kind: 'cloud', a: [0.12, 0.55, 0.15], ra: 0.17, b: [0.08, -0.15, 0.15], rb: 0.16, density: 1.3, rough: 0.5, glow: 1.1 },
        { kind: 'cloud', a: [0.08, -0.15, 0.15], ra: 0.16, b: [-0.12, -0.36, 0.12], rb: 0.12, density: 1.3, rough: 0.5, glow: 1.6 },
        { kind: 'cloud', a: [0.2, -0.45, 0.1], ra: 0.12, b: [0.45, -0.6, 0.1], rb: 0.1, density: 2.5, rough: 0.5, glow: 1.0 },
        { kind: 'bright', a: [-0.55, 0.2, 0], ra: 0.3, b: [-0.3, -0.35, 0], rb: 0.22, density: 1.5, rough: 0.5 },
        { kind: 'bright', a: [-0.2, -0.33, 0], ra: 0.06, b: [-0.02, -0.5, 0], rb: 0.05, density: 3, rough: 0.4 },
        { kind: 'bright', a: [0.5, 0.05, 0], ra: 0.25, density: 1.2, rough: 0.5 },
      ],
    },
  },
  {
    name: 'California Nebula', aliases: ['NGC 1499'],
    kind: 'emission', type: 'H II region', ra: '04 03 18', dec: '+36 25 18', dist: 1000, radius: 22,
    sb: 22.5, av: 1.0,
    note: 'A long faint ribbon of glowing hydrogen, lit by the hot star Xi Persei beside it.',
    stars: [s('Xi Persei (Menkib)', '03 58 57.90', '+35 47 27.7', 3, 35000, 2.6e5, 'O7.5III')],
    look: {
      model: 'hii', variant: 0, scale: [1, 0.26, 0.35], tilt: [0, 0, 45], seed: 71.3,
      p: [[0, 0.3, 0.95, 0.3], [0.6, 0.3, 0.03, 1.4], [0.3, 2.6, 1.0, 0.15], [0, 0, 1, -2], [0, 0, 0.1, 1], [1.6, 0, 0, 0.6]],
    },
  },
  {
    name: 'Heart Nebula', aliases: ['IC 1805', 'Melotte 15', 'Sharpless 190'],
    kind: 'emission', type: 'H II region around Melotte 15', ra: '02 33 22', dec: '+61 26 36', dist: 7500, radius: 160,
    sb: 22.0, av: 2.5,
    note: 'The cluster Melotte 15 in its middle has cleared a heart-shaped cavity.',
    stars: [s('HD 15558', '02 32 42.54', '+61 27 21.6', 0, 41000, 8.0e5, 'O5III'), s('HD 15570', '02 32 49.42', '+61 22 42.1', -8, 40000, 6.0e5, 'O4I')],
    look: {
      model: 'hii', variant: 0, scale: [0.95, 1, 0.85], seed: 81.1,
      p: [[0.4, 0.08, 0.95, 0], [0.9, 0.8, 0.05, 0.9], [0.3, 2.6, 1.0, 0.6], [0, 0, 1, -2], [0, 0, 0.1, 1], [1.2, 0.6, 0, 1]],
      prims: [
        { kind: 'cavity', a: [0.0, 0.42, 0.0], ra: 0.14, density: 0.9, rough: 0.4 },
        { kind: 'solid', a: [0.48, -0.32, 0.0], ra: 0.03, b: [0.32, -0.2, 0.0], rb: 0.014, density: 3, rough: 0.35, glow: 1 },
        { kind: 'solid', a: [-0.5, 0.15, 0.0], ra: 0.026, b: [-0.36, 0.1, 0.0], rb: 0.012, density: 3, rough: 0.35, glow: 1 },
      ],
    },
  },
  {
    name: 'Soul Nebula', aliases: ['IC 1848', 'Westerhout 5', 'Embryo Nebula'],
    kind: 'emission', type: 'H II region around IC 1848', ra: '02 51 10', dec: '+60 26 00', dist: 7500, radius: 160,
    sb: 22.5, av: 2.5,
    note: 'Two cavities blown by the cluster IC 1848, rimmed by pillars and bright-rimmed clouds.',
    stars: [s('HD 17505', '02 51 07.97', '+60 25 03.9', 0, 39000, 4.0e5, 'O6.5III')],
    look: {
      model: 'hii', variant: 0, scale: [1, 0.55, 0.6], tilt: [0, 0, 15], seed: 91.7,
      p: [[0.3, 0.1, 0.95, 0], [0.8, 0.8, 0.05, 0.9], [0.3, 2.6, 1.0, 0.6], [0, 0, 1, -2], [0, 0, 0.1, 1], [1.2, 0.5, 0, 1]],
      prims: [
        { kind: 'cavity', a: [0.42, 0.0, 0.0], ra: 0.2, density: 0.9, rough: 0.4 },
        { kind: 'solid', a: [0.75, 0.05, 0.0], ra: 0.03, b: [0.56, 0.02, 0.0], rb: 0.014, density: 3, rough: 0.35, glow: 1 },
        { kind: 'solid', a: [-0.65, 0.2, 0.0], ra: 0.026, b: [-0.45, 0.12, 0.0], rb: 0.012, density: 3, rough: 0.35, glow: 1 },
      ],
    },
  },
  {
    name: 'Tarantula Nebula', aliases: ['30 Doradus', 'NGC 2070', 'R136'],
    kind: 'emission', type: 'Giant H II region in the Large Magellanic Cloud', ra: '05 38 38', dec: '-69 05 42', dist: 160000, radius: 600,
    sb: 19.5, av: 0.3,
    note: 'The most active star-forming region of the Local Group; R136 holds the most massive stars known.',
    host: { galaxy: 'Large Magellanic Cloud', at: [3200, 0, 2400] },
    stars: [sAt('R136a1', [0, 0, 0], 46000, 4.7e6, 'WN5h'), sAt('R136a2', [1, 0.6, -0.5], 50000, 2.4e6, 'WN5h'), sAt('R136c', [-1.2, 1.5, 0.7], 42000, 2.0e6, 'WN5h')],
    look: {
      // Loops and filaments blown by R136 (the "legs"), with cavities between them.
      model: 'hii', variant: 0, scale: [1, 0.85, 0.8], seed: 101.3,
      p: [[0.12, 0.3, 0.95, 1.2], [0.8, 1.2, 0.05, 1.3], [0.4, 3.2, 1.2, 0.45], [0, 0, 1, -2], [0, 0, 0.1, 1], [2.0, 0, 0, 1]],
      prims: [
        { kind: 'cavity', a: [0.3, 0.25, 0], ra: 0.16, density: 0.8, rough: 0.5 },
        { kind: 'cavity', a: [-0.3, -0.25, 0], ra: 0.14, density: 0.8, rough: 0.5 },
        { kind: 'cavity', a: [0.25, -0.35, 0], ra: 0.12, density: 0.8, rough: 0.5 },
        { kind: 'cloud', a: [-0.45, 0.2, 0.05], ra: 0.08, b: [-0.1, 0.45, 0.05], rb: 0.06, density: 2, rough: 0.5, glow: 1 },
      ],
    },
  },
  {
    name: 'Horsehead Nebula', aliases: ['Barnard 33', 'IC 434', 'Lynds 1630', 'NGC 2023'],
    kind: 'dark', type: 'Dark nebula before the H II region IC 434', ra: '05 40 59', dec: '-02 27 30', dist: 1375, radius: 10,
    sb: 22.5, av: 0.3,
    note: 'A pillar of the dark cloud L1630 silhouetted against IC 434, the glow that Sigma Orionis raises on its edge.',
    stars: [s('Sigma Orionis', '05 38 44.77', '-02 36 00.3', 2, 34000, 4.0e4, 'O9.5V'), s('HD 37903', '05 41 38.39', '-02 15 32.5', -0.5, 22000, 1.2e4, 'B1.5V')],
    look: {
      // The dark cloud L1630 to the east, its western edge facing Sigma Orionis glowing as the band IC 434; the
      // horse's head and neck rise from the cloud into the glow, rimmed by it; NGC 2023 shines blue round HD 37903.
      model: 'hii', variant: 0, scale: [1, 1, 1], seed: 111.1,
      p: [[0, 0.3, 0.95, 0], [1.6, 0.3, 0.05, 0.8], [0.22, 2.2, 0.8, 0.0], [0.98, 0.05, 0.1, -0.06], [0.0, 3.0, 0.035, 1], [0.6, 0, 1, 1]],
      prims: [
        { kind: 'solid', a: [-0.14, -0.2, 0.02], ra: 0.06, b: [0.03, 0.02, 0.02], rb: 0.045, density: 5, rough: 0.35, glow: 0.5 },
        { kind: 'solid', a: [0.07, 0.07, 0.02], ra: 0.06, b: [0.02, -0.06, 0.02], rb: 0.028, density: 5, rough: 0.3, glow: 0.5 },
        { kind: 'solid', a: [0.075, 0.11, 0.02], ra: 0.02, b: [0.1, 0.18, 0.02], rb: 0.008, density: 5, rough: 0.2, glow: 0.5 },
        { kind: 'reflect', a: [-0.39, 0.48, 0.05], ra: 0.14, density: 2.0, rough: 0.5 },
      ],
    },
  },
  {
    name: 'Ring Nebula', aliases: ['M57', 'NGC 6720'],
    kind: 'planetary', type: 'Planetary nebula', ra: '18 53 35.08', dec: '+33 01 45.0', dist: 2570, radius: 1.0,
    sb: 17.5, av: 0.2,
    note: 'The gas thrown off by a dying star, a barrel seen almost end-on; its white dwarf is at 125,000 K.',
    stars: [sAt('Central star of M57', [0, 0, 0], 125000, 200, 'DA')],
    look: { model: 'pn', variant: 0, scale: [1, 0.74, 1.5], tilt: [8, 0, 150], seed: 5.3, p: [[0.36, 0.5, 0.6, 0.012], [2.0, 0.8, 0.5, 0], [0, 0, 0, 0]] },
  },
  {
    name: 'Helix Nebula', aliases: ['NGC 7293', 'Caldwell 63', 'Eye of God'],
    kind: 'planetary', type: 'Planetary nebula', ra: '22 29 38.55', dec: '-20 50 13.6', dist: 655, radius: 2.9,
    sb: 21.5, av: 0.05,
    note: 'One of the nearest planetary nebulae: two tilted rings of gas, their inner edge combed into thousands of cometary knots.',
    stars: [sAt('WD 2226-210', [0, 0, 0], 120000, 90, 'DAO')],
    look: { model: 'pn', variant: 3, scale: [1, 0.85, 1], tilt: [12, 0, 30], seed: 8.9, p: [[0.2, 0.5, 0.62, 0.015], [1, 0.9, 0.6, 0], [30, 15, 0.8, 0]] },
  },
  {
    name: 'Dumbbell Nebula', aliases: ['M27', 'NGC 6853', 'Apple Core Nebula'],
    kind: 'planetary', type: 'Planetary nebula', ra: '19 59 36.34', dec: '+22 43 16.1', dist: 1360, radius: 1.44,
    sb: 19.5, av: 0.3,
    note: 'The first planetary nebula discovered (Messier, 1764): a bright "apple core" inside a fainter football of gas.',
    stars: [sAt('Central star of M27', [0, 0, 0], 85000, 100, 'DO')],
    look: { model: 'pn', variant: 1, scale: [0.72, 0.72, 1], tilt: [90, 0, 30], seed: 2.2, p: [[0.5, 0.68, 0.9, 0.012], [0, 0.7, 0.5, 0.9], [0, 0, 0, 0]] },
  },
  {
    name: "Cat's Eye Nebula", aliases: ['NGC 6543', 'Caldwell 6'],
    kind: 'planetary', type: 'Planetary nebula', ra: '17 58 33.42', dec: '+66 37 59.5', dist: 3300, radius: 0.6,
    sb: 15.5, av: 0.1,
    note: 'Overlapping bubbles and jets around a Wolf-Rayet type central star, inside a halo of concentric rings.',
    stars: [sAt('Central star of NGC 6543', [0, 0, 0], 80000, 10000, 'O7+[WR]')],
    look: { model: 'pn', variant: 2, scale: [1, 1, 1], tilt: [70, 0, -10], seed: 4.4, p: [[0.2, 0.3, 0.38, 0.01], [0, 0.6, 1, 0], [20, 60, 0.9, 7]] },
  },
  {
    name: 'Crab Nebula', aliases: ['M1', 'NGC 1952', 'Taurus A', 'SN 1054'],
    kind: 'remnant', type: 'Supernova remnant (pulsar wind nebula)', ra: '05 34 31.94', dec: '+22 00 52.2', dist: 6500, radius: 5.8,
    sb: 19.5, av: 1.6,
    note: 'What is left of the supernova of 1054: a pulsar spinning 30 times a second makes the blue synchrotron glow.',
    stars: [sAt('Crab Pulsar', [0, 0, 0], 600000, 0.4, 'PSR')],
    look: { model: 'snr', variant: 0, scale: [1, 0.66, 0.66], tilt: [0, 0, 45], seed: 9.1, p: [[0.82, 0.12, 0.03, 0.4], [0.15, 1, 1, 0.6]] },
  },
  {
    name: 'Veil Nebula', aliases: ['Cygnus Loop', 'NGC 6960', 'NGC 6992', 'NGC 6995', "Pickering's Triangle", 'Witch\'s Broom'],
    kind: 'remnant', type: 'Supernova remnant', ra: '20 51 00', dec: '+30 40 00', dist: 2400, radius: 63,
    sb: 23.0, av: 0.25,
    note: 'The shell of a star that exploded some 10,000 to 20,000 years ago, its shock lighting thin wrinkled sheets of gas.',
    stars: [],
    look: { model: 'snr', variant: 1, scale: [1, 1.0, 0.95], seed: 12.7, p: [[0.86, 0.07, 0.004, 0.52], [0.55, 0, 1, 1]] },
  },
  {
    name: 'Vela Supernova Remnant', aliases: ['Vela SNR', 'Gum 16', 'Vela Pulsar'],
    kind: 'remnant', type: 'Supernova remnant', ra: '08 35 20.66', dec: '-45 10 35.2', dist: 936, radius: 65,
    sb: 24.0, av: 0.3,
    note: 'The remains of a supernova seen 11,000 years ago; its pulsar is the brightest in the gamma-ray sky.',
    stars: [sAt('Vela Pulsar', [6, -10, 0], 600000, 0.4, 'PSR')],
    look: { model: 'snr', variant: 2, scale: [1, 0.95, 1], seed: 17.3, p: [[0.8, 0.14, 0.005, 0.56], [0.4, 0, 1, 0]] },
  },
  {
    name: 'Pleiades', aliases: ['M45', 'Seven Sisters', 'Merope Nebula', 'NGC 1435', 'IC 349'],
    kind: 'reflection', type: 'Reflection nebula around an open cluster', ra: '03 47 24', dec: '+24 07 00', dist: 444, radius: 9,
    sb: 21.5, av: 0.12,
    note: 'The cluster is drifting through an unrelated dust cloud, which scatters the blue light of its stars.',
    stars: [
      s('Alcyone', '03 47 29.08', '+24 06 18.5', 0.0, 12300, 2400, 'B7III'),
      s('Atlas', '03 49 09.74', '+24 03 12.3', -1.4, 12000, 940, 'B8III'),
      s('Electra', '03 44 52.54', '+24 06 48.0', 1.2, 13400, 1200, 'B6III'),
      s('Maia', '03 45 49.61', '+24 22 03.9', 0.6, 12600, 660, 'B8III'),
      s('Merope', '03 46 19.57', '+23 56 54.1', 0.4, 14000, 630, 'B6IV'),
      s('Taygeta', '03 45 12.50', '+24 28 02.2', -0.9, 13700, 600, 'B6IV'),
      s('Pleione', '03 49 11.22', '+24 08 12.2', -1.6, 12100, 190, 'B8Vne'),
      s('Celaeno', '03 44 48.22', '+24 17 22.1', 1.9, 13300, 240, 'B7IV'),
      s('Asterope', '03 45 54.48', '+24 33 16.2', -0.4, 12300, 90, 'B8V'),
    ],
    look: { model: 'refl', variant: 0, scale: [1, 0.9, 0.8], tilt: [0, 0, 35], seed: 6.6, p: [[1, 3.5, 2.2, 0.55]] },
  },
];

function build(): NebulaData[] {
  return ENTRIES.map((e, id) => {
    // (l, b) stay the catalogue's, also for one placed in another galaxy's model.
    const [l, b] = galactic(e.ra, e.dec);
    let dir = skyDirection(l, b);
    let pos = [SOL.x + dir[0] * e.dist, SOL.y + dir[1] * e.dist, SOL.z + dir[2] * e.dist];
    let dist = e.dist;
    if (e.host) {
      // Where the model of the host galaxy has it (its giant star-forming knot), which is nearly where it is.
      const g = GALAXIES.find((x) => x.name === e.host!.galaxy)!;
      const p = { x: 0, y: 0, z: 0 };
      fromGalaxy(g, e.host.at[0], e.host.at[1], e.host.at[2], p);
      pos = [p.x, p.y, p.z];
      dist = Math.hypot(p.x - SOL.x, p.y - SOL.y, p.z - SOL.z);
      dir = [(p.x - SOL.x) / dist, (p.y - SOL.y) / dist, (p.z - SOL.z) / dist];
    }
    const sight = sightFrame(dir);
    const axes = tilted(sight, e.look.tilt ?? [0, 0, 0]);
    const stars: NebulaStar[] = (e.stars ?? []).map((st) => {
      if ('at' in st) return { name: st.name, x: st.at[0], y: st.at[1], z: st.at[2], temp: st.temp, lum: st.lum, cls: st.cls };
      const [sl, sb] = galactic(st.ra, st.dec);
      const sd = skyDirection(sl, sb);
      // Along its own sight line, at the nebula's distance plus the depth offset (towards Sol: nearer).
      const r = dist - st.depth;
      const w = [SOL.x + sd[0] * r - pos[0], SOL.y + sd[1] * r - pos[1], SOL.z + sd[2] * r - pos[2]];
      return {
        name: st.name, temp: st.temp, lum: st.lum, cls: st.cls,
        x: w[0] * sight[0] + w[1] * sight[1] + w[2] * sight[2],
        y: w[0] * sight[3] + w[1] * sight[4] + w[2] * sight[5],
        z: w[0] * sight[6] + w[1] * sight[7] + w[2] * sight[8],
      };
    });
    return {
      id, name: e.name, aliases: e.aliases, kind: e.kind, type: e.type, l, b, dist,
      x: pos[0], y: pos[1], z: pos[2], radius: e.radius, axes, sight, sb: e.sb, av: e.av,
      stars, look: e.look, note: e.note,
    };
  });
}

export const NEBULAE: NebulaData[] = build();

/** A nebula-frame offset (sight frame, ly) to universe coordinates. */
export function sightToUniverse(n: NebulaData, x: number, y: number, z: number, out: { x: number; y: number; z: number }): void {
  const a = n.sight;
  out.x = n.x + a[0] * x + a[3] * y + a[6] * z;
  out.y = n.y + a[1] * x + a[4] * y + a[7] * z;
  out.z = n.z + a[2] * x + a[5] * y + a[8] * z;
}

/** The nebula a point is inside of (the smallest, if several), or null. */
export function nebulaAt(x: number, y: number, z: number): NebulaData | null {
  let best: NebulaData | null = null;
  for (const n of NEBULAE) {
    if (Math.hypot(n.x - x, n.y - y, n.z - z) < n.radius && (!best || n.radius < best.radius)) best = n;
  }
  return best;
}
