import * as THREE from 'three';
import { bodyPosition, type BodyData, type SystemData } from '../universe/bodies';
import type { Obstacle } from '../game/player';
import { atmoTransmittance } from './atmosphereScatter';
import { LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS } from './glsl';
import { computeLight, discCover, makeBodyLight, type BodyLight } from './lighting';
import { PlanetView } from './planet';
import { StarView } from './star';

// An orbit is drawn as the trail of its body: brightest right behind it, fading once around.
// Near the camera it fades out too, so the orbit the camera sits on never slashes across the view.
const ORBIT_VERT = /* glsl */ `
${LOGDEPTH_VERT_PARS}
attribute float aTurn;   // where along the orbit this vertex is, 0..1
uniform float uHead;     // where the body is
uniform float uRadius;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float behind = fract(uHead - aTurn);
  float trail = 1.0 - behind;
  vAlpha = (0.05 + 0.95 * trail * trail * trail * trail) * smoothstep(0.02, 0.35, length(mv.xyz) / uRadius);
  gl_Position = projectionMatrix * mv;
  ${LOGDEPTH_VERT}
}
`;
const ORBIT_FRAG = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(uColor * (vAlpha * uOpacity), 1.0);
  ${LOGDEPTH_FRAG}
}
`;
const PLANET_ORBIT = new THREE.Color(0.08, 0.15, 0.28);
const MOON_ORBIT = new THREE.Color(0.13, 0.15, 0.19);

export interface BodyState {
  body: BodyData;
  view: PlanetView;
  /** km, relative to the star. */
  pos: THREE.Vector3;
  /** km, relative to the camera. */
  rel: THREE.Vector3;
  orbit: THREE.LineLoop;
  /** Unit normal of the orbital plane. */
  orbitNormal: THREE.Vector3;
  /** Eclipses, planetshine and starlight here, worked out each frame. */
  light: BodyLight;
  atmoTop: number;
}

const ORBIT_SEGMENTS = 360;
const sunDir = new THREE.Vector3();
const starRel = new THREE.Vector3();
const through = [1, 1, 1];
const camVec = new THREE.Vector3();

/** Everything renderable in the star system the camera is currently anchored to. */
export class SystemView {
  readonly group = new THREE.Group();
  readonly star: StarView;
  readonly bodies: BodyState[] = [];
  showOrbits = true;
  /** What reaches the camera of each colour of the star's light: bodies in the way hide it, their air reddens it. */
  readonly starlight = new THREE.Vector3(1, 1, 1);
  private readonly dots: THREE.Points;
  private readonly dotPos: Float32Array;
  private readonly dotCol: Float32Array;
  private readonly byBody = new Map<BodyData, BodyState>();
  private readonly obstacles: Obstacle[] = [];

  constructor(readonly system: SystemData) {
    this.star = new StarView(system.star);
    this.group.add(this.star.group);
    for (const p of system.planets) {
      this.addBody(p);
      for (const m of p.moons) this.addBody(m);
    }

    const n = Math.max(this.bodies.length, 1);
    this.dotPos = new Float32Array(n * 3);
    this.dotCol = new Float32Array(n * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.dotPos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.dotCol, 3));
    this.dots = new THREE.Points(g, new THREE.PointsMaterial({
      size: 2.5, sizeAttenuation: false, vertexColors: true,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.dots.frustumCulled = false;
    this.group.add(this.dots);
  }

  private addBody(body: BodyData): void {
    const view = new PlanetView(body, this.star.color);
    this.group.add(view.group);

    // Unit-circle orbit in the body's orbital plane, scaled per frame around its parent.
    const pts = new Float32Array(ORBIT_SEGMENTS * 3);
    const probe = { x: 0, y: 0, z: 0 };
    const unit = { ...body, orbitRadius: 1, orbitPhase: 0, orbitPeriod: ORBIT_SEGMENTS, parent: null };
    for (let i = 0; i < ORBIT_SEGMENTS; i++) {
      bodyPosition(unit, i, probe);
      pts.set([probe.x, probe.y, probe.z], i * 3);
    }
    const turns = new Float32Array(ORBIT_SEGMENTS);
    for (let i = 0; i < ORBIT_SEGMENTS; i++) turns[i] = i / ORBIT_SEGMENTS;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    geo.setAttribute('aTurn', new THREE.BufferAttribute(turns, 1));
    const orbit = new THREE.LineLoop(geo, new THREE.ShaderMaterial({
      vertexShader: ORBIT_VERT,
      fragmentShader: ORBIT_FRAG,
      uniforms: {
        uColor: { value: body.parent ? MOON_ORBIT : PLANET_ORBIT }, uOpacity: { value: 1 },
        uHead: { value: 0 }, uRadius: { value: body.orbitRadius },
      },
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    orbit.scale.setScalar(body.orbitRadius);
    orbit.frustumCulled = false;
    this.group.add(orbit);

    const quarter = ORBIT_SEGMENTS / 4;
    const orbitNormal = new THREE.Vector3(pts[0], pts[1], pts[2])
      .cross(new THREE.Vector3(pts[quarter * 3], pts[quarter * 3 + 1], pts[quarter * 3 + 2])).normalize();
    const state: BodyState = {
      body, view, pos: new THREE.Vector3(), rel: new THREE.Vector3(), orbit, orbitNormal, light: makeBodyLight(), atmoTop: view.atmoTop,
    };
    this.bodies.push(state);
    this.byBody.set(body, state);
  }

  /** Move bodies along their orbits; returns collision spheres (star first), km relative to the star. */
  advance(simTime: number): Obstacle[] {
    if (this.obstacles.length === 0) {
      this.obstacles.push({ pos: new THREE.Vector3(), radius: this.star.radiusKm, ground: null, body: null });
      for (const s of this.bodies) this.obstacles.push({ pos: s.pos, radius: s.body.radius, ground: null, body: s.body });
    }
    for (const [i, s] of this.bodies.entries()) {
      bodyPosition(s.body, simTime, s.pos);
      this.obstacles[i + 1].ground = s.view.ground;
    }
    return this.obstacles;
  }

  /** cam: camera position in km relative to the star. forward / halfAngle: view direction and half the diagonal FOV. */
  update(cam: { x: number; y: number; z: number }, simTime: number, realTime: number, forward: THREE.Vector3, halfAngle: number): void {
    starRel.set(-cam.x, -cam.y, -cam.z);
    const starDist = Math.max(starRel.length(), 1);
    const starSize = Math.asin(Math.min(this.star.radiusKm / starDist, 1));
    this.starlight.set(1, 1, 1);
    // How completely a body out in space (not the one underfoot) covers the star: 1 at totality.
    let totality = 0;
    // Glare may spill over a limb seen from space; down among mountains it would shine through them.
    let spill = 1;
    for (const s of this.bodies) {
      bodyPosition(s.body, simTime, s.pos);
      s.rel.set(s.pos.x - cam.x, s.pos.y - cam.y, s.pos.z - cam.z);
      const dist = s.rel.length(), radius = s.body.radius;
      spill = Math.min(spill, THREE.MathUtils.smoothstep(dist / radius, 1.002, 1.01));
      const along = s.rel.dot(starRel) / starDist;
      if (along > starDist || dist <= radius * 0.5) continue;
      const cos = THREE.MathUtils.clamp(along / dist, -1, 1);
      // The share of the star's disc this body hides (the same overlap the surfaces use for eclipses).
      const sep = Math.atan2(Math.sqrt(Math.max(1 - cos * cos, 0)), cos);
      const size = Math.asin(Math.min(radius / dist, 1));
      const cover = discCover(starSize, size, sep);
      const shown = 1 - cover;
      if (shown < 1) this.starlight.multiplyScalar(shown);
      if (dist > radius * 1.05 && size > starSize * 0.9) totality = Math.max(totality, cover);
      const a = s.body.atmosphere;
      if (a && shown > 0) {
        atmoTransmittance(dist / radius, -cos, s.view.atmoTop, a.color, a.density, through);
        this.starlight.set(this.starlight.x * through[0], this.starlight.y * through[1], this.starlight.z * through[2]);
      }
    }
    this.star.update(starRel, realTime, this.starlight, spill, THREE.MathUtils.smoothstep(totality, 0.985, 1));

    camVec.set(cam.x, cam.y, cam.z);
    const star = this.star.star;
    for (const [i, s] of this.bodies.entries()) {
      sunDir.copy(s.pos).normalize().negate();
      // Only bodies big enough on screen are drawn, so only they need their light worked out.
      if (s.body.radius / Math.max(s.rel.length(), 1) > 0.0006) {
        computeLight(s.light, s, this.bodies, camVec, this.star.color, star.lum, this.star.radiusKm);
      }
      s.view.update(s.rel, sunDir, simTime, realTime, forward, halfAngle, s.light);

      const dist = s.rel.length();
      const parent = s.body.parent ? this.byBody.get(s.body.parent) : undefined;
      if (parent) s.orbit.position.copy(parent.rel);
      else s.orbit.position.copy(starRel);
      // Float precision makes orbit lines jitter up close, so fade them out near their body.
      const nearFade = THREE.MathUtils.smoothstep(dist / s.body.radius, 40, 400);
      // Moon orbits only matter when you are in the neighbourhood of the planet.
      const farFade = s.body.parent ? 1 - THREE.MathUtils.smoothstep(dist / s.body.orbitRadius, 30, 120) : 1;
      const orbit = (s.orbit.material as THREE.ShaderMaterial).uniforms;
      // Seen edge-on, the orbits of a system pile up into a bundle of lines across the sky:
      // they only show from far enough above or below their plane.
      // (From inside an orbit it is a great circle whichever way it is tilted.)
      const above = Math.abs(s.orbit.position.dot(s.orbitNormal)) / Math.max(s.orbit.position.length(), s.body.orbitRadius);
      orbit.uOpacity.value = nearFade * farFade * THREE.MathUtils.smoothstep(above, 0.04, 0.3);
      const turn = s.body.orbitPhase / (2 * Math.PI) + simTime / s.body.orbitPeriod;
      orbit.uHead.value = turn - Math.floor(turn);
      s.orbit.visible = this.showOrbits && orbit.uOpacity.value > 0.005;

      // Sub-pixel bodies get a dot so planets stay visible as "wandering stars".
      const angular = s.body.radius / dist;
      const show = angular < 0.0015 ? 1 : 0;
      const lit = THREE.MathUtils.clamp(0.3 + angular * 500, 0.3, 1) * show;
      const c = s.body.palette[1];
      this.dotPos.set([s.rel.x, s.rel.y, s.rel.z], i * 3);
      this.dotCol.set([(c[0] + 0.3) * lit, (c[1] + 0.3) * lit, (c[2] + 0.3) * lit], i * 3);
    }
    this.dots.geometry.attributes.position.needsUpdate = true;
    this.dots.geometry.attributes.color.needsUpdate = true;
  }

  dispose(): void {
    this.star.dispose();
    for (const s of this.bodies) {
      s.view.dispose();
      s.orbit.geometry.dispose();
      (s.orbit.material as THREE.Material).dispose();
    }
    this.dots.geometry.dispose();
    (this.dots.material as THREE.Material).dispose();
  }
}
