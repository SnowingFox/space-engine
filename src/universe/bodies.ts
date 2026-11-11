import { EARTH_OFFSET, keplerPosition, moonGeocentric, ttFromUnixMs, type Orbit } from './ephemeris';
import type { StarData } from './stars';

export type { Orbit } from './ephemeris';

export type PlanetType = 'terran' | 'ocean' | 'desert' | 'barren' | 'ice' | 'lava' | 'gas' | 'icegiant';
export type Rgb = [number, number, number];

export interface Atmosphere {
  /** Scattering colour (which wavelengths scatter most). */
  color: Rgb;
  /** Relative optical thickness; 1 ≈ Earth. */
  density: number;
  /** Shell thickness as a fraction of the planet radius. */
  height: number;
}

export interface Rings {
  /** In planet radii. */
  inner: number;
  outer: number;
  color: Rgb;
  seed: number;
}

export interface BodyData {
  id: number;
  name: string;
  type: PlanetType;
  /** km */
  radius: number;
  /** Earth masses */
  mass: number;
  /** km, from the parent body (star or planet). */
  orbitRadius: number;
  /** seconds */
  orbitPeriod: number;
  /** Mean anomaly at sim time 0 (the app's epoch), radians. */
  orbitPhase: number;
  inclination: number;
  node: number;
  /** Shape and plane of the orbit; without it the orbit is a circle tilted by inclination about node. */
  orbit?: Orbit;
  /** Angle between the rotation axis and the orbit's pole (the ecliptic's for Sol), radians. */
  axialTilt: number;
  /** Sidereal, seconds; negative turns backwards about the pole (Venus, Uranus, Triton). */
  rotationPeriod: number;
  /**
   * Body axes (x: prime meridian at spin 0, y: north pole, -z: 90 degrees east) to universe axes,
   * as a quaternion [x, y, z, w]. Absent: Euler(axialTilt, node, 0, 'YXZ').
   */
  orientation?: [number, number, number, number];
  /** Rotation about the pole at sim time 0, radians. */
  spinPhase?: number;
  /** Equilibrium temperature, K. */
  temp: number;
  atmosphere: Atmosphere | null;
  rings: Rings | null;
  /** Four type-dependent surface colours, see planet shader. */
  palette: [Rgb, Rgb, Rgb, Rgb];
  /** Shader noise offset. */
  seed: number;
  /** 0..1 fraction of the surface under liquid. */
  seaLevel: number;
  /** 0..1 cloud cover. */
  clouds: number;
  /** Strength of the polar lights (1 ≈ Earth); when absent it follows from the type and the atmosphere. */
  aurora?: number;
  /** Key of the real surface maps under public/textures/ (Solar System bodies only). */
  maps?: string;
  moons: BodyData[];
  parent: BodyData | null;
}

export interface SystemData {
  star: StarData;
  planets: BodyData[];
}

export const GM_SUN = 1.32712e11; // km^3/s^2
export const GM_EARTH = 3.986e5;

export function keplerPeriod(aKm: number, gm: number): number {
  return 2 * Math.PI * Math.sqrt((aKm * aKm * aKm) / gm);
}

/** Wall-clock time (Unix ms) at sim time 0; the HUD shows EPOCH_MS + simTime. */
export const EPOCH_MS = Date.now();
/** Seconds of TT since J2000 at sim time 0. */
export const EPOCH_TT = ttFromUnixMs(EPOCH_MS);

/** The sim time of a moment given as Unix ms (e.g. Date.UTC(...)). */
export function simTimeAt(unixMs: number): number {
  return (unixMs - EPOCH_MS) / 1000;
}

/** The sim time of the frame being drawn, for readouts that are not handed one (main.ts sets it). */
export const simClock = { t: 0 };

const moonTmp = { x: 0, y: 0, z: 0 };

/**
 * Position relative to the parent body at time t (seconds), km.
 * Only the mean anomaly comes from orbitPhase + t / orbitPeriod and the size from orbitRadius,
 * so a copy with orbitRadius 1 and orbitPeriod N traces the unit ellipse in N steps.
 */
export function orbitPosition(b: BodyData, t: number, out: { x: number; y: number; z: number }): void {
  const o = b.orbit;
  if (o) {
    const tt = EPOCH_TT + t;
    if (o.theory === 'moon' && b.orbitRadius === o.a) {
      moonGeocentric(tt, out);
      return;
    }
    const m = b.orbitPhase + (2 * Math.PI * t) / b.orbitPeriod;
    keplerPosition(b.orbitRadius, o.e + o.eDot * tt, o.i + o.iDot * tt, o.node + o.nodeDot * tt, o.peri + o.periDot * tt, m, o.frame, out);
    if (o.theory === 'earth') {
      // The elements are the Earth-Moon barycentre's; the Earth swings around it opposite the Moon.
      moonGeocentric(tt, moonTmp);
      const k = (EARTH_OFFSET * b.orbitRadius) / o.a;
      out.x -= moonTmp.x * k;
      out.y -= moonTmp.y * k;
      out.z -= moonTmp.z * k;
    }
    return;
  }
  const ang = b.orbitPhase + (2 * Math.PI * t) / b.orbitPeriod;
  const px = Math.cos(ang) * b.orbitRadius;
  const pz = Math.sin(ang) * b.orbitRadius;
  // Tilt the orbital plane about the X axis, then swing it around Y by the node angle.
  const ci = Math.cos(b.inclination), si = Math.sin(b.inclination);
  const y = -pz * si;
  const z1 = pz * ci;
  const cn = Math.cos(b.node), sn = Math.sin(b.node);
  out.x = px * cn + z1 * sn;
  out.y = y;
  out.z = -px * sn + z1 * cn;
}

/** Position relative to the system's star, km. */
export function bodyPosition(b: BodyData, t: number, out: { x: number; y: number; z: number }): void {
  orbitPosition(b, t, out);
  if (b.parent) {
    const px = out.x, py = out.y, pz = out.z;
    orbitPosition(b.parent, t, out);
    out.x += px;
    out.y += py;
    out.z += pz;
  }
}

/** Body axes to universe axes before the spin, as [x, y, z, w] (see BodyData.orientation). */
export function bodyOrientation(b: BodyData): [number, number, number, number] {
  if (b.orientation) return b.orientation;
  // Euler(axialTilt, node, 0, 'YXZ'): about Y by node, then about X by the tilt.
  const sx = Math.sin(b.axialTilt / 2), cx = Math.cos(b.axialTilt / 2);
  const sy = Math.sin(b.node / 2), cy = Math.cos(b.node / 2);
  return [cy * sx, sy * cx, -sy * sx, cy * cx];
}

/** Rotation about the body's pole at time t, radians in [0, 2pi). */
export function spinAngle(b: BodyData, t: number): number {
  const turns = ((b.spinPhase ?? 0) / (2 * Math.PI)) + t / b.rotationPeriod;
  return (turns - Math.floor(turns)) * Math.PI * 2;
}

/** Quaternion [x, y, z, w] whose rotation takes x to xAxis and y to yAxis (unit, perpendicular). */
export function basisQuaternion(xAxis: { x: number; y: number; z: number }, yAxis: { x: number; y: number; z: number }): [number, number, number, number] {
  // z = x cross y
  const zx = xAxis.y * yAxis.z - xAxis.z * yAxis.y, zy = xAxis.z * yAxis.x - xAxis.x * yAxis.z, zz = xAxis.x * yAxis.y - xAxis.y * yAxis.x;
  const m00 = xAxis.x, m01 = yAxis.x, m02 = zx;
  const m10 = xAxis.y, m11 = yAxis.y, m12 = zy;
  const m20 = xAxis.z, m21 = yAxis.z, m22 = zz;
  const tr = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const k = 0.5 / Math.sqrt(tr + 1);
    w = 0.25 / k; x = (m21 - m12) * k; y = (m02 - m20) * k; z = (m10 - m01) * k;
  } else if (m00 > m11 && m00 > m22) {
    const k = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / k; x = 0.25 * k; y = (m01 + m10) / k; z = (m02 + m20) / k;
  } else if (m11 > m22) {
    const k = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / k; x = (m01 + m10) / k; y = 0.25 * k; z = (m12 + m21) / k;
  } else {
    const k = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / k; x = (m02 + m20) / k; y = (m12 + m21) / k; z = 0.25 * k;
  }
  return [x, y, z, w];
}

const pa = { x: 0, y: 0, z: 0 }, pb = { x: 0, y: 0, z: 0 };

/** Fraction of a moon's disc lit as seen from its planet's centre at time t, 0..1. */
export function illuminatedFraction(b: BodyData, t: number): number {
  if (!b.parent) return 1;
  orbitPosition(b, t, pa); // planet -> moon
  bodyPosition(b, t, pb); // star -> moon
  const la = Math.hypot(pa.x, pa.y, pa.z), lb = Math.hypot(pb.x, pb.y, pb.z);
  // Phase angle: between the directions from the moon to the star and to the planet.
  const cos = (pa.x * pb.x + pa.y * pb.y + pa.z * pb.z) / (la * lb);
  return (1 + cos) / 2;
}

/** 'Waxing crescent, 23% lit' and the like. */
export function phaseName(b: BodyData, t: number): string {
  const f = illuminatedFraction(b, t);
  const waxing = illuminatedFraction(b, t + 3600) > f;
  const name = f < 0.02 ? 'New' : f > 0.98 ? 'Full'
    : Math.abs(f - 0.5) < 0.03 ? (waxing ? 'First quarter' : 'Last quarter')
    : `${waxing ? 'Waxing' : 'Waning'} ${f < 0.5 ? 'crescent' : 'gibbous'}`;
  return `${name}, ${Math.round(f * 100)}% lit`;
}

export const TYPE_LABEL: Record<PlanetType, string> = {
  terran: 'Terrestrial world',
  ocean: 'Ocean world',
  desert: 'Desert world',
  barren: 'Barren rock',
  ice: 'Ice world',
  lava: 'Lava world',
  gas: 'Gas giant',
  icegiant: 'Ice giant',
};
