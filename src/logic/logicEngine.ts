import {
  DEFAULT_MACROS, MACRO_RANGES,
  type AudioFeatures, type Curve, type LogicDefinition, type Macros, type ParamSpec,
} from '../engine/types';

function applyCurve(v: number, curve: Curve = 'linear'): number {
  switch (curve) {
    case 'sqrt': return Math.sqrt(Math.max(0, v));
    case 'square': return v * v;
    case 'exp': return (Math.exp(v * 2) - 1) / (Math.E * Math.E - 1);
    case 'smooth': return v * v * (3 - 2 * v);
    case 'threshold': return v > 0.5 ? 1 : 0;
    default: return v;
  }
}

/**
 * Evaluates a LogicDefinition each frame:
 *   value(target) = base(target) (+|*|=) Σ curve(audio[source]) * amount   (with attack/release smoothing)
 *
 * "base" values come from the logic (macros) and the GUI (user-tweaked base values),
 * so the user can always steer by hand on top of the music.
 */
export class LogicEngine {
  logic: LogicDefinition = { id: 'none', name: 'None', mappings: [] };
  /** User-editable base values for macros (GUI). */
  readonly baseMacros: Macros = { ...DEFAULT_MACROS };
  /** User-editable base values for scene params (GUI). */
  baseParams: Record<string, number> = {};
  paramSpecs: Record<string, ParamSpec> = {};

  /** Output, read by scenes. Same object identity is kept for the lifetime of the app. */
  readonly macros: Macros = { ...DEFAULT_MACROS };
  readonly params: Record<string, number> = {};

  private env: number[] = [];

  setLogic(logic: LogicDefinition) {
    this.logic = logic;
    Object.assign(this.baseMacros, DEFAULT_MACROS, logic.base ?? {});
    this.env = logic.mappings.map(() => 0);
  }

  setSceneParams(specs: Record<string, ParamSpec> | undefined) {
    this.paramSpecs = specs ?? {};
    this.baseParams = {};
    for (const k of Object.keys(this.params)) delete this.params[k];
    for (const [k, s] of Object.entries(this.paramSpecs)) {
      this.baseParams[k] = s.value;
      this.params[k] = s.value;
    }
  }

  /** Call after editing mappings in the GUI so envelope state matches. */
  syncMappings() {
    this.env = this.logic.mappings.map((_, i) => this.env[i] ?? 0);
  }

  update(audio: AudioFeatures, dt: number) {
    const add: Record<string, number> = {};
    const mul: Record<string, number> = {};
    const set: Record<string, number> = {};

    this.logic.mappings.forEach((m, i) => {
      if (m.enabled === false) return;
      let raw: number;
      if (m.source === 'constant') raw = 1;
      else if (m.source === 'beat') raw = audio.beat ? 1 : 0;
      else raw = (audio as unknown as Record<string, number>)[m.source] ?? 0;
      const target = applyCurve(Math.min(1, Math.max(0, raw)), m.curve);

      // Attack/release envelope
      const prev = this.env[i] ?? 0;
      const tc = target > prev ? (m.attack ?? 0) : (m.release ?? 0.15);
      const v = tc <= 0 ? target : prev + (target - prev) * (1 - Math.exp(-dt / tc));
      this.env[i] = v;

      const out = v * m.amount;
      const mode = m.mode ?? 'add';
      if (mode === 'add') add[m.target] = (add[m.target] ?? 0) + out;
      else if (mode === 'multiply') mul[m.target] = (mul[m.target] ?? 1) * (1 + out);
      else set[m.target] = out;
    });

    const resolve = (key: string, base: number, lo: number, hi: number) => {
      let v = key in set ? set[key] : base;
      v = (v + (add[key] ?? 0)) * (mul[key] ?? 1);
      return v < lo ? lo : v > hi ? hi : v;
    };

    for (const k of Object.keys(this.macros) as (keyof Macros)[]) {
      const [lo, hi] = MACRO_RANGES[k];
      if (k === 'hue') {
        const v = ('macro.hue' in set ? set['macro.hue'] : this.baseMacros.hue) + (add['macro.hue'] ?? 0);
        this.macros.hue = v - Math.floor(v);
      } else {
        this.macros[k] = resolve(`macro.${k}`, this.baseMacros[k], lo, hi);
      }
    }
    for (const [k, spec] of Object.entries(this.paramSpecs)) {
      this.params[k] = resolve(`param.${k}`, this.baseParams[k] ?? spec.value, spec.min, spec.max);
    }
  }

  /** All valid targets for the GUI dropdown. */
  targets(): string[] {
    return [
      ...Object.keys(DEFAULT_MACROS).map((k) => `macro.${k}`),
      ...Object.keys(this.paramSpecs).map((k) => `param.${k}`),
    ];
  }
}
