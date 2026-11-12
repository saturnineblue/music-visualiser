import * as THREE from 'three';
import { noise3, flow } from './noise';
import { formations } from './formations';
import { studioHelpers } from '../studio/runtime';
import type {
  AudioFeatures, CameraSpec, IntegrateOptions, Macros, SceneContext, SceneHelpers,
} from './types';

const vertexShader = /* glsl */ `
  attribute vec3 color;
  attribute float size;
  attribute float alpha;
  uniform float uSize;
  uniform float uPixelRatio;
  uniform float uSolid;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // Solid dots are drawn a little larger: their dark rim takes up part of each one.
    gl_PointSize = min(size * uSize * uPixelRatio * (48.0 / max(0.1, -mv.z)) * (1.0 + 0.35 * uSolid), 14.0 * uPixelRatio);
    vColor = color;
    vAlpha = alpha;
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uBrightness;
  uniform float uSolid;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    if (uSolid > 0.5) {
      // Solid dots: opaque discs that cover what is behind them (for light backgrounds and dark colours).
      if (d > 0.42 || vAlpha < 0.05) discard;
      // A dark rim around each dot, so it stands out even on a background of its own colour.
      float rim = smoothstep(0.24, 0.32, d);
      gl_FragColor = vec4(mix(vColor * uBrightness, vec3(0.012), rim), 1.0);
      return;
    }
    float a = smoothstep(0.5, 0.0, d);
    a *= a;
    gl_FragColor = vec4(vColor * uBrightness, a * vAlpha * 0.7);
  }
`;

export interface Hooks {
  setCamera(spec: CameraSpec): void;
  setBackground(r: number, g: number, b: number): void;
  setBloom(strength: number): void;
}

function hash(i: number, salt: number): number {
  let h = (i * 374761393 + salt * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/** Owns the particle buffers + GPU geometry, and builds the SceneContext passed to scenes. */
export class ParticleField {
  readonly count: number;
  readonly points: THREE.Points;
  readonly material: THREE.ShaderMaterial;
  readonly ctx: SceneContext;
  private geometry: THREE.BufferGeometry;
  private tmp = new Float32Array(3);

  constructor(count: number, audio: AudioFeatures, macros: Macros, params: Record<string, number>, hooks: Hooks) {
    this.count = count;
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    const targets = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3).fill(1);
    const sizes = new Float32Array(count).fill(1);
    const alphas = new Float32Array(count).fill(1);

    // Start as a loose cloud so the first formation "assembles".
    formations.sphere(positions, count, 30);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uSize: { value: 1 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
        uBrightness: { value: 1 },
        uSolid: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;

    const helpers: SceneHelpers = {
      noise3,
      flow,
      formations,
      studio: studioHelpers,
      setColorHSL: (i, h, s, l) => {
        h = h - Math.floor(h);
        let r: number, g: number, b: number;
        if (s === 0) { r = g = b = l; }
        else {
          const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
          const p = 2 * l - q;
          r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3);
        }
        colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b;
      },
      rand: (i, salt = 0) => hash(i, salt),
      lerp: (a, b, t) => a + (b - a) * t,
      clamp: (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v),
      smoothstep: (e0, e1, x) => {
        const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
        return t * t * (3 - 2 * t);
      },
    };

    const self = this;
    this.ctx = {
      count, positions, velocities, targets, colors, sizes, alphas,
      audio, macros, params,
      time: 0, dt: 0, sdt: 0, frame: 0,
      state: {},
      models: {},
      helpers,
      integrate(opts?: IntegrateOptions) { self.integrate(opts); },
      colorize(hueOffset, saturation = 0.75, lightness = 0.55) {
        const m = self.ctx.macros;
        for (let i = 0; i < count; i++) {
          const off = hueOffset ? hueOffset(i) : hash(i, 7) - 0.5;
          helpers.setColorHSL(i, m.hue + off * m.hueSpread, saturation, lightness);
        }
      },
      setCamera: (spec) => hooks.setCamera(spec),
      setBackground: (r, g, b) => hooks.setBackground(r, g, b),
      setBloom: (v) => hooks.setBloom(v),
      setParticleStyle: (style) => self.setStyle(style),
    };
  }

  /** Called by the engine each frame before scene.update. */
  tick(time: number, dt: number, sdt: number, frame: number) {
    const c = this.ctx as { time: number; dt: number; sdt: number; frame: number };
    c.time = time; c.dt = dt; c.sdt = sdt; c.frame = frame;
  }

  integrate(opts: IntegrateOptions = {}) {
    const { spring = 2, damping = 1.5, flow: flowAmt = 0, flowScale = 0.3, maxSpeed = 40 } = opts;
    const { positions: p, velocities: v, targets: t, count, sdt, time } = this.ctx;
    const dt = Math.min(sdt, 1 / 20);
    const damp = Math.exp(-damping * dt);
    const tmp = this.tmp;
    const max2 = maxSpeed * maxSpeed;
    for (let i = 0, j = 0; i < count; i++, j += 3) {
      let ax = (t[j] - p[j]) * spring;
      let ay = (t[j + 1] - p[j + 1]) * spring;
      let az = (t[j + 2] - p[j + 2]) * spring;
      if (flowAmt !== 0) {
        flow(tmp, p[j] * flowScale, p[j + 1] * flowScale, p[j + 2] * flowScale, time * 0.5);
        ax += tmp[0] * flowAmt; ay += tmp[1] * flowAmt; az += tmp[2] * flowAmt;
      }
      let vx = (v[j] + ax * dt) * damp;
      let vy = (v[j + 1] + ay * dt) * damp;
      let vz = (v[j + 2] + az * dt) * damp;
      const s2 = vx * vx + vy * vy + vz * vz;
      if (s2 > max2) {
        const k = maxSpeed / Math.sqrt(s2);
        vx *= k; vy *= k; vz *= k;
      }
      v[j] = vx; v[j + 1] = vy; v[j + 2] = vz;
      p[j] += vx * dt; p[j + 1] += vy * dt; p[j + 2] += vz * dt;
    }
  }

  /** Push CPU buffers to the GPU. */
  upload(sizeMul: number, brightness: number) {
    const g = this.geometry;
    (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.size as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.alpha as THREE.BufferAttribute).needsUpdate = true;
    this.material.uniforms.uSize.value = sizeMul;
    this.material.uniforms.uBrightness.value = brightness;
  }

  /**
   * glow: particles add light to what is behind them (the default; needs a dark background).
   * solid: opaque dots that hide what is behind them, so dark colours show on light backgrounds.
   */
  setStyle(style: 'glow' | 'solid') {
    const solid = style === 'solid', m = this.material;
    if ((m.uniforms.uSolid.value > 0.5) === solid) return;
    m.uniforms.uSolid.value = solid ? 1 : 0;
    m.blending = solid ? THREE.NormalBlending : THREE.AdditiveBlending;
    m.transparent = !solid;
    m.depthWrite = solid;
    m.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
