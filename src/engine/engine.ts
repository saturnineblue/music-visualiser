import { Renderer } from './renderer';
import { ParticleField } from './particles';
import { AudioEngine } from '../audio/audioEngine';
import { LogicEngine } from '../logic/logicEngine';
import type { LogicDefinition, PointModel, SceneDefinition } from './types';

const DEFAULT_COUNT = 60000;
const MAX_COUNT = 300000;

export interface EngineEvents {
  onSceneChanged?(scene: SceneDefinition): void;
  onLogicChanged?(logic: LogicDefinition): void;
  onSceneError?(sceneId: string, error: Error, phase: 'setup' | 'update'): void;
}

/**
 * Wires audio → logic → scene → particles → renderer, once per frame.
 * Scenes run inside try/catch: a broken (e.g. freshly generated) scene
 * is reported and the previous working scene is restored.
 */
export class Engine {
  readonly renderer: Renderer;
  readonly audio = new AudioEngine();
  readonly logic = new LogicEngine();
  scene: SceneDefinition | null = null;
  field: ParticleField | null = null;
  fps = 0;
  paused = false;

  private lastGood: SceneDefinition | null = null;
  private lastGoodModels: Record<string, PointModel> = {};
  private time = 0;
  private frame = 0;
  private last = performance.now();

  constructor(container: HTMLElement, private events: EngineEvents = {}) {
    this.renderer = new Renderer(container);
    requestAnimationFrame(this.loop);
  }

  setLogic(logic: LogicDefinition) {
    this.logic.setLogic(logic);
    this.events.onLogicChanged?.(logic);
  }

  /** Particle count a scene will get (models are sampled to this). */
  static particleCount(def: SceneDefinition) {
    return Math.min(MAX_COUNT, Math.max(100, Math.floor(def.particleCount ?? DEFAULT_COUNT)));
  }

  /**
   * Returns true if the scene loaded; false if setup threw (previous scene is kept).
   * `models` are the scene's pre-loaded models (see SceneDefinition.models).
   */
  setScene(def: SceneDefinition, models: Record<string, PointModel> = {}): boolean {
    const prev = this.scene;
    const prevField = this.field;
    const count = Engine.particleCount(def);
    const prevModels = prevField?.ctx.models;

    let field = prevField;
    if (!field || field.count !== count) {
      field = new ParticleField(count, this.audio.features, this.logic.macros, this.logic.params, {
        setCamera: (s) => this.renderer.setCamera(s),
        setBackground: (r, g, b) => this.renderer.setBackground(r, g, b),
        setBloom: (v) => this.renderer.setBloom(v),
      });
      // Carry particles over so the new formation assembles from the old one.
      if (prevField) {
        const n = Math.min(prevField.count, count) * 3;
        field.ctx.positions.set(prevField.ctx.positions.subarray(0, n));
        field.ctx.colors.set(prevField.ctx.colors.subarray(0, n));
      }
    }

    try {
      if (prev && prevField) prev.dispose?.(prevField.ctx);
    } catch (e) { console.warn('dispose failed', e); }

    // Reset per-scene state.
    field.ctx.state = {};
    (field.ctx as { models: Record<string, PointModel> }).models = models;
    field.ctx.velocities.fill(0);
    field.ctx.sizes.fill(1);
    field.ctx.alphas.fill(1);
    this.logic.setSceneParams(def.params);
    this.renderer.setBackground(0.008, 0.008, 0.02);
    this.renderer.setBloom(def.bloom ?? 0.7);
    this.renderer.setCamera({ position: [0, 8, 50], target: [0, 0, 0], autoRotate: 0.4, fov: 60, ...def.camera });
    this.time = 0;
    this.frame = 0;

    try {
      def.setup?.(field.ctx);
    } catch (e) {
      this.events.onSceneError?.(def.id, e as Error, 'setup');
      if (field !== prevField) field.dispose();
      if (prev && prevField) {
        (prevField.ctx as { models: Record<string, PointModel> }).models = prevModels ?? {};
        this.logic.setSceneParams(prev.params);
        try { prev.setup?.(prevField.ctx); } catch { /* ignore */ }
      }
      return false;
    }

    if (field !== prevField) {
      if (prevField) {
        this.renderer.scene.remove(prevField.points);
        prevField.dispose();
      }
      this.renderer.scene.add(field.points);
    }
    this.field = field;
    this.scene = def;
    this.events.onSceneChanged?.(def);
    return true;
  }

  private loop = (now: number) => {
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.fps = this.fps * 0.95 + (dt > 0 ? 1 / dt : 0) * 0.05;
    if (this.paused) { this.renderer.render(); return; }

    this.audio.update(dt);
    this.logic.update(this.audio.features, dt);

    const scene = this.scene, field = this.field;
    if (scene && field) {
      const sdt = dt * this.logic.macros.speed;
      this.time += sdt;
      field.tick(this.time, dt, sdt, this.frame++);
      try {
        scene.update(field.ctx);
      } catch (e) {
        this.events.onSceneError?.(scene.id, e as Error, 'update');
        if (this.lastGood && this.lastGood !== scene) this.setScene(this.lastGood, this.lastGoodModels);
        else this.scene = null;
        return;
      }
      if (this.frame > 30 && this.lastGood !== scene) { this.lastGood = scene; this.lastGoodModels = field.ctx.models; }
      const m = this.logic.macros;
      field.upload(m.size, m.brightness);
    }
    this.renderer.render();
  };
}
