import type { SceneDefinition } from '../src/engine/types';

/**
 * A landscape made of dots. The front edge is the live spectrum (bass on the left, highs on the right);
 * it scrolls into the distance, so the music leaves a mountain range behind it.
 */

const COLS = 240;
const ROWS = 200;

const scene: SceneDefinition = {
  id: 'spectral-terrain',
  name: 'Spectral Terrain',
  description: 'A dot landscape: the live spectrum becomes a ridge that scrolls into the distance, over rolling noise hills.',
  author: 'built-in',
  particleCount: COLS * ROWS,
  camera: { position: [0, 12, 32], target: [0, 1, -4], autoRotate: 0 },
  bloom: 0.8,
  defaultLogic: 'balanced',
  params: {
    height: { value: 10, min: 0, max: 30, label: 'Mountain height' },
    scroll: { value: 30, min: 2, max: 120, label: 'Scroll rate (rows/s)' },
    hills: { value: 2, min: 0, max: 8, label: 'Noise hills' },
  },

  setup(ctx) {
    ctx.state.history = new Float32Array(COLS * ROWS); // spectrum history, row 0 = newest
    ctx.state.acc = 0;
    ctx.state.offset = 0;
    ctx.helpers.formations.grid(ctx.targets, ctx.count, 60, 50);
    ctx.setBackground(0.004, 0.006, 0.015);
  },

  update(ctx) {
    const { audio, macros, params, targets, count, helpers } = ctx;
    const hist = ctx.state.history as Float32Array;

    // Push the current spectrum as a new row at the configured rate.
    ctx.state.acc += ctx.sdt * params.scroll;
    while (ctx.state.acc >= 1) {
      ctx.state.acc -= 1;
      ctx.state.offset++;
      hist.copyWithin(COLS, 0, COLS * (ROWS - 1));
      for (let c = 0; c < COLS; c++) {
        // Map column → spectrum band (first 52 bands carry most musical content).
        const b = (c / (COLS - 1)) * 51;
        const b0 = Math.floor(b), f = b - b0;
        const v = audio.spectrum[b0] * (1 - f) + audio.spectrum[Math.min(63, b0 + 1)] * f;
        hist[c] = v * Math.sqrt(v);
      }
    }

    const width = 60, depth = 50;
    const h = params.height * (0.4 + macros.intensity * 0.8);
    const hills = params.hills * (0.5 + macros.chaos);
    const scrollZ = ctx.state.offset * 0.25; // so hills move with the ridge
    const t = ctx.time;

    for (let i = 0; i < count; i++) {
      const c = i % COLS, r = Math.floor(i / COLS);
      const x = (c / (COLS - 1) - 0.5) * width;
      const z = (0.5 - r / (ROWS - 1)) * depth; // row 0 at front (positive z)
      const fade = 1 - r / ROWS;
      const ridge = hist[r * COLS + c] * h * (0.4 + 0.6 * fade);
      const n = helpers.noise3(x * 0.06, (z - scrollZ) * 0.06, t * 0.05) * hills;
      const y = ridge + n - 4;
      const j = i * 3;
      targets[j] = x;
      targets[j + 1] = y;
      targets[j + 2] = z;

      const hn = helpers.clamp((y + 4) / (h + 2), 0, 1);
      helpers.setColorHSL(i, macros.hue + hn * macros.hueSpread * 2 - 0.1, 0.8, 0.38 + hn * 0.3);
      ctx.alphas[i] = 0.35 + fade * 0.65;
      ctx.sizes[i] = 1 + hn * 1.6 + audio.pulse * 0.3 * fade;
    }
    ctx.integrate({ spring: 18, damping: 8 });
  },
};

export default scene;
