import type { SceneDefinition } from '../src/engine/types';

/**
 * Particles assemble into a sequence of forms (sphere → torus knot → galaxy → Lorenz attractor → helix)
 * and morph to the next one every few beats. Beats also send a shockwave through the current form.
 */

const FORMS = ['sphere', 'knot', 'galaxy', 'lorenz', 'helix'] as const;

const scene: SceneDefinition = {
  id: 'morphing-forms',
  name: 'Morphing Forms',
  description: 'Assembles into sphere, knot, galaxy, attractor and helix; morphs every few beats, shockwaves on hits.',
  author: 'built-in',
  particleCount: 60000,
  camera: { position: [0, 6, 52], autoRotate: 0.6 },
  bloom: 0.8,
  defaultLogic: 'balanced',
  params: {
    beatsPerMorph: { value: 16, min: 1, max: 32, step: 1, label: 'Beats per morph' },
    morphTime: { value: 1.6, min: 0.2, max: 6, label: 'Morph time (s)' },
    shockwave: { value: 1, min: 0, max: 3, label: 'Shockwave' },
  },

  setup(ctx) {
    const f = ctx.helpers.formations;
    const n = ctx.count;
    const shapes: Float32Array[] = FORMS.map(() => new Float32Array(n * 3));
    f.sphere(shapes[0], n, 11, true);
    f.torusKnot(shapes[1], n, 4.2, 2, 3, 0.35);
    f.galaxy(shapes[2], n, 20, 4, 2.2);
    f.lorenz(shapes[3], n, 14);
    f.helix(shapes[4], n, 7, 30, 3.5, 3);
    ctx.state.shapes = shapes;
    ctx.state.from = 0;
    ctx.state.to = 0;
    ctx.state.t = 1;          // morph progress 0..1
    ctx.state.beats = 0;
  },

  update(ctx) {
    const s = ctx.state;
    const { audio, macros, params, targets, velocities, positions, count, helpers } = ctx;
    const shapes = s.shapes as Float32Array[];

    // Advance to the next form every N beats.
    if (audio.beat) {
      s.beats++;
      if (s.beats >= params.beatsPerMorph && s.t >= 1) {
        s.beats = 0;
        s.from = s.to;
        s.to = (s.to + 1) % shapes.length;
        s.t = 0;
      }
    }
    s.t = Math.min(1, s.t + ctx.dt / params.morphTime);
    // Stagger the morph per particle so it flows rather than snaps; macro.morph adds extra blend.
    const A = shapes[s.from], B = shapes[s.to];
    const breathe = 1 + macros.intensity * 0.15 + audio.bass * 0.12 * macros.intensity;

    for (let i = 0, j = 0; i < count; i++, j += 3) {
      const delay = helpers.rand(i, 3) * 0.5;
      let k = helpers.smoothstep(delay, delay + 0.5, s.t);
      k = Math.min(1, k + macros.morph);
      targets[j] = (A[j] + (B[j] - A[j]) * k) * breathe;
      targets[j + 1] = (A[j + 1] + (B[j + 1] - A[j + 1]) * k) * breathe;
      targets[j + 2] = (A[j + 2] + (B[j + 2] - A[j + 2]) * k) * breathe;
    }

    // Shockwave: radial kick on beats, scaled by impulse.
    const kick = (audio.beat ? 1 : 0) * params.shockwave * (0.3 + macros.impulse) * 8;
    if (kick > 0) {
      for (let i = 0, j = 0; i < count; i++, j += 3) {
        const x = positions[j], y = positions[j + 1], z = positions[j + 2];
        const d = Math.sqrt(x * x + y * y + z * z) + 0.001;
        const r = helpers.rand(i, 9);
        velocities[j] += (x / d) * kick * r;
        velocities[j + 1] += (y / d) * kick * r;
        velocities[j + 2] += (z / d) * kick * r;
      }
    }

    ctx.integrate({ spring: 2.5 + macros.intensity * 2, damping: 2.2, flow: macros.chaos * 5, flowScale: 0.25 });

    // Colour: hue shifts with each form, spread by particle, brightened by highs.
    const hueBase = macros.hue + (s.to / shapes.length) * 0.3 * (s.t) + (s.from / shapes.length) * 0.3 * (1 - s.t);
    const light = 0.45 + audio.high * 0.15;
    for (let i = 0; i < count; i++) {
      helpers.setColorHSL(i, hueBase + (helpers.rand(i, 1) - 0.5) * macros.hueSpread, 0.75, light);
      ctx.sizes[i] = 0.7 + helpers.rand(i, 5) * 0.8 + audio.pulse * 0.4;
    }
  },
};

export default scene;
