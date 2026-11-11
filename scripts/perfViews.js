// Camera placement helpers for scripts/perf.mjs (evaluated in the page; p = se.player, look(x, y, z) aims the view).
const sys = se.generateSystem(se.earth.star);
const all = sys.planets.flatMap((q) => [q, ...q.moons]);
const orbitB = (name, alt, sunAngle, yaw, pitch) => {
  const body = all.find((b) => b.name === name);
  const t = { kind: 'body', star: se.earth.star, body };
  const R = body.radius;
  se.hover(t, 0, 0, 0, 0);
  const l = p.local.clone();
  const tp = l.clone().multiplyScalar((l.length() + R) / l.length());
  const s = tp.clone().negate().normalize();
  const side = s.clone().cross(l.clone().set(0, 1, 0)).normalize();
  const a = sunAngle * Math.PI / 180;
  const u = s.clone().multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a));
  se.hover(t, alt, 0, 0, 0);
  p.local.copy(tp).addScaledVector(u, R + alt);
  const f = s.clone().applyAxisAngle(u, yaw * Math.PI / 180);
  const r = f.clone().cross(u).normalize();
  f.applyAxisAngle(r, pitch * Math.PI / 180);
  look(f.x, f.y, f.z);
  // Level the horizon: roll about the view direction until 'u' is up on screen.
  const V = p.local.constructor, Q = p.quat.constructor;
  const up = new V(0, 1, 0).applyQuaternion(p.quat);
  const want = u.clone().addScaledVector(f, -u.dot(f)).normalize();
  const ang = Math.atan2(up.clone().cross(want).dot(f), up.dot(want));
  p.quat.premultiply(new Q().setFromAxisAngle(f.clone().normalize(), ang));
};
// Look at a given azimuth (from the sun's) and elevation above the local horizontal.
const horiz = (name, alt, sunAngle, az, el) => {
  orbitB(name, alt, sunAngle, 0, 0);
  const body = all.find((b) => b.name === name);
  const t = { kind: 'body', star: se.earth.star, body };
  const V = p.local.constructor;
  const up = p.local.clone().sub(se.getView ? p.local.clone().sub(p.local).add(p.local.clone().sub(p.local)) : p.local).normalize();
  void up; void t;
};
// viewB(name, altKm, sunAngleDeg, dx, dy): camera above the body at the given angle from the subsolar point, looking at its centre (dx, dy: aim offsets in radians).
const viewB = (name, alt, sunAngle, dx = 0, dy = 0) => {
  orbitB(name, alt, sunAngle, 0, 0);
  const body = all.find((b) => b.name === name);
  const R = body.radius;
  const V = p.local.constructor;
  // orbitB put us at tp + u * (R + alt); recover u from the hover geometry.
  se.hover({ kind: 'body', star: se.earth.star, body }, 0, 0, 0, 0);
  const l = p.local.clone();
  const tp = l.clone().multiplyScalar((l.length() + R) / l.length());
  const s = tp.clone().negate().normalize();
  const side = s.clone().cross(new V(0, 1, 0)).normalize();
  const a = sunAngle * Math.PI / 180;
  const u = s.clone().multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a));
  se.hover({ kind: 'body', star: se.earth.star, body }, alt, 0, 0, 0);
  p.local.copy(tp).addScaledVector(u, R + alt);
  const f = u.clone().negate();
  const right = f.clone().cross(new V(0, 1, 0)).normalize();
  const up = right.clone().cross(f).normalize();
  f.addScaledVector(right, dx).addScaledVector(up, dy).normalize();
  look(f.x, f.y, f.z);
};
// geoB(name, latDeg, lonDeg, altKm, headingDeg, pitchDeg): camera above a geographic spot (east longitude), heading from north, pitch up.
const geoFrame = (name) => {
  const st = se.getView().bodies.find((b) => b.body.name === name);
  return st;
};
const geoDir = (st, lat, lon) => {
  const V = p.local.constructor;
  const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
  const n = new V(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo));
  n.applyAxisAngle(new V(0, 1, 0), window.__bodies.spinAngle(st.body, se.state().simTime)).applyQuaternion(st.view.group.quaternion);
  return n;
};
// Longitude at which the sun stands at the given angle from the zenith (afternoon side when pm).
const sunLon = (name, lat, angle, pm = true) => {
  const st = geoFrame(name);
  const sun = st.pos.clone().negate().normalize();
  let best = 0, err = 1e9;
  for (let lon = -180; lon < 180; lon += 0.25) {
    const d = geoDir(st, lat, lon);
    const e = Math.abs(Math.acos(Math.max(-1, Math.min(1, d.dot(sun)))) * 180 / Math.PI - angle);
    // afternoon: the sun is to the west, i.e. moving east brings it lower
    const d2 = geoDir(st, lat, lon + 1);
    const later = d2.dot(sun) < d.dot(sun);
    if (later === pm && e < err) { err = e; best = lon; }
  }
  return best;
};
const geoB = (name, lat, lon, alt, heading, pitch) => {
  const st = geoFrame(name);
  const t = { kind: 'body', star: se.earth.star, body: st.body };
  se.hover(t, alt, 0, 0, 0);
  const V = p.local.constructor, Q = p.quat.constructor;
  const up = geoDir(st, lat, lon);
  p.local.copy(st.pos).addScaledVector(up, st.body.radius + alt);
  const north = st.view.axis.clone().addScaledVector(up, -st.view.axis.dot(up)).normalize();
  const east = north.clone().cross(up).negate().normalize();
  const h = heading * Math.PI / 180, pt = pitch * Math.PI / 180;
  const f = north.clone().multiplyScalar(Math.cos(h)).addScaledVector(east, Math.sin(h)).multiplyScalar(Math.cos(pt)).addScaledVector(up, Math.sin(pt)).normalize();
  look(f.x, f.y, f.z);
  const cu = new V(0, 1, 0).applyQuaternion(p.quat);
  const want = up.clone().addScaledVector(f, -up.dot(f)).normalize();
  const ang = Math.atan2(cu.clone().cross(want).dot(f), cu.dot(want));
  p.quat.premultiply(new Q().setFromAxisAngle(f.clone().normalize(), ang));
};
// Camera's latitude / east longitude over a body.
const camGeo = (name) => {
  const st = geoFrame(name);
  const V = p.local.constructor;
  const d = p.local.clone().sub(st.pos).normalize().applyQuaternion(st.view.group.quaternion.clone().invert()).applyAxisAngle(new V(0, 1, 0), -window.__bodies.spinAngle(st.body, se.state().simTime));
  return [Math.asin(d.y) * 180 / Math.PI, Math.atan2(-d.z, d.x) * 180 / Math.PI];
};
// A scenic pose over Earth (planet 2) moved in time so the camera stands at east longitude lon.
const poseAt = (pose, name, lon) => {
  se.scenic(pose);
  const day = name === 'Earth' ? 86400 : null;
  const st = geoFrame(name);
  const period = st.body.rotationPeriod;
  for (let i = 0; i < 3; i++) {
    const [, lo] = camGeo(name);
    let dl = lon - lo; dl = ((dl + 540) % 360) - 180;
    // Moving forward in time turns the ground east under a fixed sun geometry: the camera lands further west.
    pose = { ...pose, t: (pose.t ?? 0) - dl / 360 * period };
    se.scenic(pose);
  }
  return camGeo(name);
};
// As poseAt, but first swings az (nearest to the given one) so the camera lands at latitude lat.
const poseLL = (pose, name, lat, lon) => {
  let best = pose.az, err = 1e9;
  for (let az = -Math.PI; az < Math.PI; az += 0.01) {
    se.scenic({ ...pose, az });
    const e = Math.abs(camGeo(name)[0] - lat) + 0.02 * Math.abs(az - pose.az);
    if (e < err) { err = e; best = az; }
  }
  // Moving in time to the longitude shifts the latitude a little too: search again from there, finely.
  for (let k = 0; k < 2; k++) {
    poseAt({ ...pose, az: best }, name, lon);
    const t = se.state().simTime;
    let b2 = best, e2 = 1e9;
    for (let az = best - 0.1; az < best + 0.1; az += 0.001) {
      se.scenic({ ...pose, az, t: (pose.t ?? 0) });
      const g = camGeo(name);
      const e = Math.abs(g[0] - lat);
      if (e < e2) { e2 = e; b2 = az; }
    }
    best = b2;
  }
  return poseAt({ ...pose, az: best }, name, lon);
};
// --- Staging for lighting shots (eclipses, planetshine). Positions in km relative to the star. ---
const bodyState = (name) => se.getView().bodies.find((b) => b.body.name === name);
const bodyAt = (name, t) => { const o = { x: 0, y: 0, z: 0 }; window.__bodies.bodyPosition(bodyState(name).body, t, o); return p.local.clone().set(o.x, o.y, o.z); };
// Aim at a point (km, star frame) with the horizon level for an observer whose up is 'up'.
const aimAt = (target, up) => {
  const V = p.local.constructor, Q = p.quat.constructor;
  const f = target.clone().sub(p.local).normalize();
  look(f.x, f.y, f.z);
  if (!up) return;
  const cu = new V(0, 1, 0).applyQuaternion(p.quat);
  const want = up.clone().addScaledVector(f, -up.dot(f)).normalize();
  const ang = Math.atan2(cu.clone().cross(want).dot(f), cu.dot(want));
  p.quat.premultiply(new Q().setFromAxisAngle(f, ang));
};
// Freeze the clock at a date, then (once the bodies have moved there) run 'then'.
const at = (when, then, fov) => {
  se.date(when);
  if (!se.state().paused) se.time('pause');
  if (fov) se.settings.fov = fov;
  setTimeout(then, 400);
};
// From 'dist' km off body 'name', on the side of 'from' (a body name or 'sun'), looking at the body.
const viewFrom = (name, from, dist, fov, when) => at(when, () => {
  const t = se.state().simTime;
  const c = bodyAt(name, t);
  const o = from === 'sun' ? p.local.clone().set(0, 0, 0) : bodyAt(from, t);
  se.placeAt({ kind: 'body', star: se.earth.star, body: bodyState(name).body });
  p.local.copy(c).addScaledVector(o.clone().sub(c).normalize(), dist);
  aimAt(c, p.local.clone().set(0, 1, 0));
}, fov);
// Standing at lat/lon on a body (km up), looking at the star, at a date.
const sunFrom = (name, lat, lon, alt, fov, when) => at(when, () => {
  geoB(name, lat, lon, alt, 0, 0);
  setTimeout(() => {
    const st = bodyState(name);
    aimAt(p.local.clone().set(0, 0, 0), p.local.clone().sub(st.pos).normalize());
  }, 1500);
}, fov);
// From 'dist' km off body 'name', 'phase' degrees round from the star's direction (0: sunlit side,
// 180: behind it, backlit), 'elev' degrees above the body's equator plane, looking at its centre with an 'aimOff' (deg) sideways.
const orbitView = (name, phase, elev, dist, fov, when, aimOff = 0) => at(when, () => {
  const st = bodyState(name);
  const t = se.state().simTime;
  const c = bodyAt(name, t);
  const V = p.local.constructor;
  const axis = st.view.axis.clone();
  const s = c.clone().negate().normalize();
  const flat = s.clone().addScaledVector(axis, -s.dot(axis)).normalize();
  const dir = flat.clone().applyAxisAngle(axis, phase * Math.PI / 180);
  const side = dir.clone().cross(axis).normalize();
  dir.applyAxisAngle(side, elev * Math.PI / 180);
  se.placeAt({ kind: 'body', star: se.earth.star, body: st.body });
  p.local.copy(c).addScaledVector(dir, dist);
  const f = c.clone().sub(p.local).normalize().applyAxisAngle(axis, aimOff * Math.PI / 180);
  aimAt(p.local.clone().add(f), axis);
}, fov);
// The moment within 'days' after 'from' when moon 'm' stands most nearly between the star and planet 'pl'.
const transit = (pl, m, from, days) => {
  se.date(from);
  const t0 = se.state().simTime;
  let best = t0, bestA = 9;
  for (let t = t0; t < t0 + days * 86400; t += 300) {
    const c = bodyAt(pl, t), q = bodyAt(m, t);
    const a = q.clone().sub(c).normalize().angleTo(c.clone().negate().normalize());
    if (a < bestA) { bestA = a; best = t; }
  }
  return new Date(Date.parse(from) + (best - t0) * 1000).toISOString();
};
// On Earth's night side, as deep in the night as possible with nebula 'neb' (by name) on the horizon, looking at it.
const nightToward = (neb, alt, pitchDeg, sunTilt = 0) => {
  const n = window.__nebulae.NEBULAE.find((x) => x.name.includes(neb));
  const st = bodyState('Earth');
  se.hover(se.earth, alt, 0, 0, 0);
  const g = { x: 0, y: 0, z: 0 }; p.galactic(g);
  const V = p.local.constructor;
  const d = new V(n.x - g.x, n.y - g.y, n.z - g.z).normalize();
  const s = st.pos.clone().negate().normalize();
  // Straight away from the Sun, tilted towards it by sunTilt degrees (for twilight), kept square to d.
  const away = s.clone().negate();
  const up = away.clone().addScaledVector(d, -away.dot(d)).normalize();
  const side = up.clone().cross(d).normalize();
  up.applyAxisAngle(side, (sunTilt * Math.PI) / 180);
  p.local.copy(st.pos).addScaledVector(up, st.body.radius + alt);
  const f = d.clone().applyAxisAngle(up.clone().cross(d).normalize(), -(pitchDeg * Math.PI) / 180);
  aimAt(p.local.clone().add(f), up);
};
// As sunFrom, then looking 'down' degrees below the star (towards the horizon under it).
const sunFromLow = (name, lat, lon, alt, fov, when, down) => {
  sunFrom(name, lat, lon, alt, fov, when);
  setTimeout(() => {
    const st = bodyState(name);
    const up = p.local.clone().sub(st.pos).normalize();
    const f = p.local.clone().negate().normalize();
    const axis = f.clone().cross(up).normalize();
    f.applyAxisAngle(axis, -down * Math.PI / 180);
    aimAt(p.local.clone().add(f), up);
  }, 2600);
};
// Behind body 'name' from the star, swung 'off' degrees about its axis, aimed between the body and the star.
const behind = (name, dist, off, fov, when) => at(when, () => {
  const st = bodyState(name);
  const c = bodyAt(name, se.state().simTime);
  const s = c.clone().negate().normalize();
  const axis = st.view.axis.clone();
  const dir = s.clone().negate().applyAxisAngle(axis, off * Math.PI / 180);
  se.placeAt({ kind: 'body', star: se.earth.star, body: st.body });
  p.local.copy(c).addScaledVector(dir, dist);
  const toC = c.clone().sub(p.local).normalize();
  const f = toC.clone().lerp(s, 0.45).normalize();
  aimAt(p.local.clone().add(f), axis);
}, fov);
// The nearest body, from 'alt' km, looking 'pitch' degrees down (90: straight down).
const lookDown = (alt, pitch) => {
  const v = se.getView();
  let best = null, bd = Infinity;
  for (const b of v.bodies) { const d = b.pos.distanceTo(p.local) - b.body.radius; if (d < bd) { bd = d; best = b; } }
  const up = p.local.clone().sub(best.pos).normalize();
  se.hover({ kind: 'body', star: v.system.star, body: best.body }, alt, 0, 0, 0);
  p.local.copy(best.pos).addScaledVector(up, best.body.radius + alt);
  const V = p.local.constructor;
  const east = new V(0, 1, 0).cross(up).normalize();
  const f = east.clone().applyAxisAngle(up.clone().cross(east).normalize(), pitch * Math.PI / 180);
  aimAt(p.local.clone().add(f), up);
};
// From 'alt' km over Earth, the Sun 'above' degrees over the limb, looking towards it but 'down'
// degrees lower (so the limb crosses the lower middle of the frame), the limb tilted by 'roll' degrees.
const limbSun = (alt, above, down, fov = 60, roll = 0) => {
  const st = bodyState('Earth');
  const R = st.body.radius, r = R + alt;
  se.hover(se.earth, alt, 0, 0, 0);
  const E = st.pos.clone(), s = E.clone().negate().normalize();
  const V = p.local.constructor;
  const w = new V(0, 1, 0).cross(s).normalize();
  const horizon = Math.asin(R / r);
  const beta = Math.PI - horizon - (above * Math.PI) / 180;
  const u = s.clone().multiplyScalar(Math.cos(beta)).addScaledVector(w, Math.sin(beta)).normalize();
  p.local.copy(E).addScaledVector(u, r);
  const toC = u.clone().negate();
  const axis = s.clone().cross(toC).normalize();
  const f = s.clone().applyAxisAngle(axis, (down * Math.PI) / 180);
  se.settings.fov = fov;
  const up = u.clone().applyAxisAngle(f, (roll * Math.PI) / 180);
  aimAt(p.local.clone().add(f), up);
};
