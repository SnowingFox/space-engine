import * as THREE from 'three';
import { SECTOR_LEVELS, generateSector, sectorOfPosition, sectorSize } from '../universe/galaxy';
import { temperatureToRgb, type StarData } from '../universe/stars';

const RADIUS = 3; // sectors loaded around the camera in each direction, per level

const VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aLum;
attribute float aId;
uniform float uHideId;
uniform float uPixelRatio;
uniform float uTwinkle;  // seen through air, starlight flickers
uniform float uTime;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = max(length(mv.xyz), 1e-4);
  float flux = aLum / (d * d);                      // solar luminosities per ly^2
  float mag = -2.5 * log(flux) / 2.302585 - 2.74;    // apparent magnitude
  // Brightness compressed less than before: a handful of bright stars, the rest faint pinpoints,
  // as in long-exposure photographs (and Space Engine) rather than a field of equal sparks.
  float intensity = clamp(pow(2.512, 0.7 * (3.6 - mag)), 0.0, 9.0);
  // Pinpoints: only the few brightest stars grow beyond a couple of pixels.
  float size = clamp(2.7 - mag * 0.32, 1.0, 3.8);
  // About what the eye sees on a dark night; fainter stars fade out instead of flickering.
  intensity *= smoothstep(8.8, 6.0, mag);
  // Scintillation: turbulence in the air focuses and spreads each star's light, many times a second.
  float ph = fract(aId * 0.6180339) * 6.2831853;
  float flicker = sin(uTime * (9.0 + 7.0 * fract(aId * 0.31)) + ph) * sin(uTime * (3.1 + 2.0 * fract(aId * 0.77)) + 2.0 * ph);
  intensity *= 1.0 + uTwinkle * 0.6 * flicker;
  vColor = aColor * intensity;
  gl_PointSize = size * uPixelRatio;
  gl_Position = projectionMatrix * mv;
  if (abs(aId - uHideId) < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
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

  constructor(pixelRatio: number) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uHideId: { value: -1 }, uPixelRatio: { value: pixelRatio }, uTwinkle: { value: 0 }, uTime: { value: 0 } },
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    for (let l = 0; l < SECTOR_LEVELS; l++) {
      const points = new THREE.Points(new THREE.BufferGeometry(), this.material);
      points.frustumCulled = false;
      this.group.add(points);
      this.levels.push({ points, stars: [], key: '', origin: new THREE.Vector3(), cache: new Map() });
    }
  }

  /** twinkle: 0 in space, 1 at the bottom of an Earth-like atmosphere. */
  setTwinkle(twinkle: number, time: number): void {
    this.material.uniforms.uTwinkle.value = twinkle;
    this.material.uniforms.uTime.value = time;
  }

  /** The star whose point sprite is suppressed because it is drawn as a real sphere. */
  setHidden(star: StarData | null): void {
    this.material.uniforms.uHideId.value = star ? star.id % 16777216 : -1;
  }

  /** cam: galactic position in light years. */
  update(cam: { x: number; y: number; z: number }): void {
    for (let l = 0; l < SECTOR_LEVELS; l++) {
      const lv = this.levels[l];
      const cx = sectorOfPosition(l, cam.x);
      const cy = sectorOfPosition(l, cam.y);
      const cz = sectorOfPosition(l, cam.z);
      const key = `${cx},${cy},${cz}`;
      if (key !== lv.key) this.rebuild(l, cx, cy, cz, key);
      lv.points.position.set(lv.origin.x - cam.x, lv.origin.y - cam.y, lv.origin.z - cam.z);
    }
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
