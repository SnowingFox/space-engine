import type { StarData } from './stars';

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
  orbitPhase: number;
  inclination: number;
  node: number;
  axialTilt: number;
  /** seconds */
  rotationPeriod: number;
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

/** Position relative to the parent body at time t (seconds), km. */
export function orbitPosition(b: BodyData, t: number, out: { x: number; y: number; z: number }): void {
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
