import type { SceneDefinition } from '../src/engine/types';

// Template used by the "New blank scene" button. my-scene / My Scene are replaced.
// Edit this file in any editor (or ask Claude) — the app hot-reloads it.

const scene: SceneDefinition = {
  id: 'my-scene',
  name: 'My Scene',
  description: 'A pulsing sphere of particles. Edit me!',
  author: 'you',
  particleCount: 40000,
  params: {
    radius: { value: 12, min: 2, max: 30, label: 'Radius' },
  },

  setup(ctx) {
    ctx.helpers.formations.sphere(ctx.targets, ctx.count, ctx.params.radius, true);
    ctx.state.base = ctx.targets.slice();
  },

  update(ctx) {
    const { targets, count, audio, macros } = ctx;
    const base = ctx.state.base as Float32Array;
    const scale = (ctx.params.radius / 12) * (1 + macros.intensity * 0.3 + audio.pulse * 0.2);
    for (let i = 0; i < count * 3; i++) targets[i] = base[i] * scale;
    ctx.integrate({ spring: 3, damping: 2, flow: macros.chaos * 4 });
    ctx.colorize();
  },
};

export default scene;
