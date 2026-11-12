import * as THREE from 'three';
import type { BodyData } from '../universe/bodies';
import { bake, makeProbeMaterial, probeRenderer } from './probe';

// Real surface maps of the Solar System's bodies (public/textures/, see CREDITS.md there).
// They are fetched only while a body is close enough to show them, in two sizes: a 1024-wide
// copy while it is a small disc and the full map once it fills a good part of the view.
// Colour maps stay 8-bit sRGB textures; the height and cloud maps are converted on the GPU
// into single-channel textures (kilometres as half floats, cover as R8) and the sources dropped.

const DIR = '/textures/';

interface HeightSpec { file: string; min: number; max: number }

interface MapSpec {
  color?: string;
  /** Linear gain on the map's colours, so its albedo matches the rest of the renderer. */
  gain: number;
  /** Greyscale mosaic: tinted with the body's palette. */
  gray?: boolean;
  night?: string;
  clouds?: string;
  height?: HeightSpec;
  ring?: string;
  /** Colour of an opaque cloud deck (Venus). */
  cloudTint?: string;
}

// Height ranges from public/textures/manifest.json (metres; the PNGs hold 0..65535 between them).
const SPECS: Record<string, MapSpec> = {
  earth: {
    color: 'earth_color.jpg', gain: 0.75, night: 'earth_night.jpg', clouds: 'earth_clouds.jpg',
    height: { file: 'earth_height.png', min: -10362, max: 6407 },
  },
  moon: { color: 'moon_color.jpg', gain: 0.5, height: { file: 'moon_height.png', min: -9044, max: 10634 } },
  mars: { color: 'mars_color.jpg', gain: 0.55, height: { file: 'mars_height.png', min: -8160, max: 21159 } },
  mercury: { color: 'mercury_color.jpg', gain: 0.5 },
  venus: { color: 'venus_surface.jpg', gain: 0.45, cloudTint: 'venus_color.jpg' },
  jupiter: { color: 'jupiter_color.jpg', gain: 0.8 },
  saturn: { color: 'saturn_color.jpg', gain: 0.8, ring: 'saturn_ring.png' },
  uranus: { color: 'uranus_color.jpg', gain: 0.8 },
  neptune: { color: 'neptune_color.jpg', gain: 0.8 },
  io: { color: 'io_color.jpg', gain: 0.7 },
  europa: { color: 'europa_color.jpg', gain: 0.75, gray: true },
  ganymede: { color: 'ganymede_color.jpg', gain: 0.6 },
  callisto: { color: 'callisto_color.jpg', gain: 0.6, gray: true },
  titan: { color: 'titan_color.jpg', gain: 0.7, gray: true },
  enceladus: { color: 'enceladus_color.jpg', gain: 0.8, gray: true },
  triton: { color: 'triton_color.jpg', gain: 0.7 },
};

/** Width of the small copies. */
const LOW_WIDTH = 1024;
/** Apparent size (radius / distance) at which each size is wanted, and below which it is dropped again. */
const LOW_ON = 0.0012, LOW_OFF = 0.0007;
const HIGH_ON = 0.03, HIGH_OFF = 0.015;

const HEIGHT_DECODE_FRAG = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uRange;   // km at 0 and at 65535
void main() {
  vec4 t = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0);
  float v = (floor(t.r * 255.0 + 0.5) * 256.0 + floor(t.g * 255.0 + 0.5)) / 65535.0;
  gl_FragColor = vec4(uRange.x + v * (uRange.y - uRange.x), 0.0, 0.0, 1.0);
}
`;

// The map's grey is a mix of real cloud and thin haze; thin haze would otherwise veil the whole planet.
const CLOUD_DECODE_FRAG = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uBakeSize;
void main() {
  float c = texture(uSrc, gl_FragCoord.xy / uBakeSize).r;
  gl_FragColor = vec4(smoothstep(0.06, 0.9, c), 0.0, 0.0, 1.0);
}
`;

let blank: THREE.DataTexture | null = null;
function blankTexture(): THREE.DataTexture {
  if (!blank) {
    blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    blank.needsUpdate = true;
  }
  return blank;
}

/** The map uniforms with nothing loaded: what every generated world gets. */
export function noMapUniforms(): Record<string, THREE.IUniform> {
  return {
    uColorMap: { value: blankTexture() },
    uNightMap: { value: blankTexture() },
    uHeightMap: { value: blankTexture() },
    uCloudTint: { value: blankTexture() },
    uRingMap: { value: blankTexture() },
    uRingMapOn: { value: 0 },
    uMapInfo: { value: new THREE.Vector4(0, 0, 0, 0) },
    uMapTint: { value: new THREE.Vector3(1, 1, 1) },
    uHeightInfo: { value: new THREE.Vector4(0, 0, 0, 0) },
  };
}

async function fetchBitmap(file: string, width?: number): Promise<ImageBitmap> {
  const res = await fetch(DIR + file);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const blob = await res.blob();
  const options: ImageBitmapOptions = { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
  if (width) Object.assign(options, { resizeWidth: width, resizeHeight: width / 2, resizeQuality: 'high' });
  return createImageBitmap(blob, options);
}

// Uploading a big map in one go stalls the frame it lands in: an 8k bitmap takes a quarter of a
// second inside texSubImage2D. Big maps are copied in bands instead, through a 2D canvas
// (bit-exact for these opaque images), and shown once complete. Copies run at about 0.6 GB/s
// in the GPU process and queue up behind each other, so the budget is in bytes per frame.

/** Bitmaps at least this wide go up in bands. */
const STAGE_WIDTH = 2048;
/** Bytes uploaded per frame: 4 MB, a band of 128 rows of an 8k map. */
const STAGE_BYTES = 4 << 20;

interface Staging { run: (bytes: number) => number; cancelled: boolean; done: boolean }
const stages: Staging[] = [];
let pumping = false;

function pump(): void {
  let budget = STAGE_BYTES;
  while (stages.length && budget > 0) {
    const s = stages[0];
    if (!s.cancelled) budget -= s.run(budget);
    if (s.cancelled || s.done) stages.shift();
  }
  pumping = stages.length > 0;
  if (pumping) requestAnimationFrame(pump);
}

/** A GL texture filled from the bitmap over the coming frames; resolves once all of it is in. */
function stageTexture(bitmap: ImageBitmap, srgb: boolean, mipmaps: boolean, filter: number, wrapS: number): { done: Promise<THREE.ExternalTexture>; cancel: () => void } {
  const renderer = probeRenderer()!;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const state = renderer.state;
  const w = bitmap.width, h = bitmap.height;
  const tex = gl.createTexture()!;
  const levels = mipmaps ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
  const bind = (): void => {
    state.activeTexture(gl.TEXTURE0);
    state.bindTexture(gl.TEXTURE_2D, tex);
  };
  bind();
  gl.texStorage2D(gl.TEXTURE_2D, levels, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmaps ? gl.LINEAR_MIPMAP_LINEAR : filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  if (aniso && mipmaps) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, renderer.capabilities.getMaxAnisotropy()));
  let y = 0;
  const canvas = new OffscreenCanvas(w, 512);
  const cx = canvas.getContext('2d', { willReadFrequently: true })!;
  let resolve: (t: THREE.ExternalTexture) => void = () => {};
  let reject: (e: Error) => void = () => {};
  const done = new Promise<THREE.ExternalTexture>((res, rej) => { resolve = res; reject = rej; });
  let finished = false;
  const job: Staging = {
    cancelled: false,
    done: false,
    run: (bytes) => {
      const n = Math.min(Math.max(Math.floor(bytes / (w * 4)), 8), 512, h - y);
      cx.clearRect(0, 0, w, n);
      cx.drawImage(bitmap, 0, y, w, n, 0, 0, w, n);
      const px = cx.getImageData(0, 0, w, n).data;
      bind();
      state.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      state.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      state.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, w, n, gl.RGBA, gl.UNSIGNED_BYTE, px);
      y += n;
      if (y < h) return n * w * 4;
      job.done = true;
      if (mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
      bitmap.close();
      const ext = new THREE.ExternalTexture(tex);
      ext.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      ext.addEventListener('dispose', () => gl.deleteTexture(tex));
      finished = true;
      resolve(ext);
      return n * w * 4;
    },
  };
  stages.push(job);
  if (!pumping) {
    pumping = true;
    requestAnimationFrame(pump);
  }
  return {
    done,
    cancel: () => {
      if (job.cancelled || finished) return;
      job.cancelled = true;
      bitmap.close();
      gl.deleteTexture(tex);
      reject(new Error('cancelled'));
    },
  };
}

function colourTexture(bitmap: ImageBitmap, srgb = true): THREE.Texture {
  const t = new THREE.Texture(bitmap);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.flipY = false;
  t.premultiplyAlpha = false;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = Math.min(8, probeRenderer()?.capabilities.getMaxAnisotropy() ?? 1);
  t.needsUpdate = true;
  // Once on the GPU the decoded copy (128 MB for an 8k map) is only dead weight.
  t.onUpdate = () => bitmap.close();
  return t;
}

/** Runs a one-pass conversion of a source image into a new single-channel render target. */
function convert(source: ImageBitmap | THREE.Texture, frag: string, type: THREE.TextureDataType, extra: Record<string, THREE.IUniform>): THREE.WebGLRenderTarget | null {
  const bitmap = source instanceof THREE.Texture ? null : source;
  const { width, height } = sizeOf(source);
  let src: THREE.Texture;
  if (bitmap) {
    src = new THREE.Texture(bitmap);
    src.colorSpace = THREE.NoColorSpace;
    src.flipY = false;
    src.premultiplyAlpha = false;
    src.generateMipmaps = false;
    src.minFilter = src.magFilter = sourceFilter(type);
    src.needsUpdate = true;
  } else {
    src = source as THREE.Texture;
  }
  const target = new THREE.WebGLRenderTarget(width, height, {
    format: THREE.RedFormat, type, depthBuffer: false, generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping,
  });
  target.texture.anisotropy = Math.min(8, probeRenderer()?.capabilities.getMaxAnisotropy() ?? 1);
  const mat = makeProbeMaterial(frag, { uSrc: { value: src }, uBakeSize: { value: new THREE.Vector2(width, height) }, ...extra });
  const ok = bake(mat, target);
  mat.dispose();
  src.dispose();
  bitmap?.close();
  if (!ok) {
    target.dispose();
    return null;
  }
  return target;
}

type Slot = 'color' | 'night' | 'clouds' | 'height' | 'ring' | 'cloudTint';

/** Sampling of a source image the conversion passes read: exact texels for heights. */
function sourceFilter(type: THREE.TextureDataType): THREE.MagnificationTextureFilter {
  return type === THREE.HalfFloatType ? THREE.NearestFilter : THREE.LinearFilter;
}

function sizeOf(source: ImageBitmap | THREE.Texture): { width: number; height: number } {
  return source instanceof THREE.Texture ? (source.userData as { width: number; height: number }) : source;
}

const isColour = (slot: Slot): boolean => slot === 'color' || slot === 'night' || slot === 'cloudTint';

interface Loaded { tier: number; dispose: () => void }

/** Approximate bytes on the GPU of the maps currently held, for tuning. */
export const mapStats = { bytes: 0 };

/** The real maps of one body, and the shader uniforms that carry them. */
export class BodyMaps {
  /**
   * Merged into the planet's uniforms. uMapInfo: colour map on, night map on, texels around the
   * colour map's equator, cloud tint on. uHeightInfo: terrain units per km, km at the datum,
   * texels around the height map's equator, 1 once heights are in.
   */
  readonly uniforms = noMapUniforms();
  /** Called with the cover map once the real clouds are in (null when they are dropped). */
  onClouds: ((map: THREE.Texture | null) => void) | null = null;
  readonly spec: MapSpec;
  private tier = 0;
  private readonly held = new Map<Slot, Loaded>();
  private readonly pending = new Map<Slot, number>();
  private readonly staging = new Map<Slot, () => void>();
  private disposed = false;
  private heightFailed = false;

  static for(body: BodyData): BodyMaps | null {
    const spec = body.maps ? SPECS[body.maps] : undefined;
    return spec ? new BodyMaps(body, spec) : null;
  }

  private constructor(readonly body: BodyData, spec: MapSpec) {
    this.spec = spec;
    const tint = this.uniforms.uMapTint.value as THREE.Vector3;
    if (spec.gray) {
      // A greyscale mosaic takes the hue of the body's palette, kept pale.
      const p = body.palette;
      const c = new THREE.Vector3(p[1][0] + p[2][0], p[1][1] + p[2][1], p[1][2] + p[2][2]);
      c.divideScalar(Math.max(c.x, c.y, c.z, 1e-3)).lerp(new THREE.Vector3(1, 1, 1), 0.5);
      tint.copy(c).divideScalar(Math.max(c.x, c.y, c.z));
    }
    tint.multiplyScalar(spec.gain);
  }

  get hasHeight(): boolean { return !!this.spec.height; }
  get hasClouds(): boolean { return !!this.spec.clouds; }
  get hasRing(): boolean { return !!this.spec.ring; }
  /** Highest real relief above the lowest point, km (0 without a height map). */
  get reliefKm(): number { return this.spec.height ? (this.spec.height.max - this.spec.height.min) / 1000 : 0; }

  /** Lowest point of the height map, km. */
  get minKm(): number { return this.spec.height ? this.spec.height.min / 1000 : 0; }

  /**
   * False until the height map is in (the terrain would change under the camera when it arrives).
   * Only asked about near the body, where it is always wanted; a failed load counts as ready.
   */
  get ready(): boolean {
    return !this.spec.height || this.held.has('height') || this.heightFailed;
  }

  /** Sets how heights map onto the terrain: units of terrain height per km, and the km that sit at the datum. */
  setHeightScale(unitsPerKm: number, datumKm: number): void {
    const h = this.uniforms.uHeightInfo.value as THREE.Vector4;
    h.x = unitsPerKm;
    h.y = datumKm;
  }

  /** size: the body's apparent size, radius / distance. */
  update(size: number): void {
    const want = size > HIGH_ON || (this.tier === 2 && size > HIGH_OFF) ? 2
      : size > LOW_ON || (this.tier > 0 && size > LOW_OFF) ? 1 : 0;
    if (want === this.tier) return;
    this.tier = want;
    if (want === 0) {
      this.release();
      return;
    }
    const s = this.spec;
    const width = want === 2 ? undefined : LOW_WIDTH;
    if (s.color) this.request('color', s.color, width);
    if (s.night) this.request('night', s.night, width);
    if (s.clouds) this.request('clouds', s.clouds, width);
    if (s.cloudTint) this.request('cloudTint', s.cloudTint, width);
    // Heights and the ring are small enough to keep at full size: the terrain must not change with distance.
    if (s.height) this.request('height', s.height.file, undefined, 1);
    if (s.ring) this.request('ring', s.ring, undefined, 1);
  }

  /** tierOf: the tier this slot's file belongs to (heights and the ring are the same at every size). */
  private request(slot: Slot, file: string, width: number | undefined, tierOf = this.tier): void {
    if (this.held.get(slot)?.tier === tierOf || this.pending.get(slot) === tierOf) return;
    this.pending.set(slot, tierOf);
    // A band-by-band upload of the other size is no longer wanted.
    this.staging.get(slot)?.();
    this.staging.delete(slot);
    fetchBitmap(file, width).then((bitmap) => {
      const stillWanted = !this.disposed && this.tier > 0 && this.pending.get(slot) === tierOf
        && (tierOf === this.tier || slot === 'height' || slot === 'ring');
      if (!stillWanted) {
        if (this.pending.get(slot) === tierOf) this.pending.delete(slot);
        bitmap.close();
        return;
      }
      // (The ring map has transparency, which a 2D canvas would not hand back exactly.)
      if (bitmap.width < STAGE_WIDTH || slot === 'ring' || !probeRenderer()) {
        this.pending.delete(slot);
        this.install(slot, bitmap, tierOf);
        return;
      }
      const { width, height } = bitmap;
      const filter = isColour(slot) ? WebGL2RenderingContext.LINEAR
        : sourceFilter(slot === 'height' ? THREE.HalfFloatType : THREE.UnsignedByteType) === THREE.NearestFilter ? WebGL2RenderingContext.NEAREST : WebGL2RenderingContext.LINEAR;
      const job = stageTexture(bitmap, isColour(slot), isColour(slot), filter,
        isColour(slot) ? WebGL2RenderingContext.REPEAT : WebGL2RenderingContext.CLAMP_TO_EDGE);
      this.staging.set(slot, job.cancel);
      job.done.then((tex) => {
        if (this.staging.get(slot) === job.cancel) this.staging.delete(slot);
        const wanted = !this.disposed && this.tier > 0 && this.pending.get(slot) === tierOf
          && (tierOf === this.tier || slot === 'height');
        if (this.pending.get(slot) === tierOf) this.pending.delete(slot);
        if (!wanted) {
          tex.dispose();
          return;
        }
        tex.userData = { width, height };
        this.install(slot, tex, tierOf);
      }, () => { /* cancelled: a newer request owns the slot */ });
    }, (err) => {
      this.pending.delete(slot);
      if (slot === 'height') this.heightFailed = true;
      console.warn(`surface map ${file} failed to load`, err);
    });
  }

  /** source: the decoded image, or the same already on the GPU (big maps, see stageTexture). */
  private install(slot: Slot, source: ImageBitmap | THREE.Texture, tier: number): void {
    const u = this.uniforms;
    const info = u.uMapInfo.value as THREE.Vector4;
    const { width: w, height: h } = sizeOf(source);
    let loaded: Loaded;
    if (slot === 'height') {
      const hs = this.spec.height!;
      const target = convert(source, HEIGHT_DECODE_FRAG, THREE.HalfFloatType, {
        uRange: { value: new THREE.Vector2(hs.min / 1000, hs.max / 1000) },
      });
      if (!target) return;
      u.uHeightMap.value = target.texture;
      const hi = u.uHeightInfo.value as THREE.Vector4;
      hi.z = w;
      hi.w = 1;
      const bytes = w * h * 2 * 4 / 3;
      loaded = { tier, dispose: () => {
        if (u.uHeightMap.value === target.texture) { u.uHeightMap.value = blankTexture(); hi.w = 0; }
        target.dispose();
        mapStats.bytes -= bytes;
      } };
      mapStats.bytes += bytes;
    } else if (slot === 'clouds') {
      const target = convert(source, CLOUD_DECODE_FRAG, THREE.UnsignedByteType, {});
      if (!target) return;
      this.onClouds?.(target.texture);
      const bytes = w * h * 4 / 3;
      loaded = { tier, dispose: () => { target.dispose(); mapStats.bytes -= bytes; } };
      mapStats.bytes += bytes;
    } else {
      const bitmap = source instanceof THREE.Texture ? null : source;
      const tex = bitmap ? colourTexture(bitmap) : (source as THREE.Texture);
      const bytes = w * h * 4 * 4 / 3;
      mapStats.bytes += bytes;
      const off = (): void => { tex.dispose(); bitmap?.close(); mapStats.bytes -= bytes; };
      if (slot === 'color') {
        u.uColorMap.value = tex;
        info.x = 1;
        info.z = w;
        loaded = { tier, dispose: () => { if (u.uColorMap.value === tex) { u.uColorMap.value = blankTexture(); info.x = 0; } off(); } };
      } else if (slot === 'night') {
        u.uNightMap.value = tex;
        info.y = 1;
        loaded = { tier, dispose: () => { if (u.uNightMap.value === tex) { u.uNightMap.value = blankTexture(); info.y = 0; } off(); } };
      } else if (slot === 'cloudTint') {
        u.uCloudTint.value = tex;
        info.w = 1;
        loaded = { tier, dispose: () => { if (u.uCloudTint.value === tex) { u.uCloudTint.value = blankTexture(); info.w = 0; } off(); } };
      } else {
        tex.wrapS = THREE.ClampToEdgeWrapping;
        u.uRingMap.value = tex;
        u.uRingMapOn.value = 1;
        loaded = { tier, dispose: () => { if (u.uRingMap.value === tex) { u.uRingMap.value = blankTexture(); u.uRingMapOn.value = 0; } off(); } };
      }
    }
    // The previous size stays on screen until its replacement is ready.
    const old = this.held.get(slot);
    this.held.set(slot, loaded);
    // Each map only clears the uniforms that still point at it, so this leaves the new one in place.
    old?.dispose();
  }

  private release(): void {
    for (const l of this.held.values()) l.dispose();
    if (this.held.has('clouds')) this.onClouds?.(null);
    this.held.clear();
    this.pending.clear();
    for (const cancel of this.staging.values()) cancel();
    this.staging.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.release();
  }
}
