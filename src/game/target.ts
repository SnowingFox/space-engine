import * as THREE from 'three';
import { KM_PER_LY, SUN_RADIUS_KM } from '../core/units';
import { bodyPosition, type BodyData } from '../universe/bodies';
import type { StarData } from '../universe/stars';

/** Something the player can select and fly to. */
export type Target =
  | { kind: 'star'; star: StarData }
  | { kind: 'body'; star: StarData; body: BodyData };

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
  }
  return out;
}

export function targetRadius(t: Target): number {
  return t.kind === 'body' ? t.body.radius : t.star.radius * SUN_RADIUS_KM;
}

export function targetName(t: Target): string {
  return t.kind === 'body' ? t.body.name : t.star.name;
}

export function sameTarget(a: Target | null, b: Target | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind || a.star.id !== b.star.id) return false;
  return a.kind === 'star' || a.body.id === (b as { body: BodyData }).body.id;
}

/** Distance from the target centre at which the autopilot parks. */
export function parkingDistance(t: Target): number {
  if (t.kind === 'star') return Math.max(t.star.radius * SUN_RADIUS_KM * 14, 4e6);
  return t.body.radius * (t.body.rings ? 5.2 : 3.4);
}
