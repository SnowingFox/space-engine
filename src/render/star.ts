import * as THREE from 'three';
import { KM_PER_AU, SUN_RADIUS_KM } from '../core/units';
import { temperatureToRgb, type StarData } from '../universe/stars';
import { LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS, NOISE } from './glsl';
import { PLANET_VERT } from './planetShader';

const STAR_FRAG = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
${NOISE}
uniform vec3 uColor;
uniform float uTime;
uniform vec3 uCamObj;
uniform float uGain;
varying vec3 vObj;
void main() {
  vec3 n = normalize(vObj);
  float detail = 0.6 / max(length(fwidth(vObj)), 1e-6);
  vec3 V = normalize(uCamObj - n);
  float mu = max(dot(n, V), 0.0);
  // Granulation: bright convection cells with dark lanes between them, slowly boiling.
  vec3 drift = vec3(0.0, uTime * 0.02, 0.0);
  vec2 cell = worley(n * 80.0 + drift);
  vec2 small = worley(n * 240.0 - drift * 3.0);
  float grain = mix(0.5, smoothstep(0.05, 0.8, 1.0 - cell.x), clamp(detail / 80.0 - 1.0, 0.0, 1.0));
  grain += 0.5 * (mix(0.5, smoothstep(0.05, 0.8, 1.0 - small.x), clamp(detail / 240.0 - 1.0, 0.0, 1.0)) - 0.5);
  // Supergranules and faculae: broad, faint mottling.
  float mottle = fbm(n * 5.0 + drift * 0.2, detail / 5.0);
  // Sunspots: a few small dark umbrae in two belts either side of the equator.
  float belt = smoothstep(0.6, 0.25, abs(abs(n.y) - 0.3) * 3.0);
  float spotField = fbm(n * 8.0 + 31.0 + uTime * 0.0015, min(detail / 8.0, 6.0));
  float spot = smoothstep(0.755, 0.78, spotField) * belt;
  float penumbra = smoothstep(0.725, 0.745, spotField) * belt;
  float heat = 0.84 + 0.3 * (grain - 0.5) + 0.3 * (mottle - 0.5);
  heat *= 1.0 - 0.3 * penumbra - 0.5 * spot;
  // Limb darkening: the edge shows higher, cooler layers, so it is dimmer and redder.
  float limb = 0.32 + 0.68 * pow(mu, 0.55);
  float warmth = smoothstep(0.25, 1.0, heat * limb);
  vec3 tint = mix(uColor * uColor * vec3(1.0, 0.55, 0.28), uColor * vec3(1.0, 0.96, 0.88), warmth);
  gl_FragColor = vec4(tint * heat * limb * uGain, 1.0);
  ${LOGDEPTH_FRAG}
}
`;

const GLARE_VERT = /* glsl */ `
${LOGDEPTH_VERT_PARS}
uniform float uSize;
varying vec2 vUv;
void main() {
  vUv = position.xy;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * uSize;
  gl_Position = projectionMatrix * mv;
  ${LOGDEPTH_VERT}
}
`;

const GLARE_FRAG = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
uniform vec3 uColor;
uniform vec3 uTint;    // what the way here leaves of the light: air reddens it, a limb hides it
uniform float uIntensity;
uniform vec2 uPart;    // how much of the core and rays, and of the aureole, this layer draws
uniform float uDisk;   // stellar disk radius as a fraction of the quad
uniform float uStreak;
uniform float uTime;
varying vec2 vUv;

// Smooth noise around the circle with n lobes.
float lobes(float turn, float n, float seed) {
  float t = turn * n;
  float i = floor(t), f = fract(t);
  f = f * f * (3.0 - 2.0 * f);
  float a = fract(sin((mod(i, n) + seed) * 127.1) * 43758.5453);
  float b = fract(sin((mod(i + 1.0, n) + seed) * 127.1) * 43758.5453);
  return mix(a, b, f);
}

void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float x = max(r - uDisk, 0.0) / (1.0 - uDisk);
  float turn = atan(vUv.y, vUv.x) / 6.2831853 + 0.5;
  // What an eye or a lens makes of a light far too bright for it: a core burnt out well beyond
  // the disc itself, an aureole falling off steeply around it, and through both the fine
  // fibres of the ciliary corona, hundreds of them, none standing out on its own.
  float core = 24.0 * exp(-x / 0.012);
  float aureole = 6.0 / pow(1.0 + x * x / 0.0009, 1.25);
  float shimmer = 0.5 + 0.5 * sin(uTime * 1.7 + turn * 40.0);
  float fibres = lobes(turn, 190.0, 0.0) * lobes(turn, 71.0, 7.0) * (0.8 + 0.2 * shimmer);
  float beams = pow(lobes(turn, 18.0, 3.0), 5.0);
  float rays = (0.45 + 2.2 * fibres + 1.2 * beams) * 0.34 / (1.0 + x * x / 0.0081) * smoothstep(0.0, 0.03, x) * uStreak;
  // The lenticular halo: a faint ring, blue inside and red outside.
  float h = (x - 0.3) / 0.14;
  float ring = exp(-(h - 0.5) * (h - 0.5) * 9.0) * (0.4 + 2.4 * fibres) * 0.008 * uStreak;
  // Up close: the corona, a soft glow off the limb drawn out into streamers.
  float off = max(r - uDisk, 0.0) / max(uDisk, 1e-4);
  float streamers = lobes(turn, 7.0, 11.0) * (0.5 + 0.5 * lobes(turn, 23.0, 5.0)) * (0.7 + 0.3 * lobes(turn, 90.0, 2.0));
  float chromosphere = 1.6 * exp(-off * 60.0);
  float coronaGlow = (chromosphere + 0.45 * exp(-off * 7.0) + 0.5 * streamers * streamers / (1.0 + off * off * 9.0) * smoothstep(1.0, 0.3, r)) * (1.0 - uStreak);
  vec3 spectrum = clamp(vec3(h * 1.6 - 0.3, 1.0 - abs(h * 2.0 - 1.0), 1.3 - h * 1.6), 0.0, 1.0);
  // The quad also covers the photosphere: keep the glare off the resolved disk.
  // (A disc too small to show any surface is all glare.)
  float fade = smoothstep(1.0, 0.5, r) * mix(smoothstep(uDisk * 0.97, uDisk * 1.02, r + 0.004), 1.0, uStreak);
  vec3 tint = mix(uColor, uColor * uColor, clamp(x * 6.0, 0.0, 1.0));
  vec3 col = mix(tint, vec3(1.0), clamp(core * 0.2, 0.0, 1.0)) * ((core + rays) * uPart.x + aureole * uPart.y) * uIntensity;
  col += (spectrum * ring * uIntensity + uColor * mix(uColor * vec3(1.0, 0.8, 0.62), vec3(1.0), clamp(coronaGlow - 0.4, 0.0, 1.0)) * coronaGlow) * uPart.x;
  gl_FragColor = vec4(col * uTint * fade, 1.0);
  ${LOGDEPTH_FRAG}
}
`;

/** The anchor star: a shaded photosphere plus a camera-facing glare quad. */
export class StarView {
  readonly group = new THREE.Group();
  readonly color: THREE.Color;
  readonly radiusKm: number;
  /** 1 = the Sun seen from Earth. */
  brightness = 1;
  private readonly surfaceMat: THREE.ShaderMaterial;
  private readonly glareMat: THREE.ShaderMaterial;
  // Glare forms in the eye, not in the sky: part of it spills over whatever stands next to the star.
  private readonly spillMat: THREE.ShaderMaterial;
  private readonly tint = new THREE.Vector3(1, 1, 1);

  constructor(readonly star: StarData) {
    const [r, g, b] = temperatureToRgb(star.temp);
    this.color = new THREE.Color(r, g, b);
    this.radiusKm = star.radius * SUN_RADIUS_KM;

    this.surfaceMat = new THREE.ShaderMaterial({
      vertexShader: PLANET_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: { uColor: { value: this.color }, uTime: { value: 0 }, uCamObj: { value: new THREE.Vector3() }, uGain: { value: 4 } },
    });
    const surface = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), this.surfaceMat);
    surface.scale.setScalar(this.radiusKm);
    this.group.add(surface);

    const quad = new THREE.PlaneGeometry(2, 2);
    const layer = (depthTest: boolean): THREE.ShaderMaterial => {
      const mat = new THREE.ShaderMaterial({
        vertexShader: GLARE_VERT,
        fragmentShader: GLARE_FRAG,
        transparent: true,
        depthTest,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uColor: { value: this.color }, uTint: { value: this.tint }, uSize: { value: 1 }, uIntensity: { value: 1 },
          uPart: { value: new THREE.Vector2(1, 1) }, uDisk: { value: 0 }, uStreak: { value: 1 }, uTime: { value: 0 },
        },
      });
      const mesh = new THREE.Mesh(quad, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 3;
      this.group.add(mesh);
      return mat;
    };
    this.glareMat = layer(true);
    this.spillMat = layer(false);
  }

  /**
   * tint: what is left of each colour of the star's light on its way to the camera.
   * spill: how much of the aureole may show over things in front of the star, 0..1.
   */
  update(rel: THREE.Vector3, realTime: number, tint: THREE.Vector3, spill: number): void {
    this.group.position.copy(rel);
    this.tint.copy(tint);
    const dist = Math.max(rel.length(), this.radiusKm * 1.0001);
    const dAu = dist / KM_PER_AU;
    const brightness = this.brightness = this.star.lum / (dAu * dAu);
    // Glare grows with apparent brightness but never shrinks below a visible point.
    const angular = THREE.MathUtils.clamp(0.2 * Math.pow(brightness, 0.17), 0.012, 0.36);
    // Perspective makes the silhouette wider than the true radius once the camera is close.
    const ratio = Math.min(this.radiusKm / dist, 0.98);
    const apparent = this.radiusKm / Math.sqrt(1 - ratio * ratio);
    const size = Math.max(angular * dist, apparent * 3.6);
    // Once the disc is more than a dot the photosphere carries the light itself (and blooms);
    // glare on top of it would only wash out the view.
    const closeUp = THREE.MathUtils.smoothstep(ratio, 0.02, 0.2);
    const intensity = THREE.MathUtils.clamp(Math.pow(brightness, 0.3), 0.3, 1.8) * (1 - 0.93 * closeUp);
    const over = 0.5 * spill * (1 - closeUp);
    for (const mat of [this.glareMat, this.spillMat]) {
      const g = mat.uniforms;
      g.uSize.value = size;
      g.uDisk.value = apparent / size;
      g.uStreak.value = 1 - closeUp;
      g.uTime.value = realTime;
      g.uIntensity.value = intensity;
    }
    (this.glareMat.uniforms.uPart.value as THREE.Vector2).set(1, 1 - over);
    (this.spillMat.uniforms.uPart.value as THREE.Vector2).set(0, over);
    const s = this.surfaceMat.uniforms;
    s.uTime.value = realTime;
    // A distant disc is a dazzling point; close by, the eye adapts and the surface shows its texture.
    s.uGain.value = 4 - 2.2 * THREE.MathUtils.smoothstep(ratio, 0.03, 0.25);
    s.uCamObj.value.copy(rel).multiplyScalar(-1 / this.radiusKm);
  }

  dispose(): void {
    this.surfaceMat.dispose();
    this.glareMat.dispose();
    this.spillMat.dispose();
    this.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
  }
}
