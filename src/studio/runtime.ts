import type { AudioFeatures, Curve, PointModel, SceneContext, SceneDefinition } from '../engine/types';
import { formations } from '../engine/formations';
import { cameraPosition, liveValues, loopParam, setLive, specModels, trackValue, type Leaf, type Axis, type StudioForm, type StudioLayer, type StudioSource, type StudioSpec } from './spec';

/**
 * Plays a StudioSpec (see spec.ts): the engine behind every scene made in the Scene Studio.
 * Scenes reach it as `ctx.helpers.studio.setup(ctx, spec)` / `.update(ctx, spec)`.
 *
 * Numbers in the spec are read live every frame, so the studio can edit a running scene in place.
 * Geometry is rebuilt only when the layers, their forms or the particle shares change, and colours
 * only when `spec.rev` changes.
 */

const BANDS = 64;
const TAU = Math.PI * 2;
/** Keeps designed colours from blowing out under additive blending. */
const BASE = 0.75;

interface FormData {
  pos: Float32Array;        // unit-size, centred, unrotated
  nrm: Float32Array;
  col: Float32Array;        // base colour per particle
  modelCol: Float32Array | null;
  u: Float32Array;          // 0..1 position along the layer's spectrum axis
  part: Uint8Array;
  partNames: string[];
  ext: Float32Array;        // half-extents x, y, z and max radius
  pLift: Float32Array;      // per part, refreshed each frame
  pPush: Float32Array;
  pGlow: Float32Array;
  hasParts: boolean;
  m: Float32Array;          // 3×3 rotation for this frame
  s: number; ox: number; oy: number; oz: number;
}

export interface LayerData {
  id: string; start: number; n: number; forms: FormData[]; spin: number;
  /** Where the layer is right now (centre and half-size), for picking it in the view. */
  cx: number; cy: number; cz: number; cr: number;
}

export interface StudioState {
  rev: number | undefined;
  sig: string;
  layers: LayerData[];
  used: number;
  env: number[];
  delta: Record<string, number>;
  stage: number; t: number; timer: number; moving: boolean;
  bg: string; glow: number; style: string;
  loopT: number;
  /** Which loop is playing (-1 = none), and the settings as they were before it started. */
  loopIndex: number;
  loopBase: Map<string, Leaf> | null;
  /** The automatic morph position (stage + progress), so a loop recording can capture it. */
  morphS: number; maxForms: number;
  r1: Float32Array; r2: Float32Array;
}

const hexRgb = (h: string, out: number[]) => {
  const v = parseInt(h.slice(1), 16);
  out[0] = ((v >> 16) & 255) / 255; out[1] = ((v >> 8) & 255) / 255; out[2] = (v & 255) / 255;
  return out;
};

const hzToBand = (f: number) =>
  Math.min(BANDS - 1, Math.max(0, Math.round((BANDS * Math.log(Math.max(30, f) / 30)) / Math.log(16000 / 30))));

function curve(v: number, c: Curve): number {
  switch (c) {
    case 'sqrt': return Math.sqrt(v);
    case 'square': return v * v;
    case 'exp': return (Math.exp(v * 3) - 1) / (Math.exp(3) - 1);
    case 'smooth': return v * v * (3 - 2 * v);
    case 'threshold': return v > 0.5 ? 1 : 0;
    default: return v;
  }
}

/** Current level (about 0..1) of a source. */
export function sourceValue(src: StudioSource, audio: AudioFeatures): number {
  if (src.kind === 'band') {
    const b0 = hzToBand(src.lo), b1 = Math.max(b0, hzToBand(src.hi));
    let s = 0;
    for (let b = b0; b <= b1; b++) s += audio.spectrum[b];
    return s / (b1 - b0 + 1);
  }
  if (src.name === 'beat') return audio.beat ? 1 : 0;
  if (src.name === 'constant') return 1;
  const v = (audio as unknown as Record<string, number>)[src.name];
  return typeof v === 'number' ? v : 0;
}

// ---------- Geometry ----------

function shapePoints(F: StudioForm, n: number, pos: Float32Array) {
  const f = formations;
  switch (F.shape) {
    case 'ball': f.sphere(pos, n, 1, false); break;
    case 'cube': f.cube(pos, n, 2, true); break;
    case 'torus': f.torus(pos, n, 1, 0.35); break;
    case 'knot': f.torusKnot(pos, n, 1); break;
    case 'plane': f.grid(pos, n, 2, 2); break;
    case 'galaxy': f.galaxy(pos, n, 1); break;
    case 'helix': f.helix(pos, n, 0.5, 2); break;
    case 'lorenz': f.lorenz(pos, n, 1); break;
    case 'ring': f.ring(pos, n, 1, 0.15); break;
    default: f.sphere(pos, n, 1, true);
  }
}

function buildForm(F: StudioForm, n: number, models: Record<string, PointModel>): FormData {
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), part = new Uint8Array(n);
  let modelCol: Float32Array | null = null;
  let partNames: string[] = [];
  const model = F.kind === 'model' ? models[F.model] : undefined;

  if (model) {
    modelCol = new Float32Array(n * 3);
    partNames = model.partNames;
    for (let i = 0; i < n; i++) {
      const src = Math.min(model.count - 1, Math.floor((i * model.count) / n));
      const a = src * 3, k = i * 3;
      pos[k] = model.positions[a]; pos[k + 1] = model.positions[a + 1]; pos[k + 2] = model.positions[a + 2];
      nrm[k] = model.normals[a]; nrm[k + 1] = model.normals[a + 1]; nrm[k + 2] = model.normals[a + 2];
      modelCol[k] = model.colors[a]; modelCol[k + 1] = model.colors[a + 1]; modelCol[k + 2] = model.colors[a + 2];
      part[i] = model.parts[src];
    }
  } else {
    shapePoints(F, n, pos);
  }

  // Centre on the bounding box and scale so the largest half-extent is 1.
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n * 3; i++) { const a = i % 3; if (pos[i] < lo[a]) lo[a] = pos[i]; if (pos[i] > hi[a]) hi[a] = pos[i]; }
  const c = [0, 1, 2].map((a) => (n ? (lo[a] + hi[a]) / 2 : 0));
  const half = Math.max(1e-6, ...[0, 1, 2].map((a) => (n ? (hi[a] - lo[a]) / 2 : 1)));
  let maxR = 1e-6;
  for (let i = 0; i < n; i++) {
    const k = i * 3;
    const x = (pos[k] = (pos[k] - c[0]) / half), y = (pos[k + 1] = (pos[k + 1] - c[1]) / half), z = (pos[k + 2] = (pos[k + 2] - c[2]) / half);
    const r = Math.sqrt(x * x + y * y + z * z);
    if (r > maxR) maxR = r;
    if (!model) {
      // Approximate surface normals for the built-in shapes.
      let nx = x, ny = y, nz = z;
      if (F.shape === 'plane') { nx = 0; ny = 1; nz = 0; }
      else if (F.shape === 'cube') {
        const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
        nx = ax >= ay && ax >= az ? Math.sign(x) : 0; ny = ay > ax && ay >= az ? Math.sign(y) : 0; nz = az > ax && az > ay ? Math.sign(z) : 0;
      } else if (F.shape === 'torus' || F.shape === 'ring') {
        const d = Math.sqrt(x * x + z * z) || 1, R = 1 / 1.35;
        nx = x - (x / d) * R; ny = y; nz = z - (z / d) * R;
      }
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nrm[k] = nx / l; nrm[k + 1] = ny / l; nrm[k + 2] = nz / l;
    }
  }
  const np = Math.max(1, partNames.length);
  return {
    pos, nrm, modelCol, part, partNames,
    col: new Float32Array(n * 3), u: new Float32Array(n),
    ext: new Float32Array([(hi[0] - lo[0]) / 2 / half || 1, (hi[1] - lo[1]) / 2 / half || 1, (hi[2] - lo[2]) / 2 / half || 1, maxR]),
    pLift: new Float32Array(np), pPush: new Float32Array(np), pGlow: new Float32Array(np), hasParts: false,
    m: new Float32Array(9), s: 1, ox: 0, oy: 0, oz: 0,
  };
}

/** 0..1 position of particle i of a form along an axis. */
function axisCoord(fd: FormData, axis: Axis, i: number, rnd: number): number {
  const k = i * 3, e = fd.ext;
  switch (axis) {
    case 'width': return (fd.pos[k] / e[0] + 1) / 2;
    case 'depth': return (fd.pos[k + 2] / e[2] + 1) / 2;
    case 'radius': return Math.sqrt(fd.pos[k] ** 2 + fd.pos[k + 1] ** 2 + fd.pos[k + 2] ** 2) / e[3];
    case 'random': return rnd;
    default: return (fd.pos[k + 1] / e[1] + 1) / 2;
  }
}

/** Base colours and spectrum coordinates of one form. */
function paintForm(fd: FormData, F: StudioForm, L: StudioLayer, n: number, start: number, r1: Float32Array) {
  const a = hexRgb(F.color.a, []), b = hexRgb(F.color.b, []);
  const partCol = fd.partNames.map((name) => (F.parts[name]?.color ? hexRgb(F.parts[name].color!, []) : null));
  const np = fd.partNames.length;
  fd.hasParts = fd.partNames.some((name) => {
    const p = F.parts[name];
    return !!p && !!p.source && !!(p.lift || p.push || p.glow);
  });
  const axis = L.spectrum.axis;
  for (let i = 0; i < n; i++) {
    const k = i * 3, rnd = r1[start + i];
    let r: number, g: number, bl: number;
    const pc = np ? partCol[fd.part[i]] : null;
    if (pc) { r = pc[0]; g = pc[1]; bl = pc[2]; }
    else if (F.color.mode === 'model' && fd.modelCol) { r = fd.modelCol[k]; g = fd.modelCol[k + 1]; bl = fd.modelCol[k + 2]; }
    else if (F.color.mode === 'gradient') {
      const t = Math.min(1, Math.max(0, axisCoord(fd, F.color.axis, i, rnd)));
      r = a[0] + (b[0] - a[0]) * t; g = a[1] + (b[1] - a[1]) * t; bl = a[2] + (b[2] - a[2]) * t;
    } else { r = a[0]; g = a[1]; bl = a[2]; }
    fd.col[k] = r * BASE; fd.col[k + 1] = g * BASE; fd.col[k + 2] = bl * BASE;
    fd.u[i] = axis === 'none' ? 0
      : axis === 'part' ? (np > 1 ? fd.part[i] / (np - 1) : rnd)
      : Math.min(1, Math.max(0, axisCoord(fd, axis, i, rnd)));
  }
}

/** Bring the built geometry and colours in line with the spec. */
function sync(ctx: SceneContext, spec: StudioSpec, st: StudioState) {
  const visible = spec.layers.filter((L) => L.visible && L.forms.length);
  const sig = JSON.stringify([ctx.count, Object.keys(ctx.models), visible.map((L) => [L.id, L.share, L.forms.map((F) => [F.kind, F.shape, F.model])])]);
  if (sig !== st.sig) {
    const total = visible.reduce((s, L) => s + Math.max(0.0001, L.share), 0);
    const prev = new Map(st.layers.map((l) => [l.id, l.spin]));
    let start = 0;
    st.layers = visible.map((L, i) => {
      const n = i === visible.length - 1 ? ctx.count - start : Math.min(ctx.count - start, Math.round((ctx.count * Math.max(0.0001, L.share)) / total));
      const ld: LayerData = { id: L.id, start, n, forms: L.forms.map((F) => buildForm(F, n, ctx.models)), spin: prev.get(L.id) ?? 0, cx: 0, cy: 0, cz: 0, cr: 1 };
      start += n;
      return ld;
    });
    st.used = start;
    st.sig = sig;
    for (let i = st.used; i < ctx.count; i++) ctx.alphas[i] = 0;
  }
  st.layers.forEach((ld) => {
    const L = spec.layers.find((x) => x.id === ld.id)!;
    ld.forms.forEach((fd, fi) => paintForm(fd, L.forms[fi], L, ld.n, ld.start, st.r1));
  });
  st.rev = spec.rev;
}

// ---------- Per frame ----------

/** Rotation matrix: spin around Y (degrees), applied after the form's own x, y, z rotation. */
function rotation(out: Float32Array, rot: [number, number, number], spin: number) {
  const d = Math.PI / 180;
  const cx = Math.cos(rot[0] * d), sx = Math.sin(rot[0] * d);
  const cy = Math.cos(rot[1] * d + spin * d), sy = Math.sin(rot[1] * d + spin * d);
  const cz = Math.cos(rot[2] * d), sz = Math.sin(rot[2] * d);
  // R = Ry · Rx · Rz
  out[0] = cy * cz + sy * sx * sz; out[1] = -cy * sz + sy * sx * cz; out[2] = sy * cx;
  out[3] = cx * sz; out[4] = cx * cz; out[5] = -sx;
  out[6] = -sy * cz + cy * sx * sz; out[7] = sy * sz + cy * sx * cz; out[8] = cy * cx;
}

// Scratch for one sampled particle (avoids allocating in the particle loop).
let px = 0, py = 0, pz = 0, qx = 0, qy = 0, qz = 0, cr = 0, cg = 0, cb = 0, cu = 0, cLift = 0, cPush = 0, cGlow = 0;
function sample(fd: FormData, i: number) {
  const k = i * 3, m = fd.m, p = fd.pos, nn = fd.nrm;
  const x = p[k], y = p[k + 1], z = p[k + 2];
  px = (m[0] * x + m[1] * y + m[2] * z) * fd.s + fd.ox;
  py = (m[3] * x + m[4] * y + m[5] * z) * fd.s + fd.oy;
  pz = (m[6] * x + m[7] * y + m[8] * z) * fd.s + fd.oz;
  const a = nn[k], b = nn[k + 1], c = nn[k + 2];
  qx = m[0] * a + m[1] * b + m[2] * c; qy = m[3] * a + m[4] * b + m[5] * c; qz = m[6] * a + m[7] * b + m[8] * c;
  cr = fd.col[k]; cg = fd.col[k + 1]; cb = fd.col[k + 2];
  cu = fd.u[i];
  if (fd.hasParts) { const pt = fd.part[i]; cLift = fd.pLift[pt]; cPush = fd.pPush[pt]; cGlow = fd.pGlow[pt]; }
  else { cLift = 0; cPush = 0; cGlow = 0; }
}

const tmpA: number[] = [], tmpB: number[] = [], tmpC: number[] = [];
const hue = new Float32Array(9);

let loopCam = false;
/** Write one looped setting, noting what else has to follow (a repaint, the camera). */
function writeLooped(ctx: SceneContext, spec: StudioSpec, path: string, v: Leaf) {
  const changed = setLive(spec, path, v);
  if (path.startsWith('camera.')) loopCam = true;
  // Colours and part reactions are baked per particle: repaint when one changes.
  else if (changed && (typeof v !== 'number' || path.includes('.parts.')) && path.startsWith('layer:')) spec.rev = (spec.rev ?? 0) + 1;
}

/**
 * Stop the playing loop's hold on the spec: settings it changed go back to what they were before it
 * started. The runtime calls this when the loop changes; the studio calls it before restarting a scene.
 */
export function settleLoop(ctx: SceneContext, spec: StudioSpec) {
  const st = ctx.state.studio as StudioState | undefined;
  if (!st?.loopBase) return;
  for (const [path, v] of st.loopBase) writeLooped(ctx, spec, path, v);
  st.loopBase = null;
  st.loopIndex = -1;
  if (loopCam) { loopCam = false; ctx.setCamera({ position: cameraPosition(spec.camera), target: spec.camera.target, fov: spec.camera.fov }); }
}

export function studioSetup(ctx: SceneContext, spec: StudioSpec) {
  const r1 = new Float32Array(ctx.count), r2 = new Float32Array(ctx.count);
  for (let i = 0; i < ctx.count; i++) { r1[i] = ctx.helpers.rand(i, 11); r2[i] = ctx.helpers.rand(i, 23); }
  const st: StudioState = {
    rev: undefined, sig: '', layers: [], used: 0, env: [], delta: {},
    stage: 0, t: 0, timer: 0, moving: false, bg: '', glow: -1, style: '', loopT: 0, loopIndex: -1, loopBase: null, morphS: 0, maxForms: 1, r1, r2,
  };
  ctx.state.studio = st;
  ctx.alphas.fill(1);
  sync(ctx, spec, st);
}

export function studioUpdate(ctx: SceneContext, spec: StudioSpec) {
  let st = ctx.state.studio as StudioState | undefined;
  if (!st) { studioSetup(ctx, spec); st = ctx.state.studio as StudioState; }

  // Recorded loops: the playing one writes its values into the spec, so everything below (and the
  // studio's sliders) follows it. The scene's "loop" param picks it; without one, spec.activeLoop does.
  let morphFromLoop: number | undefined;
  let want = ctx.params.loop !== undefined ? Math.round(ctx.params.loop) - 1 : spec.activeLoop;
  if (want >= spec.loops.length || want < -1) want = -1;
  if (want !== st.loopIndex) {
    settleLoop(ctx, spec); // put back what the previous loop changed
    st.loopIndex = want;
    st.loopT = 0;
    if (want >= 0) {
      const now = liveValues(spec);
      st.loopBase = new Map();
      for (const tr of spec.loops[want].tracks) if (tr.path in now) st.loopBase.set(tr.path, now[tr.path]);
    }
  }
  const loop = spec.loops[st.loopIndex];
  if (loop && loop.duration > 0) {
    st.loopT = (st.loopT + ctx.dt) % loop.duration;
    for (const tr of loop.tracks) {
      const v = trackValue(tr, st.loopT);
      if (tr.path === '@morph') { if (typeof v === 'number') morphFromLoop = v; continue; }
      writeLooped(ctx, spec, tr.path, v);
    }
    if (loopCam) { loopCam = false; ctx.setCamera({ position: cameraPosition(spec.camera), target: spec.camera.target, fov: spec.camera.fov }); }
  }
  if (st.rev !== spec.rev) sync(ctx, spec, st);

  const { audio, macros, targets, velocities, colors, sizes, alphas, dt, sdt } = ctx;
  const spectrum = audio.spectrum;

  // Mappings → deltas added to their targets.
  const d = st.delta;
  for (const k in d) d[k] = 0;
  spec.mappings.forEach((m, i) => {
    if (!m.enabled) { st!.env[i] = 0; return; }
    const v = curve(Math.min(1, Math.max(0, sourceValue(m.source, audio))), m.curve);
    let e = st!.env[i] ?? 0;
    const tc = v > e ? m.attack : m.release;
    e += (v - e) * (tc <= 0 ? 1 : 1 - Math.exp(-dt / tc));
    st!.env[i] = e;
    d[m.target] = (d[m.target] ?? 0) + e * m.amount;
  });
  const D = (k: string) => d[k] ?? 0;

  // Space. (The camera is set when the scene starts and then belongs to the view: the studio keeps the spec in step with it.)
  if (st.bg !== spec.space.color) { st.bg = spec.space.color; const c = hexRgb(st.bg, tmpA); ctx.setBackground(c[0], c[1], c[2]); }
  // Glowing particles only add light, so they vanish against a light space: draw solid dots there.
  const bgc = hexRgb(spec.space.color, tmpA);
  const style = spec.space.particles === 'auto'
    ? (0.2126 * bgc[0] + 0.7152 * bgc[1] + 0.0722 * bgc[2] > 0.3 ? 'solid' : 'glow')
    : spec.space.particles;
  if (st.style !== style) { st.style = style; ctx.setParticleStyle(style); }
  const solid = style === 'solid';
  // Bloom smears a light background over dark dots: keep it off in solid mode.
  const glow = solid ? 0 : Math.max(0, spec.space.glow + D('space.glow'));
  if (Math.abs(glow - st.glow) > 0.005) { st.glow = glow; ctx.setBloom(glow); }

  // Light.
  const lit = spec.light.enabled;
  const az = (spec.light.azimuth + D('light.azimuth')) * (Math.PI / 180), el = (spec.light.elevation + D('light.elevation')) * (Math.PI / 180);
  const Lx = Math.sin(az) * Math.cos(el), Ly = Math.sin(el), Lz = Math.cos(az) * Math.cos(el);
  const LI = Math.max(0, spec.light.intensity + D('light.intensity')), amb = Math.max(0, spec.light.ambient + D('light.ambient'));
  const lc = hexRgb(spec.light.color, tmpA), fc = hexRgb(spec.light.fill, tmpB), FI = spec.light.fillIntensity;

  // Colour shift as a 3×3 matrix (hue rotation), so it costs nine multiplies per particle.
  const shift = spec.hueShift + D('hueShift');
  const shifting = Math.abs(shift) > 0.002;
  if (shifting) {
    const c = Math.cos(shift * TAU), s = Math.sin(shift * TAU);
    hue[0] = 0.299 + 0.701 * c + 0.168 * s; hue[1] = 0.587 - 0.587 * c + 0.330 * s; hue[2] = 0.114 - 0.114 * c - 0.497 * s;
    hue[3] = 0.299 - 0.299 * c - 0.328 * s; hue[4] = 0.587 + 0.413 * c + 0.035 * s; hue[5] = 0.114 - 0.114 * c + 0.292 * s;
    hue[6] = 0.299 - 0.300 * c + 1.250 * s; hue[7] = 0.587 - 0.588 * c - 1.050 * s; hue[8] = 0.114 + 0.886 * c - 0.203 * s;
  }

  // Morph: which two forms each layer is between, and how far.
  const maxForms = st.layers.reduce((mx, l) => Math.max(mx, l.forms.length), 1);
  st.maxForms = maxForms;
  const extra = D('morph.position') + macros.morph;
  let stage = 0, t = 0;
  const manual = spec.morph.mode === 'manual';
  if (maxForms > 1) {
    let s: number;
    if (manual) {
      s = Math.min(1, Math.max(0, spec.morph.position + extra)) * (maxForms - 1);
    } else {
      if (morphFromLoop !== undefined) {
        st.morphS = morphFromLoop;
      } else {
        if (spec.morph.mode === 'time') st.timer += sdt; else if (audio.beat) st.timer += 1;
        if (!st.moving && st.timer >= spec.morph.every) st.moving = true;
        if (st.moving) {
          st.t += dt / Math.max(0.05, spec.morph.blend);
          if (st.t >= 1) { st.stage++; st.t = 0; st.moving = false; st.timer = 0; }
        }
        st.morphS = st.stage + st.t;
      }
      s = st.morphS + Math.min(1, Math.max(-1, extra)) * (maxForms - 1);
    }
    stage = Math.floor(s); t = s - stage;
  }

  const react = 0.4 + macros.intensity;
  // Colours are dimmed (BASE) so glowing particles don't blow out; solid dots show them as picked.
  const unBase = solid ? 1 / BASE : 1;
  const gBright = Math.max(0, spec.brightness + D('brightness'));
  const burst = audio.beat ? spec.motion.burst * (0.5 + macros.impulse) : 0;
  const burstSalt = ctx.frame & 7;

  for (const ld of st.layers) {
    const L = spec.layers.find((x) => x.id === ld.id);
    if (!L || !ld.n) continue;
    const key = `layer:${L.id}.`;
    const nf = ld.forms.length;
    let a = 0, b = 0, w = t;
    if (nf > 1) {
      if (manual) { a = Math.min(stage, nf - 1); b = Math.min(stage + 1, nf - 1); }
      else { a = ((stage % nf) + nf) % nf; b = (a + 1) % nf; }
    }
    if (a === b) w = 0;

    ld.spin = (ld.spin + (L.spin + D(key + 'spin')) * sdt) % 360;
    const lScale = Math.max(0.01, L.scale + D(key + 'scale')), lift = L.lift + D(key + 'lift');
    for (const fi of w > 0 ? [a, b] : [a]) {
      const fd = ld.forms[fi], F = L.forms[fi];
      rotation(fd.m, F.rotation, ld.spin);
      fd.s = F.scale * lScale; fd.ox = F.position[0]; fd.oy = F.position[1] + lift; fd.oz = F.position[2];
      if (fd.hasParts) {
        fd.partNames.forEach((name, p) => {
          const cfg = F.parts[name];
          const v = cfg?.source ? sourceValue(cfg.source, audio) : 0;
          fd.pLift[p] = (cfg?.lift ?? 0) * v * react; fd.pPush[p] = (cfg?.push ?? 0) * v * react; fd.pGlow[p] = (cfg?.glow ?? 0) * v;
        });
      }
    }
    const A = ld.forms[a], B = ld.forms[b];
    ld.cx = A.ox + (B.ox - A.ox) * w; ld.cy = A.oy + (B.oy - A.oy) * w; ld.cz = A.oz + (B.oz - A.oz) * w; ld.cr = A.s + (B.s - A.s) * w;

    const sp = L.spectrum, useSpec = sp.axis !== 'none';
    const sb0 = hzToBand(sp.lo), sbN = Math.max(0, hzToBand(sp.hi) - sb0);
    const push = (sp.push + D(key + 'spectrum.push')) * react, sGlow = Math.max(0, sp.glow + D(key + 'spectrum.glow'));
    const tint = hexRgb(sp.tint, tmpC), tintAmt = sp.tintAmount;
    const size = Math.max(0, L.size + D(key + 'size')), bright = Math.max(0, L.brightness + D(key + 'brightness')) * gBright;
    const explode = L.explode + D(key + 'explode');
    const { r1, r2 } = st;

    for (let i = 0; i < ld.n; i++) {
      const gi = ld.start + i, j = gi * 3;
      sample(A, i);
      if (w > 0) {
        // Stagger the transition per particle so the form dissolves and re-forms.
        let tt = w * 1.6 - r1[gi] * 0.6;
        tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
        tt = tt * tt * (3 - 2 * tt);
        if (tt > 0) {
          const ax = px, ay = py, az2 = pz, anx = qx, any = qy, anz = qz, ar = cr, ag = cg, ab = cb, au = cu, al = cLift, ap = cPush, agl = cGlow;
          sample(B, i);
          const s = 1 - tt;
          px = ax * s + px * tt; py = ay * s + py * tt; pz = az2 * s + pz * tt;
          qx = anx * s + qx * tt; qy = any * s + qy * tt; qz = anz * s + qz * tt;
          cr = ar * s + cr * tt; cg = ag * s + cg * tt; cb = ab * s + cb * tt;
          cu = au * s + cu * tt; cLift = al * s + cLift * tt; cPush = ap * s + cPush * tt; cGlow = agl * s + cGlow * tt;
        }
      }
      const v = useSpec ? spectrum[sb0 + Math.round(cu * sbN)] : 0;
      const disp = explode + v * push + cPush;
      targets[j] = px + qx * disp; targets[j + 1] = py + qy * disp + cLift; targets[j + 2] = pz + qz * disp;

      if (tintAmt > 0 && v > 0) {
        const k = Math.min(1, v * tintAmt);
        cr += (tint[0] * BASE - cr) * k; cg += (tint[1] * BASE - cg) * k; cb += (tint[2] * BASE - cb) * k;
      }
      if (lit) {
        const ndl = qx * Lx + qy * Ly + qz * Lz;
        const kd = ndl > 0 ? ndl * LI : 0, kf = ndl < 0 ? -ndl * FI : 0;
        cr *= amb + kd * lc[0] + kf * fc[0]; cg *= amb + kd * lc[1] + kf * fc[1]; cb *= amb + kd * lc[2] + kf * fc[2];
      }
      if (shifting) {
        const r = cr, g = cg, bl = cb;
        cr = hue[0] * r + hue[1] * g + hue[2] * bl; cg = hue[3] * r + hue[4] * g + hue[5] * bl; cb = hue[6] * r + hue[7] * g + hue[8] * bl;
        if (cr < 0) cr = 0; if (cg < 0) cg = 0; if (cb < 0) cb = 0;
      }
      const br = bright * (1 + v * sGlow + cGlow) * unBase;
      colors[j] = cr * br; colors[j + 1] = cg * br; colors[j + 2] = cb * br;
      sizes[gi] = size * (1 + v * sp.size) * (0.7 + r2[gi] * 0.6);
      alphas[gi] = 1;

      if (burst > 0 && ctx.helpers.rand(i, burstSalt) < 0.35) {
        velocities[j] += qx * burst; velocities[j + 1] += qy * burst; velocities[j + 2] += qz * burst;
      }
    }
  }

  ctx.integrate({
    spring: Math.max(0.1, spec.motion.spring + D('motion.spring')),
    damping: spec.motion.damping,
    flow: Math.max(0, spec.motion.turbulence + D('motion.turbulence')) * (0.5 + macros.chaos),
    flowScale: 0.25,
    maxSpeed: 60,
  });
}

/** What scenes get as `ctx.helpers.studio`. The spec is typed loosely there to keep the scene API small. */
export const studioHelpers = {
  setup: (ctx: SceneContext, spec: unknown) => studioSetup(ctx, spec as StudioSpec),
  update: (ctx: SceneContext, spec: unknown) => studioUpdate(ctx, spec as StudioSpec),
};

/** A runnable scene for a spec (the studio's live preview, and browser-stored scenes on the hosted site). */
export function createStudioScene(spec: StudioSpec): SceneDefinition {
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description || 'Made in the Scene Studio.',
    author: 'studio',
    particleCount: spec.particleCount,
    models: specModels(spec),
    bloom: spec.space.glow,
    params: loopParam(spec),
    camera: { position: cameraPosition(spec.camera), target: [...spec.camera.target], autoRotate: spec.camera.autoRotate, autoTilt: spec.camera.autoTilt, fov: spec.camera.fov },
    studio: spec,
    setup: (ctx) => studioSetup(ctx, spec),
    update: (ctx) => studioUpdate(ctx, spec),
  };
}
