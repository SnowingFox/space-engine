import * as THREE from 'three';
import { probeRenderer } from './probe';

// Shadows cast by the terrain itself: the patches are drawn once more as seen from the
// sun into a depth map, and every surface pixel asks that map whether something stands
// between it and the star. Two nested squares centred on the camera (a sharp one for the
// ground nearby and a wide one out to the mountains on the horizon) share one texture.

const SIZE = 2048;
/** The wide cascade is this many times the width of the sharp one. */
const WIDEN = 10;
/** The sharp cascade reaches this many camera altitudes to each side. */
const REACH = 8;

/** Fragment-side lookup. p: camera to surface in planet radii (planet frame); nrm: the true surface normal. */
export const SHADOW_LOOKUP = /* glsl */ `
#ifdef TERRAIN_SHADOW
uniform sampler2DShadow uShadowMap;   // two cascades side by side, depth as seen from the sun
uniform vec3 uShadowX;                // axes of the map, planet frame
uniform vec3 uShadowY;
uniform vec3 uShadowL;                // towards the star when the map was drawn
uniform vec3 uShadowShift[2];         // the camera now, relative to where each cascade was drawn from
uniform vec4 uShadowBox;              // half-width and half-depth of each cascade, planet radii
uniform float uShadowOn;

const float SHADOW_TEXEL = ${(1 / SIZE).toExponential(6)};

// 1 where sunlight arrives, 0 in shadow; 'trust' falls to 0 towards the edge of the cascade.
float shadowCascade(int i, vec3 p, vec3 nrm, out float trust) {
  vec2 box = i == 0 ? uShadowBox.xy : uShadowBox.zw;
  // Step off the surface by a texel or so, which keeps slopes from shadowing themselves.
  vec3 q = p + uShadowShift[i] + nrm * (3.0 * box.x * SHADOW_TEXEL);
  vec3 ls = vec3(dot(q, uShadowX), dot(q, uShadowY), -dot(q, uShadowL)) / box.xxy;
  trust = 1.0 - smoothstep(0.8, 0.96, max(max(abs(ls.x), abs(ls.y)), abs(ls.z)));
  if (trust <= 0.0) return 1.0;
  float depth = ls.z * 0.5 + 0.5 - SHADOW_TEXEL * box.x / box.y;
  vec2 uv = ls.xy * 0.5 + 0.5;
  // A 3 x 3 tent of filtered taps, a texel apart: fewer leave the shadow map's texels as stair-steps
  // along every sunlit ridge and snow edge.
  float lit = 0.0;
  float side = float(i);
  for (int k = 0; k < 9; k++) {
    vec2 g = vec2(float(k % 3), float(k / 3)) - 1.0;
    float w = (2.0 - abs(g.x)) * (2.0 - abs(g.y));
    vec2 o = g * SHADOW_TEXEL;
    lit += w * texture(uShadowMap, vec3((uv.x + o.x + side) * 0.5, uv.y + o.y, depth));
  }
  return lit / 16.0;
}

float terrainShadow(vec3 p, vec3 nrm) {
  float t0, t1;
  float lit = shadowCascade(0, p, nrm, t0);
  if (t0 < 1.0) lit = mix(mix(1.0, shadowCascade(1, p, nrm, t1), t1), lit, t0);
  return mix(1.0, lit, uShadowOn);
}
#endif
`;

/** Vertex-side projection for the depth pass. v: camera to vertex, planet radii. */
export const SHADOW_PROJECT = /* glsl */ `
uniform vec3 uShadowX;
uniform vec3 uShadowY;
uniform vec3 uShadowL;
uniform vec3 uShadowDraw;   // the camera, relative to the centre of the cascade being drawn
uniform vec2 uShadowPass;   // its half-width and half-depth
vec4 shadowProject(vec3 v) {
  vec3 q = v + uShadowDraw;
  return vec4(dot(q, uShadowX) / uShadowPass.x, dot(q, uShadowY) / uShadowPass.x, -dot(q, uShadowL) / uShadowPass.y, 1.0);
}
`;

/** Cascades drawn since the page loaded, for tuning. */
export const shadowStats = { draws: 0 };

const pick = new THREE.Vector3();
const centre = new THREE.Vector3();

export class TerrainShadow {
  /** Shared with every terrain material of the planet. */
  readonly uniforms: Record<string, THREE.IUniform> = {
    uShadowMap: { value: null },
    uShadowX: { value: new THREE.Vector3(1, 0, 0) },
    uShadowY: { value: new THREE.Vector3(0, 1, 0) },
    uShadowL: { value: new THREE.Vector3(0, 0, 1) },
    uShadowShift: { value: [new THREE.Vector3(), new THREE.Vector3()] },
    uShadowBox: { value: new THREE.Vector4(1, 1, 1, 1) },
    uShadowOn: { value: 0 },
    uShadowDraw: { value: new THREE.Vector3() },
    uShadowPass: { value: new THREE.Vector2(1, 1) },
  };
  /** Holds the depth-pass twins of the terrain patches. */
  readonly scene = new THREE.Scene();
  /** Terrain this close to the camera (planet radii) can shade what is on screen even from behind it. */
  reach = 0;
  private readonly camera = new THREE.Camera();
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly drawnFrom = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly width = [0, 0];
  private readonly stale = [0, 0];

  /**
   * cam / sun: camera position (planet radii) and direction to the star, in the planet's rotating frame.
   * altitude: camera height above the ground, planet radii. changed: the set of patches is not last frame's.
   */
  update(cam: THREE.Vector3, sun: THREE.Vector3, altitude: number, changed: boolean): void {
    const u = this.uniforms;
    // From orbit the relief is too small to cast anything a pixel could show.
    const on = 1 - THREE.MathUtils.smoothstep(altitude, 0.04, 0.1);
    u.uShadowOn.value = on;
    const renderer = probeRenderer();
    if (on <= 0 || !renderer) {
      this.release();
      return;
    }
    if (!this.target) {
      const depth = new THREE.DepthTexture(SIZE * 2, SIZE, THREE.UnsignedIntType);
      depth.compareFunction = THREE.LessEqualCompare;
      depth.minFilter = depth.magFilter = THREE.LinearFilter;
      this.target = new THREE.WebGLRenderTarget(SIZE * 2, SIZE, { depthTexture: depth, format: THREE.RedFormat, generateMipmaps: false });
      this.target.scissorTest = true;
      u.uShadowMap.value = depth;
      this.width[0] = this.width[1] = 0;
    }

    // Widths move in steps, so hovering does not redraw the map every frame.
    const near = Math.pow(2, Math.round(Math.log2(REACH * Math.max(altitude, 1e-5)) * 2) / 2);
    const widths = [Math.min(near, 0.08), Math.min(near * WIDEN, 0.8)];
    this.reach = widths[0] * 2;

    const L = u.uShadowL.value as THREE.Vector3;
    const X = u.uShadowX.value as THREE.Vector3;
    const Y = u.uShadowY.value as THREE.Vector3;
    const turned = L.dot(sun) < 1 - 2e-7;
    if (turned) {
      L.copy(sun).normalize();
      pick.set(0, 1, 0);
      if (Math.abs(L.y) > 0.9) pick.set(1, 0, 0);
      X.crossVectors(pick, L).normalize();
      Y.crossVectors(L, X);
    }

    const previous = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    let drew = false;
    for (let i = 0; i < 2; i++) {
      const from = this.drawnFrom[i];
      const w = widths[i];
      this.stale[i] += changed ? 1 : 0;
      // The sharp cascade follows every change of the mesh; the wide one can lag a little.
      const redraw = turned || w !== this.width[i] || cam.distanceTo(from) > 0.1 * w
        || (this.stale[i] > 0 && (i === 0 || this.stale[i] > 20));
      if (redraw) {
        // Centre on the camera, snapped to whole texels so shadow edges do not crawl as it moves.
        const texel = (2 * w) / SIZE;
        const x = Math.round(cam.dot(X) / texel) * texel, y = Math.round(cam.dot(Y) / texel) * texel;
        from.copy(L).multiplyScalar(cam.dot(L)).addScaledVector(X, x).addScaledVector(Y, y);
        this.width[i] = w;
        this.stale[i] = 0;
        const depth = w * 4;
        (u.uShadowBox.value as THREE.Vector4).setComponent(i * 2, w).setComponent(i * 2 + 1, depth);
        (u.uShadowDraw.value as THREE.Vector3).subVectors(cam, from);
        (u.uShadowPass.value as THREE.Vector2).set(w, depth);
        this.target.viewport.set(i * SIZE, 0, SIZE, SIZE);
        this.target.scissor.set(i * SIZE, 0, SIZE, SIZE);
        renderer.setRenderTarget(this.target);
        renderer.autoClear = false;
        renderer.clear(false, true, false);
        renderer.render(this.scene, this.camera);
        drew = true;
        shadowStats.draws++;
      }
      (u.uShadowShift.value as THREE.Vector3[])[i].copy(centre.subVectors(cam, from));
    }
    if (drew) {
      renderer.setRenderTarget(previous);
      renderer.autoClear = autoClear;
    }
  }

  private release(): void {
    if (!this.target) return;
    this.target.depthTexture?.dispose();
    this.target.dispose();
    this.target = null;
    this.uniforms.uShadowMap.value = null;
    this.reach = 0;
  }

  dispose(): void {
    this.release();
  }
}
