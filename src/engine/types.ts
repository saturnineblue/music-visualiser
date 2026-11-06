/**
 * Core contracts for the visualiser.
 *
 *  - A SCENE decides WHAT the particles form (landscapes, objects, abstract shapes)
 *    and how they move. Scenes live in /scenes/*.ts and have no runtime imports:
 *    everything they need arrives through SceneContext.
 *  - A LOGIC decides HOW the music drives the scene: it maps audio features to
 *    macros and scene params. Logics live in /logics/*.json.
 *
 * See docs/SCENE_API.md for the authoring guide (also sent to Claude).
 */

/** Audio analysis for the current frame. All values normalised to roughly 0..1. */
export interface AudioFeatures {
  /** Overall loudness. */
  rms: number;
  /** 20–150 Hz */
  bass: number;
  /** 150–600 Hz */
  lowMid: number;
  /** 600–2500 Hz */
  mid: number;
  /** 2.5–12 kHz */
  high: number;
  /** Spectral brightness (centroid), 0 = dark, 1 = bright. */
  centroid: number;
  /** Spectral flux: how much the spectrum changed since last frame (onsets). */
  flux: number;
  /** True on the frame a beat/onset is detected. */
  beat: boolean;
  /** Decaying pulse: 1 on a beat, falls towards 0. Good for smooth beat reactions. */
  pulse: number;
  /** Estimated tempo, 0 if unknown. */
  bpm: number;
  /** 64 log-spaced bands, 0..1, low to high. */
  spectrum: Float32Array;
  /** Raw waveform, 512 samples in -1..1. */
  waveform: Float32Array;
}

export type AudioSource =
  | 'rms' | 'bass' | 'lowMid' | 'mid' | 'high'
  | 'centroid' | 'flux' | 'pulse' | 'beat' | 'constant';

export const AUDIO_SOURCES: AudioSource[] = [
  'rms', 'bass', 'lowMid', 'mid', 'high', 'centroid', 'flux', 'pulse', 'beat', 'constant',
];

/**
 * Macros: a small, shared vocabulary every scene should respond to,
 * so any logic can drive any scene.
 */
export interface Macros {
  /** Overall energy / amplitude of motion. 0..2 */
  intensity: number;
  /** Turbulence / disorder. 0..2 */
  chaos: number;
  /** Time-scale multiplier. 0..3 */
  speed: number;
  /** Base hue, 0..1 (wraps). */
  hue: number;
  /** Colour spread around the base hue. 0..1 */
  hueSpread: number;
  /** Brightness multiplier. 0..3 */
  brightness: number;
  /** Particle size multiplier. 0..3 */
  size: number;
  /** Generic 0..1 blend scenes can use for morphing between formations. */
  morph: number;
  /** Short impulse (e.g. on beats) scenes can use for bursts. 0..2 */
  impulse: number;
}

export const DEFAULT_MACROS: Macros = {
  intensity: 0.6,
  chaos: 0.3,
  speed: 1,
  hue: 0.58,
  hueSpread: 0.15,
  brightness: 1,
  size: 1,
  morph: 0,
  impulse: 0,
};

export const MACRO_RANGES: Record<keyof Macros, [number, number]> = {
  intensity: [0, 2],
  chaos: [0, 2],
  speed: [0, 3],
  hue: [0, 1],
  hueSpread: [0, 1],
  brightness: [0, 3],
  size: [0, 3],
  morph: [0, 1],
  impulse: [0, 2],
};

export interface ParamSpec {
  value: number;
  min: number;
  max: number;
  step?: number;
  label?: string;
}

export interface IntegrateOptions {
  /** Pull towards targets (0 = none). Typical 0.5..8 */
  spring?: number;
  /** Velocity damping per second (0..1 of velocity kept per second is 1-damping). Typical 0.5..4 */
  damping?: number;
  /** Strength of the built-in flow field. Typical 0..5 */
  flow?: number;
  /** Spatial frequency of the flow field. Typical 0.1..2 */
  flowScale?: number;
  /** Clamp on velocity magnitude. */
  maxSpeed?: number;
}

/**
 * A 3D model (from models/<id>.glb) sampled into points over its surface.
 * Positions are normalised: centred on the origin, largest half-extent = 1
 * (so multiply by ~10–18 to fill the view). Points are shuffled, so any subset is spread evenly.
 */
export interface PointModel {
  readonly id: string;
  /** Number of sampled points (equals the scene's particle count). */
  readonly count: number;
  /** xyz per point, normalised to -1..1 on the largest axis. */
  readonly positions: Float32Array;
  /** Surface normal per point (unit length). Handy for pushing particles outward. */
  readonly normals: Float32Array;
  /** rgb 0..1 per point from the model's materials / textures. */
  readonly colors: Float32Array;
  /** Part index per point; see partNames. */
  readonly parts: Uint8Array;
  /** Lower-case mesh/object names from the file, e.g. ["walls", "roof", "windows", "door"]. */
  readonly partNames: string[];
  /** Normalised bounding-box size [x, y, z] (largest = 2). */
  readonly size: [number, number, number];
}

export interface FormationHelpers {
  /** Points uniformly inside / on a sphere. */
  sphere(out: Float32Array, count: number, radius: number, surface?: boolean): void;
  /** Points on a torus. */
  torus(out: Float32Array, count: number, R: number, r: number): void;
  /** Points along a torus knot tube. */
  torusKnot(out: Float32Array, count: number, scale: number, p?: number, q?: number, tube?: number): void;
  /** Points in a box. */
  cube(out: Float32Array, count: number, size: number, surface?: boolean): void;
  /** XZ grid, y from heightFn(x, z). Good for landscapes. */
  grid(out: Float32Array, count: number, width: number, depth: number, heightFn?: (x: number, z: number) => number): void;
  /** Spiral galaxy in the XZ plane. */
  galaxy(out: Float32Array, count: number, radius: number, arms?: number, twist?: number): void;
  /** Helix / DNA-like spiral along Y. */
  helix(out: Float32Array, count: number, radius: number, height: number, turns?: number, strands?: number): void;
  /** Lorenz attractor trajectory, centred and scaled. */
  lorenz(out: Float32Array, count: number, scale: number): void;
  /** Flat ring in XZ plane. */
  ring(out: Float32Array, count: number, radius: number, thickness?: number): void;
  /** Points of a loaded model (see SceneDefinition.models), scaled and offset. */
  model(out: Float32Array, count: number, model: PointModel, scale?: number, offset?: [number, number, number]): void;
}

export interface SceneHelpers {
  /** 3D simplex noise, returns -1..1 */
  noise3(x: number, y: number, z: number): number;
  /** Cheap divergence-free-ish flow field. Writes velocity into out[0..2]. */
  flow(out: Float32Array | number[], x: number, y: number, z: number, t: number): void;
  formations: FormationHelpers;
  /** Write an HSL colour (all 0..1) into ctx.colors at particle i. */
  setColorHSL(i: number, h: number, s: number, l: number): void;
  /** Deterministic random 0..1 for particle i (stable across frames). */
  rand(i: number, salt?: number): number;
  lerp(a: number, b: number, t: number): number;
  clamp(v: number, lo: number, hi: number): number;
  smoothstep(e0: number, e1: number, x: number): number;
}

export interface CameraSpec {
  position?: [number, number, number];
  target?: [number, number, number];
  /** Auto-rotate speed (0 = off). */
  autoRotate?: number;
  fov?: number;
}

/**
 * Everything a scene can touch. Arrays are flat: particle i occupies
 * [i*3, i*3+1, i*3+2] in positions / velocities / targets / colors,
 * and [i] in sizes / alphas.
 */
export interface SceneContext {
  readonly count: number;
  positions: Float32Array;
  velocities: Float32Array;
  targets: Float32Array;
  colors: Float32Array;
  sizes: Float32Array;
  alphas: Float32Array;

  readonly audio: AudioFeatures;
  readonly macros: Macros;
  /** Current (logic-modulated) values of this scene's params. */
  readonly params: Record<string, number>;

  /** Seconds since scene start, scaled by macros.speed. */
  readonly time: number;
  /** Real seconds since last frame (clamped). */
  readonly dt: number;
  /** dt * macros.speed */
  readonly sdt: number;
  readonly frame: number;

  /** Free storage for the scene (survives between frames). */
  state: Record<string, any>;

  /** Models the scene asked for in `models`, by id, sampled to `count` points. */
  readonly models: Record<string, PointModel>;

  helpers: SceneHelpers;

  /** Default physics: spring to targets + flow field + damping, then advances positions. */
  integrate(opts?: IntegrateOptions): void;
  /** Apply default colour from macros.hue / hueSpread / brightness, optionally per-particle hue offset. */
  colorize(hueOffset?: (i: number) => number, saturation?: number, lightness?: number): void;
  /** Override the camera (call from setup, or any frame). */
  setCamera(spec: CameraSpec): void;
  /** Background colour as 0..1 rgb. */
  setBackground(r: number, g: number, b: number): void;
}

export interface SceneDefinition {
  id: string;
  name: string;
  description?: string;
  author?: string;
  /** Number of particles, default 60000. Max 300000. */
  particleCount?: number;
  camera?: CameraSpec;
  /** Bloom glow strength, default 0.9. */
  bloom?: number;
  /** Scene-specific tunables, exposed in the GUI and targetable by logics as "param.<name>". */
  params?: Record<string, ParamSpec>;
  /** Logic id to load with this scene if the user hasn't chosen one. */
  defaultLogic?: string;
  /** Model ids from models/<id>.glb to load before setup; available as ctx.models[id]. */
  models?: string[];
  setup?(ctx: SceneContext): void;
  update(ctx: SceneContext): void;
  dispose?(ctx: SceneContext): void;
}

// ---------- Logic ----------

export type Curve = 'linear' | 'sqrt' | 'square' | 'exp' | 'smooth' | 'threshold';
export const CURVES: Curve[] = ['linear', 'sqrt', 'square', 'exp', 'smooth', 'threshold'];

export interface LogicMapping {
  /** Audio feature to read. */
  source: AudioSource;
  /** "macro.<name>" or "param.<name>" */
  target: string;
  /** Multiplier applied after the curve. Negative inverts. */
  amount: number;
  curve?: Curve;
  /** Seconds to rise (0 = instant). */
  attack?: number;
  /** Seconds to fall (0 = instant). */
  release?: number;
  /** add (default): base + value. multiply: base * (1 + value). set: value. */
  mode?: 'add' | 'multiply' | 'set';
  enabled?: boolean;
}

export interface LogicDefinition {
  id: string;
  name: string;
  description?: string;
  author?: string;
  /** Base macro values before modulation (missing ones use defaults). */
  base?: Partial<Macros>;
  mappings: LogicMapping[];
}
