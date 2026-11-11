import * as THREE from 'three';
import { PLANET_FRAG, TERRAIN_VERT } from './planetShader';
import { PLANET_FRAG_MAIN } from './planetShaderMain';

const GRID = 32;
const MAX_LEVEL = 18;
/** A patch splits once the camera is closer than this many patch widths. */
const SPLIT = 2.2;
/** Must match FINE_FREQ and the pnoise period in the shaders. */
export const FINE_FREQ = 131072;
export const FINE_PERIOD = 256;

export function fineCoord(v: number): number {
  const m = (v * FINE_FREQ) % FINE_PERIOD;
  return m < 0 ? m + FINE_PERIOD : m;
}

// Cube faces as [normal, U, V] with U x V = normal, so patch triangles wind outwards.
const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
const neg = (a: number[]) => a.map((v) => -v);
const FACES = [[X, Y, Z], [neg(X), Z, Y], [Y, Z, X], [neg(Y), X, Z], [Z, X, Y], [neg(Z), Y, X]];

let patchGeometry: THREE.BufferGeometry | null = null;

/** A GRID x GRID sheet over [-1, 1]² plus a border ring that the shader folds down into a skirt (z = 1). */
function makePatchGeometry(): THREE.BufferGeometry {
  const n = GRID + 3;
  const pos = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = THREE.MathUtils.clamp((i - 1) / GRID, 0, 1) * 2 - 1;
      const v = THREE.MathUtils.clamp((j - 1) / GRID, 0, 1) * 2 - 1;
      const skirt = i === 0 || j === 0 || i === n - 1 || j === n - 1 ? 1 : 0;
      pos.set([u, v, skirt], (j * n + i) * 3);
    }
  }
  const index: number[] = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      index.push(a, b, d, a, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(index);
  return g;
}

const DEPTH_ONLY_FRAG = /* glsl */ `
void main() {
  gl_FragColor = vec4(1.0);
}
`;

interface Patch {
  mesh: THREE.Mesh;
  /** The same sheet as the sun sees it, drawn into the shadow map. */
  shadow: THREE.Mesh;
  uniforms: Record<string, THREE.IUniform>;
  /** Unit vector to the patch centre. */
  nx: number; ny: number; nz: number;
}

/**
 * Quadtree level-of-detail terrain on a cube-sphere. Every leaf is the same small
 * grid, displaced on the GPU; leaves get smaller as the camera gets closer, from
 * six for a distant planet down to a few metres per vertex at ground level.
 */
export class Terrain {
  readonly group = new THREE.Group();
  /** Depth-pass twins of the patches, for the shadow map's own scene. */
  readonly shadowGroup = new THREE.Group();
  /** Leaves drawn last frame, for the HUD and for tuning. */
  patchCount = 0;
  /** Whether the last update added or dropped a leaf. */
  changed = false;
  /** Leaves outside the view that are kept only for the shadows they cast into it. */
  private readonly unseen = new Set<number>();
  private shadowReach = 0;
  private readonly active = new Map<number, Patch>();
  private readonly pool: Patch[] = [];
  private readonly wanted: number[] = [];
  private readonly wantedSet = new Set<number>();

  // Per-update camera state, in planet radii and the planet's rotating frame.
  private cx = 0; private cy = 0; private cz = 0;
  private fx = 0; private fy = 0; private fz = -1;
  private camLen = 1;
  private horizon = 0;
  private halfAngle = 1;
  private ground = 0;

  constructor(
    private readonly radius: number,
    private readonly shared: Record<string, THREE.IUniform>,
    private readonly maxHeight: number,
  ) {
    patchGeometry ??= makePatchGeometry();
  }

  /**
   * cam: camera position; forward: view direction (both in the planet's rotating frame, cam in radii).
   * halfAngle: half of the diagonal field of view. ground: terrain height under the camera, radii.
   * shadowReach: terrain within this distance (radii) is kept even off screen, to cast shadows.
   */
  update(cam: THREE.Vector3, forward: THREE.Vector3, halfAngle: number, ground: number, shadowReach = 0): void {
    this.cx = cam.x; this.cy = cam.y; this.cz = cam.z;
    this.fx = forward.x; this.fy = forward.y; this.fz = forward.z;
    this.camLen = Math.max(cam.length(), 1e-9);
    this.horizon = Math.acos(Math.min(1 / this.camLen, 1)) + Math.acos(1 / (1 + this.maxHeight));
    this.halfAngle = halfAngle;
    this.ground = ground;
    this.shadowReach = shadowReach;

    this.wanted.length = 0;
    this.wantedSet.clear();
    this.unseen.clear();
    this.changed = false;
    for (let f = 0; f < 6; f++) this.visit(f, 0, 0, 0, false);

    for (const [key, patch] of this.active) {
      if (this.wantedSet.has(key)) continue;
      patch.mesh.visible = false;
      patch.shadow.visible = false;
      this.pool.push(patch);
      this.active.delete(key);
      this.changed = true;
    }
    for (const key of this.wanted) {
      const patch = this.active.get(key) ?? this.acquire(key);
      patch.uniforms.uView.value.set(patch.nx - this.cx, patch.ny - this.cy, patch.nz - this.cz);
      patch.mesh.visible = !this.unseen.has(key);
    }
    this.patchCount = this.wanted.length - this.unseen.size;
  }

  private visit(face: number, level: number, x: number, y: number, unseen: boolean): void {
    const [N, U, V] = FACES[face];
    const s = 1 / (1 << level);
    const u = (2 * x + 1) * s - 1, v = (2 * y + 1) * s - 1;
    const px = N[0] + u * U[0] + v * V[0], py = N[1] + u * U[1] + v * V[1], pz = N[2] + u * U[2] + v * V[2];
    const len = Math.hypot(px, py, pz);
    const nx = px / len, ny = py / len, nz = pz / len;
    // Radius of the patch's bounding cap, as an angle from the planet centre.
    const ang = Math.atan((s * 1.4143) / len) * 1.05;

    // Below the horizon?
    const theta = Math.acos(THREE.MathUtils.clamp((nx * this.cx + ny * this.cy + nz * this.cz) / this.camLen, -1, 1));
    if (theta - ang > this.horizon) return;

    const k = 1 + this.ground;
    const dx = nx * k - this.cx, dy = ny * k - this.cy, dz = nz * k - this.cz;
    const dist = Math.hypot(dx, dy, dz);
    const bound = ang + this.maxHeight;
    // Outside the view cone?
    if (!unseen && level >= 2 && dist > bound) {
      const off = Math.acos(THREE.MathUtils.clamp((dx * this.fx + dy * this.fy + dz * this.fz) / dist, -1, 1));
      if (off - Math.asin(bound / dist) > this.halfAngle) unseen = true;
    }
    // Off screen it only matters as a shadow caster, and only from nearby.
    if (unseen && dist - ang > this.shadowReach) return;

    const width = (2 * s) / len;
    // Casters nobody looks at get by with half the resolution.
    if (level < MAX_LEVEL && Math.max(dist - ang, 0) < (unseen ? 0.5 : 1) * SPLIT * width) {
      const x2 = x * 2, y2 = y * 2;
      this.visit(face, level + 1, x2, y2, unseen);
      this.visit(face, level + 1, x2 + 1, y2, unseen);
      this.visit(face, level + 1, x2, y2 + 1, unseen);
      this.visit(face, level + 1, x2 + 1, y2 + 1, unseen);
      return;
    }
    const key = ((face * 32 + level) * 1048576 + x) * 1048576 + y;
    this.wanted.push(key);
    this.wantedSet.add(key);
    if (unseen) this.unseen.add(key);
  }

  private acquire(key: number): Patch {
    const y = key % 1048576;
    const rest = Math.floor(key / 1048576);
    const x = rest % 1048576;
    const fl = Math.floor(rest / 1048576);
    const level = fl % 32, face = Math.floor(fl / 32);
    const [N, U, V] = FACES[face];
    const s = 1 / (1 << level);
    const u = (2 * x + 1) * s - 1, v = (2 * y + 1) * s - 1;

    const patch = this.pool.pop() ?? this.create();
    const un = patch.uniforms;
    const c = un.uCubeCenter.value as THREE.Vector3;
    c.set(N[0] + u * U[0] + v * V[0], N[1] + u * U[1] + v * V[1], N[2] + u * U[2] + v * V[2]);
    (un.uCubeU.value as THREE.Vector3).set(U[0] * s, U[1] * s, U[2] * s);
    (un.uCubeV.value as THREE.Vector3).set(V[0] * s, V[1] * s, V[2] * s);
    const len = c.length();
    un.uPatchDetail.value = (16 * len) / s;
    un.uSkirt.value = ((2 * s) / len) * 0.12;
    patch.nx = c.x / len; patch.ny = c.y / len; patch.nz = c.z / len;
    (un.uFineOrigin.value as THREE.Vector3).set(fineCoord(patch.nx), fineCoord(patch.ny), fineCoord(patch.nz));
    // The mesh origin is the patch centre: three combines it with the camera in doubles,
    // so vertices only ever carry small offsets and stay steady at ground level.
    patch.mesh.position.set(patch.nx * this.radius, patch.ny * this.radius, patch.nz * this.radius);
    patch.mesh.visible = true;
    patch.shadow.visible = true;
    this.active.set(key, patch);
    this.changed = true;
    return patch;
  }

  private create(): Patch {
    const uniforms: Record<string, THREE.IUniform> = {
      ...this.shared,
      uCubeCenter: { value: new THREE.Vector3() },
      uCubeU: { value: new THREE.Vector3() },
      uCubeV: { value: new THREE.Vector3() },
      uRadius: { value: this.radius },
      uPatchDetail: { value: 1 },
      uSkirt: { value: 0 },
      uView: { value: new THREE.Vector3() },
      uFineOrigin: { value: new THREE.Vector3() },
    };
    const material = new THREE.ShaderMaterial({
      vertexShader: TERRAIN_VERT,
      fragmentShader: PLANET_FRAG + PLANET_FRAG_MAIN,
      uniforms,
      defines: { VERTEX_LOGDEPTH: 1, TERRAIN_SHADOW: 1 },
    });
    const mesh = new THREE.Mesh(patchGeometry!, material);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    const depthOnly = new THREE.ShaderMaterial({
      vertexShader: TERRAIN_VERT,
      fragmentShader: DEPTH_ONLY_FRAG,
      uniforms,
      defines: { SHADOW: 1 },
      colorWrite: false,
      side: THREE.DoubleSide,
    });
    const shadow = new THREE.Mesh(patchGeometry!, depthOnly);
    shadow.frustumCulled = false;
    this.shadowGroup.add(shadow);
    return { mesh, shadow, uniforms, nx: 0, ny: 0, nz: 1 };
  }

  dispose(): void {
    for (const p of [...this.active.values(), ...this.pool]) {
      (p.mesh.material as THREE.Material).dispose();
      (p.shadow.material as THREE.Material).dispose();
    }
  }
}
