import * as THREE from 'three';
import { Rng } from '../core/rng';

/** Faint smudges of the galaxies beyond the catalogued universe, infinitely far away: they turn with the camera but never move. */
export function makeDeepField(pixelRatio: number): THREE.Points {
  const rng = new Rng(9001);
  const n = 2600;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const size = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = rng.range(-1, 1), ph = rng.range(0, Math.PI * 2), s = Math.sqrt(1 - u * u);
    pos.set([s * Math.cos(ph) * 1e7, u * 1e7, s * Math.sin(ph) * 1e7], i * 3);
    const warm = rng.next();
    const b = Math.pow(rng.next(), 4) * 0.16 + 0.015;
    col.set([b * (0.8 + 0.2 * warm), b * 0.8, b * (1.0 - 0.3 * warm)], i * 3);
    size[i] = 1.5 + Math.pow(rng.next(), 3) * 3.5;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { uPixelRatio: { value: pixelRatio } },
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aSize;
      uniform float uPixelRatio;
      varying vec3 vColor;
      void main() {
        vColor = aColor;
        gl_PointSize = aSize * uPixelRatio;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float a = exp(-dot(p, p) * 4.0) - 0.018;
        if (a <= 0.0) discard;
        gl_FragColor = vec4(vColor * a, 1.0);
      }`,
    blending: THREE.AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
  });
  const points = new THREE.Points(g, m);
  points.frustumCulled = false;
  points.renderOrder = -5;
  return points;
}
