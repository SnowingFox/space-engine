import * as THREE from 'three';
import { KM_PER_LY, SUN_RADIUS_KM } from '../core/units';
import { bodyPosition, type BodyData } from '../universe/bodies';
import { blackHoleOffset, type BlackHoleData } from '../universe/blackHoles';
import type { StarData } from '../universe/stars';
import type { NebulaData } from '../universe/nebulae';
import type { GalaxyData } from '../universe/universe';

/** Something the player can select and fly to. A galaxy's 'star' is a stand-in at its centre. */
export type Target =
  | { kind: 'star'; star: StarData }
  | { kind: 'body'; star: StarData; body: BodyData }
  | { kind: 'galaxy'; star: StarData; galaxy: GalaxyData }
  /** A black hole's 'star' is its companion (it orbits it) or a stand-in at the hole. */
  | { kind: 'blackhole'; star: StarData; bh: BlackHoleData }
  /** A nebula's 'star' is a stand-in at its centre. */
  | { kind: 'nebula'; star: StarData; nebula: NebulaData };

const galaxyTargets = new Map<number, Target>();

/** The target for a galaxy (one per galaxy, so selections compare equal). */
export function galaxyTarget(galaxy: GalaxyData): Target {
  let t = galaxyTargets.get(galaxy.id);
  if (!t) {
    const star: StarData = {
      id: -1 - galaxy.id, name: galaxy.name, x: galaxy.x, y: galaxy.y, z: galaxy.z,
      temp: 5000, radius: 0, lum: 0, mass: 0, cls: '', kind: 'main', level: 0, virtual: true,
    };
    t = { kind: 'galaxy', star, galaxy };
    galaxyTargets.set(galaxy.id, t);
  }
  return t;
}

const blackHoleTargets = new Map<number, Target>();

/** The target for a black hole (one per hole, so selections compare equal). */
export function blackHoleTarget(bh: BlackHoleData): Target {
  let t = blackHoleTargets.get(bh.id);
  if (!t) {
    const star: StarData = bh.companion ?? {
      id: -1e6 - bh.id, name: bh.name, x: bh.x, y: bh.y, z: bh.z,
      temp: 5000, radius: 0, lum: 0, mass: bh.mass, cls: '', kind: 'main', level: 0, virtual: true,
    };
    t = { kind: 'blackhole', star, bh };
    blackHoleTargets.set(bh.id, t);
  }
  return t;
}

const nebulaTargets = new Map<number, Target>();

/** The target for a nebula (one per nebula, so selections compare equal). */
export function nebulaTarget(nebula: NebulaData): Target {
  let t = nebulaTargets.get(nebula.id);
  if (!t) {
    const star: StarData = {
      id: -2e6 - nebula.id, name: nebula.name, x: nebula.x, y: nebula.y, z: nebula.z,
      temp: 5000, radius: 0, lum: 0, mass: 0, cls: '', kind: 'main', level: 0, virtual: true,
    };
    t = { kind: 'nebula', star, nebula };
    nebulaTargets.set(nebula.id, t);
  }
  return t;
}

/** Target position in km relative to the given anchor star. */
export function targetPosition(t: Target, anchor: StarData, simTime: number, out: THREE.Vector3): THREE.Vector3 {
  out.set(
    (t.star.x - anchor.x) * KM_PER_LY,
    (t.star.y - anchor.y) * KM_PER_LY,
    (t.star.z - anchor.z) * KM_PER_LY,
  );
  if (t.kind === 'body') {
    const p = { x: 0, y: 0, z: 0 };
    bodyPosition(t.body, simTime, p);
    out.x += p.x;
    out.y += p.y;
    out.z += p.z;
  } else if (t.kind === 'blackhole') {
    const p = { x: 0, y: 0, z: 0 };
    blackHoleOffset(t.bh, simTime, p);
    out.x += p.x;
    out.y += p.y;
    out.z += p.z;
  }
  return out;
}

export function targetRadius(t: Target): number {
  if (t.kind === 'galaxy') return t.galaxy.radius * KM_PER_LY;
  if (t.kind === 'nebula') return t.nebula.radius * KM_PER_LY;
  // The event horizon.
  if (t.kind === 'blackhole') return t.bh.rs;
  return t.kind === 'body' ? t.body.radius : t.star.radius * SUN_RADIUS_KM;
}

export function targetName(t: Target): string {
  if (t.kind === 'galaxy') return t.galaxy.name;
  if (t.kind === 'nebula') return t.nebula.name;
  if (t.kind === 'blackhole') return t.bh.name;
  return t.kind === 'body' ? t.body.name : t.star.name;
}

export function sameTarget(a: Target | null, b: Target | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind || a.star.id !== b.star.id) return false;
  if (a.kind === 'blackhole') return a.bh.id === (b as { bh: BlackHoleData }).bh.id;
  return a.kind !== 'body' || a.body.id === (b as { body: BodyData }).body.id;
}

/** Where the autopilot parks by a black hole, Schwarzschild radii. */
export const BLACK_HOLE_PARKING = 40;

/** Distance from the target centre at which the autopilot parks. */
export function parkingDistance(t: Target): number {
  if (t.kind === 'star') return Math.max(t.star.radius * SUN_RADIUS_KM * 14, 4e6);
  // Far enough to take in the whole galaxy at a normal field of view.
  if (t.kind === 'galaxy') return t.galaxy.radius * KM_PER_LY * 2.6;
  // Three radii out: the whole nebula in view, its depth still showing as you move.
  if (t.kind === 'nebula') return t.nebula.radius * KM_PER_LY * 3;
  // Well outside the photon sphere and the innermost stable orbit, close enough for the disc and its lensed far side to fill the view.
  if (t.kind === 'blackhole') return t.bh.rs * BLACK_HOLE_PARKING;
  return t.body.radius * (t.body.rings ? 5.2 : 3.4);
}
