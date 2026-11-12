import { Rng, hash32 } from '../core/rng';
import { COMPANION_STARS } from './blackHoles';
import { makeStar, makeSol, type StarData } from './stars';
import { densityOf, galaxiesAround, toGalaxy } from './universe';

// The Milky Way lies in the XZ plane, centred on the origin; other galaxies are described
// in universe.ts and reuse the sector streaming below. Units: light years.
export const GALAXY_RADIUS = 52000;
export const SOL_POS = { x: 26000, y: 18, z: 900 };

const ARM_PITCH_K = 1 / Math.tan((13.5 * Math.PI) / 180);

/** 0..1, how strongly a point in the disk belongs to a spiral arm. */
export function armStrength(x: number, z: number): number {
  const r = Math.hypot(x, z);
  if (r < 1) return 1;
  const theta = Math.atan2(z, x);
  const phase = 2 * (theta - ARM_PITCH_K * Math.log(r / 4000));
  const major = Math.pow(0.5 + 0.5 * Math.cos(phase), 3);
  const minor = Math.pow(0.5 + 0.5 * Math.cos(2 * phase + 1.3), 4) * 0.35;
  // Arms dissolve into the bulge near the core.
  const core = Math.min(1, Math.max(0, (r - 2500) / 5000));
  return (1 - core) + core * Math.min(1, major + minor);
}

/** Stellar density relative to the solar neighbourhood (≈1 near Sol). */
export function galaxyDensity(x: number, y: number, z: number): number {
  const r = Math.hypot(x, z);
  const ay = Math.abs(y);
  if (r > GALAXY_RADIUS * 1.15 || ay > 9000) return 0;
  const edge = 1 - smooth(GALAXY_RADIUS * 0.8, GALAXY_RADIUS * 1.1, r);
  const disk = Math.exp(-(r - 26000) / 9500) * edge;
  const vertical = 0.9 * Math.exp(-ay / 320) + 0.1 * Math.exp(-ay / 1300);
  const arms = 0.22 + 1.25 * armStrength(x, z);
  const rb = Math.hypot(r, y * 1.7);
  const bulge = 28 * Math.exp(-rb / 1900);
  return disk * vertical * arms + bulge;
}

function smooth(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// --- Sector streaming -------------------------------------------------------
// Stars live in a stack of cubic grids. Each level has cells 4x larger than the
// one below and holds stars ~16x more luminous, so every level contributes a
// similar number of naked-eye stars: dim dwarfs nearby, supergiants far away.

export const SECTOR_LEVELS = 5;
const BASE_SECTOR_LY = 12;
const STARS_PER_SECTOR = 14; // at density 1
const DENSITY_CAP = 4;
const LEVEL_SAMPLES = [1, 1, 2, 5, 12];

export function sectorSize(level: number): number {
  return BASE_SECTOR_LY * Math.pow(4, level);
}

export function sectorOfPosition(level: number, v: number): number {
  return Math.floor(v / sectorSize(level));
}

const solSector = {
  x: sectorOfPosition(0, SOL_POS.x),
  y: sectorOfPosition(0, SOL_POS.y),
  z: sectorOfPosition(0, SOL_POS.z),
};

const local = { x: 0, y: 0, z: 0 };

export function generateSector(level: number, ix: number, iy: number, iz: number): StarData[] {
  const size = sectorSize(level);
  const ox = ix * size;
  const oy = iy * size;
  const oz = iz * size;
  const stars: StarData[] = [];

  if (level === 0 && ix === solSector.x && iy === solSector.y && iz === solSector.z) {
    stars.push(makeSol(SOL_POS.x, SOL_POS.y, SOL_POS.z));
  }
  // The real stars of the black-hole binaries (blackHoles.ts), in the level that suits their luminosity.
  for (const s of COMPANION_STARS) {
    if (s.level === level && sectorOfPosition(level, s.x) === ix && sectorOfPosition(level, s.y) === iy && sectorOfPosition(level, s.z) === iz) stars.push(s);
  }

  // Most of the universe is empty: only cells inside some galaxy hold stars.
  const half = size / 2;
  const hosts = galaxiesAround(ox + half, oy + half, oz + half)
    .filter((g) => Math.hypot(g.x - ox - half, g.y - oy - half, g.z - oz - half) < g.radius * 1.2 + size);
  if (hosts.length === 0) return stars;
  if (hosts.length === 1 && hosts[0].id === 0) {
    // Cheap reject for cells far above the Milky Way's disk and outside its bulge.
    const yMin = Math.min(Math.abs(oy), Math.abs(oy + size));
    const straddles = oy < 0 && oy + size > 0;
    if (!straddles && yMin > 5000) return stars;
  }

  const seed = hash32(ix, iy, iz, level + 77);
  const rng = new Rng(seed);
  // Large cells are mostly empty space above and below the thin disk, so they
  // need more samples to populate the slice that actually holds stars.
  const candidates = STARS_PER_SECTOR * DENSITY_CAP * LEVEL_SAMPLES[level];
  for (let i = 0; i < candidates; i++) {
    const x = ox + rng.next() * size;
    const y = oy + rng.next() * size;
    const z = oz + rng.next() * size;
    const accept = rng.next() * DENSITY_CAP;
    let density = 0;
    for (const g of hosts) {
      if (g.id === 0) {
        density += galaxyDensity(x, y, z);
      } else {
        toGalaxy(g, x, y, z, local);
        density += densityOf(g, local.x, local.y, local.z);
      }
    }
    if (accept > density) continue;
    stars.push(makeStar(hash32(seed, i, 0x51a2), level, x, y, z));
  }
  return stars;
}
