import * as THREE from 'three';
import { SECTOR_LEVELS, generateSector, sectorOfPosition, sectorSize } from '../universe/galaxy';
import { temperatureToRgb, type StarData } from '../universe/stars';

const RADIUS = 3; // sectors loaded around the camera in each direction, per level
/** Faintest magnitude shown in open space (where the fade to nothing ends). */
const SPACE_LIMIT = 8.8;
/** Time per frame spent generating star sectors while flying, ms. */
const SECTOR_BUDGET_MS = 2.5;

// Shared by the points and by their motion streaks: the light of one star.
const STAR_LIGHT = /* glsl */ `
attribute vec3 aColor;
attribute float aLum;
attribute float aId;
uniform float uHideId;
uniform float uPixelRatio;
uniform float uTwinkle;  // seen through air, starlight flickers
uniform float uLimit;    // faintest magnitude that shows: fainter under a bright sky or through air
uniform float uTime;
uniform vec3 uTrail;     // how far the camera moved during one exposure, ly (universe axes)
uniform float uPpr;      // device pixels per radian
uniform vec3 uZenith;    // straight up from where the camera stands on a world with air (universe axes)
uniform float uAir;      // how much air is overhead, 0 in space, 1 at the bottom of an Earth-like atmosphere

// Air between the star and the eye, in units of the air straight overhead (Kasten & Young 1989 form):
// 1 at the zenith, about 38 at the horizon.
float airmass(vec3 pos) {
  if (uAir <= 0.0) return 1.0;
  vec3 dir = normalize((modelMatrix * vec4(pos, 1.0)).xyz);
  float c = max(dot(dir, uZenith), 0.0);
  return min(1.0 / (c + 0.025 * exp(-11.0 * c)), 38.0);
}
// Hash for flicker that is random from frame to frame, as scintillation is (it runs at tens of Hz).
float twinkleNoise(float id, float t) {
  float i = floor(t), f = fract(t);
  float a = fract(sin(id * 12.9898 + i * 78.233) * 43758.5453);
  float b = fract(sin(id * 12.9898 + (i + 1.0) * 78.233) * 43758.5453);
  return mix(a, b, f * f * (3.0 - 2.0 * f)) * 2.0 - 1.0;
}
// What the air does to a star's light: extinction that reddens it toward the horizon, and
// scintillation, stronger and more coloured the lower the star (each colour is refracted along a
// slightly different path through the turbulence, so near the horizon a bright star flashes colours).
vec3 throughAir(vec3 pos, float id) {
  if (uAir <= 0.0) return vec3(1.0);
  float x = airmass(pos);
  // Relative to the zenith (the limiting magnitude already accounts for the air overhead):
  // about 0.2 magnitudes per airmass in the visible, more in the blue.
  vec3 ext = exp(-uAir * (x - 1.0) * vec3(0.13, 0.19, 0.33));
  float s = uTwinkle * min(0.12 * pow(x, 0.75), 0.75);
  float t = uTime * 24.0;
  float common_ = twinkleNoise(id, t);
  vec3 colour = vec3(twinkleNoise(id + 0.37, t * 1.13), twinkleNoise(id + 0.71, t * 0.91), twinkleNoise(id + 0.13, t * 1.27));
  float chroma = smoothstep(2.0, 10.0, x);
  return ext * max(vec3(0.0), 1.0 + s * mix(vec3(common_), colour, 0.6 * chroma));
}
// Length on screen, in device pixels, of the streak a star at 'pos' leaves during one exposure.
float streakPx(vec3 pos) {
  vec3 a = (modelViewMatrix * vec4(pos, 1.0)).xyz;
  vec3 b = (modelViewMatrix * vec4(pos + uTrail, 1.0)).xyz;
  float la = length(a), lb = length(b);
  if (la < 1e-6 || lb < 1e-6) return 0.0;
  return acos(clamp(dot(a, b) / (la * lb), -1.0, 1.0)) * uPpr;
}
`;

const VERT = /* glsl */ `
${STAR_LIGHT}
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = max(length(mv.xyz), 1e-4);
  float flux = aLum / (d * d);                      // solar luminosities per ly^2
  float mag = -2.5 * log(flux) / 2.302585 - 2.74;    // apparent magnitude
  // Brightness compressed less than before: a handful of bright stars, the rest faint pinpoints,
  // as in long-exposure photographs (and Space Engine) rather than a field of equal sparks.
  float intensity = clamp(1.25 * pow(2.512, 0.7 * (3.6 - mag)), 0.0, 9.0);
  // Pinpoints: most stars are a pixel or two; only the brightest grow, and their glow comes from the bloom.
  float size = clamp(2.1 - mag * 0.26, 1.0, 3.0);
  // About what the eye sees on a dark night; fainter stars fade out instead of flickering.
  intensity *= smoothstep(uLimit, uLimit - 2.8, mag);
  // Seen through air: dimmer and redder toward the horizon, twinkling, and blurred a little by the
  // turbulence (seeing), more so low down; the blur spreads the same light over a larger point.
  vec3 air = throughAir(position, aId);
  float seeing = 1.0 + uTwinkle * 0.12 * min(airmass(position), 8.0);
  // Moving fast, a star's light is spread along its streak (drawn by the lines below): the point keeps only its share.
  float px = size * uPixelRatio * seeing;
  // (The same light over a point seeing times wider: a seeing² lower peak.)
  intensity *= px / max(px, streakPx(position)) / (seeing * seeing);
  vColor = aColor * intensity * air;
  gl_PointSize = px;
  gl_Position = projectionMatrix * mv;
  if (abs(aId - uHideId) < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

// Motion streaks: what a camera sees of the real stars while it flies past them, each star's
// light smeared over the path it crossed on screen during one exposure.
const STREAK_VERT = /* glsl */ `
${STAR_LIGHT}
attribute float aEnd;     // 0: where the star is now, 1: where it was at the start of the exposure
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = max(length(mv.xyz), 1e-4);
  float mag = -2.5 * log(aLum / (d * d)) / 2.302585 - 2.74;
  float intensity = clamp(1.25 * pow(2.512, 0.7 * (3.6 - mag)), 0.0, 9.0) * smoothstep(uLimit, uLimit - 2.8, mag);
  float size = clamp(2.1 - mag * 0.26, 1.0, 3.0) * uPixelRatio;
  float len = streakPx(position);
  // The same light as the point would carry, spread over the streak's length (a line is a pixel wide).
  float spread = size * size / max(len, 1.0);
  vColor = aColor * intensity * spread * smoothstep(size, 2.0 * size, len) * (1.0 - 0.6 * aEnd);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position + uTrail * aEnd, 1.0);
  if (abs(aId - uHideId) < 0.5 || len < size) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;
const STREAK_FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, 1.0);
}
`;

const FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 5.0) - 0.0067;
  gl_FragColor = vec4(vColor * a, 1.0);
}
`;

interface Level {
  points: THREE.Points;
  streaks: THREE.LineSegments;
  stars: StarData[];
  key: string;
  origin: THREE.Vector3;
  cache: Map<string, StarData[]>;
}

/** Individually simulated stars around the camera, streamed in as it moves. */
export class Starfield {
  readonly group = new THREE.Group();
  private readonly levels: Level[] = [];
  private readonly material: THREE.ShaderMaterial;
  private readonly streakMat: THREE.ShaderMaterial;

  constructor(pixelRatio: number) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uHideId: { value: -1 }, uPixelRatio: { value: pixelRatio }, uTwinkle: { value: 0 }, uTime: { value: 0 },
        uTrail: { value: new THREE.Vector3() }, uPpr: { value: 1000 }, uLimit: { value: SPACE_LIMIT },
        uZenith: { value: new THREE.Vector3(0, 1, 0) }, uAir: { value: 0 },
      },
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    // The streaks share every uniform with the points.
    this.streakMat = new THREE.ShaderMaterial({
      vertexShader: STREAK_VERT,
      fragmentShader: STREAK_FRAG,
      uniforms: this.material.uniforms,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    for (let l = 0; l < SECTOR_LEVELS; l++) {
      const points = new THREE.Points(new THREE.BufferGeometry(), this.material);
      points.frustumCulled = false;
      const streaks = new THREE.LineSegments(new THREE.BufferGeometry(), this.streakMat);
      streaks.frustumCulled = false;
      streaks.visible = false;
      this.group.add(points, streaks);
      this.levels.push({ points, streaks, stars: [], key: '', origin: new THREE.Vector3(), cache: new Map() });
    }
  }

  /**
   * Motion blur of the stars: trail is how far the camera moved (ly, universe axes) during one
   * exposure; pixelsPerRadian converts it into streak lengths on screen.
   */
  setMotion(trail: THREE.Vector3, pixelsPerRadian: number): void {
    const u = this.material.uniforms;
    (u.uTrail.value as THREE.Vector3).copy(trail);
    u.uPpr.value = pixelsPerRadian;
    // (Unused below a fraction of a light year per exposure: nothing near enough would streak.)
    const moving = trail.lengthSq() > 1e-4;
    for (const lv of this.levels) lv.streaks.visible = moving && lv.stars.length > 0;
  }

  /**
   * twinkle: 0 in space, 1 at the bottom of an Earth-like atmosphere. air: how much air is overhead,
   * 0..1; skyGlow: the sky's own brightness behind the stars, 0..1. From the ground at night the eye
   * reaches about magnitude 6.5 (2 less than in space); airglow, twilight and moonlight take more.
   */
  setTwinkle(twinkle: number, time: number, air = 0, skyGlow = 0, zenith?: THREE.Vector3): void {
    const u = this.material.uniforms;
    u.uTwinkle.value = twinkle;
    u.uTime.value = time;
    u.uAir.value = zenith ? air : 0;
    if (zenith) (u.uZenith.value as THREE.Vector3).copy(zenith);
    u.uLimit.value = SPACE_LIMIT - 2.3 * air - 4.5 * Math.min(Math.max(skyGlow, 0), 1);
  }

  /** The star whose point sprite is suppressed because it is drawn as a real sphere. */
  setHidden(star: StarData | null): void {
    this.material.uniforms.uHideId.value = star ? star.id % 16777216 : -1;
  }

  /** cam: galactic position in light years. */
  update(cam: { x: number; y: number; z: number }): void {
    // Sectors the camera has just come near are generated a few at a time, within a budget per frame,
    // and a level is rebuilt once all of its sectors are in: flying fast never stalls a frame on them.
    // (The first fill, at start or after a jump into the unknown, is done at once.)
    const deadline = performance.now() + SECTOR_BUDGET_MS;
    for (let l = 0; l < SECTOR_LEVELS; l++) {
      const lv = this.levels[l];
      const cx = sectorOfPosition(l, cam.x);
      const cy = sectorOfPosition(l, cam.y);
      const cz = sectorOfPosition(l, cam.z);
      const key = `${cx},${cy},${cz}`;
      if (key !== lv.key && (lv.key === '' || this.prepare(l, cx, cy, cz, deadline))) this.rebuild(l, cx, cy, cz, key);
      lv.points.position.set(lv.origin.x - cam.x, lv.origin.y - cam.y, lv.origin.z - cam.z);
      lv.streaks.position.copy(lv.points.position);
    }
  }

  /** Generates missing sectors around (cx, cy, cz) until the deadline; true once none are missing. */
  private prepare(l: number, cx: number, cy: number, cz: number, deadline: number): boolean {
    const lv = this.levels[l];
    for (let x = cx - RADIUS; x <= cx + RADIUS; x++)
      for (let y = cy - RADIUS; y <= cy + RADIUS; y++)
        for (let z = cz - RADIUS; z <= cz + RADIUS; z++) {
          const k = `${x},${y},${z}`;
          if (lv.cache.has(k)) continue;
          if (performance.now() > deadline) return false;
          lv.cache.set(k, generateSector(l, x, y, z));
        }
    return true;
  }

  private rebuild(l: number, cx: number, cy: number, cz: number, key: string): void {
    const lv = this.levels[l];
    const size = sectorSize(l);
    const next = new Map<string, StarData[]>();
    const stars: StarData[] = [];
    for (let x = cx - RADIUS; x <= cx + RADIUS; x++)
      for (let y = cy - RADIUS; y <= cy + RADIUS; y++)
        for (let z = cz - RADIUS; z <= cz + RADIUS; z++) {
          const k = `${x},${y},${z}`;
          const sector = lv.cache.get(k) ?? generateSector(l, x, y, z);
          next.set(k, sector);
          for (const s of sector) stars.push(s);
        }
    lv.cache = next;
    lv.stars = stars;
    lv.key = key;
    lv.origin.set(cx * size, cy * size, cz * size);

    const n = stars.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const lum = new Float32Array(n);
    const id = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = stars[i];
      pos.set([s.x - lv.origin.x, s.y - lv.origin.y, s.z - lv.origin.z], i * 3);
      col.set(temperatureToRgb(s.temp), i * 3);
      lum[i] = s.lum;
      id[i] = s.id % 16777216; // exactly representable in a float32
    }
    const g = lv.points.geometry;
    g.dispose();
    const ng = new THREE.BufferGeometry();
    ng.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    ng.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    ng.setAttribute('aLum', new THREE.BufferAttribute(lum, 1));
    ng.setAttribute('aId', new THREE.BufferAttribute(id, 1));
    lv.points.geometry = ng;

    // Each star twice, for the two ends of its streak.
    const pos2 = new Float32Array(n * 6), col2 = new Float32Array(n * 6);
    const lum2 = new Float32Array(n * 2), id2 = new Float32Array(n * 2), end = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      pos2.set(pos.subarray(i * 3, i * 3 + 3), i * 6);
      pos2.set(pos.subarray(i * 3, i * 3 + 3), i * 6 + 3);
      col2.set(col.subarray(i * 3, i * 3 + 3), i * 6);
      col2.set(col.subarray(i * 3, i * 3 + 3), i * 6 + 3);
      lum2[i * 2] = lum2[i * 2 + 1] = lum[i];
      id2[i * 2] = id2[i * 2 + 1] = id[i];
      end[i * 2 + 1] = 1;
    }
    lv.streaks.geometry.dispose();
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos2, 3));
    sg.setAttribute('aColor', new THREE.BufferAttribute(col2, 3));
    sg.setAttribute('aLum', new THREE.BufferAttribute(lum2, 1));
    sg.setAttribute('aId', new THREE.BufferAttribute(id2, 1));
    sg.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    lv.streaks.geometry = sg;
  }

  get starCount(): number {
    return this.levels.reduce((n, lv) => n + lv.stars.length, 0);
  }

  /** A random loaded star, biased towards the brighter, more distant levels. */
  sample(): StarData | null {
    const pool = this.levels.slice(1).filter((lv) => lv.stars.length > 0);
    if (pool.length === 0) return null;
    const lv = pool[Math.floor(Math.random() * pool.length)];
    return lv.stars[Math.floor(Math.random() * lv.stars.length)];
  }

  nearest(cam: { x: number; y: number; z: number }): StarData | null {
    let best: StarData | null = null;
    let bestD = Infinity;
    for (const lv of this.levels)
      for (const s of lv.stars) {
        const d = (s.x - cam.x) ** 2 + (s.y - cam.y) ** 2 + (s.z - cam.z) ** 2;
        if (d < bestD) { bestD = d; best = s; }
      }
    return best;
  }

  /** Brightest star within a small cone around a view ray. */
  pick(cam: { x: number; y: number; z: number }, dir: THREE.Vector3, cone = 0.014): StarData | null {
    let best: StarData | null = null;
    let bestScore = 0;
    for (const lv of this.levels)
      for (const s of lv.stars) {
        const dx = s.x - cam.x, dy = s.y - cam.y, dz = s.z - cam.z;
        const d = Math.hypot(dx, dy, dz);
        if (d < 1e-9) continue;
        const cos = (dx * dir.x + dy * dir.y + dz * dir.z) / d;
        if (cos < 0.99) continue;
        const ang = Math.acos(Math.min(cos, 1));
        if (ang > cone) continue;
        const score = Math.pow(s.lum / (d * d), 0.2) / (ang + 0.003);
        if (score > bestScore) { bestScore = score; best = s; }
      }
    return best;
  }
}
