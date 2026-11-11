window.place = (name, D, elev, az = 0, yaw = 0, pitch = 0) => {
  const t = se.blackHole(name); const bh = t.bh; const a = bh.axis;
  let s = [-a[2], 0, a[0]];
  let l = Math.hypot(...s); if (l < 1e-6) { s = [1,0,0]; l = 1; } s = s.map(v=>v/l);
  const f = [a[1]*s[2]-a[2]*s[1], a[2]*s[0]-a[0]*s[2], a[0]*s[1]-a[1]*s[0]];
  const r = Math.PI/180, ca = Math.cos(az*r), sa = Math.sin(az*r), ce = Math.cos(elev*r), sn = Math.sin(elev*r);
  const dir = [0,1,2].map(i => (s[i]*ca + f[i]*sa)*ce + a[i]*sn);
  const p = se.player;
  const tp = se.targetPos(t);
  p.local.set(tp.x + dir[0]*D*bh.rs, tp.y + dir[1]*D*bh.rs, tp.z + dir[2]*D*bh.rs);
  const cross = (u, v) => [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]];
  const nz = (u) => { const L = Math.hypot(...u); return u.map(x => x / L); };
  // look at the hole, then yaw/pitch (deg) away from it
  let fwd = dir.map(x => -x);
  let right = nz(cross(fwd, a));
  let up = cross(right, fwd);
  const rot = (v, k, ang) => { const c = Math.cos(ang), s2 = Math.sin(ang), d = v[0]*k[0]+v[1]*k[1]+v[2]*k[2], x = cross(k, v); return [0,1,2].map(i => v[i]*c + x[i]*s2 + k[i]*d*(1-c)); };
  fwd = rot(fwd, up, -yaw*r); right = nz(cross(fwd, up));
  fwd = rot(fwd, right, pitch*r); up = cross(right, fwd);
  const zc = fwd.map(x => -x);
  const m00 = right[0], m01 = up[0], m02 = zc[0], m10 = right[1], m11 = up[1], m12 = zc[1], m20 = right[2], m21 = up[2], m22 = zc[2];
  const tr = m00 + m11 + m22; let qw, qx, qy, qz;
  if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; qw = 0.25 * S; qx = (m21 - m12) / S; qy = (m02 - m20) / S; qz = (m10 - m01) / S; }
  else if (m00 > m11 && m00 > m22) { const S = Math.sqrt(1 + m00 - m11 - m22) * 2; qw = (m21 - m12) / S; qx = 0.25 * S; qy = (m01 + m10) / S; qz = (m02 + m20) / S; }
  else if (m11 > m22) { const S = Math.sqrt(1 + m11 - m00 - m22) * 2; qw = (m02 - m20) / S; qx = (m01 + m10) / S; qy = 0.25 * S; qz = (m12 + m21) / S; }
  else { const S = Math.sqrt(1 + m22 - m00 - m11) * 2; qw = (m10 - m01) / S; qx = (m02 + m20) / S; qy = (m12 + m21) / S; qz = 0.25 * S; }
  p.quat.set(qx, qy, qz, qw);
  p.velocity.set(0, 0, 0); p.autopilot = null; p.aim = null;
  se.select(t);
  return bh;
};
// camera on the far side of the hole from its companion, looking at the hole; the companion behind it, offset by yaw
window.placeC = (name, D, elev, swing, yaw = 0, pitch = 0) => {
  const t = se.blackHole(name); const bh = t.bh;
  const tp = se.targetPos(t), cp = se.targetPos({ kind: 'star', star: bh.companion });
  const c = [cp.x - tp.x, cp.y - tp.y, cp.z - tp.z]; const L = Math.hypot(...c);
  // azimuth of the companion in the disc frame
  const a = bh.axis; let s = [-a[2], 0, a[0]]; const ls = Math.hypot(...s); s = s.map(v => v / ls);
  const f = [a[1]*s[2]-a[2]*s[1], a[2]*s[0]-a[0]*s[2], a[0]*s[1]-a[1]*s[0]];
  const az = Math.atan2(c[0]*f[0]+c[1]*f[1]+c[2]*f[2], c[0]*s[0]+c[1]*s[1]+c[2]*s[2]) * 180 / Math.PI;
  return place(name, D, elev, az + 180 + swing, yaw, pitch);
};
// camera D r_s from the hole, looking at it along a universe direction (e.g. towards the galactic centre)
window.placeLook = (name, D, look, roll = [0, 1, 0]) => {
  const t = se.blackHole(name); const bh = t.bh;
  const l = Math.hypot(...look); const f = look.map((v) => v / l);
  const p = se.player, tp = se.targetPos(t);
  p.local.set(tp.x - f[0] * D * bh.rs, tp.y - f[1] * D * bh.rs, tp.z - f[2] * D * bh.rs);
  const V = p.local.constructor;
  const cross = (u, v) => [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]];
  const nz = (u) => { const L = Math.hypot(...u); return u.map((x) => x / L); };
  const right = nz(cross(f, roll)), up = cross(right, f), zc = f.map((x) => -x);
  const m = [right, up, zc];
  const m00 = m[0][0], m01 = m[1][0], m02 = m[2][0], m10 = m[0][1], m11 = m[1][1], m12 = m[2][1], m20 = m[0][2], m21 = m[1][2], m22 = m[2][2];
  const tr = m00 + m11 + m22; let qw, qx, qy, qz;
  if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; qw = 0.25 * S; qx = (m21 - m12) / S; qy = (m02 - m20) / S; qz = (m10 - m01) / S; }
  else if (m00 > m11 && m00 > m22) { const S = Math.sqrt(1 + m00 - m11 - m22) * 2; qw = (m21 - m12) / S; qx = 0.25 * S; qy = (m01 + m10) / S; qz = (m02 + m20) / S; }
  else if (m11 > m22) { const S = Math.sqrt(1 + m11 - m00 - m22) * 2; qw = (m02 - m20) / S; qx = (m01 + m10) / S; qy = 0.25 * S; qz = (m12 + m21) / S; }
  else { const S = Math.sqrt(1 + m22 - m00 - m11) * 2; qw = (m10 - m01) / S; qx = (m02 + m20) / S; qy = (m12 + m21) / S; qz = 0.25 * S; }
  p.quat.set(qx, qy, qz, qw);
  p.velocity.set(0, 0, 0); p.autopilot = null; p.aim = null;
  se.select(t);
  void V;
  return bh;
};
