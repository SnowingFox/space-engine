// Feature toggles for scripts/perf.mjs. Prints js that defines window.__toggle(on), which switches
// the named parts of the frame off (on = false) and back. Used with AB=1, which alternates the two
// states and times each, so the cost of a part is the difference within one page:
//   AB=1 OFF="$(node scripts/perfOff.mjs sky clouds)" node scripts/perf.mjs e400
const LAYER = {
  // The sky shell (far side of the atmosphere).
  sky: 'm.uniforms?.uAirglow !== undefined',
  // The extinction veil over what lies behind the air.
  veil: 'm.blendSrc === 200 && m.blending === 5',
  // The cloud deck (terrain shares its uniforms, so it is told apart by its transparency).
  clouds: 'm.uniforms?.uCloudColor && !m.uniforms.uCubeCenter && m.transparent',
  // Terrain patches drawn on screen (the shadow pass keeps its own copies).
  terrain: 'm.uniforms?.uCubeCenter && m.defines?.TERRAIN_SHADOW',
  aurora: 'm.uniforms?.uShell',
  rings: 'm.uniforms?.uRingMapOn && m.uniforms?.uColor && !m.uniforms?.uPal',
  glare: 'm.uniforms?.uStreak',
};
const EXTRA = {
  // The terrain's fragment shader only (the patches still go through the vertex shader and the depth test).
  tfrag: `se.pipeline.scene.traverse((o) => { const m = o.userData.__mat ?? o.material;
    if (!m?.uniforms?.uCubeCenter || !m.defines?.TERRAIN_SHADOW) return;
    o.userData.__mat = m;
    o.userData.__flat ??= new m.constructor({ vertexShader: m.vertexShader, fragmentShader: 'void main() { gl_FragColor = vec4(0.5); }', uniforms: m.uniforms, defines: m.defines });
    o.material = on ? m : o.userData.__flat; });`,
  bloom: 'se.pipeline.bloom.enabled = on;',
  bg: 'se.pipeline.bgScene.visible = on;',
  // Terrain shadows: map redraws and lookups.
  shadow: `for (const s of se.getView().bodies) { const sh = s.view.shadow; if (!sh) continue;
    sh.__update ??= sh.update; sh.update = on ? sh.__update : () => { sh.uniforms.uShadowOn.value = 0; }; }`,
  // Atmosphere in the surface shaders (haze, sunlight colour, mirrored sky): density to zero.
  surfair: `for (const s of se.getView().bodies) { const u = s.view.uniforms.uAtmoDensity; u.__v ??= u.value; u.value = on ? u.__v : 0; }`,
};
const picks = process.argv.slice(2);
const conds = picks.filter((p) => LAYER[p]).map((p) => `(${LAYER[p]})`);
let body = '';
if (conds.length) body += `se.pipeline.scene.traverse((o) => { const m = o.material; if (m && (${conds.join(' || ')})) o.layers.set(on ? 0 : 5); });`;
for (const p of picks) if (EXTRA[p]) body += EXTRA[p];
if (!process.env.SWAP) console.log(`window.__toggle = (on) => { ${body} };`);
// SWAP='[["from", "to"], ...]': instead of the named parts, toggle these substitutions in the terrain's fragment shader.
if (process.env.SWAP) {
  const swaps = JSON.stringify(JSON.parse(process.env.SWAP));
  console.log(`window.__toggle = (on) => { se.pipeline.scene.traverse((o) => { const m = o.userData.__mat ?? o.material;
    if (!m?.uniforms?.uCubeCenter || !m.defines?.TERRAIN_SHADOW) return;
    o.userData.__mat = m;
    if (!o.userData.__alt) { let f = m.fragmentShader; let vs = m.vertexShader; for (const [a, b] of ${swaps}) { if (!f.includes(a) && !vs.includes(a)) console.error('swap miss: ' + a); f = f.split(a).join(b); vs = vs.split(a).join(b); }
      o.userData.__alt = new m.constructor({ vertexShader: vs, fragmentShader: f, uniforms: m.uniforms, defines: m.defines }); }
    o.material = on ? m : o.userData.__alt; }); };`.replace(/\n\s*/g, ' '));
}
