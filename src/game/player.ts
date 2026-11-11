import * as THREE from 'three';
import { KM_PER_LY } from '../core/units';
import type { BodyData } from '../universe/bodies';
import type { StarData } from '../universe/stars';
import type { Input } from './input';
import { parkingDistance, targetPosition, type Target } from './target';

export interface Obstacle {
  /** km, relative to the anchor star. */
  pos: THREE.Vector3;
  radius: number;
  /** Distance from the centre to the terrain under the camera (km), when it is known. */
  ground: number | null;
  body: BodyData | null;
}

/** Height above the terrain at which the landing autopilot levels off, km. */
const LANDING_HEIGHT = 0.25;

export const MIN_SPEED = 0.001; // km/s — 1 m/s
export const MAX_SPEED = 1e7 * KM_PER_LY; // km/s — 10 Mly/s, intergalactic
/** One wheel notch / key press multiplies the velocity setting by this. */
export const SPEED_STEP = 1.3;
/** Seconds for the actual velocity to settle on the setting (exponential time constant). */
const INERTIA = 0.11;
/** Seconds for the proximity speed cap to rise e-fold as the camera leaves a body. */
const RAMP = 0.45;
const LOOK_RAD_PER_PX = 0.0022;
const ORBIT_RAD_PER_PX = 0.005;

/** What the right mouse button orbits around: usually the selected object. */
export interface OrbitPivot {
  /** km, relative to the anchor star. */
  center: THREE.Vector3;
  /** Surface radius, km: close to the ground the orbit slows so the surface follows the cursor. */
  radius: number;
}

export interface ViewContext {
  pivot: OrbitPivot | null;
  /** Vertical field of view in degrees; mouse look scales with it. */
  fov: number;
  sensitivity: number;
}

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const v3 = new THREE.Vector3();
const q1 = new THREE.Quaternion();
const m1 = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

/** The free-flying camera: position, orientation, flight model and autopilot. */
export class Player {
  /** km, relative to the anchor star. Doubles, so metre precision out to light years. */
  readonly local = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  readonly velocity = new THREE.Vector3();
  private readonly spin = new THREE.Vector3();
  private readonly lookPending = new THREE.Vector2();
  private stepHold = 0;
  /**
   * The velocity setting, km/s: thrust keys fly at exactly this speed. Only the wheel,
   * +/- and an autopilot arrival ever change it; it never grows with hold time.
   */
  speedSetting = 3000;
  /** True while the proximity safety limit is holding the speed below the setting. */
  limited = false;
  /** The fastest the proximity limit allows here, km/s (Infinity far from everything). */
  cap = Infinity;
  /**
   * The cap as it eases up: leaving a planet, the proximity limit rises with the fourth power of the
   * altitude, so obeying it at once would take the camera from a fraction of c to light years a second
   * within a few frames (it reads as a jump). It may fall at once, but rises at most e-fold every RAMP s.
   */
  private easedCap = Infinity;
  private lastLocal = new THREE.Vector3(NaN, 0, 0);
  /** C / T: turn the camera towards a target; with 'hold' keep it centred. */
  aim: { target: Target; hold: boolean } | null = null;
  /** Called when the autopilot reaches its destination. */
  onArrive: (target: Target, landed: boolean) => void = () => {};
  /** Measured km/s over the last frame, including autopilot motion. */
  speed = 0;
  autopilot: { target: Target; age: number; land: boolean; heading: THREE.Vector3 | null } | null = null;
  /** Altitude above the nearest surface (km) and that obstacle, for the HUD. */
  altitude = Infinity;

  constructor(public anchor: StarData) {}

  galactic(out: { x: number; y: number; z: number }): void {
    out.x = this.anchor.x + this.local.x / KM_PER_LY;
    out.y = this.anchor.y + this.local.y / KM_PER_LY;
    out.z = this.anchor.z + this.local.z / KM_PER_LY;
  }

  /** Re-express the position relative to a different star without moving. */
  reanchor(star: StarData): void {
    this.local.x += (this.anchor.x - star.x) * KM_PER_LY;
    this.local.y += (this.anchor.y - star.y) * KM_PER_LY;
    this.local.z += (this.anchor.z - star.z) * KM_PER_LY;
    this.anchor = star;
  }

  /** Fly to a target; with 'land', descend to its surface and level off facing the horizon. */
  goTo(target: Target, land = false): void {
    this.autopilot = { target, age: 0, land: land && target.kind === 'body', heading: null };
    this.velocity.set(0, 0, 0);
    if (!this.aim?.hold) this.aim = null;
  }

  /** Full stop: kill all motion and any autopilot. */
  stop(): void {
    this.autopilot = null;
    this.velocity.set(0, 0, 0);
  }

  /** Multiply the velocity setting by SPEED_STEP^steps. */
  stepSpeed(steps: number): void {
    this.speedSetting = THREE.MathUtils.clamp(this.speedSetting * Math.pow(SPEED_STEP, steps), MIN_SPEED, MAX_SPEED);
  }

  /** A velocity setting that suits the surroundings: crosses 'distance' km in a few seconds. */
  setSpeedFor(distance: number): void {
    this.speedSetting = THREE.MathUtils.clamp(distance / 5, 0.02, MAX_SPEED);
  }

  update(dt: number, input: Input, obstacles: Obstacle[], simTime: number, ctx: ViewContext = DEFAULT_CTX): void {
    const before = v3.copy(this.local);
    this.rotate(dt, input, simTime, ctx);

    // Velocity setting: wheel notches, and +/- (one step per press, repeating while held).
    let steps = input.takeWheel();
    const key = input.axis(['Equal', 'NumpadAdd'], ['Minus', 'NumpadSubtract']);
    if (key !== 0) {
      if (this.stepHold === 0) steps += key * (input.shift ? 8.776 : 1);
      else if (this.stepHold > 0.35) steps += key * dt * 9;
      this.stepHold += dt;
    } else this.stepHold = 0;
    if (steps !== 0) this.stepSpeed(steps);

    // Shift+F is "follow", not "down".
    const descend = input.down('KeyF') && !input.shift ? 1 : 0;
    const thrust = v1.set(input.axis('KeyD', 'KeyA'), (input.down('KeyR') ? 1 : 0) - descend, input.axis('KeyS', 'KeyW'));
    if (thrust.lengthSq() > 0) this.autopilot = null;

    this.limited = false;
    const limitHere = this.speedLimit(obstacles);
    // After a jump (a scenic spot, a reload, the autopilot) there's nothing to ease from.
    const jumped = !(before.distanceTo(this.lastLocal) <= Math.max(Math.min(this.easedCap, limitHere), this.speed, 1) * Math.max(dt, 1 / 30) * 4);
    this.easedCap = this.autopilot || jumped ? limitHere : Math.min(limitHere, this.easedCap * Math.exp(dt / RAMP));
    this.cap = this.easedCap;
    if (this.autopilot) {
      this.flyAutopilot(dt, simTime, obstacles);
    } else {
      if (thrust.lengthSq() > 0) thrust.normalize().applyQuaternion(this.quat).multiplyScalar(this.speedSetting);
      this.velocity.lerp(thrust, 1 - Math.exp(-dt / INERTIA));
      // Released keys mean a clean stop, not an endless exponential tail.
      if (thrust.lengthSq() === 0 && this.velocity.length() < this.speedSetting * 0.01) this.velocity.set(0, 0, 0);
      // Slow down near surfaces so a planet can be approached at any speed setting.
      const limit = this.cap;
      if (this.velocity.length() > limit) {
        this.velocity.setLength(limit);
        this.limited = true;
      }
      this.local.addScaledVector(this.velocity, dt);
    }

    this.collide(obstacles);
    this.speed = dt > 0 ? before.distanceTo(this.local) / dt : 0;
    this.lastLocal.copy(this.local);
  }

  private rotate(dt: number, input: Input, simTime: number, ctx: ViewContext): void {
    const fovScale = ctx.fov / 60;
    let [dx, dy] = input.takeLook();
    let [ox, oy] = input.takeOrbit();
    // While tracking, the view direction is taken: dragging orbits instead of fighting it.
    if (this.aim?.hold) { ox += dx; oy += dy; dx = dy = 0; }
    if (!ctx.pivot) { dx += ox; dy += oy; ox = oy = 0; }
    if ((dx !== 0 || dy !== 0) && this.aim && !this.aim.hold) this.aim = null;

    // Mouse look: applied over a few frames, which reads as weight without lag.
    this.lookPending.x += dx * LOOK_RAD_PER_PX * fovScale * ctx.sensitivity;
    this.lookPending.y += dy * LOOK_RAD_PER_PX * fovScale * ctx.sensitivity;
    const take = 1 - Math.exp(-dt * 28);
    const yaw = -this.lookPending.x * take;
    const pitch = -this.lookPending.y * take;
    this.lookPending.multiplyScalar(1 - take);

    // Keys turn at a steady rate with a short ease in and out.
    const rate = 0.9 * fovScale;
    const ease = 1 - Math.exp(-dt * 9);
    this.spin.x += (input.axis(['ArrowUp', 'Numpad8'], ['ArrowDown', 'Numpad2']) * rate - this.spin.x) * ease;
    this.spin.y += (input.axis(['ArrowLeft', 'Numpad4'], ['ArrowRight', 'Numpad6']) * rate - this.spin.y) * ease;
    this.spin.z += (input.axis(['KeyQ', 'Numpad7'], ['KeyE', 'Numpad9']) * 1.1 - this.spin.z) * ease;
    q1.setFromEuler(eul.set(pitch + this.spin.x * dt, yaw + this.spin.y * dt, this.spin.z * dt, 'YXZ'));
    this.quat.multiply(q1).normalize();

    if (ctx.pivot && (ox !== 0 || oy !== 0)) this.orbit(ox, oy, ctx);
    if (this.aim) this.turnToAim(dt, simTime);
  }

  /** Swing the camera around the pivot, keeping the distance and the pivot's place on screen. */
  private orbit(dx: number, dy: number, ctx: ViewContext): void {
    const pivot = ctx.pivot!;
    const offset = v1.copy(this.local).sub(pivot.center);
    const dist = offset.length();
    // Near the ground a full-rate orbit would whip the camera around the planet.
    const alt = Math.max(dist - pivot.radius, 0);
    const perPx = Math.min(ORBIT_RAD_PER_PX, (LOOK_RAD_PER_PX * (ctx.fov / 60) * alt) / Math.max(dist, 1e-9)) * ctx.sensitivity;
    const up = v2.set(0, 1, 0).applyQuaternion(this.quat);
    const right = sideVec.set(1, 0, 0).applyQuaternion(this.quat);
    q1.setFromAxisAngle(up, -dx * perPx);
    q2.setFromAxisAngle(right, -dy * perPx);
    q1.multiply(q2);
    this.local.copy(pivot.center).add(offset.applyQuaternion(q1));
    this.quat.premultiply(q1).normalize();
  }

  private turnToAim(dt: number, simTime: number): void {
    const aim = this.aim!;
    if (this.autopilot && this.autopilot.land) return;
    const tp = targetPosition(aim.target, this.anchor, simTime, v1);
    if (tp.distanceToSquared(this.local) < 1e-12) return;
    m1.lookAt(this.local, tp, v2.copy(UP).applyQuaternion(this.quat));
    q1.setFromRotationMatrix(m1);
    const angle = this.quat.angleTo(q1);
    this.quat.slerp(q1, 1 - Math.exp(-dt * (aim.hold && angle < 0.05 ? 30 : 5)));
    if (!aim.hold && angle < 0.002) this.aim = null;
  }

  private flyAutopilot(dt: number, simTime: number, obstacles: Obstacle[]): void {
    const ap = this.autopilot!;
    ap.age += dt;
    const tp = targetPosition(ap.target, this.anchor, simTime, v1);
    const offset = v2.copy(this.local).sub(tp);
    const dist = offset.length();
    offset.divideScalar(dist || 1);
    if (ap.land && ap.target.kind === 'body') {
      this.flyLanding(dt, tp, offset, dist, obstacles);
      return;
    }
    const end = parkingDistance(ap.target);

    if (ap.target.kind === 'galaxy') {
      // Arrive above the disc at an angle, so a spiral shows its arms rather than its edge.
      const a = ap.target.galaxy.axes;
      const normal = q1Vec.set(a[3], a[4], a[5]);
      const side = sideVec.copy(offset).addScaledVector(normal, -offset.dot(normal));
      if (side.lengthSq() < 1e-6) side.set(a[0], a[1], a[2]);
      side.normalize();
      const pref = normal.multiplyScalar(Math.sign(offset.dot(normal)) || 1).multiplyScalar(0.8).addScaledVector(side, 0.6).normalize();
      // Turn towards it only on the last stretch, not across intergalactic space.
      const near = 1 - THREE.MathUtils.smoothstep(dist / end, 1.5, 6);
      offset.lerp(pref, (1 - Math.exp(-dt * 1.4)) * near).normalize();
    }
    if (ap.target.kind === 'blackhole') {
      // Arrive above the disc, some 23 degrees over its plane: the classic view, its far side lensed over the shadow.
      const [nx, ny, nz] = ap.target.bh.axis;
      const normal = q1Vec.set(nx, ny, nz);
      const up = Math.sign(offset.dot(normal)) || 1;
      const side = sideVec.copy(offset).addScaledVector(normal, -offset.dot(normal));
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0).addScaledVector(normal, -normal.x);
      side.normalize();
      const pref = side.multiplyScalar(Math.cos(0.4)).addScaledVector(normal, Math.sin(0.4) * up).normalize();
      const near = 1 - THREE.MathUtils.smoothstep(dist / end, 3, 40);
      offset.lerp(pref, (1 - Math.exp(-dt * 1.4)) * near).normalize();
    }
    if (ap.target.kind === 'nebula') {
      // Arrive on the side that faces Sol, as the photographs show it: the lit face of a blister such as Orion,
      // not the inside of the dark cloud behind it.
      const sg = ap.target.nebula.sight;
      const pref = q1Vec.set(sg[6], sg[7], sg[8]);
      const near = 1 - THREE.MathUtils.smoothstep(dist / end, 1.5, 6);
      offset.lerp(pref, (1 - Math.exp(-dt * 1.4)) * near).normalize();
    }
    if (ap.target.kind === 'body') {
      // Swing around to the sunlit side so arrivals show a lit, slightly gibbous disk.
      const starPos = targetPosition({ kind: 'star', star: ap.target.star }, this.anchor, simTime, q1Vec);
      const toSun = starPos.sub(tp).normalize();
      const side = sideVec.crossVectors(toSun, UP).normalize();
      const pref = toSun.multiplyScalar(0.72).addScaledVector(side, 0.6).addScaledVector(UP, 0.2).normalize();
      offset.lerp(pref, 1 - Math.exp(-dt * 1.4)).normalize();
    }

    // Exponential approach: covers light years and the last kilometres in the same few seconds.
    const rate = 2.8 * THREE.MathUtils.smoothstep(ap.age, 0, 1.6);
    const remaining = dist - end;
    const next = end + remaining * Math.exp(-rate * dt);
    this.local.copy(tp).addScaledVector(offset, next);

    v2.copy(UP).applyQuaternion(this.quat);
    // By a black hole, end up with its disc level across the view (its axis up on screen).
    if (ap.target.kind === 'blackhole') {
      const [nx, ny, nz] = ap.target.bh.axis;
      const up = sideVec.set(nx, ny, nz).multiplyScalar(Math.sign(offset.dot(sideVec.set(nx, ny, nz))) || 1);
      v2.lerp(up, 1 - THREE.MathUtils.smoothstep(dist / end, 3, 40)).normalize();
    }
    m1.lookAt(this.local, tp, v2);
    q1.setFromRotationMatrix(m1);
    this.quat.slerp(q1, 1 - Math.exp(-dt * 3.5));

    if (Math.abs(remaining) < end * 0.004 && ap.age > 1.6) this.arrive(obstacles);
  }

  /** End the autopilot and leave a velocity setting that suits the new surroundings. */
  private arrive(obstacles: Obstacle[]): void {
    const ap = this.autopilot!;
    this.autopilot = null;
    this.velocity.set(0, 0, 0);
    this.collide(obstacles);
    // A galaxy is approached at a speed that takes a good while to cross it, so the first press of W
    // does not shoot straight past it.
    if (ap.target.kind === 'galaxy') this.speedSetting = THREE.MathUtils.clamp(parkingDistance(ap.target) / 30, MIN_SPEED, MAX_SPEED);
    else this.setSpeedFor(Number.isFinite(this.altitude) ? this.altitude : parkingDistance(ap.target));
    this.onArrive(ap.target, ap.land);
  }

  /** Straight down to just above the terrain, pitching up to face the horizon on the way. */
  private flyLanding(dt: number, tp: THREE.Vector3, radial: THREE.Vector3, dist: number, obstacles: Obstacle[]): void {
    const ap = this.autopilot!;
    const body = (ap.target as { body: BodyData }).body;
    const ground = obstacles.find((o) => o.body === body)?.ground ?? body.radius * 1.02;
    const end = ground + LANDING_HEIGHT;
    const rate = 2.2 * THREE.MathUtils.smoothstep(ap.age, 0, 1.6);
    const remaining = dist - end;
    this.local.copy(tp).addScaledVector(radial, end + remaining * Math.exp(-rate * dt));

    // Whatever is "up" on screen while looking down becomes the way we face on the ground.
    const heading = ap.heading ??= UP.clone().applyQuaternion(this.quat);
    heading.addScaledVector(radial, -heading.dot(radial));
    if (heading.lengthSq() < 1e-4) {
      heading.set(1, 0, 0).applyQuaternion(this.quat);
      heading.addScaledVector(radial, -heading.dot(radial));
    }
    heading.normalize();
    const level = 1 - THREE.MathUtils.smoothstep(remaining / body.radius, 0.002, 0.25);
    const forward = q1Vec.copy(radial).multiplyScalar(level - 1).addScaledVector(heading, level).addScaledVector(radial, -0.1 * level);
    const up = sideVec.copy(heading).lerp(radial, level);
    m1.lookAt(this.local, forward.add(this.local), up);
    q1.setFromRotationMatrix(m1);
    this.quat.slerp(q1, 1 - Math.exp(-dt * 3.5));

    if (Math.abs(remaining) < 0.004 && ap.age > 1.6) this.arrive(obstacles);
  }

  private speedLimit(obstacles: Obstacle[]): number {
    let limit = Infinity;
    for (const o of obstacles) {
      const alt = Math.max(this.local.distanceTo(o.pos) - (o.ground ?? o.radius), 0);
      const far = alt / (60 * o.radius);
      // Over known terrain the floor drops to walking-on-the-Moon speeds.
      const floor = o.ground === null ? o.radius * 0.002 : 0.03;
      limit = Math.min(limit, (alt * 1.6 + floor) * (1 + far * far * far));
    }
    return limit;
  }

  private collide(obstacles: Obstacle[]): void {
    this.altitude = Infinity;
    for (const o of obstacles) {
      const d = v1.copy(this.local).sub(o.pos);
      const dist = d.length();
      const min = o.ground === null ? o.radius * 1.003 : o.ground + 0.004;
      if (dist < min) {
        if (dist < 1e-6) d.set(0, 1, 0);
        this.local.copy(o.pos).addScaledVector(d.normalize(), min);
      }
      this.altitude = Math.min(this.altitude, Math.max(dist, min) - (o.ground ?? o.radius));
    }
  }
}

const q1Vec = new THREE.Vector3();
const sideVec = new THREE.Vector3();
const q2 = new THREE.Quaternion();
const eul = new THREE.Euler();
const DEFAULT_CTX: ViewContext = { pivot: null, fov: 60, sensitivity: 1 };
