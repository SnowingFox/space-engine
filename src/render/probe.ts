import * as THREE from 'three';

// Terrain only exists on the GPU, so collision asks the GPU: one pixel is shaded
// with the height under the camera and read back.

const PROBE_VERT = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

let renderer: THREE.WebGLRenderer | null = null;
const target = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
const scene = new THREE.Scene();
const camera = new THREE.Camera();
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
quad.frustumCulled = false;
scene.add(quad);
const pixel = new Uint8Array(4);

export function initProbe(r: THREE.WebGLRenderer): void {
  renderer = r;
}

/** The renderer handed to initProbe, for other off-screen passes; null before then. */
export function probeRenderer(): THREE.WebGLRenderer | null {
  return renderer;
}

export function makeProbeMaterial(fragmentShader: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ vertexShader: PROBE_VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false });
}

/** Runs the material over every pixel of a render target. */
export function bake(material: THREE.ShaderMaterial, into: THREE.WebGLRenderTarget): boolean {
  if (!renderer) return false;
  quad.material = material;
  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(into);
  renderer.render(scene, camera);
  renderer.setRenderTarget(previous);
  return true;
}

const decode = (p: Uint8Array): number => p[0] / 255 + p[1] / 65025 + p[2] / 16581375;

/**
 * The same probe without waiting for it: a synchronous read stalls the CPU until the GPU has
 * finished everything queued before it (the whole previous frame), every frame. This one is read
 * back once the GPU gets there, a frame or so later. One read at a time.
 */
export class AsyncProbe {
  private readonly target = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
  private readonly pixel = new Uint8Array(4);
  private pending = false;

  /** A read is on its way. */
  get busy(): boolean {
    return this.pending;
  }

  /** Starts a read unless one is already on its way; done gets the decoded value. */
  start(material: THREE.ShaderMaterial, done: (v: number) => void): boolean {
    if (!renderer || this.pending) return false;
    quad.material = material;
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(previous);
    this.pending = true;
    renderer.readRenderTargetPixelsAsync(this.target, 0, 0, 1, 1, this.pixel).then(() => {
      this.pending = false;
      done(decode(this.pixel));
    }, () => { this.pending = false; });
    return true;
  }

  dispose(): void {
    this.target.dispose();
  }
}

/** Runs the material over a single pixel and decodes its packed 0..1 output; null before initProbe. */
export function probe(material: THREE.ShaderMaterial): number | null {
  if (!renderer) return null;
  quad.material = material;
  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  renderer.readRenderTargetPixels(target, 0, 0, 1, 1, pixel);
  renderer.setRenderTarget(previous);
  return decode(pixel);
}
