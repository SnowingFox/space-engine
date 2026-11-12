import * as THREE from 'three';
import type { SystemView } from '../render/systemView';
import type { Player } from './player';
import { sameTarget, targetName, targetPosition, targetRadius, type Target } from './target';

export interface LabelItem {
  key: string;
  text: string;
  cls: 'star' | 'planet' | 'moon' | 'galaxy' | 'blackhole' | 'nebula';
  /** Screen position of the object's centre, CSS px. */
  x: number;
  y: number;
  /** Where the text starts, to the right of the object. */
  tx: number;
  /** Distance to the surface, km. */
  dist: number;
  target: Target;
  selected: boolean;
  opacity: number;
  /** Estimated text width, px, for hit-testing and decluttering. */
  width: number;
}

/** Something besides the current system to name, e.g. a black hole nearby (camera-relative position, km). */
export interface LabelSource {
  target: Target;
  rel: THREE.Vector3;
  radius: number;
  fade: number;
}

export interface Marker {
  x: number;
  y: number;
  /** Side of the reticle square, px. */
  size: number;
}

/** A screen rectangle, CSS px. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface LabelLayout {
  items: LabelItem[];
  /** Reticle around the selected object, while it is small on screen. */
  marker: Marker | null;
}

const v = new THREE.Vector3();
const rel = new THREE.Vector3();
const qInv = new THREE.Quaternion();
const smooth = THREE.MathUtils.smoothstep;
const LABEL_HEIGHT = 16;
/** Besides the selection and the star, only this many of the nearest bodies are named. */
const MAX_LABELS = 8;

/** Screen-space labels for the current system plus the selected target, decluttered. */
export function buildLabels(
  view: SystemView | null, player: Player, selected: Target | null, simTime: number,
  camera: THREE.PerspectiveCamera, width: number, height: number, showLabels = true, avoid: readonly Box[] = [],
  extra: readonly LabelSource[] = [],
): LabelLayout {
  const items: LabelItem[] = [];
  let marker: Marker | null = null;
  qInv.copy(player.quat).invert();
  const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const tanX = tanY * camera.aspect;
  const pxPerRad = height / (2 * tanY);

  // Project a camera-relative position by hand, in doubles: distances here span
  // metres to thousands of light years, far beyond what a float matrix can carry.
  const add = (key: string, target: Target, cls: LabelItem['cls'], r: THREE.Vector3, radius: number, fade: number) => {
    const dist = r.length();
    const isSel = sameTarget(target, selected);
    if (!isSel && (!showLabels || fade <= 0.02 || occluded(r, dist))) return;
    v.copy(r).applyQuaternion(qInv);
    if (v.z >= -1e-9) return;
    const nx = v.x / -v.z / tanX;
    const ny = v.y / -v.z / tanY;
    if (Math.abs(nx) > 1.02 || Math.abs(ny) > 1.02) return;
    const x = (nx * 0.5 + 0.5) * width;
    const y = (0.5 - ny * 0.5) * height;
    const radiusPx = dist > radius ? Math.asin(Math.min(radius / dist, 1)) * pxPerRad : Infinity;
    if (isSel && radiusPx < 70) marker = { x, y, size: Math.max(2 * radiusPx + 14, 26) };
    // A disk that fills a good part of the screen needs no name tag.
    const big = 1 - smooth(radiusPx, 60, 95);
    const opacity = (isSel ? 1 : fade) * big;
    if (opacity <= 0.02) return;
    const text = targetName(target);
    items.push({
      key, target, cls, text, x, y, selected: isSel, opacity,
      dist: Math.max(dist - radius, 0),
      tx: x + (isSel ? Math.max(radiusPx + 7, 13) + 6 : Math.min(radiusPx, 110) * 0.74 + 9),
      width: text.length * 6.6 + (isSel ? 70 : 6),
    });
  };

  // Anything behind the disk of a nearer body is hidden, like the body itself.
  const occluded = (r: THREE.Vector3, dist: number): boolean => {
    if (!view) return false;
    for (const o of view.bodies) {
      const od = o.rel.length();
      if (od >= dist * 0.999 || od <= o.body.radius) continue;
      const cos = r.dot(o.rel) / (dist * od);
      if (cos > Math.sqrt(1 - (o.body.radius / od) ** 2)) return true;
    }
    return false;
  };

  let selectedShown = false;
  if (view) {
    const star = view.system.star;
    const starTarget: Target = { kind: 'star', star };
    rel.copy(player.local).negate();
    add(`s${star.id}`, starTarget, 'star', rel, view.star.radiusKm, 1);
    selectedShown ||= sameTarget(starTarget, selected);
    const starDist = rel.length();
    for (const s of view.bodies) {
      const b = s.body;
      const t: Target = { kind: 'body', star, body: b };
      selectedShown ||= sameTarget(t, selected);
      let fade: number;
      if (b.parent) {
        // Moons only clutter the view until you are in their planet's neighbourhood.
        const parent = view.bodies.find((o) => o.body === b.parent);
        fade = parent ? 1 - smooth(parent.rel.length() / b.orbitRadius, 25, 45) : 0;
      } else {
        // From far outside the system the planets merge into their star.
        fade = 1 - smooth(starDist / b.orbitRadius, 150, 400);
      }
      add(`b${b.id}`, t, b.parent ? 'moon' : 'planet', s.rel, b.radius, fade);
    }
  }

  for (const e of extra) {
    selectedShown ||= sameTarget(e.target, selected);
    add(`x${targetName(e.target)}`, e.target, e.target.kind === 'blackhole' || e.target.kind === 'nebula' ? e.target.kind : 'star', e.rel, e.radius, e.fade);
  }

  if (selected && !selectedShown) {
    rel.copy(targetPosition(selected, player.anchor, simTime, rel)).sub(player.local);
    add('selected', selected, selected.kind === 'body' ? 'planet' : selected.kind, rel, targetRadius(selected), 1);
  }

  // Declutter: the selection first, then the star, then the nearest bodies. A label is
  // dropped when its text would land on one already placed or under a HUD panel, and
  // only a handful are shown at all so the sky never fills up with names.
  items.sort((a, b) => rank(a) - rank(b) || a.dist - b.dist);
  const placed: LabelItem[] = [];
  let others = 0;
  for (const it of items) {
    const x1 = it.tx + it.width;
    const y0 = it.y - LABEL_HEIGHT / 2;
    if (avoid.some((b) => it.tx < b.x1 && x1 > b.x0 && y0 < b.y1 && y0 + LABEL_HEIGHT > b.y0)) continue;
    if (placed.some((p) => it.tx < p.tx + p.width && p.tx < x1 && Math.abs(it.y - p.y) < LABEL_HEIGHT)) continue;
    if (rank(it) === 2 && ++others > MAX_LABELS) continue;
    placed.push(it);
  }
  return { items: placed, marker };
}

function rank(it: LabelItem): number {
  return it.selected ? 0 : it.cls === 'star' || it.cls === 'blackhole' ? 1 : 2;
}

/** The label under a screen point, if any: labels are clickable like the objects themselves. */
export function labelAt(layout: LabelLayout, x: number, y: number): Target | null {
  for (const it of layout.items) {
    if (x >= it.x - 8 && x <= it.tx + it.width && Math.abs(y - it.y) <= LABEL_HEIGHT / 2) return it.target;
  }
  return null;
}
