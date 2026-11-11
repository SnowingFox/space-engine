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

/** Runs the material over a single pixel and decodes its packed 0..1 output; null before initProbe. */
export function probe(material: THREE.ShaderMaterial): number | null {
  if (!renderer) return null;
  quad.material = material;
  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  renderer.readRenderTargetPixels(target, 0, 0, 1, 1, pixel);
  renderer.setRenderTarget(previous);
  return pixel[0] / 255 + pixel[1] / 65025 + pixel[2] / 16581375;
}
