import * as THREE from 'three';
import { KM_PER_AU, SUN_RADIUS_KM } from '../core/units';
import { temperatureToRgb, type StarData } from '../universe/stars';
import { LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS, NOISE } from './glsl';
import { PLANET_VERT } from './planetShader';
import { lightSwitches } from './lighting';
import { probeRenderer } from './probe';

const STAR_FRAG = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
${NOISE}
uniform vec3 uColor;
uniform float uTime;
uniform vec3 uCamObj;
uniform float uGain;
uniform vec3 uTint;     // what the way here leaves of the light (air in front reddens and dims it)
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
  gl_FragColor = vec4(tint * heat * limb * uGain * uTint, 1.0);
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
uniform float uCorona; // 1 when another body exactly covers the star: its corona shows
uniform float uAureole; // the soft glow around the core: full for a star as bright as the Sun from Earth, far less for a distant one
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
  // A starburst: many thin rays reaching well beyond the aureole, their lengths uneven.
  float burst = pow(lobes(turn, 64.0, 9.0), 14.0) * (0.4 + 0.6 * lobes(turn, 16.0, 4.0));
  float rays = ((0.45 + 2.2 * fibres + 1.2 * beams) * 0.34 / (1.0 + x * x / 0.0081) + burst * 0.5 / (1.0 + x * x / 0.06))
    * smoothstep(0.0, 0.03, x) * uStreak;
  // The lenticular halo: a faint ring, blue inside and red outside.
  float h = (x - 0.3) / 0.14;
  float ring = exp(-(h - 0.5) * (h - 0.5) * 9.0) * (0.4 + 2.4 * fibres) * 0.008 * uStreak;
  // Up close: the corona, a soft glow off the limb drawn out into streamers.
  float off = max(r - uDisk, 0.0) / max(uDisk, 1e-4);
  float streamers = lobes(turn, 7.0, 11.0) * (0.5 + 0.5 * lobes(turn, 23.0, 5.0)) * (0.7 + 0.3 * lobes(turn, 90.0, 2.0));
  float chromosphere = 1.6 * exp(-off * 60.0);
  float coronaGlow = (chromosphere + 0.45 * exp(-off * 7.0) + 0.5 * streamers * streamers / (1.0 + off * off * 9.0) * smoothstep(1.0, 0.3, r));
  vec3 spectrum = clamp(vec3(h * 1.6 - 0.3, 1.0 - abs(h * 2.0 - 1.0), 1.3 - h * 1.6), 0.0, 1.0);
  // The quad also covers the photosphere: keep the glare off the resolved disk.
  // (A disc too small to show any surface is all glare.)
  float fade = smoothstep(1.0, 0.5, r) * mix(smoothstep(uDisk * 0.97, uDisk * 1.02, r + 0.004), 1.0, uStreak);
  vec3 tint = mix(uColor, uColor * uColor, clamp(x * 6.0, 0.0, 1.0));
  vec3 col = mix(tint, vec3(1.0), clamp(core * 0.2, 0.0, 1.0)) * ((core + rays) * uPart.x + aureole * uAureole * uPart.y) * uIntensity;
  vec3 corona = uColor * mix(uColor * vec3(1.0, 0.8, 0.62), vec3(1.0), clamp(coronaGlow - 0.4, 0.0, 1.0)) * coronaGlow;
  col += (spectrum * ring * uIntensity * uAureole + corona * (1.0 - uStreak)) * uPart.x;
  col *= uTint * fade;
  // At totality the corona is all that is left of the star: pearly, with the pink chromosphere at the limb.
  // (It is not dimmed by the starlight tint, which the covering body has taken to zero.)
  // Its brightness falls off about as the cube of the distance from the Sun's centre, out to several radii.
  float rim = smoothstep(uDisk * 0.97, uDisk * 1.03, r) * smoothstep(1.0, 0.5, r);
  float rr = max(r / max(uDisk, 1e-4), 1.0);
  float outer = 0.9 * pow(rr, -3.2) * (0.55 + 0.9 * streamers);
  vec3 pearl = mix(uColor, vec3(0.92, 0.95, 1.0), 0.6);
  col += (pearl * outer + corona * 0.25 + vec3(1.0, 0.3, 0.42) * chromosphere * 0.3) * uCorona * rim * uPart.x;
  gl_FragColor = vec4(col, 1.0);
  ${LOGDEPTH_FRAG}
}
`;

// Is the star's disc in sight? Small quads over the disc, pulled just in front of the star, are drawn
// depth-tested with an occlusion query each; the share that passes says how much of the disc the
// terrain and the bodies leave visible. The answer arrives a frame or two later.
const PROBE_GRID = 4;
const PROBE_VERT = /* glsl */ `
${LOGDEPTH_VERT_PARS}
uniform float uSize;
uniform float uPull;
uniform vec2 uCell;
void main() {
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xyz *= uPull;
  mv.xy += (uCell + position.xy * (0.5 / ${PROBE_GRID}.0)) * uSize * uPull;
  gl_Position = projectionMatrix * mv;
  ${LOGDEPTH_VERT}
}
`;
const PROBE_FRAG = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
void main() {
  gl_FragColor = vec4(0.0);
  ${LOGDEPTH_FRAG}
}
`;

// Lens flare: ghosts of the aperture on the line from the star through the centre of the frame,
// and the anamorphic streak across it. Placed in clip space, on top of everything.
const FLARE_VERT = /* glsl */ `
attribute vec4 aGhost;   // place along the line (1 = the star, -1 = mirrored through the centre), size, hue, kind
uniform float uAspect;
varying vec2 vUv;
varying vec2 vGhost;
varying float vKind;
varying float vInFrame;
void main() {
  vec4 c = projectionMatrix * modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec2 sun = c.xy / max(c.w, 1e-6);
  vUv = position.xy;
  vGhost = aGhost.zw;
  vKind = aGhost.w;
  // Only with the star itself in the frame.
  vInFrame = 1.0 - smoothstep(0.85, 1.0, max(abs(sun.x), abs(sun.y)));
  // (With the star near the middle the ghosts pile up on it, where its glare drowns them anyway.)
  if (aGhost.w < 1.5) vInFrame *= smoothstep(0.12, 0.35, length(sun));
  vec2 at = sun * aGhost.x;
  vec2 size = aGhost.w > 1.5 ? vec2(0.9, 0.006) : vec2(aGhost.y / uAspect, aGhost.y);
  // Behind the camera: nothing.
  gl_Position = c.w > 0.0 ? vec4(at + position.xy * size, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}
`;
const FLARE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uFlare;
uniform float uStreakGain;
varying vec2 vUv;
varying vec2 vGhost;
varying float vKind;
varying float vInFrame;
void main() {
  float r = length(vUv);
  vec3 col;
  if (vKind > 1.5) {
    // Anamorphic streak: a thin horizontal line, bluish, fading out along its length.
    float a = exp(-abs(vUv.x) * 3.5) * exp(-vUv.y * vUv.y * 9.0);
    col = mix(vec3(0.35, 0.55, 1.0), uColor, 0.35) * a * uStreakGain;
  } else {
    // The aperture's shape: a hexagon (six iris blades), soft-edged, brighter towards its rim; each colour
    // focuses a little differently, so the edge is fringed red outside and blue inside (kind 1: a ring only).
    vec2 q = abs(vUv);
    float hex = max(q.x * 0.8660254 + q.y * 0.5, q.y);
    if (hex > 1.05) discard;
    vec3 rad = hex * vec3(1.0, 1.035, 1.07);
    vec3 shape = vKind > 0.5
      ? exp(-pow((rad - 0.86) / 0.07, vec3(2.0)))
      : smoothstep(vec3(1.0), vec3(0.86), rad) * (0.45 + 0.55 * smoothstep(0.4, 0.95, rad));
    float h = vGhost.x;
    vec3 hue = clamp(vec3(1.5 - abs(h * 3.0 - 0.5), 1.5 - abs(h * 3.0 - 1.5), 1.5 - abs(h * 3.0 - 2.5)) - 0.5, 0.0, 1.0);
    col = mix(uColor, hue, 0.45) * shape;
  }
  gl_FragColor = vec4(col * uFlare * vInFrame, 1.0);
}
`;
// place, size (fraction of the frame height), hue, kind (0 disc, 1 ring, 2 streak)
const GHOSTS: [number, number, number, number][] = [
  [0.62, 0.02, 0.15, 0], [0.33, 0.035, 0.55, 0], [-0.18, 0.05, 0.3, 0], [-0.42, 0.03, 0.8, 0],
  [-0.66, 0.07, 0.6, 1], [-0.95, 0.06, 0.05, 0], [-1.3, 0.1, 0.45, 1], [1.0, 1.0, 0.0, 2],
];

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
  /** The starlight tint without the occlusion share (the disc's own pixels are hidden by depth). */
  private readonly tintAir = new THREE.Vector3(1, 1, 1);
  private readonly flareMat: THREE.ShaderMaterial;
  private readonly probeMat: THREE.ShaderMaterial;
  private readonly probes: { query: WebGLQuery | null; pending: boolean; passed: boolean }[] = [];
  /** Share of the star's disc not hidden by anything solid (from the occlusion queries). */
  private visible = 1;
  private visibleNow = 1;

  constructor(readonly star: StarData) {
    const [r, g, b] = temperatureToRgb(star.temp);
    this.color = new THREE.Color(r, g, b);
    this.radiusKm = star.radius * SUN_RADIUS_KM;

    this.surfaceMat = new THREE.ShaderMaterial({
      vertexShader: PLANET_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: { uColor: { value: this.color }, uTime: { value: 0 }, uCamObj: { value: new THREE.Vector3() }, uGain: { value: 4 }, uTint: { value: this.tintAir } },
      // Drawn over the sky (which would otherwise hide the disc behind its own brightness), dimmed instead
      // by the air in front through uTint.
      transparent: true, blending: THREE.NoBlending,
    });
    const surface = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), this.surfaceMat);
    surface.renderOrder = 1.2;
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
          uPart: { value: new THREE.Vector2(1, 1) }, uDisk: { value: 0 }, uStreak: { value: 1 }, uTime: { value: 0 }, uCorona: { value: 0 }, uAureole: { value: 1 },
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

    this.probeMat = new THREE.ShaderMaterial({
      vertexShader: PROBE_VERT, fragmentShader: PROBE_FRAG, transparent: true, depthWrite: false, colorWrite: false,
      uniforms: { uSize: { value: 1 }, uPull: { value: 1 }, uCell: { value: new THREE.Vector2() } },
    });
    for (let j = 0; j < PROBE_GRID; j++) {
      for (let i = 0; i < PROBE_GRID; i++) {
        const mat = this.probeMat.clone();
        mat.uniforms.uSize = this.probeMat.uniforms.uSize;
        mat.uniforms.uPull = this.probeMat.uniforms.uPull;
        (mat.uniforms.uCell.value as THREE.Vector2).set((i + 0.5) / PROBE_GRID - 0.5, (j + 0.5) / PROBE_GRID - 0.5);
        const mesh = new THREE.Mesh(quad, mat);
        mesh.frustumCulled = false;
        // After everything solid, and before the glare.
        mesh.renderOrder = 2.9;
        const probe = { query: null as WebGLQuery | null, pending: false, passed: true };
        this.probes.push(probe);
        mesh.onBeforeRender = (renderer) => {
          const gl = renderer.getContext() as WebGL2RenderingContext;
          if (probe.pending) return;
          probe.query ??= gl.createQuery();
          gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, probe.query);
        };
        mesh.onAfterRender = (renderer) => {
          const gl = renderer.getContext() as WebGL2RenderingContext;
          if (probe.pending || !probe.query) return;
          gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
          probe.pending = true;
        };
        this.group.add(mesh);
      }
    }

    const flare = new THREE.BufferGeometry();
    const pos: number[] = [], ghost: number[] = [], index: number[] = [];
    GHOSTS.forEach((g, k) => {
      for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        pos.push(x, y, 0);
        ghost.push(...g);
      }
      index.push(k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3);
    });
    flare.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    flare.setAttribute('aGhost', new THREE.Float32BufferAttribute(ghost, 4));
    flare.setIndex(index);
    this.flareMat = new THREE.ShaderMaterial({
      vertexShader: FLARE_VERT, fragmentShader: FLARE_FRAG, transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: this.color }, uFlare: { value: 0 }, uStreakGain: { value: 0 }, uAspect: { value: 1 } },
    });
    const flareMesh = new THREE.Mesh(flare, this.flareMat);
    flareMesh.frustumCulled = false;
    flareMesh.renderOrder = 10;
    this.group.add(flareMesh);
  }

  /** Collects the occlusion answers that have come back; returns the share of the disc in sight. */
  private readVisibility(gl: WebGL2RenderingContext): number {
    let seen = 0, known = 0;
    for (const p of this.probes) {
      if (p.pending && p.query && gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE)) {
        p.passed = !!gl.getQueryParameter(p.query, gl.QUERY_RESULT);
        p.pending = false;
      }
      known++;
      if (p.passed) seen++;
    }
    return known ? seen / known : 1;
  }

  /**
   * tint: what is left of each colour of the star's light on its way to the camera.
   * spill: how much of the aureole may show over things in front of the star, 0..1.
   */
  update(rel: THREE.Vector3, realTime: number, tint: THREE.Vector3, spill: number, totality = 0): void {
    this.group.position.copy(rel);
    // Mountains (or anything solid) over the disc put out the glare too, not just the disc.
    const renderer = probeRenderer();
    const gl = renderer?.getContext() as WebGL2RenderingContext | undefined;
    if (gl) this.visibleNow = this.readVisibility(gl);
    const canvas = renderer?.domElement;
    const aspect = canvas && canvas.height > 0 ? canvas.width / canvas.height : 1;
    this.visible += (this.visibleNow - this.visible) * 0.5;
    this.tint.copy(tint).multiplyScalar(this.visible);
    this.tintAir.copy(tint);
    const dist = Math.max(rel.length(), this.radiusKm * 1.0001);
    const dAu = dist / KM_PER_AU;
    const brightness = this.brightness = this.star.lum / (dAu * dAu);
    // Glare grows with apparent brightness but never shrinks below a visible point.
    // Fainter (further away) the glare shrinks towards a sharp point with fine rays: at Neptune the Sun is
    // still dazzling (magnitude -19), but a point, not a soft disc of light.
    const angular = THREE.MathUtils.clamp(0.2 * Math.pow(brightness, brightness > 1 ? 0.08 : 0.5), 0.004, 0.36);
    // Perspective makes the silhouette wider than the true radius once the camera is close.
    const ratio = Math.min(this.radiusKm / dist, 0.98);
    const apparent = this.radiusKm / Math.sqrt(1 - ratio * ratio);
    const size = Math.max(angular * dist, apparent * 3.6);
    // Once the disc is more than a dot the photosphere carries the light itself (and blooms);
    // glare on top of it would only wash out the view.
    const closeUp = THREE.MathUtils.smoothstep(ratio, 0.02, 0.2);
    const intensity = THREE.MathUtils.clamp(Math.pow(brightness, brightness > 1 ? 0.15 : 0.3), 0.3, 1.4) * (1 - 0.93 * closeUp);
    const over = 0.5 * spill * (1 - closeUp);
    for (const mat of [this.glareMat, this.spillMat]) {
      const g = mat.uniforms;
      g.uSize.value = size;
      g.uDisk.value = apparent / size;
      g.uStreak.value = 1 - closeUp;
      g.uTime.value = realTime;
      g.uIntensity.value = intensity;
      g.uAureole.value = THREE.MathUtils.clamp(Math.pow(brightness, 0.5), 0.02, 1);
    }
    (this.glareMat.uniforms.uPart.value as THREE.Vector2).set(1, 1 - over);
    (this.spillMat.uniforms.uPart.value as THREE.Vector2).set(0, over);
    this.glareMat.uniforms.uCorona.value = lightSwitches.eclipses ? totality : 0;
    this.spillMat.uniforms.uCorona.value = 0;
    // The occlusion quads cover the disc (at least a few pixels), just in front of the star.
    this.probeMat.uniforms.uSize.value = Math.max(apparent * 2, dist * 0.002);
    this.probeMat.uniforms.uPull.value = Math.max(1 - (this.radiusKm * 1.5) / dist, 0.001);
    // Flare: faint, and only from a star that is a dazzling point rather than a disc filling the view.
    const lit = (tint.x * 0.3 + tint.y * 0.6 + tint.z * 0.1) * this.visible;
    const f = this.flareMat.uniforms;
    // A few hundredths of the glare at most: noticed, never in the way.
    f.uFlare.value = lightSwitches.flare ? 0.016 * Math.min(intensity, 1.5) * lit * (1 - closeUp) : 0;
    f.uStreakGain.value = 0.3;
    f.uAspect.value = aspect;
    const s = this.surfaceMat.uniforms;
    s.uTime.value = realTime;
    // A distant disc is a dazzling point; close by, the eye adapts and the surface shows its texture.
    // While the glare is on, the disc must be at least as bright as the glare's core around it, or a large
    // close star shows as a dim disc inside a bright ring.
    s.uGain.value = (4 - 2.2 * THREE.MathUtils.smoothstep(ratio, 0.03, 0.25)) * (1 + 6 * (1 - closeUp) * Math.min(intensity, 1.4) / 1.4);
    s.uCamObj.value.copy(rel).multiplyScalar(-1 / this.radiusKm);
  }

  dispose(): void {
    this.surfaceMat.dispose();
    this.glareMat.dispose();
    this.spillMat.dispose();
    this.flareMat.dispose();
    this.probeMat.dispose();
    const gl = probeRenderer()?.getContext() as WebGL2RenderingContext | undefined;
    for (const p of this.probes) if (p.query) gl?.deleteQuery(p.query);
    this.group.traverse((o) => { if ((o as THREE.Mesh).material && (o as THREE.Mesh).material !== this.probeMat && ((o as THREE.Mesh).material as THREE.ShaderMaterial).uniforms?.uCell) ((o as THREE.Mesh).material as THREE.Material).dispose(); });
    this.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
  }
}
