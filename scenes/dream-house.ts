import type { SceneDefinition } from '../src/engine/types';

/**
 * A house made of particles (models/house.glb, built in Blender).
 * Each named part reacts on its own: the roof lifts on bass, the windows glow with the highs,
 * beats blow the walls outward along their surface normals, the door pulses with the low-mids.
 * Chaos stirs the whole house; morph dissolves it into a galaxy and back.
 */

const scene: SceneDefinition = {
  id: 'dream-house',
  name: 'Dream House',
  description: 'A particle house from a Blender model: roof lifts on bass, windows glow with highs, beats blow the walls out, morph dissolves it into a galaxy.',
  author: 'built-in',
  particleCount: 60000,
  models: ['house'],
  camera: { position: [26, 12, 40], target: [0, 1, 0], autoRotate: 0.25 },
  bloom: 0.9,
  defaultLogic: 'balanced',
  params: {
    scale: { value: 13, min: 6, max: 22, label: 'House size' },
    lift: { value: 4, min: 0, max: 12, label: 'Roof lift' },
    glow: { value: 1.2, min: 0, max: 3, label: 'Window glow' },
    tint: { value: 0.35, min: 0, max: 1, label: 'Tint by hue' },
  },

  setup(ctx) {
    const m = ctx.models.house;
    ctx.state.cloud = new Float32Array(ctx.count * 3);
    ctx.helpers.formations.galaxy(ctx.state.cloud, ctx.count, 24, 3, 2);
    ctx.state.roof = m.partNames.indexOf('roof');
    ctx.state.walls = m.partNames.indexOf('walls');
    ctx.state.windows = m.partNames.indexOf('windows');
    ctx.state.door = m.partNames.indexOf('door');
    ctx.setBackground(0.005, 0.006, 0.016);
  },

  update(ctx) {
    const { audio, macros, params, targets, velocities, colors, sizes, alphas, count, helpers } = ctx;
    const m = ctx.models.house;
    const P = m.positions, N = m.normals, C = m.colors, part = m.parts;
    const cloud = ctx.state.cloud as Float32Array;
    const { roof, walls, windows, door } = ctx.state as Record<string, number>;

    const s = params.scale;
    const morph = helpers.smoothstep(0, 1, macros.morph);
    const lift = params.lift * audio.bass * macros.intensity;
    const burst = audio.beat ? 1.5 + macros.impulse * 5 : 0;
    const glow = params.glow * (0.3 + audio.high * 1.2 + audio.pulse * 0.4);
    const doorPush = audio.lowMid * macros.intensity * 1.5;
    const tint = params.tint * (0.6 + macros.hueSpread);
    const spin = ctx.time * 0.15;
    const cs = Math.cos(spin), sn = Math.sin(spin);

    for (let i = 0, j = 0; i < count; i++, j += 3) {
      const p = part[i];
      let x = P[j] * s, y = P[j + 1] * s, z = P[j + 2] * s;
      // Simple lighting from the normals so walls, roof slopes and edges read as 3D.
      const lambert = N[j] * 0.45 + N[j + 1] * 0.75 + N[j + 2] * 0.5;
      const light = 0.3 + 0.7 * (lambert > 0 ? lambert : 0);
      const boost = p === roof ? 2.4 : 1.25;
      let r = C[j] * light * boost, g = C[j + 1] * light * boost, b = C[j + 2] * light * boost;
      let size = 1, alpha = 0.85;

      if (p === roof) {
        // Lift and slightly spread the roof on bass.
        y += lift;
        x *= 1 + lift * 0.01;
        z *= 1 + lift * 0.01;
      } else if (p === windows) {
        // Warm light that flickers with the highs.
        const flick = 0.6 + 0.4 * helpers.rand(i, ctx.frame >> 3);
        r = 0.9 * glow * flick; g = 0.6 * glow * flick; b = 0.25 * glow * flick;
        size = 1.2 + audio.high * 1.5;
        alpha = 1;
      } else if (p === door) {
        x += N[j] * doorPush; y += N[j + 1] * doorPush; z += N[j + 2] * doorPush;
        r += audio.lowMid * 0.25; g += audio.lowMid * 0.1;
      } else if (p === walls && burst > 0 && helpers.rand(i, ctx.frame & 7) < 0.35) {
        velocities[j] += N[j] * burst;
        velocities[j + 1] += N[j + 1] * burst;
        velocities[j + 2] += N[j + 2] * burst;
      }

      // Morph: dissolve into a slowly turning galaxy.
      if (morph > 0) {
        const cx = cloud[j] * cs - cloud[j + 2] * sn, cz = cloud[j] * sn + cloud[j + 2] * cs;
        x += (cx - x) * morph; y += (cloud[j + 1] - y) * morph; z += (cz - z) * morph;
      }
      targets[j] = x; targets[j + 1] = y; targets[j + 2] = z;

      // Blend the model's own colour towards the hue macro (windows keep their warm light).
      if (p !== windows && tint > 0) {
        helpers.setColorHSL(i, macros.hue + P[j + 1] * macros.hueSpread * 0.5, 0.7, 0.2 + 0.35 * light);
        r += (colors[j] - r) * tint; g += (colors[j + 1] - g) * tint; b += (colors[j + 2] - b) * tint;
      }
      colors[j] = r; colors[j + 1] = g; colors[j + 2] = b;
      sizes[i] = size * (1.1 + helpers.rand(i, 5) * 0.7);
      alphas[i] = alpha;
    }

    ctx.integrate({
      spring: 7 + macros.intensity * 3,
      damping: 3,
      flow: macros.chaos * 2.5,
      flowScale: 0.25,
      maxSpeed: 40,
    });
  },
};

export default scene;
