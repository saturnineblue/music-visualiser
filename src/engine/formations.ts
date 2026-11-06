import type { FormationHelpers } from './types';

const TAU = Math.PI * 2;

function randSphereDir(): [number, number, number] {
  const u = Math.random() * 2 - 1;
  const th = Math.random() * TAU;
  const s = Math.sqrt(1 - u * u);
  return [s * Math.cos(th), u, s * Math.sin(th)];
}

export const formations: FormationHelpers = {
  sphere(out, count, radius, surface = false) {
    for (let i = 0; i < count; i++) {
      const [x, y, z] = randSphereDir();
      const r = surface ? radius : radius * Math.cbrt(Math.random());
      out[i * 3] = x * r; out[i * 3 + 1] = y * r; out[i * 3 + 2] = z * r;
    }
  },

  torus(out, count, R, r) {
    for (let i = 0; i < count; i++) {
      const u = Math.random() * TAU;
      const v = Math.random() * TAU;
      const rr = r * Math.sqrt(Math.random());
      out[i * 3] = (R + rr * Math.cos(v)) * Math.cos(u);
      out[i * 3 + 1] = rr * Math.sin(v);
      out[i * 3 + 2] = (R + rr * Math.cos(v)) * Math.sin(u);
    }
  },

  torusKnot(out, count, scale, p = 2, q = 3, tube = 0.25) {
    for (let i = 0; i < count; i++) {
      const t = (i / count) * TAU;
      const r = Math.cos(q * t) + 2;
      const cx = r * Math.cos(p * t), cy = Math.sin(q * t), cz = r * Math.sin(p * t);
      const [dx, dy, dz] = randSphereDir();
      const k = tube * Math.sqrt(Math.random());
      out[i * 3] = (cx + dx * k) * scale;
      out[i * 3 + 1] = (cy + dy * k) * scale;
      out[i * 3 + 2] = (cz + dz * k) * scale;
    }
  },

  cube(out, count, size, surface = false) {
    const h = size / 2;
    for (let i = 0; i < count; i++) {
      let x = (Math.random() * 2 - 1) * h, y = (Math.random() * 2 - 1) * h, z = (Math.random() * 2 - 1) * h;
      if (surface) {
        const face = Math.floor(Math.random() * 6);
        const s = face % 2 === 0 ? h : -h;
        if (face < 2) x = s; else if (face < 4) y = s; else z = s;
      }
      out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = z;
    }
  },

  grid(out, count, width, depth, heightFn) {
    const aspect = width / depth;
    const cols = Math.max(1, Math.round(Math.sqrt(count * aspect)));
    const rows = Math.max(1, Math.ceil(count / cols));
    for (let i = 0; i < count; i++) {
      const cx = i % cols, cz = Math.floor(i / cols);
      const x = (cx / (cols - 1 || 1) - 0.5) * width;
      const z = (cz / (rows - 1 || 1) - 0.5) * depth;
      out[i * 3] = x;
      out[i * 3 + 1] = heightFn ? heightFn(x, z) : 0;
      out[i * 3 + 2] = z;
    }
  },

  galaxy(out, count, radius, arms = 3, twist = 2.5) {
    for (let i = 0; i < count; i++) {
      const arm = i % arms;
      const d = Math.pow(Math.random(), 0.6);
      const ang = (arm / arms) * TAU + d * twist * Math.PI;
      const spread = (1 - d * 0.6) * 0.35 * radius;
      const r = d * radius;
      out[i * 3] = Math.cos(ang) * r + (Math.random() - 0.5) * spread * (1 - d);
      out[i * 3 + 1] = (Math.random() - 0.5) * spread * 0.4 * (1 - d);
      out[i * 3 + 2] = Math.sin(ang) * r + (Math.random() - 0.5) * spread * (1 - d);
    }
  },

  helix(out, count, radius, height, turns = 4, strands = 2) {
    for (let i = 0; i < count; i++) {
      const s = i % strands;
      const t = Math.random();
      const ang = t * turns * TAU + (s / strands) * TAU;
      const jitter = radius * 0.08;
      out[i * 3] = Math.cos(ang) * radius + (Math.random() - 0.5) * jitter;
      out[i * 3 + 1] = (t - 0.5) * height;
      out[i * 3 + 2] = Math.sin(ang) * radius + (Math.random() - 0.5) * jitter;
    }
  },

  lorenz(out, count, scale) {
    let x = 0.1, y = 0, z = 0;
    const dt = 0.005, sigma = 10, rho = 28, beta = 8 / 3;
    for (let i = 0; i < 1000; i++) { // settle onto the attractor
      const dx = sigma * (y - x), dy = x * (rho - z) - y, dz = x * y - beta * z;
      x += dx * dt; y += dy * dt; z += dz * dt;
    }
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < 3; k++) {
        const dx = sigma * (y - x), dy = x * (rho - z) - y, dz = x * y - beta * z;
        x += dx * dt; y += dy * dt; z += dz * dt;
      }
      out[i * 3] = x * scale * 0.05;
      out[i * 3 + 1] = (z - 25) * scale * 0.05;
      out[i * 3 + 2] = y * scale * 0.05;
    }
  },

  ring(out, count, radius, thickness = 0.1) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const r = radius + (Math.random() - 0.5) * thickness * radius;
      out[i * 3] = Math.cos(a) * r;
      out[i * 3 + 1] = (Math.random() - 0.5) * thickness * radius * 0.3;
      out[i * 3 + 2] = Math.sin(a) * r;
    }
  },

  model(out, count, model, scale = 15, offset = [0, 0, 0]) {
    const src = model.positions, m = model.count;
    for (let i = 0; i < count; i++) {
      const j = (count === m ? i : Math.floor((i * m) / count)) * 3;
      out[i * 3] = src[j] * scale + offset[0];
      out[i * 3 + 1] = src[j + 1] * scale + offset[1];
      out[i * 3 + 2] = src[j + 2] * scale + offset[2];
    }
  },
};
