import * as THREE from 'three';
import { bodyOrientation, spinAngle, type BodyData, type PlanetType } from '../universe/bodies';
import { ATMO_EXTINCT_FRAG, ATMO_FRAG, RING_FRAG, WORLD_VERT } from './atmosphereShader';
import { Aurora, auroraStrength } from './aurora';
import { eclipseUniforms, setEclipse, type BodyLight } from './lighting';
import { BodyMaps, noMapUniforms } from './bodyMaps';
import { PLANET_FRAG, PLANET_VERT } from './planetShader';
import { CLOUD_BAKE_FRAG, CLOUD_FRAG, PLANET_FRAG_MAIN, PROBE_FRAG, RING_MAP_FRAG } from './planetShaderMain';
import { AsyncProbe, bake, makeProbeMaterial, probe } from './probe';
import { Terrain, fineCoord } from './terrain';
import { TerrainShadow } from './terrainShadow';

const TYPE_INDEX: Record<PlanetType, number> = { terran: 0, ocean: 0, desert: 1, barren: 2, ice: 3, lava: 4, gas: 5, icegiant: 6 };

function cubeSphere(segments: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(2, 2, 2, segments, segments, segments);
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g.computeBoundingSphere();
  return g;
}

let geoHi: THREE.BufferGeometry | null = null;
let geoLo: THREE.BufferGeometry | null = null;
let geoRing: THREE.BufferGeometry | null = null;

const CLOUD_MAP_WIDTH = 4096;
let blankMap: THREE.Texture | null = null;

const qInv = new THREE.Quaternion();
const AXIS = new THREE.Vector3(0, 1, 0);
const fwd = new THREE.Vector3();
let spinFrame = 0;
// World-space vectors into the planet's turning frame, its ring frame, or left as they are (qInv: the body's tilt, undone).
const toPlanet = (v: THREE.Vector3): THREE.Vector3 => v.applyQuaternion(qInv).applyAxisAngle(AXIS, -spinFrame);
const toRing = (v: THREE.Vector3): THREE.Vector3 => v.applyQuaternion(qInv);
const toWorld = (v: THREE.Vector3): THREE.Vector3 => v;

/** Meshes for one planet or moon. Positioned camera-relative every frame. */
export class PlanetView {
  readonly group = new THREE.Group();
  /** Distance from the centre to the terrain under the camera (km); null when far away or gaseous. */
  ground: number | null = null;
  /** World-space rotation axis. */
  readonly axis = new THREE.Vector3();
  /** Where the atmosphere ends, in radii from the centre (1 without one). */
  readonly atmoTop: number;
  /** Carries everything that turns with the body. */
  private readonly spin = new THREE.Group();
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly materials: THREE.Material[] = [];
  private readonly sphere: THREE.Mesh | null = null;
  private readonly terrain: Terrain | null = null;
  private readonly probeMat: THREE.ShaderMaterial | null = null;
  private readonly atmoMat: THREE.ShaderMaterial | null = null;
  private readonly ringMat: THREE.ShaderMaterial | null = null;
  private readonly heightScale: number;
  private readonly shadow: TerrainShadow | null = null;
  private readonly aurora: Aurora | null = null;
  /** Procedural weather, painted once the planet is close enough to show it. */
  private cloudMap: THREE.WebGLRenderTarget | null = null;
  /** Real maps (Solar System bodies), loaded while the body is near. */
  private readonly maps: BodyMaps | null;
  private groundReady = false;
  /** This body's share of the star's light (the star's colour, scaled for distance). */
  private readonly sunLight = new THREE.Color(1, 1, 1);
  /** Reads the ground height without stalling the frame; the answer comes a frame or two later. */
  private readonly asyncProbe: AsyncProbe | null = null;
  /** The last answer: height (radii above the datum), where it was asked (unit vector), whether the real heights were in. */
  private probed: { height: number; dir: THREE.Vector3; maps: boolean } | null = null;
  private readonly asking = new THREE.Vector3();
  private askingMaps = false;
  private readonly answered = (v: number): void => {
    // (Dropped if the camera has left the body meanwhile.)
    if (!this.probed) return;
    this.probed.height = v * 2 * this.heightScale;
    this.probed.dir.copy(this.asking);
    this.probed.maps = this.askingMaps;
  };

  constructor(readonly body: BodyData, starColor: THREE.Color) {
    const sunColor = this.sunLight.copy(starColor);
    geoHi ??= cubeSphere(96);
    geoLo ??= cubeSphere(24);
    blankMap ??= new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    blankMap.needsUpdate = true;
    const a = body.atmosphere;
    const ring = body.rings;
    const type = TYPE_INDEX[body.type];
    const solid = type < 5;
    const polar = body.type === 'terran' || body.type === 'ocean'
      ? THREE.MathUtils.clamp((295 - body.temp) / 250 + 0.12, 0.04, 0.7)
      : body.type === 'desert' && body.temp < 260 ? 0.07 : 0;
    const cloudColor = body.clouds >= 0.99 && a
      ? new THREE.Color(1, 1, 1).lerp(new THREE.Color(...a.color), 0.55)
      : new THREE.Color(0.95, 0.96, 0.98);
    // Small worlds are lumpier: relief shrinks more slowly than radius.
    this.heightScale = solid ? 0.0042 * THREE.MathUtils.clamp(Math.pow(6371 / body.radius, 0.85), 0.7, 6) : 0;
    // An overcast deck (Venus, Titan) must clear the highest mountains, or they poke through it.
    const cloudAlt = Math.max(this.heightScale * (body.clouds >= 0.99 ? 1.2 : 0.45), 0.0015);
    // Air thins out fast: a rocky world's sky ends a few scale heights up, well inside low orbit.
    const top = this.atmoTop = 1 + (a?.height ?? 0) * (solid ? 0.55 : 1);

    this.uniforms = {
      uType: { value: type },
      uPal: { value: body.palette.map((c) => new THREE.Vector3(...c)) },
      // Kept small: float32 noise coordinates lose their fine detail far from the origin.
      uSeed: { value: ((body.seed * 0.6180339) % 1) * 3 },
      uSea: { value: body.seaLevel },
      uClouds: { value: body.clouds },
      uCloudColor: { value: cloudColor },
      uCloudAlt: { value: cloudAlt },
      uCloudMap: { value: blankMap },
      uCloudRot: { value: new THREE.Vector2(1, 0) },
      uTime: { value: 0 },
      uPolar: { value: polar },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uSunColor: { value: sunColor },
      uCamObj: { value: new THREE.Vector3(0, 0, 5) },
      uAtmoColor: { value: new THREE.Vector3(...(a?.color ?? [0, 0, 0])) },
      uAtmoDensity: { value: a?.density ?? 0 },
      uAtmoTop: { value: top },
      uRing: { value: new THREE.Vector4(ring?.inner ?? 0, ring?.outer ?? 1, ring?.seed ?? 0, ring ? 1 : 0) },
      uRingNormal: { value: new THREE.Vector3(0, 1, 0) },
      uHeightScale: { value: this.heightScale },
      ...eclipseUniforms(),
      // What lights the night side: the brightest neighbour, and the sunlit face of the rings.
      uShineDir: { value: new THREE.Vector3(0, 1, 0) },
      uShine: { value: new THREE.Color(0, 0, 0) },
      uRingShine: { value: new THREE.Color(0, 0, 0) },
    };
    this.maps = BodyMaps.for(body);
    Object.assign(this.uniforms, this.maps?.uniforms ?? noMapUniforms());
    let maxHeight = this.heightScale * 1.05;
    if (this.maps?.hasHeight && solid) {
      // Real relief in terrain units: the datum is sea level on Earth, the lowest point elsewhere.
      const unitsPerKm = 1 / (body.radius * this.heightScale);
      this.maps.setHeightScale(unitsPerKm, type === 0 ? 0 : this.maps.minKm);
      maxHeight = Math.max(maxHeight, (this.maps.reliefKm * unitsPerKm + 0.15) * this.heightScale);
    }
    if (this.maps?.hasClouds) {
      this.maps.onClouds = (map) => { this.uniforms.uCloudMap.value = map ?? blankMap; };
    }
    this.group.add(this.spin);

    if (solid) {
      this.shadow = new TerrainShadow();
      Object.assign(this.uniforms, this.shadow.uniforms);
      this.terrain = new Terrain(body.radius, this.uniforms, maxHeight);
      this.spin.add(this.terrain.group);
      this.shadow.scene.add(this.terrain.shadowGroup);
      this.probeMat = makeProbeMaterial(PROBE_FRAG, {
        ...this.uniforms, uProbeDir: { value: new THREE.Vector3(0, 1, 0) }, uProbeFine: { value: new THREE.Vector3() },
      });
      this.materials.push(this.probeMat);
      this.asyncProbe = new AsyncProbe();
    } else {
      const mat = new THREE.ShaderMaterial({
        vertexShader: PLANET_VERT, fragmentShader: PLANET_FRAG + PLANET_FRAG_MAIN, uniforms: this.uniforms,
      });
      this.materials.push(mat);
      this.sphere = new THREE.Mesh(geoHi, mat);
      this.sphere.scale.setScalar(body.radius);
      this.spin.add(this.sphere);
    }

    if (solid && body.clouds > 0) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: PLANET_VERT, fragmentShader: CLOUD_FRAG, uniforms: this.uniforms,
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
      });
      this.materials.push(mat);
      const clouds = new THREE.Mesh(geoHi, mat);
      clouds.scale.setScalar(body.radius * (1 + cloudAlt));
      clouds.frustumCulled = false;
      clouds.renderOrder = 2;
      this.spin.add(clouds);
    }

    if (a) {
      // Only the far side of the shell is drawn, so the sky sits behind everything
      // solid; surfaces add the haze in front of themselves in their own shaders.
      this.atmoMat = new THREE.ShaderMaterial({
        vertexShader: WORLD_VERT,
        fragmentShader: ATMO_FRAG,
        transparent: true,
        premultipliedAlpha: true,
        depthWrite: false,
        side: THREE.BackSide,
        uniforms: {
          uCenter: { value: new THREE.Vector3() },
          uRadius: { value: body.radius },
          uTop: { value: top },
          uSunDir: { value: new THREE.Vector3(1, 0, 0) },
          uSunColor: { value: sunColor },
          uColor: { value: new THREE.Vector3(...a.color) },
          uDensity: { value: a.density },
          // Oxygen glows at night; worlds without free oxygen stay dark.
          uAirglow: { value: body.type === 'terran' || body.type === 'ocean' ? 1 : 0 },
          uGiant: { value: solid ? 0 : 1 },
          uShineDir: { value: new THREE.Vector3(0, 1, 0) },
          uShine: { value: new THREE.Color(0, 0, 0) },
          uEcliptic: { value: new THREE.Vector3(0, 1, 0) },
          ...eclipseUniforms(),
        },
      });
      this.materials.push(this.atmoMat);
      const atmo = new THREE.Mesh(geoLo, this.atmoMat);
      atmo.scale.setScalar(body.radius * top * 1.02);
      atmo.frustumCulled = false;
      atmo.renderOrder = 1;
      this.group.add(atmo);
      const u = this.atmoMat.uniforms;
      const extinct = new THREE.ShaderMaterial({
        vertexShader: WORLD_VERT,
        fragmentShader: ATMO_EXTINCT_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.BackSide,
        blending: THREE.CustomBlending,
        blendSrc: THREE.ZeroFactor,
        blendDst: THREE.SrcColorFactor,
        uniforms: { uCenter: u.uCenter, uRadius: u.uRadius, uTop: u.uTop, uColor: u.uColor, uDensity: u.uDensity },
      });
      this.materials.push(extinct);
      const veil = new THREE.Mesh(geoLo, extinct);
      veil.scale.copy(atmo.scale);
      veil.frustumCulled = false;
      veil.renderOrder = 0.9;
      this.group.add(veil);
    }

    const lights = auroraStrength(body);
    if (lights > 0) {
      this.aurora = new Aurora(body, geoLo, lights);
      this.group.add(this.aurora.mesh);
    }

    if (ring) {
      geoRing ??= new THREE.RingGeometry(1, 2, 192, 1).rotateX(-Math.PI / 2);
      const mapped = this.maps?.hasRing;
      this.ringMat = new THREE.ShaderMaterial({
        vertexShader: RING_VERT,
        fragmentShader: mapped ? RING_MAP_FRAG : RING_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: {
          uRing: { value: new THREE.Vector4(ring.inner, ring.outer, ring.seed, 1) },
          uColor: { value: new THREE.Vector3(...ring.color) },
          uSunDir: { value: new THREE.Vector3(1, 0, 0) },
          uSunColor: { value: sunColor },
          uCamObj: { value: new THREE.Vector3() },
          uRingMap: this.uniforms.uRingMap,
          uRingMapOn: this.uniforms.uRingMapOn,
          ...eclipseUniforms(),
        },
      });
      this.materials.push(this.ringMat);
      const mesh = new THREE.Mesh(geoRing, this.ringMat);
      mesh.scale.setScalar(body.radius);
      mesh.frustumCulled = false;
      mesh.renderOrder = 3;
      this.group.add(mesh);
    }

    this.group.quaternion.fromArray(bodyOrientation(body));
    this.axis.copy(AXIS).applyQuaternion(this.group.quaternion);
  }

  /** Terrain leaves on screen, for the HUD. */
  get patchCount(): number {
    return this.terrain?.patchCount ?? 0;
  }

  /** False until `ground` has been measured with the real heights in place (it may still move before). */
  get ready(): boolean {
    return this.groundReady;
  }

  /**
   * rel: planet centre relative to the camera (km). sunDir: world-space unit vector to the star.
   * forward / halfAngle: the camera's view direction and half its diagonal field of view.
   * light: eclipses, planetshine and the star's strength here (see lighting.ts).
   */
  update(rel: THREE.Vector3, sunDir: THREE.Vector3, simTime: number, realTime: number, forward: THREE.Vector3, halfAngle: number, light?: BodyLight): void {
    const b = this.body;
    const dist = rel.length();
    this.ground = null;
    this.maps?.update(b.radius / dist);
    // Too small to see: the system view draws a dot instead.
    this.group.visible = b.radius / dist > 0.0006;
    if (!this.group.visible) return;

    this.group.position.copy(rel);
    const angle = spinAngle(b, simTime);
    this.spin.rotation.y = angle;
    if (this.sphere) this.sphere.geometry = b.radius / dist > 0.02 ? geoHi! : geoLo!;

    // Ring space: group rotation only. Planet space: group rotation plus spin.
    qInv.copy(this.group.quaternion).invert();
    if (this.ringMat) {
      this.ringMat.uniforms.uSunDir.value.copy(sunDir).applyQuaternion(qInv);
      this.ringMat.uniforms.uCamObj.value.copy(rel).multiplyScalar(-1 / b.radius).applyQuaternion(qInv);
    }
    const u = this.uniforms;
    const cam = u.uCamObj.value as THREE.Vector3;
    u.uSunDir.value.copy(sunDir).applyQuaternion(qInv).applyAxisAngle(AXIS, -angle);
    cam.copy(rel).multiplyScalar(-1 / b.radius).applyQuaternion(qInv).applyAxisAngle(AXIS, -angle);
    u.uTime.value = realTime;
    if (light) this.applyLight(light, rel, angle);
    if (b.clouds > 0 && this.terrain) {
      if (!this.cloudMap && !this.maps?.hasClouds) this.paintClouds();
      // The deck drifts east a little faster than the ground turns.
      const drift = ((simTime / (b.rotationPeriod * 9)) % 1) * Math.PI * 2;
      u.uCloudRot.value.set(Math.cos(drift), Math.sin(drift));
    }

    if (this.terrain && this.probeMat) {
      const mapsReady = this.maps?.ready ?? true;
      let height = 0;
      if (dist < b.radius * 2) {
        const dir = this.probeMat.uniforms.uProbeDir.value.copy(cam).normalize();
        this.probeMat.uniforms.uProbeFine.value.set(fineCoord(dir.x), fineCoord(dir.y), fineCoord(dir.z));
        // The last answer stands while it was asked close enough by: the speed limit near the ground
        // scales with altitude, so a frame or two of lag is a short way compared with the height.
        const last = this.probed;
        const altKm = last ? (cam.length() - 1 - last.height) * b.radius : 0;
        const fresh = last !== null && last.maps === mapsReady
          && last.dir.distanceTo(dir) * b.radius < Math.max(0.05, 0.5 * altKm);
        if (fresh) {
          height = last.height;
          if (!this.asyncProbe!.busy) {
            this.asking.copy(dir);
            this.askingMaps = mapsReady;
            this.asyncProbe!.start(this.probeMat, this.answered);
          }
        } else {
          // Just arrived (or the heights just changed): wait for the answer once, rather than guess.
          const v = probe(this.probeMat);
          if (v !== null) {
            height = v * 2 * this.heightScale;
            this.probed = { height, dir: dir.clone(), maps: mapsReady };
          }
        }
        if (this.probed) {
          this.ground = b.radius * (1 + height);
          this.groundReady = mapsReady;
        }
      } else {
        this.probed = null;
      }
      fwd.copy(forward).applyQuaternion(qInv).applyAxisAngle(AXIS, -angle);
      this.terrain.update(cam, fwd, halfAngle, height, this.shadow?.reach ?? 0);
      this.shadow?.update(cam, u.uSunDir.value, cam.length() - 1 - height, this.terrain.changed);
    }

    this.aurora?.update(rel, sunDir, this.group.quaternion, angle, realTime);
    if (this.atmoMat) {
      this.atmoMat.uniforms.uCenter.value.copy(rel);
      this.atmoMat.uniforms.uSunDir.value.copy(sunDir);
    }
  }

  private applyLight(light: BodyLight, rel: THREE.Vector3, angle: number): void {
    const u = this.uniforms;
    const r = this.body.radius;
    this.sunLight.copy(light.sun);
    spinFrame = angle;
    setEclipse(u, light, rel, r, toPlanet);
    toPlanet((u.uShineDir.value as THREE.Vector3).copy(light.shineDir));
    (u.uShine.value as THREE.Color).copy(light.shine);
    (u.uRingShine.value as THREE.Color).copy(light.ringShine);
    if (this.atmoMat) {
      const au = this.atmoMat.uniforms;
      setEclipse(au, light, rel, r, toWorld);
      (au.uShineDir.value as THREE.Vector3).copy(light.shineDir);
      (au.uShine.value as THREE.Color).copy(light.shine);
      (au.uEcliptic.value as THREE.Vector3).copy(light.orbitNormal);
    }
    if (this.ringMat) setEclipse(this.ringMat.uniforms, light, rel, r, toRing);
  }

  /** Terrain height above the datum (km) under a world-space direction from the centre; null for gas or before the probe is ready. */
  heightAlong(dir: THREE.Vector3, simTime: number): number | null {
    if (!this.probeMat) return null;
    const angle = spinAngle(this.body, simTime);
    qInv.copy(this.group.quaternion).invert();
    const d = this.probeMat.uniforms.uProbeDir.value.copy(dir).normalize().applyQuaternion(qInv).applyAxisAngle(AXIS, -angle);
    this.probeMat.uniforms.uProbeFine.value.set(fineCoord(d.x), fineCoord(d.y), fineCoord(d.z));
    const v = probe(this.probeMat);
    return v === null ? null : v * 2 * this.heightScale * this.body.radius;
  }

  private paintClouds(): void {
    const target = new THREE.WebGLRenderTarget(CLOUD_MAP_WIDTH, CLOUD_MAP_WIDTH / 2, {
      format: THREE.RedFormat, depthBuffer: false, generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping,
    });
    target.texture.anisotropy = 8;
    const mat = makeProbeMaterial(CLOUD_BAKE_FRAG, {
      ...this.uniforms, uBakeSize: { value: new THREE.Vector2(target.width, target.height) },
    });
    if (bake(mat, target)) {
      this.cloudMap = target;
      this.uniforms.uCloudMap.value = target.texture;
    } else {
      target.dispose();
    }
    mat.dispose();
  }

  dispose(): void {
    this.maps?.dispose();
    this.cloudMap?.dispose();
    this.shadow?.dispose();
    this.aurora?.dispose();
    this.asyncProbe?.dispose();
    for (const m of this.materials) m.dispose();
    this.terrain?.dispose();
  }
}

// The shared ring mesh spans radius 1..2; remap it to [inner, outer] in the vertex shader.
const RING_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform vec4 uRing;
varying vec3 vObj;
void main() {
  float r = length(position.xz);
  vec3 p = position / r * mix(uRing.x, uRing.y, r - 1.0);
  vObj = p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  #include <logdepthbuf_vertex>
}
`;
