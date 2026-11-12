import * as THREE from 'three';
import type { NearGalaxy } from './galaxyVolume';

// Inside the disc of the Milky Way the sky is not a model: it is the sky as surveyed from Earth
// (NASA SVS Deep Star Maps, the glow without the individual stars), wrapped around the camera
// and turned so that its bulge lies towards the galactic centre from wherever the camera is.
// Other spiral galaxies borrow the same view from inside their discs. Above the disc, in the
// core and outside, the view is a different one and the marched model shows instead.

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * vec4(mat3(modelViewMatrix) * position, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform mat3 uFrame;    // universe axes to the galaxy's own
uniform float uTurn;    // longitude of the galactic centre in that frame
uniform float uShift;   // how far the band sinks below the horizon, radians
uniform float uMirror;
uniform float uClouds;  // 0 hides the Magellanic Clouds, which belong to the Milky Way's sky only
uniform float uGain;
uniform float uLod;
varying vec3 vDir;
void main() {
  vec3 d = uFrame * normalize(vDir);
  // l from the direction to the galaxy's centre (-cos, -sin of uTurn) towards l = 90 deg (the pole crossed with it).
  vec2 cs = vec2(cos(uTurn), sin(uTurn));
  float l = atan(d.z * cs.x - d.x * cs.y, -(d.x * cs.x + d.z * cs.y)) * uMirror;
  float b = asin(clamp(d.y, -1.0, 1.0));
  b = clamp(b + uShift * cos(b), -1.5707, 1.5707);
  vec2 uv = vec2(0.5 - l / 6.2831853, 0.5 + b / 3.14159265);
  // (An explicit mip level: the jump of the longitude across the seam would otherwise pick a tiny one.)
  vec3 c = textureLod(uMap, uv, uLod).rgb;
  vec3 p = vec3(cos(b) * cos(l), sin(b), cos(b) * sin(l));
  float clouds = max(smoothstep(0.965, 0.988, dot(p, vec3(0.153, -0.543, -0.826))), smoothstep(0.982, 0.994, dot(p, vec3(0.388, -0.698, -0.602))));
  c *= 1.0 - clouds * (1.0 - uClouds);
  gl_FragColor = vec4(c * uGain, 1.0);
}
`;

/** Heights above the plane, in scale heights of the disc, over which the view from inside gives way to the one from above. */
export const PLANE_FADE: readonly [number, number] = [1.2, 2.4];

function smooth(v: number, a: number, b: number): number {
  return THREE.MathUtils.smoothstep(v, a, b);
}

export class HomeSky {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private loading = false;
  private loadedAt = -1;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uMap: { value: null }, uFrame: { value: new THREE.Matrix3() }, uTurn: { value: 0 }, uShift: { value: 0 },
        uMirror: { value: 1 }, uClouds: { value: 1 }, uGain: { value: 0 }, uLod: { value: 0 },
      },
      side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  private load(): void {
    this.loading = true;
    new THREE.ImageBitmapLoader().setOptions({ imageOrientation: 'flipY' }).load('/textures/sky_milkyway.jpg', (bitmap) => {
      const map = new THREE.CanvasTexture(bitmap);
      map.colorSpace = THREE.SRGBColorSpace;
      map.minFilter = THREE.LinearMipmapLinearFilter;
      map.wrapS = THREE.RepeatWrapping;
      this.material.uniforms.uMap.value = map;
      this.loadedAt = performance.now();
    });
  }

  /** How much of the sky the survey would carry for a camera at `eye` in a galaxy's disc, 0..1. */
  static cover(host: NearGalaxy | undefined): number {
    if (!host) return 0;
    const g = host.galaxy;
    if (g.kind !== 'spiral' && g.kind !== 'barred spiral' && g.kind !== 'irregular') return 0;
    const r = Math.hypot(host.eye.x, host.eye.z);
    const inPlane = 1 - smooth(Math.abs(host.eye.y), PLANE_FADE[0] * g.height, PLANE_FADE[1] * g.height);
    return inPlane * smooth(r, 0.1 * g.radius, 0.22 * g.radius) * (1 - smooth(r, 0.85 * g.radius, 1.05 * g.radius));
  }

  /** Returns how much of the host galaxy's light the survey carries here, 0..1; the model shows the rest. */
  update(host: NearGalaxy | undefined, pixelsPerRadian: number, gain: number): number {
    const cover = gain > 0 ? HomeSky.cover(host) : 0;
    if (cover > 0 && !this.loading) this.load();
    const ready = this.loadedAt < 0 ? 0 : Math.min(1, (performance.now() - this.loadedAt) / 800);
    const weight = cover * ready;
    this.mesh.visible = weight > 0;
    if (!host || weight <= 0) return 0;
    const g = host.galaxy, u = this.material.uniforms;
    const a = g.axes;
    u.uFrame.value.set(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8]);
    u.uTurn.value = Math.atan2(host.eye.z, host.eye.x);
    u.uShift.value = Math.atan(host.eye.y / (16 * g.height));
    u.uMirror.value = g.id % 2 === 0 ? 1 : -1;
    u.uClouds.value = g.id === 0 ? 1 : 0;
    // Brighter towards the centre, where the disc is denser; calibrated half-way out, where the Sun is.
    const r = Math.hypot(host.eye.x, host.eye.z);
    const dense = THREE.MathUtils.clamp(Math.exp(-(r - 0.5 * g.radius) / (2 * g.discScale)), 0.6, 1.5);
    u.uGain.value = gain * weight * dense;
    const map = u.uMap.value as THREE.Texture | null;
    if (map) u.uLod.value = Math.max(0, Math.log2((map.image as ImageBitmap).width / (2 * Math.PI) / pixelsPerRadian));
    return weight;
  }
}
