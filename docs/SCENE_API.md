# Scene & Logic API

This file is the authoring guide for humans **and** the reference sent to Claude when generating scenes/logics in Online mode. Keep it accurate.

## Concepts

- **Scene** (`scenes/<id>.ts`): decides *what* the particles form and how they move. Examples: a landscape, an object, an abstract structure.
- **Model** (`models/<id>.glb`): a 3D object (e.g. a house from Blender) that scenes can turn into particles. See [Models](#models).
- **Logic** (`logics/<id>.json`): decides *how the music drives* the scene. It maps audio features to **macros** (shared by all scenes) and **params** (specific to one scene).
- Any logic can be combined with any scene. Scenes should therefore read `ctx.macros` for their main behaviour, and expose extra knobs as `params`.

Data flow, every frame: `audio → features → logic → macros/params → scene.update(ctx) → particles → GPU`.

## Scene file format

A scene file has **no runtime imports** (only `import type`), and default-exports a plain object:

```ts
import type { SceneDefinition } from '../src/engine/types';

const scene: SceneDefinition = {
  id: 'my-scene',              // must equal the file name
  name: 'My Scene',
  description: 'What it looks like and how it reacts.',
  author: 'you',
  particleCount: 60000,        // 100..300000, default 60000. CPU-simulated: keep ≤ 120000 for complex update loops
  camera: { position: [0, 8, 50], target: [0, 0, 0], autoRotate: 0.4, fov: 60 },
  bloom: 0.9,                  // glow strength 0..3
  defaultLogic: 'balanced',    // optional
  models: ['house'],           // optional: models/<id>.glb to load before setup → ctx.models.house
  params: {
    radius: { value: 12, min: 2, max: 30, label: 'Radius' },
  },
  setup(ctx) {
    // build initial targets, colours, state
  },
  update(ctx) {
    // called every frame: move particles (usually set targets then ctx.integrate())
  },
  dispose(ctx) {},             // optional
};

export default scene;
```

Rules:
- Default export must be the scene object. `update` is required.
- Avoid allocating in `update` (no `new Array`, closures or object literals inside the per-particle loop). Pre-allocate in `setup` and keep it in `ctx.state`.
- One or two passes over all particles per frame is fine; nested loops over particles are not.
- Units: the world is roughly −30..30. Default camera sits at z=50 looking at the origin.
- If the scene throws, the app shows the error and falls back to the previous scene.

## SceneContext (`ctx`)

Flat typed arrays; particle `i` uses `[i*3, i*3+1, i*3+2]` in xyz/rgb arrays and `[i]` in scalar arrays.

| Field | Type | Meaning |
|---|---|---|
| `count` | number | particle count |
| `positions` | Float32Array (count×3) | current positions — drawn each frame |
| `velocities` | Float32Array (count×3) | used by `integrate()` |
| `targets` | Float32Array (count×3) | where `integrate()` pulls particles to |
| `colors` | Float32Array (count×3) | rgb 0..1 (additive blending: keep lightness ~0.4–0.6) |
| `sizes` | Float32Array (count) | per-particle size multiplier (1 = default) |
| `alphas` | Float32Array (count) | per-particle opacity 0..1 |
| `audio` | AudioFeatures | see below |
| `macros` | Macros | see below |
| `params` | Record<string, number> | current (logic-modulated) values of this scene's params |
| `time` | number | seconds since scene start, already scaled by `macros.speed` |
| `dt` | number | real seconds since last frame |
| `sdt` | number | `dt * macros.speed` |
| `frame` | number | frames since scene start |
| `state` | object | free storage for the scene |
| `models` | Record<string, PointModel> | the models listed in the scene's `models`, by id (see [Models](#models)) |
| `helpers` | SceneHelpers | see below |
| `integrate(opts?)` | fn | spring-to-target + flow field + damping, then moves positions |
| `colorize(hueOffset?, s?, l?)` | fn | colours all particles from `macros.hue`/`hueSpread`; `hueOffset(i)` returns −0.5..0.5 (default random per particle) |
| `setCamera(spec)` | fn | `{ position, target, autoRotate, fov }` |
| `setBackground(r,g,b)` | fn | 0..1 |

`integrate(opts)` options: `spring` (default 2; 0 = free flight), `damping` (default 1.5, per second), `flow` (default 0; strength of the swirling flow field, try 1–6), `flowScale` (default 0.3; spatial frequency), `maxSpeed` (default 40).

You may also skip `integrate()` and write `positions` directly (e.g. for rigid, exactly-placed formations).

### AudioFeatures (`ctx.audio`), all ~0..1, auto-normalised

`rms` (loudness), `bass` (20–150 Hz), `lowMid` (150–600 Hz), `mid` (600–2.5k), `high` (2.5k–16k), `centroid` (brightness), `flux` (spectral change / onsets), `beat` (boolean, true on the onset frame), `pulse` (1 on a beat, decays to 0 — use this for smooth beat reactions), `bpm` (0 if unknown), `spectrum` (Float32Array(64), log-spaced low→high), `waveform` (Float32Array(512), −1..1).

### Macros (`ctx.macros`)

| Macro | Range | Scenes should use it for |
|---|---|---|
| `intensity` | 0..2 | amplitude of motion / displacement |
| `chaos` | 0..2 | turbulence, noise, disorder |
| `speed` | 0..3 | already applied to `time`/`sdt` |
| `hue` | 0..1 | base colour |
| `hueSpread` | 0..1 | colour variation |
| `brightness` | 0..3 | applied automatically on GPU |
| `size` | 0..3 | applied automatically on GPU |
| `morph` | 0..1 | blend between formations / states |
| `impulse` | 0..2 | bursts, explosions, shockwaves |

### Helpers (`ctx.helpers`)

- `noise3(x, y, z)` → −1..1 simplex noise (≈ 1µs per call: fine for one call per particle per frame at 60k particles, avoid more).
- `flow(out, x, y, z, t)` → writes a swirling vector into `out[0..2]` (cheap).
- `setColorHSL(i, h, s, l)`, `rand(i, salt?)` (stable random 0..1 per particle), `lerp`, `clamp`, `smoothstep`.
- `formations.*(out, count, ...)` fill a `Float32Array(count*3)` (usually `ctx.targets`, or your own arrays created in `setup` for morphing):
  - `sphere(out, n, radius, surface?)`, `cube(out, n, size, surface?)`, `torus(out, n, R, r)`, `torusKnot(out, n, scale, p?, q?, tube?)`
  - `grid(out, n, width, depth, heightFn?)` — XZ grid, row-major; `heightFn(x, z)` → y. Great for landscapes.
  - `galaxy(out, n, radius, arms?, twist?)`, `helix(out, n, radius, height, turns?, strands?)`, `lorenz(out, n, scale)`, `ring(out, n, radius, thickness?)`
  - `model(out, n, model, scale = 15, offset = [0, 0, 0])` — the points of a loaded model (see below).

## Models

3D objects (houses, trees, people, scanned objects…) live in `models/<id>.glb` (glTF binary). Add one by dropping a `.glb` onto the app window, copying it into `models/`, or exporting from Blender (File → Export → glTF 2.0, format "glTF Binary"). Phone scans (Polycam, Scaniverse) and libraries like Poly Haven export `.glb` too.

A scene lists the models it needs; they're loaded and sampled before `setup`:

```ts
models: ['house'],
setup(ctx) {
  ctx.helpers.formations.model(ctx.targets, ctx.count, ctx.models.house, 13);
},
```

`ctx.models[id]` is a **PointModel**: the model's surface sampled into exactly `ctx.count` points, so point `i` of the model can drive particle `i`.

| Field | Type | Meaning |
|---|---|---|
| `count` | number | number of points (= `ctx.count`) |
| `positions` | Float32Array (count×3) | surface points, centred on the origin, largest half-extent = 1 (multiply by ~10–18) |
| `normals` | Float32Array (count×3) | unit surface normal per point (push particles outward, e.g. on beats) |
| `colors` | Float32Array (count×3) | rgb 0..1 from the model's materials/textures (scale by ~0.5 for additive blending) |
| `parts` | Uint8Array (count) | part index per point, into `partNames` |
| `partNames` | string[] | lower-case object names from the file, e.g. `["walls", "roof", "windows", "door"]` |
| `size` | [x, y, z] | normalised bounding-box size (largest = 2) |

Parts are what make objects musical: animate each one differently (`if (m.parts[i] === roofIndex) …`). Get an index with `m.partNames.indexOf('roof')` in `setup` (−1 if the model has no such part) and keep it in `ctx.state`. Points are shuffled, so any subset is spread evenly over the surface. The same points come back every load, so effects stay stable.

## Logic file format (`logics/<id>.json`)

```json
{
  "id": "balanced",
  "name": "Balanced",
  "description": "What musical aspects drive what.",
  "base": { "intensity": 0.5, "chaos": 0.2, "speed": 1, "hue": 0.6, "hueSpread": 0.15, "brightness": 1, "size": 1, "morph": 0, "impulse": 0 },
  "mappings": [
    { "source": "bass", "target": "macro.intensity", "amount": 0.8, "curve": "square", "attack": 0, "release": 0.2, "mode": "add" },
    { "source": "pulse", "target": "macro.impulse", "amount": 1.0, "curve": "linear", "attack": 0, "release": 0.1, "mode": "add" }
  ]
}
```

Each mapping: `value = curve(audio[source]) * amount`, smoothed by `attack`/`release` (seconds), then combined into the target:
`add` → base + value, `multiply` → base × (1 + value), `set` → value. Results are clamped to the macro/param range.

- `source`: `rms | bass | lowMid | mid | high | centroid | flux | pulse | beat | constant`
- `target`: `macro.<name>` or `param.<name>` (params of the current scene; ignored if the scene doesn't have it)
- `curve`: `linear | sqrt | square | exp | smooth | threshold`
- Prefer macro targets so the logic works on every scene.
