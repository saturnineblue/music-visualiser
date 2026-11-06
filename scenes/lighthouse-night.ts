import type { SceneDefinition } from '../src/engine/types';

/**
 * Lighthouse Night: the 'lighthouse-island' model plus a particle ocean and two sweeping light beams.
 * Particles 0..62% draw the model, 62..90% the ocean, the rest the lamp's beams.
 * Parts react separately:
 *  - rocks rumble along their normals with the bass
 *  - tower (and everything on it) sways with intensity and bass, more at the top
 *  - stripes glow in bands that chase upward, flaring on beats
 *  - gallery and railing widen with the low-mids, the railing sparkles with the highs
 *  - glass glows with the mids and bursts outward on beats
 *  - the lamp swells with loudness and beats; the roof hops on beats
 *  - the cottage roof bounces with the bass, its windows flicker warm with the highs
 * Ocean waves follow the bass, beats send shock rings out from the island, and the beams light the water.
 */

const MODEL = 'lighthouse-island';

const scene: SceneDefinition = {
  id: 'lighthouse-night',
  name: 'Lighthouse Night',
  description: 'A particle lighthouse on a rocky island at night: beams sweep the bass-driven sea, stripes chase upward, the lamp flares on beats, beats ring across the water, morph dissolves it into a galaxy.',
  author: 'claude',
  particleCount: 90000,
  models: [MODEL],
  camera: { position: [34, 9, 44], target: [0, 0, 0], autoRotate: 0.12, fov: 55 },
  bloom: 1.1,
  defaultLogic: 'balanced',
  params: {
    scale: { value: 14, min: 8, max: 20, label: 'Island size' },
    rotate: { value: 0.9, min: 0, max: 3, label: 'Beam rotation' },
    beam: { value: 1, min: 0, max: 2, label: 'Beam length' },
    waves: { value: 1, min: 0, max: 3, label: 'Wave height' },
    sway: { value: 0.6, min: 0, max: 3, label: 'Tower sway' },
    lift: { value: 1.5, min: 0, max: 5, label: 'Roof lift' },
    glow: { value: 1.2, min: 0, max: 3, label: 'Lamp glow' },
    tint: { value: 0.3, min: 0, max: 1, label: 'Tint by hue' },
  },

  setup(ctx) {
    const S = ctx.state as any;
    const m = ctx.models[MODEL];
    const P = m.positions, part = m.parts, n = ctx.count, h = ctx.helpers;
    const pi = (name: string) => m.partNames.indexOf(name);
    S.rocks = pi('rocks'); S.tower = pi('tower'); S.stripes = pi('stripes'); S.gallery = pi('gallery');
    S.railing = pi('railing'); S.glass = pi('glass'); S.roof = pi('roof'); S.lamp = pi('lamp');
    S.lampBase = pi('lamp_base'); S.cottage = pi('cottage'); S.cottageRoof = pi('cottage_roof'); S.windows = pi('windows');

    let minY = 1e9, maxY = -1e9;
    let lx = 0, ly = 0, lz = 0, ln = 0, gx = 0, gy = 0, gz = 0, gn = 0, rr = 0, ry = 0, rn = 0;
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      const y = P[j + 1];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const p = part[i];
      if (p === S.lamp) { lx += P[j]; ly += y; lz += P[j + 2]; ln++; }
      else if (p === S.glass) { gx += P[j]; gy += y; gz += P[j + 2]; gn++; }
      if (p === S.rocks) { rr += Math.hypot(P[j], P[j + 2]); ry += y; rn++; }
    }
    if (ln > 0) { S.lx = lx / ln; S.ly = ly / ln; S.lz = lz / ln; }
    else if (gn > 0) { S.lx = gx / gn; S.ly = gy / gn; S.lz = gz / gn; }
    else { S.lx = 0; S.ly = maxY * 0.85; S.lz = 0; }
    S.minY = minY; S.maxY = maxY;
    S.waterY = rn > 0 ? minY + (ry / rn - minY) * 0.55 : minY + 0.02;
    S.hRange = Math.max(0.01, maxY - S.waterY);
    const inner = rn > 0 ? (rr / rn) * 1.05 : 0.35;
    S.inner = inner;

    S.modelEnd = Math.floor(n * 0.62);
    S.oceanEnd = Math.floor(n * 0.9);

    // Ocean / beam per-particle layout (reused arrays).
    const A = new Float32Array(n), B = new Float32Array(n), C = new Float32Array(n), D = new Float32Array(n);
    for (let i = S.modelEnd; i < S.oceanEnd; i++) {
      const a = h.rand(i, 11) * Math.PI * 2;
      A[i] = Math.cos(a); B[i] = Math.sin(a);
      C[i] = inner + (3.3 - inner) * Math.pow(h.rand(i, 12), 0.85);
    }
    for (let i = S.oceanEnd; i < n; i++) {
      const a = h.rand(i, 22) * Math.PI * 2;
      const r = Math.sqrt(h.rand(i, 23));
      A[i] = Math.cos(a) * r; B[i] = Math.sin(a) * r;
      C[i] = h.rand(i, 21);
      D[i] = h.rand(i, 24) < 0.5 ? 1 : -1;
    }
    S.A = A; S.B = B; S.C = C; S.D = D;

    S.cloud = new Float32Array(n * 3);
    h.formations.galaxy(S.cloud, n, 24, 3, 2);
    S.ringT = -100; S.ringAmp = 0;

    // Start everything at its target-ish place.
    ctx.setBackground(0.004, 0.008, 0.022);
  },

  update(ctx) {
    const { audio, macros, params, targets, positions, velocities, colors, sizes, alphas, count, helpers } = ctx;
    const S = ctx.state as any;
    const m = ctx.models[MODEL];
    const P = m.positions, N = m.normals, MC = m.colors, part = m.parts;
    const cloud = S.cloud as Float32Array;
    const A = S.A as Float32Array, B = S.B as Float32Array, C = S.C as Float32Array, D = S.D as Float32Array;
    const rocks = S.rocks, tower = S.tower, stripes = S.stripes, gallery = S.gallery, railing = S.railing;
    const glass = S.glass, roof = S.roof, lamp = S.lamp, lampBase = S.lampBase;
    const cottage = S.cottage, cottageRoof = S.cottageRoof, windows = S.windows;
    const modelEnd = S.modelEnd as number, oceanEnd = S.oceanEnd as number;
    const waterY = S.waterY as number, hRange = S.hRange as number;

    const t = ctx.time;
    const s = params.scale;
    const inten = macros.intensity, chaos = macros.chaos;
    const hue = macros.hue, spread = macros.hueSpread;

    if (audio.beat) { S.ringT = t; S.ringAmp = 0.6 + macros.impulse * 1.2; }
    const age = Math.max(0, t - S.ringT);
    const ringR = S.inner * s + age * 16;
    const ringA = S.ringAmp * Math.exp(-age * 0.9) * params.waves;

    // Tower sway (world units at the top).
    const swayAmp = params.sway * (0.3 + inten * 0.7 + audio.bass * 0.6);
    const swayX = Math.sin(t * 0.7) * swayAmp;
    const swayZ = Math.cos(t * 0.53) * swayAmp * 0.6;

    // Lamp position (follows sway).
    const hL = helpers.clamp((S.ly - waterY) / hRange, 0, 1);
    const lampX = S.lx * s + swayX * hL * hL;
    const lampY = S.ly * s;
    const lampZ = S.lz * s + swayZ * hL * hL;
    const axX = S.lx * s, axZ = S.lz * s;

    const theta = t * params.rotate;
    const ct = Math.cos(theta), stn = Math.sin(theta);
    const beamStr = Math.min(1.4, params.glow * (0.35 + audio.mid * 0.6 + audio.pulse * 0.5));
    const L = s * (1.6 + audio.mid * 1.2 + audio.pulse * 0.6) * params.beam;

    const rumble = audio.bass * inten * 0.7;
    const morph = helpers.smoothstep(0, 1, macros.morph);
    const spin = t * 0.15, cs = Math.cos(spin), sn = Math.sin(spin);
    const burst = audio.beat ? 2 + macros.impulse * 5 : 0;
    const galleryF = audio.lowMid * inten * 0.12;
    const roofLift = params.lift * (audio.pulse * (0.5 + macros.impulse * 0.5) + audio.bass * 0.15);
    const cRoofLift = params.lift * audio.bass * inten * 0.35;
    const lampGlow = params.glow * (0.6 + audio.rms * 1.0 + audio.pulse * 0.8);
    const tint = params.tint * (0.6 + spread);
    const chase = t * 0.6;
    const frame = ctx.frame;

    // ---------- Model ----------
    for (let i = 0, j = 0; i < modelEnd; i++, j += 3) {
      const p = part[i];
      const nx = N[j], ny = N[j + 1], nz = N[j + 2];
      let x = P[j] * s, y = P[j + 1] * s, z = P[j + 2] * s;
      const lambert = nx * 0.45 + ny * 0.7 + nz * 0.5;
      const light = 0.3 + 0.7 * (lambert > 0 ? lambert : 0);
      let r = MC[j] * light * 1.1, g = MC[j + 1] * light * 1.1, b = MC[j + 2] * light * 1.1;
      let size = 1, alpha = 0.88;
      let tintable = true, onTower = true;

      if (p === rocks) {
        onTower = false;
        const k = (helpers.rand(i, frame & 15) - 0.5) * rumble;
        x += nx * k; y += ny * k; z += nz * k;
        r *= 0.75; g *= 0.8; b *= 0.95;
      } else if (p === stripes) {
        const hn = (P[j + 1] - waterY) / hRange;
        let band = hn * 3 - chase;
        band = band - Math.floor(band);
        let tri = 1 - Math.abs(band - 0.5) * 2;
        tri = tri * tri * tri * tri;
        helpers.setColorHSL(i, hue + 0.42, 0.85, 0.22 + 0.15 * light + tri * 0.25 * (0.5 + audio.mid) + audio.pulse * 0.12);
        r = colors[j]; g = colors[j + 1]; b = colors[j + 2];
        size = 1 + tri * 0.4;
        tintable = false;
      } else if (p === gallery || p === railing) {
        const dx = x - axX, dz = z - axZ;
        x += dx * galleryF; z += dz * galleryF;
        if (p === railing && helpers.rand(i, frame >> 1) < audio.high * 0.6) {
          r += 0.5; g += 0.5; b += 0.45; size = 1.6; alpha = 1;
        }
      } else if (p === glass) {
        helpers.setColorHSL(i, hue - 0.05, 0.6, 0.2 + audio.mid * 0.35 + audio.pulse * 0.15);
        r = colors[j]; g = colors[j + 1]; b = colors[j + 2];
        alpha = 0.7;
        tintable = false;
        if (burst > 0 && helpers.rand(i, frame & 7) < 0.3) {
          velocities[j] += nx * burst; velocities[j + 1] += ny * burst; velocities[j + 2] += nz * burst;
        }
      } else if (p === lamp) {
        const fl = lampGlow * (0.85 + 0.15 * helpers.rand(i, frame >> 2));
        r = 1.0 * fl; g = 0.85 * fl; b = 0.5 * fl;
        size = 1.5 + audio.rms * 2 + audio.pulse * 1.5;
        alpha = 1;
        tintable = false;
      } else if (p === lampBase) {
        r *= 1.3; g *= 1.2; b *= 0.9;
      } else if (p === roof) {
        y += roofLift;
      } else if (p === cottage) {
        onTower = false;
      } else if (p === cottageRoof) {
        onTower = false;
        y += cRoofLift;
      } else if (p === windows) {
        onTower = false;
        const fl = (0.55 + 0.45 * helpers.rand(i, frame >> 3)) * (0.5 + audio.high * 1.5 + audio.pulse * 0.3);
        r = 0.95 * fl; g = 0.62 * fl; b = 0.25 * fl;
        size = 1.2 + audio.high * 1.2;
        alpha = 1;
        tintable = false;
      } else if (p !== tower) {
        onTower = false;
      }

      if (onTower) {
        const hn = helpers.clamp((P[j + 1] - waterY) / hRange, 0, 1);
        const h2 = hn * hn;
        x += swayX * h2; z += swayZ * h2;
      }

      if (morph > 0) {
        const cx = cloud[j] * cs - cloud[j + 2] * sn, cz = cloud[j] * sn + cloud[j + 2] * cs;
        x += (cx - x) * morph; y += (cloud[j + 1] - y) * morph; z += (cz - z) * morph;
      }
      targets[j] = x; targets[j + 1] = y; targets[j + 2] = z;

      if (tintable && tint > 0) {
        helpers.setColorHSL(i, hue + P[j + 1] * spread * 0.5, 0.6, 0.18 + 0.32 * light);
        r += (colors[j] - r) * tint; g += (colors[j + 1] - g) * tint; b += (colors[j + 2] - b) * tint;
      }
      colors[j] = r; colors[j + 1] = g; colors[j + 2] = b;
      sizes[i] = size * (1 + helpers.rand(i, 5) * 0.6);
      alphas[i] = alpha;
    }

    // ---------- Ocean ----------
    const amp = params.waves * (0.25 + audio.bass * inten * 1.4 + inten * 0.2);
    const wY = waterY * s;
    const noiseAmp = 0.4 + chaos * 0.6;
    for (let i = modelEnd, j = modelEnd * 3; i < oceanEnd; i++, j += 3) {
      const radN = C[i];
      const rad = radN * s;
      const x = A[i] * rad, z = B[i] * rad;
      const nse = helpers.noise3(x * 0.06, z * 0.06, t * 0.25);
      const hgt = (Math.sin(rad * 0.32 - t * 1.4) * 0.5 + Math.sin(x * 0.15 + z * 0.11 + t * 0.8) * 0.35 + nse * noiseAmp) * amp;
      const dr = rad - ringR;
      const ringV = ringA > 0.01 ? ringA * Math.exp(-dr * dr * 0.12) : 0;
      targets[j] = x; targets[j + 1] = wY + hgt + ringV * 1.2; targets[j + 2] = z;

      const crest = helpers.clamp(hgt / (amp + 0.001) * 0.5 + 0.5, 0, 1);
      const d = A[i] * ct + B[i] * stn;
      const d2 = d * d;
      let illum = d2 > 0.97 ? (d2 - 0.97) / 0.03 : 0;
      if (illum > 0) illum *= beamStr * helpers.clamp(1.2 - rad / (L * 1.3 + 0.001), 0, 1);
      helpers.setColorHSL(i, hue + 0.02 - crest * 0.05 * (0.3 + spread), 0.7 - illum * 0.4, 0.06 + crest * crest * 0.14 + illum * 0.42 + ringV * 0.1);
      const fade = 1 - helpers.smoothstep(2.5, 3.3, radN);
      alphas[i] = (0.45 + crest * 0.25 + illum * 0.3) * fade;
      sizes[i] = 0.9 + illum * 0.8 + crest * 0.3;
    }

    // ---------- Beams ----------
    const px = -stn, pz = ct;
    const widthK = 0.07 + chaos * 0.02;
    for (let i = oceanEnd, j = oceanEnd * 3; i < count; i++, j += 3) {
      const u = C[i];
      const side = D[i];
      const dist = u * L;
      const w = widthK * dist + 0.25;
      const bx = A[i], by = B[i];
      targets[j] = lampX + ct * side * dist + px * bx * w;
      targets[j + 1] = lampY - 0.04 * dist + by * w * 0.6;
      targets[j + 2] = lampZ + stn * side * dist + pz * bx * w;
      const fall = 1 - u;
      const core = 1 - Math.min(1, bx * bx + by * by);
      const l = beamStr * fall * (0.35 + 0.65 * core);
      colors[j] = 0.95 * l; colors[j + 1] = 0.82 * l; colors[j + 2] = 0.55 * l;
      alphas[i] = fall * 0.7;
      sizes[i] = 1.1 + u * 0.9;
    }

    ctx.integrate({
      spring: 8 + inten * 3,
      damping: 3.2,
      flow: chaos * 2,
      flowScale: 0.25,
      maxSpeed: 40,
    });

    // Ocean and beams are placed exactly (crisp sweep, no lag).
    for (let k = modelEnd * 3, e = count * 3; k < e; k++) {
      positions[k] = targets[k];
      velocities[k] = 0;
    }
  },
};

export default scene;
