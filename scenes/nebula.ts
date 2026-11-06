import type { SceneDefinition } from '../src/engine/types';

/**
 * A drifting nebula held loosely around a breathing shell. Chaos stirs the flow field,
 * bass inflates the shell, and beats blow particles outward before gravity pulls them back.
 */

const scene: SceneDefinition = {
  id: 'nebula',
  name: 'Nebula',
  description: 'Soft flowing cloud around a breathing shell; bass inflates, beats explode, chaos stirs.',
  author: 'built-in',
  particleCount: 50000,
  camera: { position: [0, 0, 58], autoRotate: 0.25 },
  bloom: 1.0,
  defaultLogic: 'ambient',
  params: {
    radius: { value: 8, min: 3, max: 25, label: 'Shell radius' },
    gravity: { value: 1.5, min: 0, max: 4, label: 'Gravity' },
    swirl: { value: 3, min: 0, max: 10, label: 'Swirl' },
  },

  setup(ctx) {
    ctx.helpers.formations.sphere(ctx.targets, ctx.count, 1, true); // unit directions
    ctx.state.dirs = ctx.targets.slice();
    ctx.state.spread = new Float32Array(ctx.count);
    for (let i = 0; i < ctx.count; i++) ctx.state.spread[i] = 0.3 + Math.pow(ctx.helpers.rand(i, 2), 2) * 1.2;
  },

  update(ctx) {
    const { audio, macros, params, targets, velocities, positions, count, helpers } = ctx;
    const dirs = ctx.state.dirs as Float32Array;
    const spread = ctx.state.spread as Float32Array;
    const R = params.radius * (1 + audio.bass * 0.35 * macros.intensity);
    const burst = audio.beat ? (2 + macros.impulse * 6) : 0;

    for (let i = 0, j = 0; i < count; i++, j += 3) {
      const r = R * spread[i];
      targets[j] = dirs[j] * r;
      targets[j + 1] = dirs[j + 1] * r;
      targets[j + 2] = dirs[j + 2] * r;
      if (burst > 0 && helpers.rand(i, ctx.frame & 7) < 0.5) {
        velocities[j] += dirs[j] * burst;
        velocities[j + 1] += dirs[j + 1] * burst;
        velocities[j + 2] += dirs[j + 2] * burst;
      }
    }

    ctx.integrate({
      spring: params.gravity * (0.5 + macros.intensity),
      damping: 1.4,
      flow: params.swirl * (0.4 + macros.chaos),
      flowScale: 0.18,
      maxSpeed: 30,
    });

    // Colour by distance from the centre: core warm, edges cool (shifted by hue macro).
    for (let i = 0, j = 0; i < count; i++, j += 3) {
      const d = Math.sqrt(positions[j] ** 2 + positions[j + 1] ** 2 + positions[j + 2] ** 2) / (R * 1.4);
      helpers.setColorHSL(i, macros.hue + (d - 0.5) * macros.hueSpread * 2, 0.75, helpers.clamp(0.62 - d * 0.3, 0.2, 0.6) + audio.high * 0.1);
      ctx.sizes[i] = 0.5 + helpers.rand(i, 4) * 1.2;
      ctx.alphas[i] = 0.5 + 0.5 * helpers.rand(i, 6);
    }
  },
};

export default scene;
