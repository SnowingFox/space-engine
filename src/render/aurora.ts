import * as THREE from 'three';
import type { BodyData } from '../universe/bodies';
import { atmoCommon } from './atmosphereScatter';
import { WORLD_VERT } from './atmosphereShader';
import { LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, NOISE } from './glsl';

// Polar lights: thin curtains hanging along the auroral ovals, a ring around each magnetic
// pole that is pushed towards the night side. The glow is green where the curtains bottom
// out, red far above, with a violet hem; it is marched through a shell above the air and
// added to the frame, so it costs nothing where no ray crosses an oval.

const AURORA_FRAG = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
${NOISE}
${atmoCommon(1)}
uniform vec3 uCenter;     // planet centre relative to camera, km
uniform float uRadius;    // km
uniform vec3 uSunDir;     // world space, towards the star
uniform vec3 uPole;       // world space, the magnetic axis
uniform vec2 uShell;      // bottom and top of the glowing layer, planet radii
uniform float uStrength;
uniform float uTime;
uniform vec3 uLow;        // colour of the bright lower border
uniform vec3 uHigh;       // colour of the tall faint rays
varying vec3 vWorld;

const int STEPS = 20;

// Spacing of the samples along the ray (planet radii). The curtains are far thinner than that when
// marched from afar, so each is widened to the spacing (keeping its total light) and the fine rays
// fade to their mean: the same curtains at every distance, only sharper close up.
float gStep = 0.0;

// A curtain of half-width w across the oval, at offset x, blurred to the sample spacing.
float curtain(float x, float w) {
  float s2 = w * w + 0.25 * gStep * gStep;
  return w * inversesqrt(s2) * exp(-0.5 * x * x / s2);
}

// Light given off per unit length (planet radii) at p.
vec3 glow(vec3 p) {
  float r = length(p);
  vec3 dir = p / r;
  float alt = (r - uShell.x) / (uShell.y - uShell.x);
  if (alt < 0.0 || alt > 1.0) return vec3(0.0);
  float s = dot(dir, uSunDir);
  float night = 1.0 - smoothstep(-0.22, 0.08, s);
  if (night <= 0.0) return vec3(0.0);
  float cz = dot(dir, uPole);
  float colat = acos(min(abs(cz), 1.0));
  // The oval sits further from the pole on the side facing away from the star.
  float oval = 0.33 - 0.1 * s / max(sqrt(1.0 - cz * cz), 0.2);
  float off = colat - oval;
  if (abs(off) > 0.16) return vec3(0.0);
  // The curtains wander, slowly; both hemispheres get their own.
  vec3 q = dir * 7.0 + sign(cz) * 3.0;
  float drift = uTime * 0.012;
  float wander = vnoise(q + drift) - 0.5;
  float fold = vnoise(q * 5.5 - drift * 2.0) - 0.5;
  float a = off - 0.07 * wander - 0.014 * fold;
  float b = off + 0.045 + 0.06 * wander + 0.012 * fold;
  float arcs = curtain(a, 0.00477) + 0.6 * curtain(b, 0.00408);
  float veil = 0.07 * exp(-off * off * 300.0);
  if (arcs + veil < 0.004) return vec3(0.0);
  // Rays: brightness varies along a curtain, and each ray reaches its own height.
  float ray = mix(0.5, vnoise(dir * 260.0 + drift * 6.0), clamp(1.5 - gStep * 520.0, 0.0, 1.0));
  float fine = mix(0.5, vnoise(dir * 1100.0 - drift * 9.0), clamp(1.5 - gStep * 2200.0, 0.0, 1.0));
  float lively = 0.25 + 1.5 * ray * ray * (0.5 + fine);
  float reach = 4.0 + 9.0 * fine;
  float low = smoothstep(0.0, 0.05, alt) * exp(-alt * reach);
  float high = smoothstep(0.08, 0.4, alt) * (1.0 - smoothstep(0.55, 1.0, alt));
  float hem = exp(-pow((alt - 0.025) / 0.02, 2.0));
  vec3 c = uLow * low + uHigh * (0.16 * high) + vec3(0.45, 0.2, 0.9) * (0.35 * hem * ray);
  return c * ((arcs * lively + veil) * night);
}

void main() {
  vec3 rd = normalize(vWorld);
  vec3 ro = -uCenter / uRadius;
  vec2 outer = raySphere(ro, rd, uShell.y);
  if (outer.x > outer.y || outer.y <= 0.0) discard;
  float t0 = max(outer.x, 0.0), t1 = outer.y;
  vec2 ground = raySphere(ro, rd, 1.0);
  if (ground.x < ground.y && ground.x > 0.0) t1 = min(t1, ground.x);
  // The stretch below the layer is empty: march what lies before it and what lies beyond.
  vec2 inner = raySphere(ro, rd, uShell.x);
  float a1 = t1, b0 = t1;
  if (inner.x < inner.y && inner.y > t0) {
    a1 = clamp(inner.x, t0, t1);
    b0 = clamp(inner.y, t0, t1);
  }
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec3 col = vec3(0.0);
  if (a1 > t0) {
    float dt = (a1 - t0) / float(STEPS);
    gStep = dt;
    for (int i = 0; i < STEPS; i++) col += glow(ro + rd * (t0 + (float(i) + jitter) * dt)) * dt;
  }
  if (t1 > b0) {
    float dt = (t1 - b0) / float(STEPS);
    gStep = dt;
    for (int i = 0; i < STEPS; i++) col += glow(ro + rd * (b0 + (float(i) + jitter) * dt)) * dt;
  }
  col *= uStrength;
  if (col.r + col.g + col.b < 1e-4) discard;
  gl_FragColor = vec4(col, 1.0);
  ${LOGDEPTH_FRAG}
}
`;

/** How strong the polar lights of a body are: they need air to glow in and a magnetic field to steer the particles. */
export function auroraStrength(body: BodyData): number {
  if (body.aurora !== undefined) return body.aurora;
  if (!body.atmosphere) return 0;
  return body.type === 'terran' || body.type === 'ocean' || body.type === 'gas' || body.type === 'icegiant' ? 1 : 0;
}

const AXIS = new THREE.Vector3(0, 1, 0);
const camDir = new THREE.Vector3();

export class Aurora {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly top: number;
  /** The magnetic axis in the frame that turns with the body. */
  private readonly pole: THREE.Vector3;

  constructor(private readonly body: BodyData, geometry: THREE.BufferGeometry, strength: number) {
    const h = body.atmosphere?.height ?? 0.02;
    const giant = body.type === 'gas' || body.type === 'icegiant';
    const bottom = 1 + h * 0.7;
    this.top = 1 + h * 2.3;
    const lean = 0.17, turn = body.seed * 2.399;
    this.pole = new THREE.Vector3(Math.sin(lean) * Math.cos(turn), Math.cos(lean), Math.sin(lean) * Math.sin(turn));
    this.material = new THREE.ShaderMaterial({
      vertexShader: WORLD_VERT,
      fragmentShader: AURORA_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      uniforms: {
        uCenter: { value: new THREE.Vector3() },
        uRadius: { value: body.radius },
        uSunDir: { value: new THREE.Vector3(1, 0, 0) },
        uPole: { value: new THREE.Vector3(0, 1, 0) },
        uShell: { value: new THREE.Vector2(bottom, this.top) },
        uStrength: { value: 0 },
        uTime: { value: 0 },
        // Oxygen green below and red above on worlds like ours; hydrogen pink and blue on the giants.
        uLow: { value: giant ? new THREE.Vector3(0.9, 0.3, 0.7) : new THREE.Vector3(0.25, 1.0, 0.45) },
        uHigh: { value: giant ? new THREE.Vector3(0.3, 0.4, 1.0) : new THREE.Vector3(1.0, 0.12, 0.2) },
      },
    });
    this.material.userData.strength = (strength * 80 * 0.022) / h;
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.scale.setScalar(body.radius * this.top * 1.02);
    this.mesh.frustumCulled = false;
  }

  /**
   * rel: planet centre relative to the camera (km). sunDir: world-space unit vector to the star.
   * tilt: orientation of the body's axis; angle: how far it has turned about it.
   */
  update(rel: THREE.Vector3, sunDir: THREE.Vector3, tilt: THREE.Quaternion, angle: number, realTime: number): void {
    const u = this.material.uniforms;
    const dist = rel.length() / this.body.radius;
    const pole = (u.uPole.value as THREE.Vector3).copy(this.pole).applyAxisAngle(AXIS, angle).applyQuaternion(tilt);
    camDir.copy(rel).multiplyScalar(-1 / rel.length());
    const inside = dist < this.top * 1.02;
    // From far away the ovals are too thin to see; under a daytime sky they are drowned out,
    // and from the ground they only show within a few hundred kilometres of an oval.
    let on = 1 - THREE.MathUtils.smoothstep(dist, 8, 14);
    // Down in the air these fade in gradually with the descent (a switch at the shell would make the
    // curtains pop out of sight): under a daylit sky they are drowned out, and from the ground they only
    // rise over the horizon from high latitudes (ovals sit 20-25 degrees from the magnetic pole), not
    // from the middle ones, where they would lie along it as a band.
    const low = 1 - THREE.MathUtils.smoothstep(dist, 1 + (this.top - 1) * 0.3, this.top);
    if (low > 0) {
      const colat = Math.acos(Math.min(Math.abs(camDir.dot(pole)), 1));
      const near = (1 - THREE.MathUtils.smoothstep(camDir.dot(sunDir), -0.12, 0.05)) * (1 - THREE.MathUtils.smoothstep(colat, 0.5, 0.68));
      on *= 1 - low + low * near;
    }
    this.mesh.visible = on > 0.003;
    if (!this.mesh.visible) return;
    u.uStrength.value = on * (this.material.userData.strength as number);
    u.uCenter.value.copy(rel);
    u.uSunDir.value.copy(sunDir);
    u.uTime.value = realTime;
    // Seen from outside the near face of the shell is drawn, from within the far one, so the ground hides what is behind it.
    this.material.side = inside ? THREE.BackSide : THREE.FrontSide;
    // Under the cloud deck from below, over it from above.
    this.mesh.renderOrder = inside ? 1.5 : 2.5;
  }

  dispose(): void {
    this.material.dispose();
  }
}
