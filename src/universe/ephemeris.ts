// The Solar System as it really is on the date shown: orbits, the Moon, and how every body turns.
//
// Sources
//   Planets: E. M. Standish, "Keplerian Elements for Approximate Positions of the Major Planets",
//     JPL Solar System Dynamics, Table 1 (mean ecliptic and equinox of J2000, valid 1800-2050).
//     https://ssd.jpl.nasa.gov/planets/approx_pos.html
//   Moon: J. Meeus, Astronomical Algorithms (2nd ed., 1998), ch. 47 (from Chapront ELP-2000/82),
//     the full tables 47.A and 47.B; ~10" in longitude, ~4" in latitude.
//   Satellites: JPL SSD planetary satellite mean elements (https://ssd.jpl.nasa.gov/sats/elem/),
//     referred to each moon's local Laplace plane.
//   Rotation: IAU WGCCRE 2015 (Archinal et al. 2018, Celest. Mech. Dyn. Astr. 130:22) as given in
//     NAIF pck00011.tpc; Earth from the IERS Earth Rotation Angle.
//   Galactic frame: Hipparcos (ESA 1997, vol. 1 sec. 1.5.3) ICRS-to-galactic matrix.
//
// Everything here is plain numbers (no three.js) so that it can be checked from Node directly.

import { GAL_TO_APP as SKY_GAL_TO_APP } from './universe';

const DEG = Math.PI / 180;
const DAY = 86400;
const CENTURY = 36525 * DAY;
const AU_KM = 1.495978707e8;
/** Earth/Moon mass ratio (DE440). */
const EMRAT = 81.3005682;

/** 2000-01-01 12:00 UTC as a Unix time, ms. */
export const J2000_UNIX_MS = Date.UTC(2000, 0, 1, 12);
/** TT - UTC since 2017 (37 leap seconds + 32.184 s): seconds since J2000 TT = Unix seconds since J2000 noon + this. */
export const TT_MINUS_UTC = 69.184;

/** Seconds of TT since J2000 for a Unix time in ms. (UT1 is taken as UTC: < 1 s.) */
export function ttFromUnixMs(ms: number): number {
  return (ms - J2000_UNIX_MS) / 1000 + TT_MINUS_UTC;
}

// ---------------------------------------------------------------------------------------------
// Frames. The app's universe axes: the Milky Way's disc in XZ, galactic north +Y, and a galactic
// direction (l, b) at (-cos b cos l, sin b, -cos b sin l) (see fromSky in universe.ts).

/** ICRS (equatorial J2000) to galactic, rows. */
const ICRS_TO_GAL = [
  -0.0548755604162154, -0.8734370902348850, -0.4838350155487132,
  +0.4941094278755837, -0.4448296299600112, +0.7469822444972189,
  -0.8676661490190047, -0.1980763734312015, +0.4559837761750669,
];

function mul3(a: number[], b: number[]): number[] {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  }
  return r;
}

function det3(m: number[]): number {
  return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
}


/** Galactic (x to the centre, y to l = 90, z to the north pole) to the app's axes, as fromSky in universe.ts. */
const GAL_TO_APP = [...SKY_GAL_TO_APP];

/** Equatorial J2000 to the app's axes as the sky is laid out (galaxies, the Milky Way survey). */
export const SKY_EQ_TO_APP: number[] = mul3(GAL_TO_APP, ICRS_TO_GAL);

/** Obliquity of the ecliptic at J2000 (IAU 2006). */
export const OBLIQUITY = 23.43928 * DEG;

const ce = Math.cos(OBLIQUITY), se = Math.sin(OBLIQUITY);
const ECL_TO_EQ = [1, 0, 0, 0, ce, -se, 0, se, ce];
const EQ_TO_ECL = [1, 0, 0, 0, ce, se, 0, -se, ce];

/**
 * The sky's mapping is a proper rotation (universe.ts), so the Solar System goes in by the same one:
 * the planets follow the zodiac against the Milky Way and Earth's pole points at the real celestial pole.
 * (Kept as a check: a mirrored sky would need the Solar System reflected through the ecliptic instead.)
 */
const ECL_FLIP = det3(SKY_EQ_TO_APP) < 0 ? [1, 0, 0, 0, 1, 0, 0, 0, -1] : [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Ecliptic J2000 to the app's axes (for the Solar System). */
export const ECL_TO_APP: number[] = mul3(mul3(SKY_EQ_TO_APP, ECL_TO_EQ), ECL_FLIP);

/** Equatorial J2000 to the app's axes (for the Solar System, consistent with ECL_TO_APP). */
export const EQ_TO_APP: number[] = mul3(ECL_TO_APP, EQ_TO_ECL);

export interface Vec { x: number; y: number; z: number }

export function apply3(m: number[], x: number, y: number, z: number, out: Vec): Vec {
  out.x = m[0] * x + m[1] * y + m[2] * z;
  out.y = m[3] * x + m[4] * y + m[5] * z;
  out.z = m[6] * x + m[7] * y + m[8] * z;
  return out;
}

/** Unit vector, in app axes, of an equatorial (J2000) direction; degrees. */
export function raDecToApp(raDeg: number, decDeg: number, out: Vec = { x: 0, y: 0, z: 0 }): Vec {
  const ra = raDeg * DEG, dec = decDeg * DEG;
  return apply3(EQ_TO_APP, Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec), out);
}

/**
 * Columns of a frame whose z axis is the pole (RA, Dec) and whose x axis is the ascending node of
 * its equator on the ICRF equator (the IAU convention for prime meridians), mapped to app axes.
 */
export function poleFrame(raDeg: number, decDeg: number): number[] {
  const ra = raDeg * DEG, dec = decDeg * DEG;
  const x = [-Math.sin(ra), Math.cos(ra), 0];
  const z = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return mul3(EQ_TO_APP, [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]]);
}

// ---------------------------------------------------------------------------------------------
// Kepler orbits.

/**
 * Keplerian elements about the parent body. Angles in radians at J2000 TT, rates per second.
 * The mean anomaly is not stored here: it lives in the body (orbitPhase at the app's epoch and
 * orbitPeriod), so that a copy with a unit radius and period traces the same ellipse.
 */
export interface Orbit {
  /** Semi-major axis, km. */
  a: number;
  e: number;
  /** Inclination to the reference plane. */
  i: number;
  /** Longitude of the ascending node on the reference plane. */
  node: number;
  /** Argument of periapsis. */
  peri: number;
  eDot: number;
  iDot: number;
  nodeDot: number;
  periDot: number;
  /** Mean anomaly at J2000 TT, and its rate (rad/s). */
  m0: number;
  n: number;
  /** Reference plane (x towards its origin of longitudes, z its pole) to app axes, row-major. */
  frame: number[];
  /** Positions that come from a theory rather than the elements (the elements still draw the orbit). */
  theory?: 'earth' | 'moon';
}

/** Eccentric anomaly for mean anomaly m (Newton, converges in a few steps for e < 0.9). */
export function solveKepler(m: number, e: number): number {
  m = m - 2 * Math.PI * Math.floor(m / (2 * Math.PI) + 0.5);
  let E = e < 0.8 ? m : Math.PI * Math.sign(m || 1);
  for (let k = 0; k < 12; k++) {
    const d = (E - e * Math.sin(E) - m) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return E;
}

/** Position on an ellipse with the focus at the origin, rotated into app axes. */
export function keplerPosition(a: number, e: number, i: number, node: number, peri: number, m: number, frame: number[], out: Vec): Vec {
  const E = solveKepler(m, e);
  const xo = a * (Math.cos(E) - e);
  const yo = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(peri), sw = Math.sin(peri);
  const cn = Math.cos(node), sn = Math.sin(node);
  const ci = Math.cos(i), si = Math.sin(i);
  const x1 = cw * xo - sw * yo, y1 = sw * xo + cw * yo;
  const x2 = x1, y2 = ci * y1, z2 = si * y1;
  return apply3(frame, cn * x2 - sn * y2, sn * x2 + cn * y2, z2, out);
}

/** Unit normal of the orbit plane (direction of the angular momentum) in app axes. */
export function orbitNormal(o: Orbit, out: Vec): Vec {
  return apply3(o.frame, Math.sin(o.i) * Math.sin(o.node), -Math.sin(o.i) * Math.cos(o.node), Math.cos(o.i), out);
}

/** Unit vector to periapsis in app axes. */
export function periapsisDir(o: Orbit, out: Vec): Vec {
  const cw = Math.cos(o.peri), sw = Math.sin(o.peri), cn = Math.cos(o.node), sn = Math.sin(o.node), ci = Math.cos(o.i);
  return apply3(o.frame, cn * cw - sn * ci * sw, sn * cw + cn * ci * sw, Math.sin(o.i) * sw, out);
}

// ---------------------------------------------------------------------------------------------
// Planets: JPL Table 1. a (AU), e, I, L, long. peri., long. node (deg) and their rates per century.

type Row = [number, number, number, number, number, number];
const PLANET_ELEMENTS: Record<string, [Row, Row]> = {
  Mercury: [[0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593],
    [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081]],
  Venus: [[0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255],
    [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418]],
  // The Earth-Moon barycentre.
  Earth: [[1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
    [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0]],
  Mars: [[1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343]],
  Jupiter: [[5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
    [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106]],
  Saturn: [[9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
    [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794]],
  Uranus: [[19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503],
    [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589]],
  Neptune: [[30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
    [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664]],
};

export function planetOrbit(name: string): Orbit | null {
  const el = PLANET_ELEMENTS[name];
  if (!el) return null;
  const [[a, e, i, L, w, node], [, eD, iD, LD, wD, nodeD]] = el;
  return {
    a: a * AU_KM, e, i: i * DEG, node: node * DEG, peri: (w - node) * DEG,
    eDot: eD / CENTURY, iDot: (iD * DEG) / CENTURY, nodeDot: (nodeD * DEG) / CENTURY, periDot: ((wD - nodeD) * DEG) / CENTURY,
    m0: (L - w) * DEG, n: ((LD - wD) * DEG) / CENTURY,
    frame: ECL_TO_APP,
    theory: name === 'Earth' ? 'earth' : undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Satellites: JPL mean elements on the local Laplace plane. The node is counted from the ascending
// node of the Laplace plane on the ICRF equator. P and the node and apse periods are converted to
// rates; the mean motion n is that of the mean longitude, so the mean anomaly advances at n - (dw + dO).

interface SatRow {
  /** Epoch, JD TT. */
  epoch: number;
  a: number; e: number; peri: number; m: number; i: number; node: number;
  /** deg/day */
  n: number;
  /** Laplace plane pole, deg (RA, Dec). Absent: the J2000 ecliptic. */
  pole?: [number, number];
  /** deg/century */
  periRate: number; nodeRate: number;
}

const SATELLITES: Record<string, SatRow> = {
  // Mean ecliptic elements: draw the orbit; the position comes from Meeus.
  Moon: { epoch: 2451545.0, a: 384400, e: 0.0554, peri: 318.15, m: 135.27, i: 5.16, node: 125.08, n: 13.176358, periRate: 6003.00150075, nodeRate: -1934.13205824 },
  Io: { epoch: 2450464.5, a: 421800, e: 0.0041, peri: 84.129, m: 342.021, i: 0.036, node: 43.977, n: 203.4889583, pole: [268.057, 64.495], periRate: 22153.8461538, nodeRate: -4851.75202156 },
  Europa: { epoch: 2450464.5, a: 671100, e: 0.0094, peri: 88.97, m: 171.016, i: 0.466, node: 219.106, n: 101.3747242, pole: [268.084, 64.506], periRate: 25824.964132, nodeRate: -1192.68486615 },
  Ganymede: { epoch: 2450464.5, a: 1070400, e: 0.0013, peri: 192.417, m: 317.54, i: 0.177, node: 63.552, n: 50.3176072, pole: [268.168, 64.543], periRate: 566.491998301, nodeRate: -271.38269483 },
  Callisto: { epoch: 2450464.5, a: 1882700, e: 0.0074, peri: 52.643, m: 181.408, i: 0.192, node: 298.848, n: 21.5710728, pole: [268.639, 64.749], periRate: 174.969623329, nodeRate: -106.251106782 },
  Enceladus: { epoch: 2451545.0, a: 238042, e: 0.0, peri: 0.076, m: 199.686, i: 0.003, node: 342.507, n: 262.7318978, pole: [40.586, 83.536], periRate: 0, nodeRate: 0 },
  Titan: { epoch: 2451545.0, a: 1221865, e: 0.0288, peri: 180.532, m: 163.31, i: 0.306, node: 28.06, n: 22.5769756, pole: [36.214, 83.949], periRate: 102.237873452, nodeRate: -51.0928186205 },
  Triton: { epoch: 2451545.0, a: 354759, e: 0.0, peri: 66.142, m: 352.257, i: 156.865, node: 177.608, n: 61.2572638, pole: [299.456, 43.414], periRate: 0, nodeRate: 52.3677496123 },
};

export function satelliteOrbit(name: string): Orbit | null {
  const s = SATELLITES[name];
  if (!s) return null;
  const dt = (2451545.0 - s.epoch) * DAY;
  const periDot = (s.periRate * DEG) / CENTURY, nodeDot = (s.nodeRate * DEG) / CENTURY;
  // n is the sidereal mean motion (it equals the IAU spin rate of the synchronous moons), so the
  // mean anomaly runs at n less the turning of the apse and the node's share in the orbit plane
  // (cos i of it: for retrograde Triton this sign matters, ~30 degrees over 25 years; checked
  // against Triton's IAU prime meridian, which faces Neptune).
  const n = (s.n * DEG) / DAY - periDot - nodeDot * Math.cos(s.i * DEG);
  return {
    a: s.a, e: s.e, i: s.i * DEG,
    node: s.node * DEG + nodeDot * dt, peri: s.peri * DEG + periDot * dt,
    eDot: 0, iDot: 0, nodeDot, periDot,
    m0: s.m * DEG + n * dt, n,
    frame: s.pole ? poleFrame(s.pole[0], s.pole[1]) : ECL_TO_APP,
    theory: name === 'Moon' ? 'moon' : undefined,
  };
}
// ---------------------------------------------------------------------------------------------
// The Moon: Meeus ch. 47. Rows: D, M, M', F multipliers, then sum-l (1e-6 deg), sum-r (1e-3 km).

const MOON_LR = [
  0, 0, 1, 0, 6288774, -20905355, 2, 0, -1, 0, 1274027, -3699111, 2, 0, 0, 0, 658314, -2955968, 0, 0, 2, 0, 213618, -569925,
  0, 1, 0, 0, -185116, 48888, 0, 0, 0, 2, -114332, -3149, 2, 0, -2, 0, 58793, 246158, 2, -1, -1, 0, 57066, -152138,
  2, 0, 1, 0, 53322, -170733, 2, -1, 0, 0, 45758, -204586, 0, 1, -1, 0, -40923, -129620, 1, 0, 0, 0, -34720, 108743,
  0, 1, 1, 0, -30383, 104755, 2, 0, 0, -2, 15327, 10321, 0, 0, 1, 2, -12528, 0, 0, 0, 1, -2, 10980, 79661,
  4, 0, -1, 0, 10675, -34782, 0, 0, 3, 0, 10034, -23210, 4, 0, -2, 0, 8548, -21636, 2, 1, -1, 0, -7888, 24208,
  2, 1, 0, 0, -6766, 30824, 1, 0, -1, 0, -5163, -8379, 1, 1, 0, 0, 4987, -16675, 2, -1, 1, 0, 4036, -12831,
  2, 0, 2, 0, 3994, -10445, 4, 0, 0, 0, 3861, -11650, 2, 0, -3, 0, 3665, 14403, 0, 1, -2, 0, -2689, -7003,
  2, 0, -1, 2, -2602, 0, 2, -1, -2, 0, 2390, 10056, 1, 0, 1, 0, -2348, 6322, 2, -2, 0, 0, 2236, -9884,
  0, 1, 2, 0, -2120, 5751, 0, 2, 0, 0, -2069, 0, 2, -2, -1, 0, 2048, -4950, 2, 0, 1, -2, -1773, 4130,
  2, 0, 0, 2, -1595, 0, 4, -1, -1, 0, 1215, -3958, 0, 0, 2, 2, -1110, 0, 3, 0, -1, 0, -892, 3258,
  2, 1, 1, 0, -810, 2616, 4, -1, -2, 0, 759, -1897, 0, 2, -1, 0, -713, -2117, 2, 2, -1, 0, -700, 2354,
  2, 1, -2, 0, 691, 0, 2, -1, 0, -2, 596, 0, 4, 0, 1, 0, 549, -1423, 0, 0, 4, 0, 537, -1117,
  4, -1, 0, 0, 520, -1571, 1, 0, -2, 0, -487, -1739, 2, 1, 0, -2, -399, 0, 0, 0, 2, -2, -381, -4421,
  1, 1, 1, 0, 351, 0, 3, 0, -2, 0, -340, 0, 4, 0, -3, 0, 330, 0, 2, -1, 2, 0, 327, 0,
  0, 2, 1, 0, -323, 1165, 1, 1, -1, 0, 299, 0, 2, 0, 3, 0, 294, 0, 2, 0, -1, -2, 0, 8752,
];
/** D, M, M', F multipliers, then sum-b (1e-6 deg). */
const MOON_B = [
  0, 0, 0, 1, 5128122, 0, 0, 1, 1, 280602, 0, 0, 1, -1, 277693, 2, 0, 0, -1, 173237,
  2, 0, -1, 1, 55413, 2, 0, -1, -1, 46271, 2, 0, 0, 1, 32573, 0, 0, 2, 1, 17198,
  2, 0, 1, -1, 9266, 0, 0, 2, -1, 8822, 2, -1, 0, -1, 8216, 2, 0, -2, -1, 4324,
  2, 0, 1, 1, 4200, 2, 1, 0, -1, -3359, 2, -1, -1, 1, 2463, 2, -1, 0, 1, 2211,
  2, -1, -1, -1, 2065, 0, 1, -1, -1, -1870, 4, 0, -1, -1, 1828, 0, 1, 0, 1, -1794,
  0, 0, 0, 3, -1749, 0, 1, -1, 1, -1565, 1, 0, 0, 1, -1491, 0, 1, 1, 1, -1475,
  0, 1, 1, -1, -1410, 0, 1, 0, -1, -1344, 1, 0, 0, -1, -1335, 0, 0, 3, 1, 1107,
  4, 0, 0, -1, 1021, 4, 0, -1, 1, 833, 0, 0, 1, -3, 777, 4, 0, -2, 1, 671,
  2, 0, 0, -3, 607, 2, 0, 2, -1, 596, 2, -1, 1, -1, 491, 2, 0, -2, 1, -451,
  0, 0, 3, -1, 439, 2, 0, 2, 1, 422, 2, 0, -3, -1, 421, 2, 1, -1, 1, -366,
  2, 1, 0, 1, -351, 4, 0, 0, 1, 331, 2, -1, 1, 1, 315, 2, -2, 0, -1, 302,
  0, 0, 1, 3, -283, 2, 1, 1, -1, -229, 1, 1, 0, -1, 223, 1, 1, 0, 1, 223,
  0, 1, -2, -1, -220, 2, 1, -1, -1, -220, 1, 0, 1, 1, -185, 2, -1, -2, -1, 181,
  0, 1, 2, 1, -177, 4, 0, -2, -1, 176, 4, -1, -1, -1, 166, 1, 0, 1, -1, -164,
  4, 0, 1, -1, 132, 1, 0, -1, -1, -119, 4, -1, 0, -1, 115, 2, -2, 0, 1, 107,
];

const moonCache = { t: NaN, x: 0, y: 0, z: 0 };

/** Geocentric position of the Moon in app axes, km, at t seconds of TT since J2000. */
export function moonGeocentric(t: number, out: Vec): Vec {
  if (t !== moonCache.t) {
    const T = t / CENTURY;
    const T2 = T * T, T3 = T2 * T, T4 = T3 * T;
    const Lp = (218.3164477 + 481267.88123421 * T - 0.0015786 * T2 + T3 / 538841 - T4 / 65194000) * DEG;
    const D = (297.8501921 + 445267.1114034 * T - 0.0018819 * T2 + T3 / 545868 - T4 / 113065000) * DEG;
    const M = (357.5291092 + 35999.0502909 * T - 0.0001536 * T2 + T3 / 24490000) * DEG;
    const Mp = (134.9633964 + 477198.8675055 * T + 0.0087414 * T2 + T3 / 69699 - T4 / 14712000) * DEG;
    const F = (93.272095 + 483202.0175233 * T - 0.0036539 * T2 - T3 / 3526000 + T4 / 863310000) * DEG;
    const A1 = (119.75 + 131.849 * T) * DEG, A2 = (53.09 + 479264.29 * T) * DEG, A3 = (313.45 + 481266.484 * T) * DEG;
    const E = 1 - 0.002516 * T - 0.0000074 * T2;
    let sl = 3958 * Math.sin(A1) + 1962 * Math.sin(Lp - F) + 318 * Math.sin(A2);
    let sr = 0;
    let sb = -2235 * Math.sin(Lp) + 382 * Math.sin(A3) + 175 * Math.sin(A1 - F) + 175 * Math.sin(A1 + F)
      + 127 * Math.sin(Lp - Mp) - 115 * Math.sin(Lp + Mp);
    for (let k = 0; k < MOON_LR.length; k += 6) {
      const m = MOON_LR[k + 1];
      const arg = MOON_LR[k] * D + m * M + MOON_LR[k + 2] * Mp + MOON_LR[k + 3] * F;
      const f = m === 0 ? 1 : m === 1 || m === -1 ? E : E * E;
      sl += MOON_LR[k + 4] * f * Math.sin(arg);
      sr += MOON_LR[k + 5] * f * Math.cos(arg);
    }
    for (let k = 0; k < MOON_B.length; k += 5) {
      const m = MOON_B[k + 1];
      const arg = MOON_B[k] * D + m * M + MOON_B[k + 2] * Mp + MOON_B[k + 3] * F;
      sb += MOON_B[k + 4] * (m === 0 ? 1 : m === 1 || m === -1 ? E : E * E) * Math.sin(arg);
    }
    // Mean ecliptic and equinox of date ...
    const lon = Lp + sl * 1e-6 * DEG;
    const lat = sb * 1e-6 * DEG;
    const r = 385000.56 + sr * 1e-3;
    // ... back to J2000 (Meeus 21.5, from the epoch of date over -T centuries).
    const t1 = -T;
    const eta = ((47.0029 - 0.06603 * T + 0.000598 * T2) * t1 + (-0.03302 + 0.000598 * T) * t1 * t1 + 0.00006 * t1 * t1 * t1) / 3600 * DEG;
    const Pi = 174.876384 * DEG + ((3289.4789 * T + 0.60622 * T2) - (869.8089 + 0.50491 * T) * t1 + 0.03536 * t1 * t1) / 3600 * DEG;
    const p = ((5029.0966 + 2.22226 * T - 0.000042 * T2) * t1 + (1.11113 - 0.000042 * T) * t1 * t1 - 0.000006 * t1 * t1 * t1) / 3600 * DEG;
    const a = Math.cos(eta) * Math.cos(lat) * Math.sin(Pi - lon) - Math.sin(eta) * Math.sin(lat);
    const b = Math.cos(lat) * Math.cos(Pi - lon);
    const c = Math.cos(eta) * Math.sin(lat) + Math.sin(eta) * Math.cos(lat) * Math.sin(Pi - lon);
    const lon0 = p + Pi - Math.atan2(a, b);
    const lat0 = Math.asin(Math.max(-1, Math.min(1, c)));
    apply3(ECL_TO_APP, r * Math.cos(lat0) * Math.cos(lon0), r * Math.cos(lat0) * Math.sin(lon0), r * Math.sin(lat0), moonCache);
    moonCache.t = t;
  }
  out.x = moonCache.x;
  out.y = moonCache.y;
  out.z = moonCache.z;
  return out;
}

/** How far the Earth sits from the Earth-Moon barycentre, as a fraction of the Moon's distance. */
export const EARTH_OFFSET = 1 / (1 + EMRAT);

// ---------------------------------------------------------------------------------------------
// Rotation: IAU WGCCRE. Pole RA/Dec (deg) and prime meridian W (deg) at t seconds of TT since J2000.

export interface Rotation { ra: number; dec: number; w: number; /** deg/day */ rate: number }

const s = (deg: number) => Math.sin(deg * DEG);
const c = (deg: number) => Math.cos(deg * DEG);

export function iauRotation(name: string, t: number): Rotation | null {
  const d = t / DAY, T = t / CENTURY;
  switch (name) {
    case 'Mercury': return { ra: 281.0103 - 0.0328 * T, dec: 61.4155 - 0.0049 * T, w: 329.5988 + 6.1385108 * d, rate: 6.1385108 };
    case 'Venus': return { ra: 272.76, dec: 67.16, w: 160.20 - 1.4813688 * d, rate: -1.4813688 };
    case 'Earth': {
      // The Earth Rotation Angle (IERS 2010) turns the prime meridian away from the CIO, which sits
      // within 0.01 degrees of the ICRF origin; W counts from the node of the equator instead.
      const du = (t - TT_MINUS_UTC) / DAY;
      const era = 360 * (0.7790572732640 + 0.00273781191135448 * du + (du % 1));
      const ra = -0.641 * T;
      return { ra, dec: 90 - 0.557 * T, w: era - (ra + 90), rate: 360.98561228 };
    }
    case 'Mars': return {
      ra: 317.269202 - 0.10927547 * T + 0.419057 * s(79.398797 + 0.5042615 * T),
      dec: 54.432516 - 0.05827105 * T + 1.591274 * c(166.325722 + 0.5042615 * T),
      w: 176.049863 + 350.891982443297 * d + 0.584542 * s(95.391654 + 0.5042615 * T),
      rate: 350.891982443297,
    };
    case 'Jupiter': return { ra: 268.056595 - 0.006499 * T, dec: 64.495303 + 0.002413 * T, w: 284.95 + 870.536 * d, rate: 870.536 };
    case 'Saturn': return { ra: 40.589 - 0.036 * T, dec: 83.537 - 0.004 * T, w: 38.90 + 810.7939024 * d, rate: 810.7939024 };
    case 'Uranus': return { ra: 257.311, dec: -15.175, w: 203.81 - 501.1600928 * d, rate: -501.1600928 };
    case 'Neptune': {
      const N = 357.85 + 52.316 * T;
      return { ra: 299.36 + 0.70 * s(N), dec: 43.46 - 0.51 * c(N), w: 249.978 + 541.1397757 * d - 0.48 * s(N), rate: 541.1397757 };
    }
    case 'Moon': {
      const E = [125.045 - 0.0529921 * d, 250.089 - 0.1059842 * d, 260.008 + 13.0120009 * d, 176.625 + 13.3407154 * d,
        357.529 + 0.9856003 * d, 311.589 + 26.4057084 * d, 134.963 + 13.0649930 * d, 276.617 + 0.3287146 * d,
        34.226 + 1.7484877 * d, 15.134 - 0.1589763 * d, 119.743 + 0.0036096 * d, 239.961 + 0.1643573 * d, 25.053 + 12.9590088 * d];
      return {
        ra: 269.9949 + 0.0031 * T - 3.8787 * s(E[0]) - 0.1204 * s(E[1]) + 0.0700 * s(E[2]) - 0.0172 * s(E[3])
          + 0.0072 * s(E[5]) - 0.0052 * s(E[9]) + 0.0043 * s(E[12]),
        dec: 66.5392 + 0.0130 * T + 1.5419 * c(E[0]) + 0.0239 * c(E[1]) - 0.0278 * c(E[2]) + 0.0068 * c(E[3])
          - 0.0029 * c(E[5]) + 0.0009 * c(E[6]) + 0.0008 * c(E[9]) - 0.0009 * c(E[12]),
        w: 38.3213 + 13.17635815 * d - 1.4e-12 * d * d + 3.5610 * s(E[0]) + 0.1208 * s(E[1]) - 0.0642 * s(E[2])
          + 0.0158 * s(E[3]) + 0.0252 * s(E[4]) - 0.0066 * s(E[5]) - 0.0047 * s(E[6]) - 0.0046 * s(E[7])
          + 0.0028 * s(E[8]) + 0.0052 * s(E[9]) + 0.0040 * s(E[10]) + 0.0019 * s(E[11]) - 0.0044 * s(E[12]),
        rate: 13.17635815,
      };
    }
  }
  // Jupiter's satellites.
  const J3 = 283.90 + 4850.7 * T, J4 = 355.80 + 1191.3 * T, J5 = 119.90 + 262.1 * T, J6 = 229.80 + 64.3 * T;
  const J7 = 352.25 + 2382.6 * T, J8 = 113.35 + 6070.0 * T;
  switch (name) {
    case 'Io': return {
      ra: 268.05 - 0.009 * T + 0.094 * s(J3) + 0.024 * s(J4), dec: 64.50 + 0.003 * T + 0.040 * c(J3) + 0.011 * c(J4),
      w: 200.39 + 203.4889538 * d - 0.085 * s(J3) - 0.022 * s(J4), rate: 203.4889538,
    };
    case 'Europa': return {
      ra: 268.08 - 0.009 * T + 1.086 * s(J4) + 0.060 * s(J5) + 0.015 * s(J6) + 0.009 * s(J7),
      dec: 64.51 + 0.003 * T + 0.468 * c(J4) + 0.026 * c(J5) + 0.007 * c(J6) + 0.002 * c(J7),
      w: 36.022 + 101.3747235 * d - 0.980 * s(J4) - 0.054 * s(J5) - 0.014 * s(J6) - 0.008 * s(J7), rate: 101.3747235,
    };
    case 'Ganymede': return {
      ra: 268.20 - 0.009 * T - 0.037 * s(J4) + 0.431 * s(J5) + 0.091 * s(J6),
      dec: 64.57 + 0.003 * T - 0.016 * c(J4) + 0.186 * c(J5) + 0.039 * c(J6),
      w: 44.064 + 50.3176081 * d + 0.033 * s(J4) - 0.389 * s(J5) - 0.082 * s(J6), rate: 50.3176081,
    };
    case 'Callisto': return {
      ra: 268.72 - 0.009 * T - 0.068 * s(J5) + 0.590 * s(J6) + 0.010 * s(J8),
      dec: 64.83 + 0.003 * T - 0.029 * c(J5) + 0.254 * c(J6) - 0.004 * c(J8),
      w: 259.51 + 21.5710715 * d + 0.061 * s(J5) - 0.533 * s(J6) - 0.009 * s(J8), rate: 21.5710715,
    };
    case 'Enceladus': return { ra: 40.66 - 0.036 * T, dec: 83.52 - 0.004 * T, w: 6.32 + 262.7318996 * d, rate: 262.7318996 };
    case 'Titan': return { ra: 39.4827, dec: 83.4279, w: 186.5855 + 22.5769768 * d, rate: 22.5769768 };
    case 'Triton': {
      const N7 = 177.85 + 52.316 * T;
      let ra = 299.36, dec = 41.17, w = 296.53 - 61.2572637 * d;
      const RA = [-32.35, -6.28, -2.08, -0.74, -0.28, -0.11, -0.07, -0.02, -0.01];
      const DEC = [22.55, 2.10, 0.55, 0.16, 0.05, 0.02, 0.01, 0, 0];
      const W = [22.25, 6.73, 2.05, 0.74, 0.28, 0.11, 0.05, 0.02, 0.01];
      for (let k = 0; k < 9; k++) {
        ra += RA[k] * s((k + 1) * N7);
        dec += DEC[k] * c((k + 1) * N7);
        w += W[k] * s((k + 1) * N7);
      }
      return { ra, dec, w, rate: -61.2572637 };
    }
  }
  return null;
}
