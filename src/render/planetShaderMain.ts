import { atmoCommon } from './atmosphereScatter';
import { LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS } from './glsl';
import { CLOUD_COVER, PLANET_COMMON, SURFACE_MAPS } from './planetShader';

/** Appended to PLANET_FRAG: surface classification + lighting. */
export const PLANET_FRAG_MAIN = /* glsl */ `
uniform float uCloudAlt;   // planet radii

void main() {
  vec3 n = normalize(vObj);
  float px = max(length(fwidth(vView)), 1e-9);
  float detail = 0.45 / px;
  vec3 L = normalize(uSunDir);
  vec3 V = -normalize(vView);
  vec3 N = n;
  vec3 ground = n;   // the surface as it really tilts, without the far-view exaggeration
  vec3 albedo = vec3(0.5);
  vec3 emissive = vec3(0.0);
  float spec = 0.0;
  float water = 0.0;         // open liquid: mirrors the sky
  float wLost = 0.0;         // slope variance of the waves too small to see
  vec3 wgrad = vec3(0.0);    // slope of the waves that can be seen
  float lat = abs(n.y);

  if (uType >= 5) {
    albedo = gasColor(n, detail, uType == 5 ? 1.0 : 0.35);
  } else {
    float rough;
    float h = terrain(n, detail, rough);
    float f0 = detail > FINE_FREQ ? fineRelief(vFine, detail, rough) : 0.0;
    // The slope comes from how the height changes across neighbouring pixels: one terrain
    // evaluation per pixel instead of three. The fine layer is differenced on its own
    // because added to h it would vanish in float32.
    vec3 dpx = dFdx(vView), dpy = dFdy(vView);
    dpx -= n * dot(dpx, n);
    dpy -= n * dot(dpy, n);
    vec3 r1 = cross(dpy, n), r2 = cross(n, dpx);
    float det = dot(dpx, r1);
    det = det < 0.0 ? min(det, -1e-30) : max(det, 1e-30);
    vec3 grad = ((dFdx(h) + dFdx(f0)) * r1 + (dFdy(h) + dFdy(f0)) * r2) / det;
    if (vSkirt > 0.0) grad = vec3(0.0);
    h += f0;
    // True relief up close; exaggerated from orbit, where real slopes would be invisible.
    float farK = uType == 2 ? 0.09 : uType == 3 ? 0.035 : uType == 4 ? 0.07 : 0.05;
    float bumpK = mix(uHeightScale, max(uHeightScale, farK), smoothstep(1e-4, 3e-3, px));
    float snowLine = 1.0 - uPolar;
    // How steep the ground really is. From far away the slopes are not resolved yet, so
    // the share of bare rock is estimated from how mountainous the region is instead.
    float slope = uHeightScale * length(grad);
    float mf = clamp(0.63 / uHeightScale, 40.0, 150.0) * 1.7;
    float near = smoothstep(mf * 2.0, mf * 24.0, detail);
    float rock = mix(max(rough, 0.0) * 0.4, smoothstep(0.36, 0.72, slope), near);
    // Mottling at two scales: regional patches and the ground texture underfoot.
    float patchy = fbm(n * 90.0 + uSeed + 7.0, min(detail / 90.0, 4.0));
    float grain = fbm(n * 2600.0 + uSeed, min(detail / 2600.0, 4.0));
    // The finest mottling the pixels can show, whatever the distance: neighbouring octaves cross-faded.
    float lf = log2(clamp(detail, 5000.0, MAX_DETAIL) / 5.0);
    float f1 = exp2(floor(lf)), fr = fract(lf);
    vec3 tp = n * f1 + uSeed;
    float tex = ((1.0 - fr) * vnoise(tp) + vnoise(tp * 2.0 + 5.0) + fr * vnoise(tp * 4.0 + 9.0)) * 0.5;
    grain = mix(grain, tex, 0.5 * smoothstep(5000.0, 20000.0, detail));

    if (uType == 0) {
      float seaH = seaLevelH();
      float elev = max(h - seaH, 0.0);
      float moist = fbm(n * 3.3 + uSeed + 40.0, min(detail / 3.3, 24.0));
      float cold = lat + elev * 3.6 + (moist - 0.5) * 0.22;
      float snow;
      if (h < seaH || gBasin > 0.5) {
        float depth = gBasin > 0.5 ? 0.25 : clamp((seaH - h) * 7.0, 0.0, 1.0);
        albedo = mix(uPal[0] * 2.4 + vec3(0.0, 0.05, 0.06), uPal[0], smoothstep(0.0, 0.6, depth));
        // The bottom shows through the last few metres by the shore.
        float shoal = gBasin > 0.5 ? 0.0 : 1.0 - smoothstep(0.0, 0.0012, seaH - h);
        albedo = mix(albedo, uPal[2] * vec3(0.55, 1.0, 0.95), shoal * 0.7);
        grad = vec3(0.0);
        if (gBasin < 0.5) cold = lat + (moist - 0.5) * 0.12 - 0.04;
        snow = smoothstep(snowLine, snowLine + 0.07, cold);
        water = 1.0 - snow;
        // Lakes and sheltered shallows lie calmer than the open sea.
        float calm = (gBasin > 0.5 ? 0.3 : 1.0 - 0.75 * shoal) * water;
        float wv = waves(vFine, detail / FINE_FREQ, wLost) * calm;
        wLost *= calm * calm;
        wgrad = (dFdx(wv) * r1 + dFdy(wv) * r2) / (det * FINE_FREQ);
        wgrad *= min(1.0, 0.8 / max(length(wgrad), 1e-6));
      } else {
        float wetness = moist + (0.45 - lat) * 0.35 + (patchy - 0.5) * 0.45;
        vec3 low = mix(uPal[2], uPal[1], smoothstep(0.38, 0.62, wetness));
        low *= 0.7 + 0.6 * grain;
        low = mix(low, low * vec3(1.25, 1.05, 0.6), smoothstep(0.45, 0.75, patchy) * 0.5);
        // Woodland: dark clumps where it is wet enough, breaking up into single stands up close.
        float wood = smoothstep(0.5, 0.62, wetness) * smoothstep(0.42, 0.56, 0.6 * grain + 0.4 * patchy) * (1.0 - smoothstep(0.25, 0.5, slope));
        low = mix(low, uPal[1] * vec3(0.42, 0.5, 0.4) * (0.6 + 0.8 * tex), wood * 0.8);
        // Vegetation thins out with altitude, leaving scree.
        albedo = mix(low, uPal[3] * (0.9 + 0.5 * grain), smoothstep(0.07, 0.16, elev + (patchy - 0.5) * 0.05));
        albedo = mix(albedo, uPal[3] * (0.75 + 0.6 * grain) * mix(vec3(1.0), vec3(1.08, 1.0, 0.9), patchy), rock);
        // Beaches.
        albedo = mix(uPal[2] * 1.5, albedo, smoothstep(0.0006, 0.003, elev + slope * 0.004));
        // Snow lies on the gentler ground and slides off the cliffs.
        snow = smoothstep(snowLine, snowLine + 0.07, cold + (grain - 0.5) * 0.06) * (1.0 - 0.9 * near * smoothstep(0.6, 1.0, slope));
      }
      albedo = mix(albedo, vec3(0.86, 0.9, 0.95), snow);
      spec *= 1.0 - snow;
    } else if (uType == 1) {
      albedo = mix(uPal[0], uPal[1], smoothstep(0.3, 0.5, h));
      albedo = mix(albedo, uPal[2], smoothstep(0.52, 0.72, h));
      float streak = fbm(n * 11.0 + uSeed, min(detail / 11.0, 80.0));
      albedo = mix(albedo, uPal[3], smoothstep(0.55, 0.8, streak) * 0.6);
      albedo *= 0.8 + 0.25 * patchy + 0.2 * grain;
      // Cliffs show their layers: bands of darker and paler rock that follow the height.
      float band = 0.6 * ringNoise(h * 700.0 + patchy * 5.0) + 0.4 * ringNoise(h * 2900.0 + 31.0);
      vec3 cliff = mix(uPal[1] * 0.75, uPal[2] * 0.95, band * 0.6 + 0.4 * grain);
      albedo = mix(albedo, cliff, rock * 0.85);
      // Wind-blown dust settles pale on the level ground and in the basins.
      albedo = mix(albedo, uPal[2] * 1.05, (1.0 - smoothstep(0.03, 0.2, slope)) * near * 0.2);
      if (gBasin > 0.5) albedo = mix(uPal[2], vec3(0.82, 0.76, 0.66), 0.25) * (0.92 + 0.16 * grain);
      float snow = smoothstep(snowLine, snowLine + 0.05, lat + (streak - 0.5) * 0.1);
      albedo = mix(albedo, vec3(0.9, 0.9, 0.92), snow * step(0.001, uPolar));
    } else if (uType == 2) {
      albedo = mix(uPal[0], uPal[1], smoothstep(0.28, 0.48, h));
      albedo = mix(albedo, uPal[2], smoothstep(0.5, 0.68, h));
      albedo = mix(albedo, uPal[3], smoothstep(0.7, 0.82, h) * 0.7);
      // Fresh slopes are brighter than the space-weathered plains.
      albedo *= 0.82 + 0.2 * patchy + 0.16 * grain + 0.35 * near * smoothstep(0.3, 0.8, slope);
    } else if (uType == 3) {
      albedo = mix(uPal[1], uPal[2], smoothstep(0.35, 0.62, h));
      albedo = mix(uPal[0], albedo, smoothstep(0.16, 0.34, h));
      float dirt = fbm(n * 5.0 + uSeed + 9.0, min(detail / 5.0, 80.0));
      albedo = mix(albedo, uPal[3], smoothstep(0.6, 0.85, dirt) * 0.5);
      spec = 0.25;
    } else {
      float glow = smoothstep(0.47, 0.36, h);
      vec3 crust = mix(uPal[1], uPal[2], smoothstep(0.45, 0.85, h));
      albedo = crust * (1.0 - glow);
      float pulse = 0.8 + 0.2 * sin(uTime * 0.6 + h * 40.0);
      emissive = mix(uPal[3], uPal[0], smoothstep(0.0, 0.6, glow)) * glow * 3.5 * pulse;
    }
    N = normalize(n - bumpK * grad - wgrad);
    ground = normalize(n - uHeightScale * grad);
  }

  float geo = dot(n, L);
  float wrap = uAtmoDensity > 0.0 ? 0.1 : 0.0;
  float diff = clamp((dot(N, L) + wrap) / (1.0 + wrap), 0.0, 1.0) * smoothstep(-0.1, 0.1, geo + wrap);

  float shadow = 1.0;
  if (uRing.w > 0.5) {
    float dn = dot(L, uRingNormal);
    if (abs(dn) > 1e-4) {
      float t = -dot(n, uRingNormal) / dn;
      if (t > 0.0) {
        float r = length(n + L * t);
        shadow = 1.0 - 0.85 * ringDensity((r - uRing.x) / (uRing.y - uRing.x), uRing.z);
      }
    }
  }

#ifdef TERRAIN_SHADOW
  // Mountains between here and the sun.
  if (uShadowOn > 0.0 && diff > 0.0) shadow *= terrainShadow(vView, ground);
#endif
  vec3 sun = uSunColor * 1.5 * shadow;
  vec3 surf = n * (1.0 + 2e-4);
  if (uAtmoDensity > 0.0) sun *= atmoSunlight(surf, L, uAtmoTop, uAtmoColor, uAtmoDensity);
  vec3 col = albedo * diff * sun;
  // Skylight fills the shadows under an atmosphere; in a vacuum they stay black.
  if (uAtmoDensity > 0.0) {
    vec3 sky = uSunColor * (uAtmoColor * 0.75 + 0.25) * min(uAtmoDensity, 1.5);
    col += albedo * sky * 0.16 * smoothstep(-0.12, 0.3, geo) * (0.6 + 0.4 * dot(N, n));
  }

  // The cloud deck floats above the ground; here it only casts its shadow.
  float c = 0.0;
  if (uClouds > 0.0 && geo > -0.1) {
    vec3 slant = (L - n * geo) * (uCloudAlt / max(geo, 0.25));
    c = cloudAt(normalize(n + slant), 0.0);
    col *= 1.0 - 0.6 * c;
  }
  vec3 H = normalize(L + V);
  col += spec * pow(max(dot(N, H), 0.0), 110.0) * sun * 0.9 * step(0.0, geo) * (1.0 - c);
  if (water > 0.0) {
    float nv = max(dot(N, V), 0.0);
    float fres = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
    // A ruffled sea never becomes a perfect mirror, however low the eye.
    fres = min(fres, mix(0.9, 0.4, smoothstep(0.0, 0.03, wLost))) * water;
    if (uAtmoDensity > 0.0 && fres > 0.03 && geo > -0.25) {
      // The sky in the direction the water mirrors, with the clouds that hang there.
      vec3 rd = reflect(-V, N);
      rd = normalize(rd + n * max(0.04 - dot(rd, n), 0.0));
      vec3 od;
      vec3 mirrored = uSunColor * atmoScatter(surf, rd, 1e9, L, uAtmoTop, uAtmoColor, uAtmoDensity, od);
      if (uClouds > 0.0) {
        float over = cloudAt(normalize(n + rd * (uCloudAlt / max(dot(rd, n), 0.1))), 0.0);
        mirrored = mix(mirrored, sun * (0.15 + 0.6 * clamp(geo + 0.1, 0.0, 1.0)), over * 0.85);
      }
      col = mix(col, mirrored, fres);
    }
    // Glitter: the sun in every wave facet that happens to face the right way.
    float a2 = 0.004 + 2.0 * wLost;
    float nh = max(dot(N, H), 1e-3);
    float nh2 = nh * nh;
    float facets = exp((nh2 - 1.0) / (a2 * nh2)) / (a2 * nh2 * nh2);
    float fh = 0.02 + 0.98 * pow(1.0 - max(dot(V, H), 0.0), 5.0);
    col += sun * min(facets * fh / (4.0 * max(nv, 0.08)), 40.0) * water * step(0.0, geo) * (1.0 - c);
  }

  col += emissive;
  col += albedo * 0.0025;

  // Aerial perspective: the air between the camera and the ground.
  if (uAtmoDensity > 0.0) {
    vec3 od;
    vec3 haze = atmoScatter(uCamObj, -V, length(vView), L, uAtmoTop, uAtmoColor, uAtmoDensity, od);
    col = col * exp(-od) + uSunColor * haze;
  }
  gl_FragColor = vec4(col, 1.0);
#ifndef VERTEX_LOGDEPTH
  ${LOGDEPTH_FRAG}
#endif
}
`;

/** The cloud deck: a translucent shell just above the highest terrain. */
export const CLOUD_FRAG = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
${PLANET_COMMON}
${SURFACE_MAPS}
${atmoCommon(6)}
uniform vec3 uCloudColor;
uniform float uCloudAlt;
uniform float uAtmoTop;
varying vec3 vObj;
void main() {
  vec3 n = normalize(vObj);
  float detail = 0.6 / max(length(fwidth(vObj)), 1e-7);
  vec3 p = n * (1.0 + uCloudAlt);
  vec3 view = p - uCamObj;
  float dist = length(view);
  // The far side of the deck, beyond the horizon: hidden by the planet.
  vec2 tp = raySphere(uCamObj, view / dist, 0.9995);
  if (tp.x < tp.y && tp.x > 0.0 && tp.x < dist) discard;
  float c = cloudAt(n, detail);
  if (c < 0.004) discard;
  vec3 L = normalize(uSunDir);
  float geo = dot(n, L);
  // Self-shadowing: thicker cloud on the sunward side darkens this spot.
  float c2 = cloudAt(normalize(n + (L - n * geo) * 0.012), 0.0);
  float shade = 1.0 - 0.5 * clamp((c2 - c) * 2.0 + 0.2 * c, 0.0, 1.0);
  float cdiff = clamp((geo + 0.12) / 1.12, 0.0, 1.0);
  vec3 col = uCloudColor * uSunColor * (1.5 * cdiff * shade);
  if (uAtmoDensity > 0.0) {
    col *= atmoSunlight(p, L, uAtmoTop, uAtmoColor, uAtmoDensity);
    vec3 od;
    vec3 haze = atmoScatter(uCamObj, view / dist, dist, L, uAtmoTop, uAtmoColor, uAtmoDensity, od);
    col = col * exp(-od) + uSunColor * haze;
  }
  gl_FragColor = vec4(col, c * 0.94);
  ${LOGDEPTH_FRAG}
}
`;

/** Renders the ground height under one direction into a single pixel for the CPU to read. */
export const PROBE_FRAG = /* glsl */ `
${PLANET_COMMON}
uniform vec3 uProbeDir;
uniform vec3 uProbeFine;
void main() {
  float rough;
  float h = terrain(normalize(uProbeDir), 1e9, rough);
  h += fineRelief(uProbeFine, 1e9, rough);
  float v = clamp(displacement(h) / uHeightScale * 0.5, 0.0, 0.9999);
  vec3 enc = fract(v * vec3(1.0, 255.0, 65025.0));
  enc.xy -= enc.yz / 255.0;
  gl_FragColor = vec4(enc, 1.0);
}
`;

/** Fills an equirectangular map with a planet's procedural cloud cover. */
export const CLOUD_BAKE_FRAG = /* glsl */ `
${PLANET_COMMON}
${CLOUD_COVER}
uniform vec2 uBakeSize;
void main() {
  vec2 uv = gl_FragCoord.xy / uBakeSize;
  float lon = (uv.x - 0.5) * 6.2831853, lat = (uv.y - 0.5) * 3.1415927;
  vec3 n = vec3(cos(lat) * cos(lon), sin(lat), -cos(lat) * sin(lon));
  gl_FragColor = vec4(vec3(cloudCover(n, uBakeSize.x / 6.2831853)), 1.0);
}
`;
