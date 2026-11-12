import type { AudioSource, Curve } from '../engine/types';

/**
 * The Scene Studio's scene format: a plain-data description of a particle scene (layers of shapes
 * and 3D models, colours, lighting, space, motion and audio mappings). `runtime.ts` plays it.
 * A saved studio scene is an ordinary scenes/<id>.ts file that embeds this spec (see
 * `studioSceneSource`), so sets, the projector and the hosted site treat it like any scene.
 *
 * No DOM or engine imports here: the local server uses this file too.
 */

export const STUDIO_FORMAT = 'music-visualiser-studio';

/** Where a value comes from: a named audio feature, or a frequency range of the spectrum. */
export type StudioSource =
  | { kind: 'feature'; name: AudioSource }
  | { kind: 'band'; lo: number; hi: number }; // Hz

export interface StudioMapping {
  source: StudioSource;
  /** A key of studioTargets(spec), e.g. "light.intensity" or "layer:<id>.scale". */
  target: string;
  /** Added to the target: curve(source 0..1) × amount. Negative inverts. */
  amount: number;
  curve: Curve;
  /** Seconds to rise / fall. */
  attack: number;
  release: number;
  enabled: boolean;
}

export const SHAPES = ['sphere', 'ball', 'cube', 'torus', 'knot', 'plane', 'galaxy', 'helix', 'lorenz', 'ring'] as const;
export type ShapeName = (typeof SHAPES)[number];

export const AXES = ['height', 'width', 'depth', 'radius', 'random'] as const;
export type Axis = (typeof AXES)[number];

export interface StudioColor {
  /** solid: colour A. gradient: A → B along `axis`. model: the 3D model's own colours (shapes use A). */
  mode: 'solid' | 'gradient' | 'model';
  a: string; // #rrggbb
  b: string;
  axis: Axis;
}

/** How one named part of a model looks and reacts. All optional: unset = like the rest of the form. */
export interface StudioPart {
  /** Overrides the form's colour for this part. */
  color?: string;
  /** What drives this part's reaction. */
  source?: StudioSource;
  /** World units of upward lift at full signal. */
  lift?: number;
  /** World units pushed outward along the surface at full signal. */
  push?: number;
  /** Extra brightness at full signal (1 = twice as bright). */
  glow?: number;
}

/** One shape or model, with its placement and colour. A layer morphs through its forms. */
export interface StudioForm {
  kind: 'shape' | 'model';
  shape: ShapeName;
  /** Model id (models/<id>.glb) when kind is "model". */
  model: string;
  /** Half-size in world units (the view is about ±30). */
  scale: number;
  position: [number, number, number];
  /** Degrees around x, y, z. */
  rotation: [number, number, number];
  color: StudioColor;
  /** Per-part settings, by part name (models only). */
  parts: Record<string, StudioPart>;
}

export interface StudioSpectrum {
  /** How the spectrum is laid over the layer: low frequencies at one end, high at the other. */
  axis: 'none' | Axis | 'part';
  lo: number; // Hz
  hi: number;
  /** World units pushed outward at full level. */
  push: number;
  /** Extra brightness at full level. */
  glow: number;
  /** Extra particle size at full level. */
  size: number;
  /** Colour blended in where the spectrum is loud, and how strongly (0..1). */
  tint: string;
  tintAmount: number;
}

export interface StudioLayer {
  id: string;
  name: string;
  visible: boolean;
  /** Relative share of the scene's particles. */
  share: number;
  /** One form = static. Several = the layer morphs from one to the next. */
  forms: StudioForm[];
  /** Multiplies the forms' scale. */
  scale: number;
  /** Upward offset in world units. */
  lift: number;
  /** Degrees per second around the vertical axis. */
  spin: number;
  size: number;
  brightness: number;
  /** World units pushed outward along the surface. */
  explode: number;
  spectrum: StudioSpectrum;
}

export interface StudioSpec {
  format: typeof STUDIO_FORMAT;
  version: 1;
  id: string;
  name: string;
  description: string;
  particleCount: number;
  space: {
    /** Background colour of the surrounding space. */
    color: string;
    /** Bloom glow strength, 0..3. */
    glow: number;
  };
  camera: {
    distance: number;
    /** Degrees around the scene (0 = in front, 90 = from the right). */
    azimuth: number;
    /** Degrees above (+) or below (−) the horizon. */
    elevation: number;
    fov: number;
    /** Automatic rotation around the scene, and up and down (0 = off). */
    autoRotate: number;
    autoTilt: number;
    /** The point the camera looks at. */
    target: [number, number, number];
  };
  light: {
    enabled: boolean;
    color: string;
    intensity: number;
    /** Degrees: direction the key light comes from. */
    azimuth: number;
    elevation: number;
    /** Light that reaches every particle, 0..1. */
    ambient: number;
    /** Light from the opposite side. */
    fill: string;
    fillIntensity: number;
  };
  motion: {
    /** How tightly particles hold their place. */
    spring: number;
    damping: number;
    turbulence: number;
    /** Outward kick on each beat. */
    burst: number;
  };
  morph: {
    /** manual: `position` (and mappings) pick the form. time/beats: step to the next form automatically. */
    mode: 'manual' | 'time' | 'beats';
    /** Seconds (time) or beats (beats) each form is held. */
    every: number;
    /** Seconds a transition takes. */
    blend: number;
    /** 0..1 through each layer's forms (manual mode; mappings add to it in every mode). */
    position: number;
  };
  /** Rotates every colour around the colour wheel, in turns (0..1). */
  hueShift: number;
  /** Multiplies all colours. */
  brightness: number;
  layers: StudioLayer[];
  mappings: StudioMapping[];
  /** A recorded loop of setting changes, replayed while the scene plays. */
  loop?: StudioLoop;
  /** Bumped by the studio UI when colours or structure change (not saved). */
  rev?: number;
}

export type Leaf = number | string | boolean;

/** One setting's recorded values. Numbers are interpolated between keys; other values switch. */
export interface LoopTrack {
  /** A key of liveValues(spec), or "@morph" (the automatic morph position). */
  path: string;
  t: number[]; // seconds, ascending
  v: Leaf[];
}

export interface StudioLoop { enabled: boolean; duration: number; tracks: LoopTrack[] }

/** Where the camera sits, from its angles. */
export function cameraPosition(c: StudioSpec['camera']): [number, number, number] {
  const az = (c.azimuth * Math.PI) / 180, el = (c.elevation * Math.PI) / 180;
  return [
    c.target[0] + c.distance * Math.sin(az) * Math.cos(el),
    c.target[1] + c.distance * Math.sin(el),
    c.target[2] + c.distance * Math.cos(az) * Math.cos(el),
  ];
}

export const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'studio-scene';

let uid = 0;
export const newId = () => `l${Date.now().toString(36)}${(uid++).toString(36)}`;

export function newForm(kind: 'shape' | 'model' = 'shape', what = 'sphere'): StudioForm {
  return {
    kind,
    shape: kind === 'shape' ? (what as ShapeName) : 'sphere',
    model: kind === 'model' ? what : '',
    scale: kind === 'model' ? 13 : 10,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    color: kind === 'model'
      ? { mode: 'model', a: '#9fb4ff', b: '#ff7ab8', axis: 'height' }
      : { mode: 'gradient', a: '#5b8cff', b: '#ff6ad5', axis: 'height' },
    parts: {},
  };
}

export function newLayer(name: string, form: StudioForm): StudioLayer {
  return {
    id: newId(), name, visible: true, share: 50, forms: [form],
    scale: 1, lift: 0, spin: 0, size: 1, brightness: 1, explode: 0,
    spectrum: { axis: 'none', lo: 40, hi: 8000, push: 2, glow: 1, size: 0, tint: '#ffffff', tintAmount: 0 },
  };
}

export function newSpec(name = 'Studio scene'): StudioSpec {
  const layer = newLayer('Sphere', newForm('shape', 'sphere'));
  return {
    format: STUDIO_FORMAT, version: 1, id: slug(name), name, description: '',
    particleCount: 60000,
    space: { color: '#020308', glow: 0.8 },
    camera: { distance: 47, azimuth: 0, elevation: 10, fov: 60, autoRotate: 0.4, autoTilt: 0, target: [0, 0, 0] },
    light: { enabled: true, color: '#fff2dd', intensity: 1, azimuth: 35, elevation: 40, ambient: 0.45, fill: '#3050ff', fillIntensity: 0.25 },
    motion: { spring: 6, damping: 3, turbulence: 0.6, burst: 2 },
    morph: { mode: 'beats', every: 16, blend: 2.5, position: 0 },
    hueShift: 0,
    brightness: 1,
    layers: [layer],
    mappings: [
      { source: { kind: 'feature', name: 'bass' }, target: `layer:${layer.id}.scale`, amount: 0.25, curve: 'square', attack: 0, release: 0.25, enabled: true },
      { source: { kind: 'band', lo: 2500, hi: 12000 }, target: 'brightness', amount: 0.6, curve: 'linear', attack: 0, release: 0.15, enabled: true },
    ],
  };
}

const num = (v: unknown, d: number, lo = -Infinity, hi = Infinity) =>
  typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const hex = (v: unknown, d: string) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : d);
const vec3 = (v: unknown): [number, number, number] =>
  Array.isArray(v) ? [num(v[0], 0), num(v[1], 0), num(v[2], 0)] : [0, 0, 0];

function cleanSource(s: unknown): StudioSource {
  const o = (s ?? {}) as Record<string, unknown>;
  if (o.kind === 'band') {
    const lo = num(o.lo, 60, 20, 20000), hi = num(o.hi, 250, 20, 20000);
    return { kind: 'band', lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
  }
  return { kind: 'feature', name: (typeof o.name === 'string' ? o.name : 'bass') as AudioSource };
}

/** Fill in anything missing and clamp values, so old or hand-written specs always run. */
export function normalizeSpec(raw: unknown): StudioSpec {
  const d = newSpec();
  const s = (raw ?? {}) as Partial<StudioSpec> & Record<string, any>;
  const name = typeof s.name === 'string' && s.name.trim() ? s.name.trim() : d.name;
  const layers: StudioLayer[] = (Array.isArray(s.layers) ? s.layers : []).map((L: any, i: number) => {
    const base = newLayer(`Layer ${i + 1}`, newForm());
    const forms: StudioForm[] = (Array.isArray(L?.forms) && L.forms.length ? L.forms : [newForm()]).map((F: any) => {
      const kind = F?.kind === 'model' && typeof F.model === 'string' && F.model ? 'model' : 'shape';
      const fb = newForm(kind);
      const parts: Record<string, StudioPart> = {};
      for (const [k, p] of Object.entries<any>(F?.parts ?? {})) {
        if (!p || typeof p !== 'object') continue;
        const out: StudioPart = {};
        if (typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color)) out.color = p.color;
        if (p.source) out.source = cleanSource(p.source);
        for (const key of ['lift', 'push', 'glow'] as const) if (typeof p[key] === 'number' && isFinite(p[key]) && p[key] !== 0) out[key] = p[key];
        if (Object.keys(out).length) parts[k] = out;
      }
      return {
        kind,
        shape: (SHAPES as readonly string[]).includes(F?.shape) ? F.shape : 'sphere',
        model: kind === 'model' ? F.model : '',
        scale: num(F?.scale, fb.scale, 0.1, 100),
        position: vec3(F?.position),
        rotation: vec3(F?.rotation),
        color: {
          mode: ['solid', 'gradient', 'model'].includes(F?.color?.mode) ? F.color.mode : fb.color.mode,
          a: hex(F?.color?.a, fb.color.a), b: hex(F?.color?.b, fb.color.b),
          axis: (AXES as readonly string[]).includes(F?.color?.axis) ? F.color.axis : 'height',
        },
        parts,
      } as StudioForm;
    });
    const sp = L?.spectrum ?? {};
    const lo = num(sp.lo, 40, 20, 20000), hi = num(sp.hi, 8000, 20, 20000);
    return {
      id: typeof L?.id === 'string' && /^[a-z0-9]+$/i.test(L.id) ? L.id : base.id,
      name: typeof L?.name === 'string' && L.name ? L.name : base.name,
      visible: L?.visible !== false,
      share: num(L?.share, 50, 1, 100),
      forms,
      scale: num(L?.scale, 1, 0.05, 10), lift: num(L?.lift, 0, -60, 60), spin: num(L?.spin, 0, -360, 360),
      size: num(L?.size, 1, 0.05, 6), brightness: num(L?.brightness, 1, 0, 5), explode: num(L?.explode, 0, -30, 30),
      spectrum: {
        axis: ['none', 'part', ...AXES].includes(sp.axis) ? sp.axis : 'none',
        lo: Math.min(lo, hi), hi: Math.max(lo, hi),
        push: num(sp.push, 2, -30, 30), glow: num(sp.glow, 1, 0, 8), size: num(sp.size, 0, 0, 6),
        tint: hex(sp.tint, '#ffffff'), tintAmount: num(sp.tintAmount, 0, 0, 1),
      },
    };
  });
  const curves = ['linear', 'sqrt', 'square', 'exp', 'smooth', 'threshold'];
  return {
    format: STUDIO_FORMAT, version: 1,
    id: slug(typeof s.id === 'string' && s.id ? s.id : name), name,
    description: typeof s.description === 'string' ? s.description : '',
    particleCount: Math.round(num(s.particleCount, d.particleCount, 1000, 300000)),
    space: { color: hex(s.space?.color, d.space.color), glow: num(s.space?.glow, d.space.glow, 0, 3) },
    camera: cleanCamera(s.camera, d.camera),
    light: {
      enabled: s.light?.enabled !== false,
      color: hex(s.light?.color, d.light.color), intensity: num(s.light?.intensity, d.light.intensity, 0, 5),
      azimuth: num(s.light?.azimuth, d.light.azimuth, -360, 360), elevation: num(s.light?.elevation, d.light.elevation, -90, 90),
      ambient: num(s.light?.ambient, d.light.ambient, 0, 2),
      fill: hex(s.light?.fill, d.light.fill), fillIntensity: num(s.light?.fillIntensity, d.light.fillIntensity, 0, 5),
    },
    motion: {
      spring: num(s.motion?.spring, d.motion.spring, 0.1, 40), damping: num(s.motion?.damping, d.motion.damping, 0.1, 20),
      turbulence: num(s.motion?.turbulence, d.motion.turbulence, 0, 12), burst: num(s.motion?.burst, d.motion.burst, 0, 30),
    },
    morph: {
      mode: ['manual', 'time', 'beats'].includes(s.morph?.mode as string) ? s.morph!.mode : d.morph.mode,
      every: num(s.morph?.every, d.morph.every, 0.25, 600), blend: num(s.morph?.blend, d.morph.blend, 0.05, 60),
      position: num(s.morph?.position, 0, 0, 1),
    },
    hueShift: num(s.hueShift, 0, -1, 1),
    brightness: num(s.brightness, 1, 0, 5),
    layers,
    mappings: (Array.isArray(s.mappings) ? s.mappings : []).filter((m: any) => m && typeof m.target === 'string').map((m: any) => ({
      source: cleanSource(m.source), target: m.target, amount: num(m.amount, 0.5, -100, 100),
      curve: curves.includes(m.curve) ? m.curve : 'linear',
      attack: num(m.attack, 0, 0, 10), release: num(m.release, 0.2, 0, 10), enabled: m.enabled !== false,
    })),
    ...(cleanLoop(s.loop) ? { loop: cleanLoop(s.loop)! } : {}),
  };
}

function cleanCamera(c: any, d: StudioSpec['camera']): StudioSpec['camera'] {
  let distance = num(c?.distance, d.distance, 5, 300);
  let elevation = num(c?.elevation, d.elevation, -89, 89);
  // Older specs stored a height instead of an angle.
  if (typeof c?.elevation !== 'number' && typeof c?.height === 'number') {
    elevation = (Math.atan2(c.height, distance) * 180) / Math.PI;
    distance = Math.hypot(c.height, distance);
  }
  return {
    distance, elevation,
    azimuth: num(c?.azimuth, 0, -1e6, 1e6),
    fov: num(c?.fov, d.fov, 20, 110),
    autoRotate: num(c?.autoRotate, d.autoRotate, -10, 10), autoTilt: num(c?.autoTilt, 0, -10, 10),
    target: vec3(c?.target),
  };
}

function cleanLoop(raw: any): StudioLoop | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tracks)) return null;
  const duration = num(raw.duration, 0, 0, 3600);
  const tracks: LoopTrack[] = raw.tracks.filter((tr: any) =>
    tr && typeof tr.path === 'string' && Array.isArray(tr.t) && Array.isArray(tr.v) && tr.t.length === tr.v.length && tr.t.length > 0 &&
    tr.t.every((x: unknown) => typeof x === 'number' && isFinite(x)) &&
    tr.v.every((x: unknown) => ['number', 'string', 'boolean'].includes(typeof x)))
    .map((tr: any) => ({ path: tr.path, t: tr.t, v: tr.v }));
  if (duration <= 0 || !tracks.length) return null;
  return { enabled: raw.enabled !== false, duration, tracks };
}

// ---------- Live values (what a loop can record and replay) ----------

function walk(o: any, prefix: string, skip: readonly string[], out: Record<string, Leaf>) {
  for (const [k, v] of Object.entries(o ?? {})) {
    if (skip.includes(k)) continue;
    if (v !== null && typeof v === 'object') walk(v, `${prefix}${k}.`, skip, out);
    else if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') out[prefix + k] = v;
  }
}

/**
 * Every setting that can change without rebuilding the scene, by path. Layers are addressed by
 * id ("layer:<id>.forms.0.position.0"), so a recorded loop survives reordering them.
 */
export function liveValues(spec: StudioSpec): Record<string, Leaf> {
  const out: Record<string, Leaf> = {};
  for (const k of ['space', 'camera', 'light', 'motion', 'morph'] as const) walk(spec[k], k + '.', [], out);
  out.hueShift = spec.hueShift;
  out.brightness = spec.brightness;
  for (const L of spec.layers) walk(L, `layer:${L.id}.`, ['id', 'name', 'visible', 'share', 'kind', 'shape', 'model'], out);
  spec.mappings.forEach((m, i) => walk(m, `mappings.${i}.`, ['target'], out));
  return out;
}

/** Set one live value by path. Returns true if it changed (false if unchanged or the path is gone). */
export function setLive(spec: StudioSpec, path: string, value: Leaf): boolean {
  let node: any = spec;
  let rest = path;
  const m = /^layer:([^.]+)\.(.*)$/.exec(path);
  if (m) {
    node = spec.layers.find((L) => L.id === m[1]);
    rest = m[2];
  }
  const keys = rest.split('.');
  for (let i = 0; i < keys.length - 1 && node; i++) node = node[keys[i]];
  const last = keys[keys.length - 1];
  if (!node || typeof node !== 'object' || typeof node[last] !== typeof value || node[last] === value) return false;
  node[last] = value;
  return true;
}

/** A loop track's value at time t. */
export function trackValue(tr: LoopTrack, t: number): Leaf {
  const n = tr.t.length;
  if (t <= tr.t[0]) return tr.v[0];
  if (t >= tr.t[n - 1]) return tr.v[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tr.t[mid] <= t) lo = mid; else hi = mid; }
  const a = tr.v[lo], b = tr.v[hi];
  if (typeof a !== 'number' || typeof b !== 'number') return a;
  const span = tr.t[hi] - tr.t[lo];
  return span > 0 ? a + ((b - a) * (t - tr.t[lo])) / span : b;
}

/** The spec as it is saved: no editor bookkeeping, and looped settings at the loop's first values. */
export function canonicalSpec(spec: StudioSpec): StudioSpec {
  const c: StudioSpec = JSON.parse(JSON.stringify(spec));
  delete c.rev;
  for (const tr of c.loop?.tracks ?? []) if (!tr.path.startsWith('@')) setLive(c, tr.path, tr.v[0]);
  return c;
}

/** Ids of the 3D models a spec needs. */
export function specModels(spec: StudioSpec): string[] {
  const ids = new Set<string>();
  for (const L of spec.layers) for (const F of L.forms) if (F.kind === 'model' && F.model) ids.add(F.model);
  return [...ids];
}

export interface StudioTarget { key: string; label: string; group: string; min: number; max: number }

/** Everything a mapping can drive, with a sensible range for its amount. */
export function studioTargets(spec: StudioSpec): StudioTarget[] {
  const t: StudioTarget[] = [
    { key: 'brightness', label: 'Brightness', group: 'Whole scene', min: -3, max: 3 },
    { key: 'hueShift', label: 'Colour shift', group: 'Whole scene', min: -1, max: 1 },
    { key: 'morph.position', label: 'Morph position', group: 'Whole scene', min: -1, max: 1 },
    { key: 'motion.turbulence', label: 'Turbulence', group: 'Whole scene', min: -8, max: 8 },
    { key: 'motion.spring', label: 'Tightness', group: 'Whole scene', min: -20, max: 20 },
    { key: 'space.glow', label: 'Glow', group: 'Space and light', min: -3, max: 3 },
    { key: 'light.intensity', label: 'Light intensity', group: 'Space and light', min: -4, max: 4 },
    { key: 'light.ambient', label: 'Ambient light', group: 'Space and light', min: -2, max: 2 },
    { key: 'light.azimuth', label: 'Light direction', group: 'Space and light', min: -360, max: 360 },
    { key: 'light.elevation', label: 'Light height', group: 'Space and light', min: -90, max: 90 },
  ];
  for (const L of spec.layers) {
    const g = `Layer: ${L.name}`, k = `layer:${L.id}.`, n = `${L.name}: `;
    t.push(
      { key: k + 'scale', label: n + 'scale', group: g, min: -2, max: 2 },
      { key: k + 'lift', label: n + 'lift', group: g, min: -30, max: 30 },
      { key: k + 'spin', label: n + 'spin speed', group: g, min: -360, max: 360 },
      { key: k + 'size', label: n + 'particle size', group: g, min: -4, max: 4 },
      { key: k + 'brightness', label: n + 'brightness', group: g, min: -3, max: 3 },
      { key: k + 'explode', label: n + 'explode', group: g, min: -20, max: 20 },
      { key: k + 'spectrum.push', label: n + 'spectrum push', group: g, min: -20, max: 20 },
      { key: k + 'spectrum.glow', label: n + 'spectrum glow', group: g, min: -6, max: 6 },
    );
  }
  return t;
}

/**
 * The scenes/<id>.ts file for a studio scene. Plain JavaScript (valid as TypeScript with
 * @ts-nocheck), so the same text also serves as the compiled module in scene sets.
 */
export function studioSceneSource(spec: StudioSpec): string {
  const clean = canonicalSpec(spec);
  const cam = clean.camera;
  const q = (s: string) => JSON.stringify(s);
  return `// @ts-nocheck
// Made in the Scene Studio. Open it there ("Edit in studio") to change it: the spec below is
// the whole scene, and the shared studio engine (ctx.helpers.studio) plays it.
const spec = ${JSON.stringify(clean, null, 2)};

const scene = {
  id: ${q(spec.id)},
  name: ${q(spec.name)},
  description: ${q(spec.description || 'Made in the Scene Studio.')},
  author: 'studio',
  particleCount: ${spec.particleCount},
  models: ${JSON.stringify(specModels(spec))},
  bloom: ${spec.space.glow},
  camera: { position: ${JSON.stringify(cameraPosition(cam).map((v) => +v.toFixed(3)))}, target: ${JSON.stringify(cam.target)}, autoRotate: ${cam.autoRotate}, autoTilt: ${cam.autoTilt}, fov: ${cam.fov} },
  studio: spec,
  setup(ctx) { ctx.helpers.studio.setup(ctx, spec); },
  update(ctx) { ctx.helpers.studio.update(ctx, spec); },
};

export default scene;
`;
}
