import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { LensPass } from './lensPass';

/** Objects on this layer of the background scene are diffuse glows, drawn at reduced resolution. */
export const SOFT_LAYER = 1;
/** Resolution of the soft layer relative to the main target; point sprites on it scale their sizes by this. */
export const softLayer = { scale: 0.5 };
/**
 * Objects on this layer of the main scene are drawn at half resolution into halfLayer.target before the main
 * pass, for glows marched per pixel (the aurora); their meshes in the main pass sample that target.
 */
export const HALF_LAYER = 2;
export const halfLayer = {
  target: new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false }),
  /** 1 / the main target's size, in pixels: gl_FragCoord.xy * invFull is the target's uv. */
  invFull: new THREE.Vector2(1, 1),
  /** Whether anything on the layer is to be drawn this frame (set by its owners each frame). */
  wanted: false,
};
/** Soft layer pixels per CSS pixel. */
const SOFT_RES = 0.75;
/** The most pixels the main target gets, whatever the window and display. */
const MAX_PIXELS = 4.6e6;

const SOFT_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
const BG_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
// The background enters the frame here: anything not finite in it (one NaN would be spread over the whole
// frame by the bloom, as a flat white or coloured frame) is clamped away. (min/max rather than isnan,
// which fast-math compilers may drop; Metal's fmin/fmax return the number when the other operand is NaN.)
const BG_FRAG = /* glsl */ `
uniform sampler2D tSoft;
varying vec2 vUv;
void main() {
  gl_FragColor = max(min(texture2D(tSoft, vUv), vec4(6e4)), vec4(0.0));
}
`;
const SOFT_FRAG = /* glsl */ `
uniform sampler2D tSoft;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(tSoft, vUv);
}
`;

// Light meter: a thumbnail of the HDR frame with log2 luminance packed into 8 bits (2^-12 .. 2^8).
const METER_W = 48, METER_H = 27;
/** Mean light of the frame the dark-adapted eye brings up to (linear): a faint Milky Way about 25 / 255 grey. */
const DARK_SKY = 0.033;
/** How far the eye dark-adapts in open space or on a night side (the band at exposure 1 is ~0.0014). */
export const DARK_ADAPTED = 16;
const METER_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec3 c = vec3(0.0);
  for (int j = 0; j < 4; j++)
  for (int i = 0; i < 4; i++) {
    // (Clamped: a star's glare in view would otherwise pull the exposure down and leave the scene dim.)
    c += min(texture2D(tScene, vUv + (vec2(float(i), float(j)) - 1.5) * uTexel).rgb, vec3(3.0));
  }
  float lum = dot(c / 16.0, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor = vec4(vec3(clamp((log2(max(lum, 1e-6)) + 12.0) / 20.0, 0.0, 1.0)), 1.0);
}
`;

/**
 * Two scenes share one HDR target:
 *   background — galaxy and stars, in light years, never depth-tested;
 *   foreground — the current star system, in km, with a logarithmic depth buffer
 *                so a 1 m near plane and a multi-light-year far plane coexist.
 * The camera always sits at the origin of both; the world moves around it.
 */
export class Pipeline {
  readonly renderer: THREE.WebGLRenderer;
  readonly bgScene = new THREE.Scene();
  readonly scene = new THREE.Scene();
  readonly bgCamera = new THREE.PerspectiveCamera(60, 1, 0.01, 1e9);
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.001, 1e16);
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  readonly lens: LensPass;
  /** The buffer holding the frame as shown (before tone mapping), for the light meter. */
  private shown!: THREE.WebGLRenderTarget;
  // The galaxy's glow is hundreds of thousands of overlapping sprites; blending them at
  // full multisampled resolution costs more than everything else in the frame.
  /** Eye adaptation: exposure follows the brightness of what is on screen. */
  autoExposure = true;
  /** How far adaptation may brighten the frame: above 1 only where there is a landscape to see in the dark. */
  maxExposure = 1;
  /**
   * A nebula around the camera: its light is too faint for the meter to read as a lit scene, and the mean of the
   * frame it gives would leave it a dim haze. The dark adaptation goes at least this far (set by the nebulae; 1: none).
   */
  darkAdapt = 1;
  /** How far adaptation may darken it: below 0.6 only for what is far brighter than any star's surface (an accretion disc). */
  minExposure = 0.6;
  exposure = 1;
  /** How much of the sky's light is lost to a dazzling star in view, 0..1: eyes and cameras stop down for it. */
  skyDim = 0;
  /** How much of the frame is in daylight, 0..1 (from the light meter). */
  daylight = 0;
  private readonly dimMat = new THREE.MeshBasicMaterial({ color: 0, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
  private readonly meterTarget = new THREE.WebGLRenderTarget(METER_W, METER_H, { depthBuffer: false });
  private readonly meter = new FullScreenQuad(new THREE.ShaderMaterial({
    vertexShader: SOFT_VERT, fragmentShader: METER_FRAG,
    uniforms: { tScene: { value: null }, uTexel: { value: new THREE.Vector2(1 / (METER_W * 4), 1 / (METER_H * 4)) } },
    depthTest: false, depthWrite: false,
  }));
  private readonly meterPixels = new Uint8Array(METER_W * METER_H * 4);
  private meterBusy = false;
  private meterSince = 0;
  private meterRead = 0;
  private exposureGoal = 1;
  private frameCount = 0;
  private lastFrame = 0;
  private frameMs = 16;
  // Dynamic resolution: the fraction of the display's pixel ratio actually rendered.
  private baseRatio = 1;
  private resScale = 1;
  private resCheck = 0;
  private fastSince = 0;
  private upDelay = 3000;
  private lastUp = -1e9;
  private readonly softTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  // The background has no edges to smooth, so it is drawn without multisampling and copied in as the
  // first thing in the main pass: one multisampled pass (and one resolve) per frame instead of two.
  private readonly bgTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  private readonly bgQuad: THREE.Mesh;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(this.baseRatio);
    // Nearest first, so terrain hidden behind nearer terrain is never shaded.
    this.renderer.setOpaqueSort((a, b) => a.groupOrder - b.groupOrder || a.renderOrder - b.renderOrder || a.z - b.z || a.id - b.id);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    // Nothing after the main pass reads depth: resolving it would only cost bandwidth.
    target.resolveDepthBuffer = false;
    this.composer = new EffectComposer(this.renderer, target);
    const main = new RenderPass(this.scene, this.camera);
    this.composer.addPass(main);
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.bgQuad = new THREE.Mesh(tri, new THREE.ShaderMaterial({
      vertexShader: BG_VERT, fragmentShader: BG_FRAG, uniforms: { tSoft: { value: this.bgTarget.texture } },
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    }));
    this.bgQuad.frustumCulled = false;
    // First of the opaque objects, under everything.
    this.bgQuad.renderOrder = -1e9;
    this.scene.add(this.bgQuad);
    // Gravitational lensing by black holes in view (lensPass.ts); disabled, and free, when there are none.
    this.lens = new LensPass(this.bgScene);
    this.composer.addPass(this.lens);
    // The lens writes the whole frame once more: into a single-sampled buffer (its rays have no edges for
    // multisampling to smooth; a 4x target would cost four times the bandwidth plus a resolve). After each frame
    // the buffers are put back so that the main pass always draws into the multisampled one.
    this.composer.renderTarget2.dispose();
    this.composer.renderTarget2 = this.composer.writeBuffer = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.composer.readBuffer = this.composer.renderTarget1;
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.45, 0.6, 1.7);
    this.composer.addPass(this.bloom);
    // After bloom: the shadows of black holes darkened again, so the glow of their discs does not fill them.
    this.composer.addPass(this.lens.mask);
    this.composer.addPass(new OutputPass());

    const softQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      vertexShader: SOFT_VERT, fragmentShader: SOFT_FRAG, uniforms: { tSoft: { value: this.softTarget.texture } },
      transparent: true, premultipliedAlpha: true, depthTest: false, depthWrite: false,
    }));
    softQuad.frustumCulled = false;
    // Over the distant galaxies, under the stars.
    softQuad.renderOrder = -3.5;
    this.bgScene.add(softQuad);
    // A black veil over the whole background, as wide as any field of view.
    const dim = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), this.dimMat);
    this.dimMat.side = THREE.BackSide;
    dim.frustumCulled = false;
    dim.renderOrder = 1e3;
    this.bgScene.add(dim);

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  /** Rendered pixels per CSS pixel (drops below the display's ratio when frames get slow). */
  get pixelRatio(): number {
    return this.baseRatio * this.resScale;
  }

  /** Device pixels per radian at the centre of the view. */
  get pixelsPerRadian(): number {
    const h = this.canvas.clientHeight * this.pixelRatio;
    return h / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // A large window on a dense display has more pixels than the frame can afford to shade.
    this.baseRatio = Math.min(window.devicePixelRatio, 2, Math.sqrt(MAX_PIXELS / (w * h)));
    this.renderer.setPixelRatio(this.baseRatio);
    this.renderer.setSize(w, h, false);
    this.applyScale();
    for (const cam of [this.camera, this.bgCamera]) {
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    }
  }

  private applyScale(): void {
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(window.innerWidth, window.innerHeight);
    this.bgTarget.setSize(this.composer.renderTarget1.width, this.composer.renderTarget1.height);
    halfLayer.target.setSize(Math.ceil(this.composer.renderTarget1.width / 2), Math.ceil(this.composer.renderTarget1.height / 2));
    halfLayer.invFull.set(1 / this.composer.renderTarget1.width, 1 / this.composer.renderTarget1.height);
    // The soft layer is where a galaxy that fills the view is marched: when frames run long it gives way first.
    const soft = Math.min(this.pixelRatio, Math.max(SOFT_RES * this.resScale, 0.45));
    this.softTarget.setSize(Math.ceil(window.innerWidth * soft), Math.ceil(window.innerHeight * soft));
    softLayer.scale = soft / this.pixelRatio;
  }

  /** Trade resolution for frame rate: step down when frames run long, creep back up when there is headroom. */
  private adaptResolution(now: number): void {
    const dt = now - this.lastFrame;
    this.lastFrame = now;
    if (dt <= 0 || dt > 250) return;
    this.frameMs += (dt - this.frameMs) * 0.1;
    if (this.frameMs > 17.6) this.fastSince = now;
    if (now - this.resCheck < 500) return;
    this.resCheck = now;
    const floor = 0.8 / this.baseRatio;
    if (this.frameMs > 21 && this.resScale > floor) {
      // Dropping right after a step up means that step was too much: wait longer before trying again.
      if (now - this.lastUp < 2500) this.upDelay = Math.min(this.upDelay * 2, 16000);
      this.resScale = Math.max(this.resScale * (this.frameMs > 30 ? 0.7 : 0.84), floor);
    } else if (this.resScale < 1 && now - this.fastSince > this.upDelay) {
      this.resScale = Math.min(this.resScale * 1.19, 1);
      this.lastUp = now;
      // A step up that holds earns back some patience: a slow moment long ago (a heavy view since left)
      // must not keep the resolution down for good.
      this.upDelay = Math.max(this.upDelay / 2, 3000);
    } else {
      return;
    }
    this.fastSince = now;
    this.frameMs = 16;
    this.applyScale();
  }

  private meterExposure(dt: number): void {
    if (!this.autoExposure) {
      this.exposureGoal = 1;
    } else if (this.frameCount % 6 === 0 && (!this.meterBusy || performance.now() - this.meterSince > 500)) {
      // (A read the GPU never answers would otherwise freeze the exposure for good: after half a second, ask again.)
      const read = ++this.meterRead;
      this.meterSince = performance.now();
      const mat = this.meter.material as THREE.ShaderMaterial;
      mat.uniforms.tScene.value = this.shown.texture;
      this.renderer.setRenderTarget(this.meterTarget);
      this.meter.render(this.renderer);
      this.renderer.setRenderTarget(null);
      this.meterBusy = true;
      this.renderer.readRenderTargetPixelsAsync(this.meterTarget, 0, 0, METER_W, METER_H, this.meterPixels).then(() => {
        if (read !== this.meterRead) return;
        this.meterBusy = false;
        // Average the lit part of the frame in stops; black space and the faint glow of galaxies say nothing about how bright the scene is.
        let sum = 0, lit = 0, all = 0, peak = -12;
        for (let i = 0; i < METER_W * METER_H; i++) {
          const stops = (this.meterPixels[i * 4] / 255) * 20 - 12;
          if (stops > -4.5) { sum += stops; lit++; }
          all += Math.pow(2, stops);
          peak = Math.max(peak, stops);
        }
        const coverage = lit / (METER_W * METER_H);
        this.daylight = lit > 0 ? THREE.MathUtils.smoothstep(coverage, 0.04, 0.3) * THREE.MathUtils.smoothstep(sum / lit, -3.2, -1.2) : 0;
        // With nothing lit in view the eye dark-adapts, as far as maxExposure, until the faint light there is
        // (the glow of the galaxy) reads as a dim sky: a subtle band of light, not a glare, in the core of a disc too.
        // (Never so far that the frame as a whole, the Milky Way behind the nebula too, becomes a glare; further
        // when nothing in view is lit at all, as among the faint filaments of a supernova remnant.)
        const mean = all / (METER_W * METER_H);
        const dark = Math.max(THREE.MathUtils.clamp(DARK_SKY / mean, 1, Math.max(this.maxExposure, 1)), Math.min(this.darkAdapt, Math.max(1, (lit > 0 ? 0.03 : 0.08) / mean)));
        const wanted = lit > 0 ? THREE.MathUtils.clamp(0.19 / Math.pow(2, sum / lit), this.minExposure, Math.max(this.maxExposure, this.darkAdapt)) : dark;
        let goal = THREE.MathUtils.lerp(dark, wanted, THREE.MathUtils.smoothstep(coverage, 0.03, 0.4));
        // A sun in view, however small, stops the eye down at once: the dark adaptation is gone.
        goal = THREE.MathUtils.lerp(goal, Math.min(goal, 1), THREE.MathUtils.smoothstep(peak, 0, 5));
        this.exposureGoal = goal;
      }, () => { this.meterBusy = false; });
    }
    this.exposure += (this.exposureGoal - this.exposure) * (1 - Math.exp(-dt / 0.7));
    this.renderer.toneMappingExposure = this.exposure;
  }

  setView(quat: THREE.Quaternion, fov: number): void {
    for (const cam of [this.camera, this.bgCamera]) {
      cam.quaternion.copy(quat);
      if (Math.abs(cam.fov - fov) > 0.01) {
        cam.fov = fov;
        cam.updateProjectionMatrix();
      }
    }
  }

  render(): void {
    const now = performance.now();
    const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
    this.adaptResolution(now);
    this.frameCount++;
    this.bgCamera.layers.set(SOFT_LAYER);
    this.renderer.setRenderTarget(this.softTarget);
    this.renderer.setClearAlpha(0);
    this.renderer.render(this.bgScene, this.bgCamera);
    this.renderer.setClearAlpha(1);
    this.renderer.setRenderTarget(null);
    this.bgCamera.layers.set(0);
    this.dimMat.opacity = this.skyDim;
    this.dimMat.visible = this.skyDim > 0.002;
    if (halfLayer.wanted) {
      this.camera.layers.set(HALF_LAYER);
      this.renderer.setRenderTarget(halfLayer.target);
      this.renderer.setClearColor(0, 0);
      this.renderer.clear(true, false, false);
      this.renderer.render(this.scene, this.camera);
      this.camera.layers.set(0);
      this.renderer.setClearAlpha(1);
      halfLayer.wanted = false;
    }
    this.renderer.setRenderTarget(this.bgTarget);
    this.renderer.render(this.bgScene, this.bgCamera);
    // (The composer puts back whatever target was bound when it started.)
    this.renderer.setRenderTarget(null);
    this.composer.render();
    // (The output pass swaps after reading: what it showed is now the write buffer.)
    this.shown = this.composer.writeBuffer;
    if (this.composer.readBuffer !== this.composer.renderTarget1) this.composer.swapBuffers();
    this.meterExposure(dt);
  }
}
