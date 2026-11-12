import * as THREE from 'three';
import type { BodyData } from '../universe/bodies';
import { atmoCommon } from './atmosphereScatter';
import { WORLD_VERT } from './atmosphereShader';
import { LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, NOISE } from './glsl';
import { HALF_LAYER, halfLayer } from './pipeline';

// Down in the air the aurora fills the sky and every pixel marches a long way through it: then it is
// marched at half resolution (pipeline.ts, HALF_LAYER) and drawn from there by this copy of the shell,
// depth-tested at full resolution so the ground in front still cuts it sharply.
const COMPOSITE_FRAG = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
uniform sampler2D uHalf;
uniform vec2 uInvFull;
void main() {
  gl_FragColor = vec4(texture2D(uHalf, gl_FragCoord.xy * uInvFull).rgb, 1.0);
  ${LOGDEPTH_FRAG}
}
`;

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
uniform float uActivity;  // 0 quiet .. 1 storm: how far equatorward the oval reaches and how bright it is
uniform vec3 uLow;        // colour of the bright lower border
uniform vec3 uHigh;       // colour of the tall faint rays
varying vec3 vWorld;

// Samples per stretch of the ray: 20 from space, more from down in the air, where rays run a long way
// through the layer and the curtains (a few kilometres thick) must still come out sharp.
const int MAX_STEPS = 64;
uniform float uSteps;

// Spacing of the samples along the ray (planet radii). The curtains are far thinner than that when
// marched from afar, so each is widened to the spacing (keeping its total light) and the fine rays
// fade to their mean: the same curtains at every distance, only sharper close up.
float gStep = 0.0;

// A curtain of half-width w across the oval, at offset x, blurred to the sample spacing; 'total' is how much
// light it gives off across its width (in units of the old, broad curtains), whatever the width.
float curtain(float x, float w, float total) {
  float s2 = w * w + 0.25 * gStep * gStep;
  return total * 0.00477 * inversesqrt(s2) * exp(-0.5 * x * x / s2);
}

// How far from the oval a point is (radians of colatitude), as glow() works it out.
float ovalOff(vec3 p) {
  vec3 dir = normalize(p);
  float s = dot(dir, uSunDir), cz = dot(dir, uPole);
  return acos(min(abs(cz), 1.0)) - (0.33 + 0.07 * (uActivity - 0.4) - 0.1 * s / max(sqrt(1.0 - cz * cz), 0.2));
}

// Samples for a stretch of ray from a to b: enough that each moves about 10 km across the ground
// (the curtains stay sharp), none at all if the stretch passes nowhere near the oval.
float stepsFor(vec3 ro, vec3 rd, float a, float b) {
  vec3 pa = ro + rd * a, pb = ro + rd * b, pm = ro + rd * (0.5 * (a + b));
  if (min(min(abs(ovalOff(pa)), abs(ovalOff(pb))), abs(ovalOff(pm))) > 0.32) return 0.0;
  float across = (b - a) * length(cross(rd, normalize(pm)));
  return clamp(ceil(across / 0.0016), 8.0, min(uSteps, float(MAX_STEPS)));
}

// Light given off per unit length (planet radii) at p.
vec3 glow(vec3 p) {
  float r = length(p);
  vec3 dir = p / r;
  float alt = (r - uShell.x) / (uShell.y - uShell.x);
  if (alt < 0.0 || alt > 1.0) return vec3(0.0);
  float s = dot(dir, uSunDir);
  // Brightest on the night side, fading broadly towards noon (dayside aurora is faint, and drowned by the
  // sky). Sunlight reaching the upper air does not switch the curtains off: a narrow mask would cut them
  // along a hard line where the layer passes into sunlight, as seen at twilight.
  float night = 1.0 - 0.9 * smoothstep(-0.5, 0.7, s);
  float cz = dot(dir, uPole);
  float colat = acos(min(abs(cz), 1.0));
  // The oval sits further from the pole on the side facing away from the star.
  float oval = 0.33 + 0.07 * (uActivity - 0.4) - 0.1 * s / max(sqrt(1.0 - cz * cz), 0.2);
  float off = colat - oval;
  // (Wide enough for every wander of the curtains; the arcs fade out well inside it, so it never cuts one.)
  if (abs(off) > 0.3) return vec3(0.0);
  // The curtains wander, slowly; both hemispheres get their own.
  vec3 q = dir * 7.0 + sign(cz) * 3.0;
  float drift = uTime * 0.012;
  float wander = vnoise(q + drift) - 0.5;
  float fold = vnoise(q * 5.5 - drift * 2.0) - 0.5;
  // Small folds and curls along each curtain, a few tens of kilometres across, faded out when marched from afar.
  float curl = (vnoise(q * 40.0 + drift * 4.0) - 0.5) * clamp(1.5 - gStep * 300.0, 0.0, 1.0);
  float a = off - 0.07 * wander - 0.014 * fold - 0.003 * curl;
  float b = off + 0.045 + 0.06 * wander + 0.012 * fold + 0.0025 * curl;
  // Curtains a few kilometres thick, as real ones are (a kilometre or two), with a fainter second arc poleward.
  // Further poleward, fainter scattered arcs (the polar cap is never quite empty in a storm).
  float c3 = off + 0.1 + 0.05 * wander - 0.01 * fold;
  float arcs = (curtain(a, 0.0006, 1.0) + 0.6 * curtain(b, 0.0005, 0.85) + 0.25 * uActivity * curtain(c3, 0.0007, 0.7))
    * (1.0 - smoothstep(0.18, 0.28, abs(off)));
  // The diffuse glow around the curtains, centred on them (on either side alike, so it has no edge of its own).
  // A fainter, broad glow reaches poleward over the cap: from the ground, looking under the lower border of a
  // curtain, the eye sees the cap beyond, and with nothing there it showed as a black hump with a hard rim.
  float veil = 0.02 * exp(-a * a * 600.0) + 0.012 * exp(-b * b * 600.0) + 0.006 * exp(-a * a * (a < 0.0 ? 40.0 : 600.0));
  // Most samples lie in the glow between the curtains, where the patterns along them do not show: there
  // they take their mean values, and the noise below is only looked up near a curtain.
  bool near = arcs > 2e-3 * veil;
  // Never a uniform ring: brightenings travel along the oval (substorms), patches pulse, and quiet
  // stretches fade to almost nothing.
  float along = vnoise(dir * 2.2 + sign(cz) * 5.0 + vec3(uTime * 0.004, 0.0, -uTime * 0.003));
  float surge = near ? vnoise(dir * 6.0 - vec3(0.0, uTime * 0.01, uTime * 0.008)) : 0.5;
  float pulse = 0.85 + 0.15 * sin(uTime * 1.3 + surge * 20.0);
  float patchy = smoothstep(0.25, 0.75, along);
  arcs *= patchy * (0.4 + 1.6 * surge * surge) * pulse * (0.4 + 1.2 * uActivity);
  veil *= 0.3 + 0.7 * patchy;
  // (A curtain blurred over a long step gives off little per unit length but a lot in all: the cut-off must be
  // far below anything visible, or curtains end along a hard line where the steps lengthen.)
  if (arcs + veil < 1e-5) return vec3(0.0);
  // Rays: brightness varies along a curtain, and each ray reaches its own height.
  float ray = near ? mix(0.5, vnoise(dir * 260.0 + drift * 6.0), clamp(1.5 - gStep * 520.0, 0.0, 1.0)) : 0.5;
  float fine = near ? mix(0.5, vnoise(dir * 1100.0 - drift * 9.0), clamp(1.5 - gStep * 2200.0, 0.0, 1.0)) : 0.5;
  float lively = 0.25 + 1.5 * ray * ray * (0.5 + fine);
  // Rays flicker a little, each at its own few hertz.
  lively *= 1.0 + 0.08 * sin(uTime * (6.0 + 40.0 * fine) + ray * 30.0);
  float reach = 4.0 + 9.0 * fine;
  float low = smoothstep(0.0, 0.05, alt) * exp(-alt * reach);
  float high = smoothstep(0.08, 0.4, alt) * (1.0 - smoothstep(0.55, 1.0, alt));
  float hem = exp(-pow((alt - 0.025) / 0.02, 2.0));
  // Greenish-white at the sharp lower edge, green above, faint red at the top; a magenta hem in storms.
  vec3 c = mix(uLow, vec3(0.75, 1.0, 0.8), 0.3 * smoothstep(0.1, 0.0, alt)) * low + uHigh * (0.07 * high)
    + vec3(0.65, 0.2, 0.75) * (0.3 * hem * ray * uActivity);
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
    float n = stepsFor(ro, rd, t0, a1);
    float dt = (a1 - t0) / max(n, 1.0);
    // (What blurs a curtain is how far each step moves across the ground, not up through the layer.)
    gStep = dt * length(cross(rd, normalize(ro + rd * (0.5 * (t0 + a1)))));
    for (int i = 0; i < MAX_STEPS; i++) { if (float(i) >= n) break; col += glow(ro + rd * (t0 + (float(i) + jitter) * dt)) * dt; }
  }
  if (t1 > b0) {
    float n = stepsFor(ro, rd, b0, t1);
    float dt = (t1 - b0) / max(n, 1.0);
    gStep = dt * length(cross(rd, normalize(ro + rd * (0.5 * (b0 + t1)))));
    for (int i = 0; i < MAX_STEPS; i++) { if (float(i) >= n) break; col += glow(ro + rd * (b0 + (float(i) + jitter) * dt)) * dt; }
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
  private readonly composite: THREE.Mesh;
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
        uSteps: { value: 20 },
        uActivity: { value: 0.5 },
        uTime: { value: 0 },
        // Oxygen green below and red above on worlds like ours; hydrogen pink and blue on the giants.
        uLow: { value: giant ? new THREE.Vector3(0.9, 0.3, 0.7) : new THREE.Vector3(0.25, 1.0, 0.45) },
        uHigh: { value: giant ? new THREE.Vector3(0.3, 0.4, 1.0) : new THREE.Vector3(1.0, 0.12, 0.2) },
      },
    });
    // (A giant's aurora shines mostly in the ultraviolet: in visible light it is a faint glow.)
    this.material.userData.strength = (strength * 80 * 0.022 * (giant ? 0.1 : 1)) / h;
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.scale.setScalar(body.radius * this.top * 1.02);
    this.mesh.frustumCulled = false;
    this.composite = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
      vertexShader: WORLD_VERT, fragmentShader: COMPOSITE_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      uniforms: { uHalf: { value: halfLayer.target.texture }, uInvFull: { value: halfLayer.invFull } },
    }));
    this.composite.frustumCulled = false;
    this.composite.visible = false;
    this.mesh.add(this.composite);
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
    // The most samples a ray may take (each takes what it needs, see stepsFor).
    u.uSteps.value = Math.round(THREE.MathUtils.lerp(24, 64, low));
    const half = low > 0.5;
    this.mesh.layers.set(half ? HALF_LAYER : 0);
    this.composite.visible = half;
    if (half) halfLayer.wanted = true;
    const cm = this.composite.material as THREE.ShaderMaterial;
    cm.side = inside ? THREE.BackSide : THREE.FrontSide;
    this.composite.renderOrder = inside ? 1.5 : 2.5;
    u.uCenter.value.copy(rel);
    u.uSunDir.value.copy(sunDir);
    u.uTime.value = realTime;
    // Activity wanders over hours, its own way on each world (sums of slow sines at unrelated rates).
    const t = realTime / 3600 + this.body.seed * 7.3;
    u.uActivity.value = THREE.MathUtils.clamp(0.5 + 0.3 * Math.sin(t * 0.9) * Math.sin(t * 0.37 + 1.3) + 0.2 * Math.sin(t * 2.3 + 0.4), 0.05, 1);
    // Seen from outside the near face of the shell is drawn, from within the far one, so the ground hides what is behind it.
    this.material.side = inside ? THREE.BackSide : THREE.FrontSide;
    // Under the cloud deck from below, over it from above.
    this.mesh.renderOrder = inside ? 1.5 : 2.5;
  }

  dispose(): void {
    this.material.dispose();
    (this.composite.material as THREE.Material).dispose();
  }
}
