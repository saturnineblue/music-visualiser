import type { SceneDefinition } from '../src/engine/types';

/**
 * Storm Moon: layered banks of billowing particle clouds drifting past a glowing moon, with lightning.
 * Particles 0..70% are clouds, 70..76% the moon (disc + halo), 76..79% faint stars, the rest three
 * lightning-bolt slots.
 *  - clouds are made of puffs that swell with the bass × intensity and billow (noise) with chaos;
 *    their tops catch the moonlight, the wind drifts each layer at its own speed
 *  - the moon brightens with the mids and shifts from warm silver toward the scene hue with the highs
 *  - each beat fires a branching bolt (impulse can fire two at once); it flickers and re-strikes,
 *    lights up the clouds around it, kicks them outward and flashes the sky
 *  - stars twinkle with the highs
 */

const NB = 3;          // concurrent bolt slots
const MAXSEG = 160;    // segments per bolt
const SEGF = 7;        // floats per segment: ax ay az bx by bz weight
const NP = 150;        // cloud puffs
const LIFE = 0.75;     // bolt lifetime (s)

const scene: SceneDefinition = {
  id: 'storm-moon',
  name: 'Storm Moon',
  description: 'Billowing night clouds drift past a glowing moon; beats fire branching lightning that flickers, re-strikes and lights up the clouds. Bass swells the clouds, mids brighten the moon, highs tint it and make the stars twinkle.',
  author: 'claude',
  particleCount: 80000,
  camera: { position: [0, 3, 50], target: [0, 6, -6], autoRotate: 0, fov: 58 },
  bloom: 1.0,
  defaultLogic: 'storm',
  params: {
    swell: { value: 1, min: 0, max: 3, label: 'Cloud swell' },
    billow: { value: 1, min: 0, max: 3, label: 'Billow' },
    wind: { value: 1, min: 0, max: 4, label: 'Wind' },
    moonGlow: { value: 1, min: 0, max: 3, label: 'Moon glow' },
    strikes: { value: 1, min: 0, max: 1, label: 'Strike chance' },
    flash: { value: 1, min: 0, max: 3, label: 'Lightning glow' },
    branches: { value: 1, min: 0, max: 2, label: 'Branching' },
  },

  setup(ctx) {
    const S = ctx.state as any;
    const n = ctx.count, h = ctx.helpers;
    const rnd = Math.random;

    S.cloudEnd = Math.floor(n * 0.70);
    S.moonEnd = Math.floor(n * 0.77);
    S.starEnd = Math.floor(n * 0.80);
    S.boltPer = Math.floor((n - S.starEnd) / NB);

    // ---- Cloud puffs: three layers (back/high, middle, front/low) ----
    const PX = new Float32Array(NP), PY = new Float32Array(NP), PZ = new Float32Array(NP);
    const PR = new Float32Array(NP), PL = new Uint8Array(NP), PPh = new Float32Array(NP);
    const W = new Float32Array(NP);
    let wsum = 0;
    // Puffs are grouped into heaped cloud banks: big puffs low in the middle, smaller ones on top/sides.
    //                   banks, baseY, z0,  zR, width, heapH, radius
    const LAYERS = [
      [6, 13, -34, 10, 26, 7, 6.5],
      [6, 5.5, -15, 9, 20, 6, 5],
      [4, 0.5, 2, 8, 13, 4, 3.6],
    ];
    const NBK = 16;
    let bank = -1, bx = 0, by = 0, bz = 0, bw = 0, bh = 0, br = 0;
    for (let p = 0; p < NP; p++) {
      const bk = Math.floor(p * NBK / NP);
      const layer = bk < 6 ? 0 : bk < 12 ? 1 : 2;
      if (bk !== bank) {
        bank = bk;
        const L = LAYERS[layer];
        const k = layer === 0 ? bk : layer === 1 ? bk - 6 : bk - 12;
        bx = -60 + (k + 0.5 + (rnd() - 0.5) * 0.5) * (120 / L[0]);
        by = L[1] + rnd() * 2; bz = L[2] + rnd() * L[3];
        bw = L[4] * (0.75 + rnd() * 0.5); bh = L[5] * (0.7 + rnd() * 0.6); br = L[6];
      }
      PL[p] = layer;
      const ox = (rnd() - 0.5) * bw;
      const centre = 1 - Math.abs(ox) / (bw * 0.5);   // 1 in the middle, 0 at the ends
      PX[p] = bx + ox;
      PY[p] = by + centre * bh * Math.pow(rnd(), 0.8);
      PZ[p] = bz + (rnd() - 0.5) * br;
      PR[p] = br * (0.45 + 0.75 * centre) * (0.8 + rnd() * 0.4);
      PPh[p] = rnd() * Math.PI * 2;
      wsum += PR[p] * PR[p];
      W[p] = wsum;
    }
    S.PX = PX; S.PY = PY; S.PZ = PZ; S.PR = PR; S.PL = PL; S.PPh = PPh;
    S.PS = new Float32Array(NP);            // per-frame swell
    S.PMx = new Float32Array(NP); S.PMy = new Float32Array(NP); S.PMz = new Float32Array(NP); // dir to moon

    // Cloud particles: puff index (area-weighted) + direction inside the puff.
    const puff = new Uint16Array(S.cloudEnd);
    const D = new Float32Array(S.cloudEnd * 3);
    for (let i = 0, j = 0; i < S.cloudEnd; i++, j += 3) {
      const target = h.rand(i, 1) * wsum;
      let lo = 0, hi = NP - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (W[mid] < target) lo = mid + 1; else hi = mid; }
      puff[i] = lo;
      // random direction, radius biased toward the surface
      const z = h.rand(i, 2) * 2 - 1, a = h.rand(i, 3) * Math.PI * 2;
      const rr = Math.sqrt(1 - z * z), r = Math.pow(h.rand(i, 4), 0.45);
      let dy = z * r;
      if (dy < 0) dy *= 0.4;                // flat-ish cloud bottoms
      D[j] = Math.cos(a) * rr * r; D[j + 1] = dy; D[j + 2] = Math.sin(a) * rr * r;
    }
    S.puff = puff; S.D = D;
    const CR = new Float32Array(S.cloudEnd), CZ = new Float32Array(S.cloudEnd);
    for (let i = 0; i < S.cloudEnd; i++) { CR[i] = h.rand(i, 6); CZ[i] = 4 + h.rand(i, 7) * 4; }
    S.CR = CR; S.CZ = CZ;
    // hsl → rgb into out[0..2] (used a few times per frame, not per particle)
    S.hsl = (hh: number, ss: number, ll: number, out: Float32Array) => {
      hh -= Math.floor(hh);
      const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss, pp = 2 * ll - q;
      for (let c = 0; c < 3; c++) {
        let tt = hh + (1 - c) / 3;
        if (tt < 0) tt += 1; if (tt > 1) tt -= 1;
        out[c] = tt < 1 / 6 ? pp + (q - pp) * 6 * tt : tt < 0.5 ? q : tt < 2 / 3 ? pp + (q - pp) * (2 / 3 - tt) * 6 : pp;
      }
    };
    S.cA = new Float32Array(3); S.cB = new Float32Array(3);

    // ---- Moon ----
    S.moonX = -14; S.moonY = 25; S.moonZ = -24; S.moonR = 5.5;
    const MA = new Float32Array(n), MB = new Float32Array(n), MS = new Float32Array(n), MH = new Uint8Array(n);
    for (let i = S.cloudEnd; i < S.moonEnd; i++) {
      const a = h.rand(i, 31) * Math.PI * 2;
      if (h.rand(i, 30) < 0.66) {
        const r = Math.sqrt(h.rand(i, 32));
        const x = Math.cos(a) * r, y = Math.sin(a) * r;
        MA[i] = x; MB[i] = y;
        const crater = h.noise3(x * 2.1 + 3, y * 2.1, 0.7) * 0.55 + h.noise3(x * 5.3, y * 5.3 + 7, 2.1) * 0.25;
        MS[i] = (0.78 + 0.22 * crater) * (1 - r * r * 0.28);
        MH[i] = 0;
      } else {
        const r = 1.02 + Math.pow(h.rand(i, 32), 1.8) * 1.9;
        MA[i] = Math.cos(a) * r; MB[i] = Math.sin(a) * r;
        MS[i] = 1 - (r - 1.02) / 1.9;   // halo falloff 1..0
        MH[i] = 1;
      }
    }
    S.MA = MA; S.MB = MB; S.MS = MS; S.MH = MH;

    // ---- Stars (fixed positions) ----
    const { positions, targets, velocities } = ctx;
    for (let i = S.moonEnd, j = S.moonEnd * 3; i < S.starEnd; i++, j += 3) {
      positions[j] = targets[j] = -110 + h.rand(i, 41) * 220;
      positions[j + 1] = targets[j + 1] = -8 + Math.pow(h.rand(i, 42), 0.7) * 75;
      positions[j + 2] = targets[j + 2] = -70 - h.rand(i, 43) * 20;
      velocities[j] = velocities[j + 1] = velocities[j + 2] = 0;
    }

    // ---- Bolts ----
    const BU = new Float32Array(n), BV = new Float32Array(n), BJx = new Float32Array(n), BJz = new Float32Array(n);
    const BHalo = new Uint8Array(n);
    for (let i = S.starEnd; i < n; i++) {
      BU[i] = h.rand(i, 51); BV[i] = h.rand(i, 52);
      // gaussian-ish lateral jitter
      BJx[i] = (h.rand(i, 53) + h.rand(i, 54) + h.rand(i, 55) - 1.5) * 0.8;
      BJz[i] = (h.rand(i, 56) + h.rand(i, 57) + h.rand(i, 58) - 1.5) * 0.8;
      BHalo[i] = h.rand(i, 59) < 0.28 ? 1 : 0;
    }
    S.BU = BU; S.BV = BV; S.BJx = BJx; S.BJz = BJz; S.BHalo = BHalo;
    S.seg = new Float32Array(NB * MAXSEG * SEGF);
    S.mainCount = new Int32Array(NB); S.segCount = new Int32Array(NB);
    S.bStart = new Float32Array(NB).fill(-100);
    S.bOx = new Float32Array(NB); S.bOy = new Float32Array(NB); S.bOz = new Float32Array(NB);
    S.env = new Float32Array(NB);
    S.kick = -1;
    S.nextSlot = 0; S.clock = 0; S.lastStrike = -100;

    // Park the bolt particles so they don't streak in from the origin.
    for (let i = S.starEnd, j = S.starEnd * 3; i < n; i++, j += 3) {
      positions[j] = targets[j] = 0; positions[j + 1] = targets[j + 1] = 40; positions[j + 2] = targets[j + 2] = -60;
    }
    // Clouds start at their puffs.
    for (let i = 0, j = 0; i < S.cloudEnd; i++, j += 3) {
      const p = puff[i], R = PR[p];
      positions[j] = PX[p] + D[j] * R; positions[j + 1] = PY[p] + D[j + 1] * R * 0.8; positions[j + 2] = PZ[p] + D[j + 2] * R;
    }

    S.generate = (b: number, branchAmt: number) => {
      const seg = S.seg as Float32Array;
      const base = b * MAXSEG * SEGF;
      let k = 0;
      const push = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number) => {
        if (k >= MAXSEG) return;
        const o = base + k * SEGF;
        seg[o] = ax; seg[o + 1] = ay; seg[o + 2] = az; seg[o + 3] = bx; seg[o + 4] = by; seg[o + 5] = bz; seg[o + 6] = w;
        k++;
      };
      const sx = -34 + rnd() * 68, sy = 5 + rnd() * 4, sz = -14 + rnd() * 14;
      const ex = sx + (rnd() - 0.5) * 22, ey = -28;
      const steps = 44;
      const MPx = S.mpx || (S.mpx = new Float32Array(64));
      const MPy = S.mpy || (S.mpy = new Float32Array(64));
      const MPz = S.mpz || (S.mpz = new Float32Array(64));
      let x = sx, y = sy, z = sz;
      MPx[0] = x; MPy[0] = y; MPz[0] = z;
      for (let s = 1; s <= steps; s++) {
        const rem = steps - s + 1;
        const nx = x + (ex - x) / rem + (rnd() - 0.5) * 2.6;
        const ny = y + (ey - y) / rem * (0.6 + rnd() * 0.8);
        const nz = z + (rnd() - 0.5) * 1.6;
        push(x, y, z, nx, ny, nz, 1);
        x = nx; y = ny; z = nz;
        MPx[s] = x; MPy[s] = y; MPz[s] = z;
      }
      const mainCount = k;
      const nBranch = Math.round((2 + rnd() * 4) * branchAmt);
      for (let q = 0; q < nBranch; q++) {
        const si = 2 + Math.floor(rnd() * (steps * 0.65));
        let bx = MPx[si], by = MPy[si], bz = MPz[si];
        const dir = rnd() < 0.5 ? -1 : 1;
        const len = 7 + Math.floor(rnd() * 12);
        const w0 = 0.65 - q * 0.04;
        for (let s = 0; s < len; s++) {
          const nx = bx + dir * (0.6 + rnd() * 1.2) + (rnd() - 0.5) * 0.8;
          const ny = by - (0.4 + rnd() * 1.0);
          const nz = bz + (rnd() - 0.5) * 1.2;
          push(bx, by, bz, nx, ny, nz, w0 * (1 - s / len * 0.6));
          // occasional sub-branch
          if (s === 3 && rnd() < 0.5 * branchAmt) {
            let cx = nx, cy = ny, cz = nz;
            for (let c = 0; c < 5; c++) {
              const mx = cx - dir * (0.3 + rnd() * 0.9), my = cy - (0.4 + rnd() * 0.7), mz = cz + (rnd() - 0.5);
              push(cx, cy, cz, mx, my, mz, w0 * 0.55 * (1 - c / 5));
              cx = mx; cy = my; cz = mz;
            }
          }
          bx = nx; by = ny; bz = nz;
        }
      }
      S.mainCount[b] = mainCount;
      S.segCount[b] = k;
      S.bOx[b] = sx; S.bOy[b] = sy + 2; S.bOz[b] = sz;
      S.bStart[b] = S.clock;
    };

    ctx.setBackground(0.006, 0.009, 0.028);
  },

  update(ctx) {
    const { audio, macros, params, targets, positions, velocities, colors, sizes, alphas, count, helpers } = ctx;
    const S = ctx.state as any;
    const t = ctx.time;
    S.clock += ctx.dt;
    const clock = S.clock as number;

    const cloudEnd = S.cloudEnd as number, moonEnd = S.moonEnd as number, starEnd = S.starEnd as number;
    const PX = S.PX as Float32Array, PY = S.PY as Float32Array, PZ = S.PZ as Float32Array, PR = S.PR as Float32Array;
    const PL = S.PL as Uint8Array, PPh = S.PPh as Float32Array, PS = S.PS as Float32Array;
    const PMx = S.PMx as Float32Array, PMy = S.PMy as Float32Array, PMz = S.PMz as Float32Array;
    const puff = S.puff as Uint16Array, D = S.D as Float32Array;
    const inten = macros.intensity, chaos = macros.chaos, hue = macros.hue, spread = macros.hueSpread;

    // ---------- Lightning triggers ----------
    if (audio.beat && clock - S.lastStrike > 0.1 && Math.random() < params.strikes) {
      const branchAmt = params.branches * (0.7 + macros.impulse * 0.3);
      S.generate(S.nextSlot, branchAmt);
      S.kick = S.nextSlot;
      S.nextSlot = (S.nextSlot + 1) % NB;
      if (macros.impulse > 1.2 && Math.random() < 0.5) {
        S.generate(S.nextSlot, branchAmt * 0.7);
        S.nextSlot = (S.nextSlot + 1) % NB;
      }
      S.lastStrike = clock;
    } else {
      S.kick = -1;
    }
    const env = S.env as Float32Array;
    const bOx = S.bOx as Float32Array, bOy = S.bOy as Float32Array, bOz = S.bOz as Float32Array;
    let maxEnv = 0;
    const flick = 0.8 + 0.2 * Math.sin(clock * 90);
    for (let b = 0; b < NB; b++) {
      const a = clock - S.bStart[b];
      let e = 0;
      if (a >= 0 && a < LIFE) {
        e = Math.exp(-a * 7);
        if (a > 0.11) e += 0.85 * Math.exp(-(a - 0.11) * 9);
        if (a > 0.26) e += 0.5 * Math.exp(-(a - 0.26) * 12);
        e *= flick * (1 - a / LIFE);
      }
      env[b] = e;
      if (e > maxEnv) maxEnv = e;
    }
    const e0 = env[0], e1 = env[1], e2 = env[2];
    const ox0 = bOx[0], oy0 = bOy[0], oz0 = bOz[0];
    const ox1 = bOx[1], oy1 = bOy[1], oz1 = bOz[1];
    const ox2 = bOx[2], oy2 = bOy[2], oz2 = bOz[2];
    const flashK = params.flash;
    const kick = S.kick as number;
    const kx = kick >= 0 ? bOx[kick] : 0, ky = kick >= 0 ? bOy[kick] : 0, kz = kick >= 0 ? bOz[kick] : 0;
    const kickAmt = kick >= 0 ? 6 + macros.impulse * 6 : 0;

    // ---------- Puffs (cheap, per puff) ----------
    const W = 120;
    const wind = params.wind * 1.2;
    const swellAmt = params.swell * (audio.bass * inten * 0.45 + audio.rms * 0.12);
    const mX = S.moonX, mY = S.moonY, mZ = S.moonZ;
    for (let p = 0; p < NP; p++) {
      const sp = PL[p] === 0 ? 0.5 : PL[p] === 1 ? 0.8 : 1.15;
      PX[p] += ctx.sdt * wind * sp;
      if (PX[p] > 60) PX[p] -= W;
      PS[p] = 1 + swellAmt * (0.6 + 0.4 * Math.sin(PPh[p] + t * 0.7)) + Math.sin(t * 0.35 + PPh[p]) * 0.05;
      const dx = mX - PX[p], dy = mY - PY[p], dz = mZ - PZ[p];
      const il = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
      PMx[p] = dx * il; PMy[p] = dy * il; PMz[p] = dz * il;
    }

    // ---------- Clouds ----------
    const billow = params.billow * (0.22 + chaos * 0.25 + inten * 0.08);
    // Two base cloud colours (at lightness 0.5); each particle blends between them and is scaled by its light.
    const cA = S.cA as Float32Array, cB = S.cB as Float32Array, CR = S.CR as Float32Array, CZ = S.CZ as Float32Array;
    S.hsl(hue - spread * 0.12, 0.32, 0.5, cA);
    S.hsl(hue + spread * 0.12, 0.32, 0.5, cB);
    const aR = cA[0], aG = cA[1], aB = cA[2], dR = cB[0] - aR, dG = cB[1] - aG, dB = cB[2] - aB;
    const moonLight = params.moonGlow * (0.6 + audio.mid * 0.6);
    for (let i = 0, j = 0; i < cloudEnd; i++, j += 3) {
      const p = puff[i];
      const R = PR[p] * PS[p];
      const dx = D[j], dy = D[j + 1], dz = D[j + 2];
      let x = PX[p] + dx * R, y = PY[p] + dy * R * 0.8, z = PZ[p] + dz * R;
      const nz = helpers.noise3(x * 0.07 + t * 0.05, y * 0.09 - t * 0.04, z * 0.07 + PPh[p]);
      const bul = nz * billow * R;
      x += dx * bul; y += dy * bul * 0.8; z += dz * bul;
      // fade at the wrap edges
      const ex = x < 0 ? -x : x;
      const edge = ex > 46 ? Math.max(0, 1 - (ex - 46) / 12) : 1;
      targets[j] = x; targets[j + 1] = y; targets[j + 2] = z;

      // lighting: lit tops, moon rim, lightning
      const top = dy * 0.5 + 0.5;
      const md = dx * PMx[p] + dy * PMy[p] + dz * PMz[p];
      const rim = md > 0 ? md * md : 0;
      let ill = 0;
      if (e0 > 0.01) { const a = x - ox0, b = y - oy0, c = z - oz0; ill += e0 / (1 + (a * a + b * b * 1.6 + c * c) * 0.012); }
      if (e1 > 0.01) { const a = x - ox1, b = y - oy1, c = z - oz1; ill += e1 / (1 + (a * a + b * b * 1.6 + c * c) * 0.012); }
      if (e2 > 0.01) { const a = x - ox2, b = y - oy2, c = z - oz2; ill += e2 / (1 + (a * a + b * b * 1.6 + c * c) * 0.012); }
      ill *= flashK;
      if (ill > 1) ill = 1;

      if (kickAmt > 0) {
        const a = x - kx, b = y - ky, c = z - kz;
        const d2 = a * a + b * b + c * c;
        if (d2 < 200) {
          const f = kickAmt * (1 - d2 / 200) / (Math.sqrt(d2) + 0.5);
          velocities[j] += a * f; velocities[j + 1] += b * f; velocities[j + 2] += c * f;
        }
      }

      const nz01 = nz * 0.5 + 0.5;
      const l2 = (0.07 + top * 0.11 + rim * 0.16 * moonLight + nz01 * 0.05) * 2;
      const cr = CR[i], li = ill * 0.5;   // lightning adds a cool white
      colors[j] = (aR + dR * cr) * l2 + li * 0.82;
      colors[j + 1] = (aG + dG * cr) * l2 + li * 0.86;
      colors[j + 2] = (aB + dB * cr) * l2 + li;
      alphas[i] = (0.3 + top * 0.2 + rim * 0.15 + ill * 0.2) * edge;
      sizes[i] = CZ[i] + ill * 1.5;
    }

    ctx.integrate({ spring: 3, damping: 2.4, flow: chaos * 1.5, flowScale: 0.12, maxSpeed: 30 });

    // ---------- Moon (placed exactly) ----------
    const MA = S.MA as Float32Array, MB = S.MB as Float32Array, MS = S.MS as Float32Array, MH = S.MH as Uint8Array;
    const mR = S.moonR * (1 + audio.rms * 0.05 + audio.pulse * 0.02);
    const mGlow = params.moonGlow * (0.75 + audio.mid * 0.55 + audio.pulse * 0.1) + maxEnv * 0.25;
    // warm silver → cool scene hue with the highs (blended in RGB so it never passes through green)
    const hiShift = helpers.clamp(0.2 + audio.high * 0.9, 0, 1);
    S.hsl(0.11, 0.35, 0.5, cA);
    S.hsl(hue, 0.3 + audio.high * 0.25, 0.5, cB);
    const mr = cA[0] + (cB[0] - cA[0]) * hiShift, mg = cA[1] + (cB[1] - cA[1]) * hiShift, mb = cA[2] + (cB[2] - cA[2]) * hiShift;
    for (let i = cloudEnd, j = cloudEnd * 3; i < moonEnd; i++, j += 3) {
      const halo = MH[i] === 1;
      positions[j] = targets[j] = mX + MA[i] * mR;
      positions[j + 1] = targets[j + 1] = mY + MB[i] * mR;
      positions[j + 2] = targets[j + 2] = mZ - (halo ? 0.5 : 0);
      velocities[j] = velocities[j + 1] = velocities[j + 2] = 0;
      const s = MS[i];
      if (halo) {
        const l2 = 0.24 * mGlow * s * s;
        colors[j] = mr * l2; colors[j + 1] = mg * l2; colors[j + 2] = mb * l2;
        alphas[i] = 0.5 * s;
        sizes[i] = 7;
      } else {
        let l2 = 0.6 * mGlow * s;
        if (l2 > 1.5) l2 = 1.5;
        colors[j] = mr * l2; colors[j + 1] = mg * l2; colors[j + 2] = mb * l2;
        alphas[i] = 0.85;
        sizes[i] = 4;
      }
    }

    // ---------- Stars ----------
    const frame = ctx.frame;
    for (let i = moonEnd, j = moonEnd * 3; i < starEnd; i++, j += 3) {
      const tw = helpers.rand(i, (frame >> 2) & 31);
      const l = 0.12 + helpers.rand(i, 44) * 0.18 + tw * audio.high * 0.3;
      colors[j] = 0.8 * l; colors[j + 1] = 0.85 * l; colors[j + 2] = l;
      alphas[i] = 0.7;
      sizes[i] = 2 + helpers.rand(i, 45) * 1.5 + tw * audio.high * 2;
      positions[j] = targets[j]; positions[j + 1] = targets[j + 1]; positions[j + 2] = targets[j + 2];
      velocities[j] = velocities[j + 1] = velocities[j + 2] = 0;
    }

    // ---------- Bolts (placed exactly) ----------
    const seg = S.seg as Float32Array;
    const BU = S.BU as Float32Array, BV = S.BV as Float32Array, BJx = S.BJx as Float32Array, BJz = S.BJz as Float32Array;
    const BHalo = S.BHalo as Uint8Array;
    const per = S.boltPer as number;
    const bHue = hue + 0.08;
    for (let b = 0; b < NB; b++) {
      const e = env[b] * flashK;
      const start = starEnd + b * per, end = b === NB - 1 ? count : start + per;
      if (e < 0.01) {
        for (let i = start; i < end; i++) alphas[i] = 0;
        continue;
      }
      const mc = S.mainCount[b] as number, sc = S.segCount[b] as number, bc = sc - mc;
      const base = b * MAXSEG * SEGF;
      for (let i = start, j = start * 3; i < end; i++, j += 3) {
        const u = BU[i];
        let si: number;
        if (bc <= 0 || u < 0.6) si = Math.floor((bc <= 0 ? u : u / 0.6) * mc);
        else si = mc + Math.floor((u - 0.6) / 0.4 * bc);
        if (si >= sc) si = sc - 1;
        const o = base + si * SEGF;
        const v = BV[i];
        const w = seg[o + 6];
        const halo = BHalo[i] === 1;
        const jit = halo ? 0.55 : 0.07;
        positions[j] = targets[j] = seg[o] + (seg[o + 3] - seg[o]) * v + BJx[i] * jit;
        positions[j + 1] = targets[j + 1] = seg[o + 1] + (seg[o + 4] - seg[o + 1]) * v;
        positions[j + 2] = targets[j + 2] = seg[o + 2] + (seg[o + 5] - seg[o + 2]) * v + BJz[i] * jit;
        velocities[j] = velocities[j + 1] = velocities[j + 2] = 0;
        let l = (halo ? 0.16 : 0.62) * e * w;
        if (l > 0.85) l = 0.85;
        helpers.setColorHSL(i, bHue, halo ? 0.6 : 0.35, l);
        alphas[i] = Math.min(1, e * 1.5) * (halo ? 0.5 : 1);
        sizes[i] = halo ? 5 : 2 + w * 1.2;
      }
    }

    // ---------- Sky flash ----------
    const f = Math.min(1, maxEnv * flashK) * 0.03;
    ctx.setBackground(0.006 + f * 0.75, 0.009 + f * 0.8, 0.028 + f);
  },
};

export default scene;
