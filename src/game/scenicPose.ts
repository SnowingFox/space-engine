import * as THREE from 'three';
import { KM_PER_LY, SUN_RADIUS_KM } from '../core/units';
import { bodyPosition, simTimeAt, type BodyData } from '../universe/bodies';
import { SOL_POS } from '../universe/galaxy';
import { makeStar, type StarData } from '../universe/stars';
import { generateSystem } from '../universe/system';
import { SCENIC_EPOCH_MS, type BodyPose, type SpacePose } from './scenic';

export interface ResolvedBodyPose {
  star: StarData;
  body: BodyData;
  /** Camera position, km relative to the star, at the pose's sim time. */
  local: THREE.Vector3;
  quat: THREE.Quaternion;
  /** Unit vector from the body centre to the camera. */
  zenith: THREE.Vector3;
  /** Level heading at turn = 0, for aiming. */
  heading0: THREE.Vector3;
  /** km above the terrain to settle at once the ground height is known; null for orbital poses. */
  groundAlt: number | null;
  simTime: number;
}

const UP = new THREE.Vector3(0, 1, 0);
const p = { x: 0, y: 0, z: 0 };

/** The star a body pose refers to: Sol, the real star at `starAt`, or a stand-in near Sol. */
export function poseStar(pose: BodyPose, sol: StarData): StarData {
  if (pose.star === 'sol') return sol;
  // bench.html builds generated stars at level 0, so the same id gives the same system here.
  if (pose.starAt) return makeStar(pose.star, 0, pose.starAt[0], pose.starAt[1], pose.starAt[2]);
  const a = (pose.star % 628) / 100;
  return makeStar(pose.star, 0, SOL_POS.x + 3 * Math.cos(a), SOL_POS.y + 1.5, SOL_POS.z + 3 * Math.sin(a));
}

/** Same construction as src/bench.ts, so numbers found there paste straight into a spot. */
export function resolveBodyPose(pose: BodyPose, sol: StarData): ResolvedBodyPose | null {
  const star = poseStar(pose, sol);
  const planet = generateSystem(star).planets[pose.planet];
  const body = pose.moon === undefined ? planet : planet?.moons[pose.moon];
  if (!body) return null;
  const simTime = simTimeAt(SCENIC_EPOCH_MS) + (pose.t ?? 0);
  bodyPosition(body, simTime, p);
  const pos = new THREE.Vector3(p.x, p.y, p.z);

  // Local frame at the spot: zenith tilted away from the sun by 'sun', swung around the sun axis by 'az'.
  const toSun = pos.clone().normalize().negate();
  const side = UP.clone().cross(toSun).normalize();
  const zenith = toSun.clone().applyAxisAngle(side, pose.sun).applyAxisAngle(toSun, pose.az);
  const north = side.clone().applyAxisAngle(toSun, pose.az);
  const heading0 = north.clone().cross(zenith).normalize();
  const heading = heading0.clone().applyAxisAngle(zenith, pose.turn);
  const right = heading.clone().cross(zenith).normalize();
  const forward = heading.clone().applyAxisAngle(right, pose.pitch).normalize();
  const up = right.clone().cross(forward).normalize();
  const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, forward.clone().negate()));

  const orbital = pose.alt > body.radius * 0.05;
  const r = orbital ? body.radius + pose.alt : body.radius * 1.02 + pose.alt;
  return {
    star, body, quat, zenith, heading0, simTime,
    local: pos.addScaledVector(zenith, r),
    groundAlt: orbital ? null : pose.alt,
  };
}

export function spaceQuat(pose: SpacePose): THREE.Quaternion {
  const look = new THREE.Vector3(...pose.look).normalize();
  const up = pose.up ? new THREE.Vector3(...pose.up).normalize() : UP.clone();
  // Looking straight along 'up' leaves the roll undefined; pick any perpendicular.
  if (Math.abs(look.dot(up)) > 0.999) up.set(0, 0, 1);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), look, up));
}

/**
 * Curation helper: the turn and pitch that put another body of the same system (or the
 * star, with planet = -1) in the centre of the view, and how high it stands in the sky.
 */
export function aimPose(pose: BodyPose, sol: StarData, planet: number, moon?: number):
  { turn: number; pitch: number; elevation: number; distance: number; angularRadius: number } | null {
  const r = resolveBodyPose(pose, sol);
  if (!r) return null;
  const target = new THREE.Vector3();
  let radius = r.star.radius * SUN_RADIUS_KM;
  if (planet >= 0) {
    const pl = generateSystem(r.star).planets[planet];
    const b = moon === undefined ? pl : pl?.moons[moon];
    if (!b) return null;
    bodyPosition(b, r.simTime, p);
    target.set(p.x, p.y, p.z);
    radius = b.radius;
  }
  const d = target.sub(r.local);
  const distance = d.length();
  d.normalize();
  const elevation = Math.asin(THREE.MathUtils.clamp(d.dot(r.zenith), -1, 1));
  const flat = d.clone().addScaledVector(r.zenith, -d.dot(r.zenith));
  const turn = Math.atan2(r.heading0.clone().cross(flat).dot(r.zenith), r.heading0.dot(flat));
  return { turn, pitch: elevation, elevation, distance, angularRadius: Math.asin(Math.min(radius / distance, 1)) };
}

/** Galactic light years → km relative to an anchor star. */
export function galacticToLocal(pos: [number, number, number], anchor: StarData, out: THREE.Vector3): THREE.Vector3 {
  return out.set((pos[0] - anchor.x) * KM_PER_LY, (pos[1] - anchor.y) * KM_PER_LY, (pos[2] - anchor.z) * KM_PER_LY);
}
