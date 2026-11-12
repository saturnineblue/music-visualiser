# Scene Studio

The studio builds particle scenes without code. A studio scene is **data** (a "spec"): layers of shapes and 3D models, their colours, the lighting, the surrounding space, motion, and mappings from sound to settings. One shared engine (`src/studio/runtime.ts`) plays every spec.

## In the app

Open it with **✦ New in studio** in the Scenes section, or **Edit in studio** when the current scene was made there. The scene plays on the stage while you edit.

- **Scene**: name, notes, particle count.
- **Space and camera**: space (background) colour, glow, camera distance, height, field of view, auto-rotate.
- **Lighting**: a key light (colour, intensity, direction, height), ambient light, and a fill light from the opposite side. Particles are shaded by the direction of the surface they sit on.
- **Motion and morphing**: tightness, damping, turbulence, beat burst, overall brightness and colour shift. Morphing steps every few beats, every few seconds, or follows a slider that mappings can drive.
- **Layers**: each layer takes a share of the particles and shows one **form**: a built-in shape or a 3D model, with its own size, position, rotation and colour (one colour, a gradient, or the model's own colours). Several layers sit side by side.
  - A layer with **more than one form** morphs from one to the next.
  - **Parts** (models only): each named part can have its own colour and its own reaction (lift, push out, glow) to a sound source of its own.
  - **Spectrum across the shape**: lays a frequency range over the layer along an axis (or one band per part), so each region is pushed, glows, grows or is tinted by its own frequency.
- **Mappings**: a source (a frequency range in Hz, or a feature such as bass or beat pulse) drives any setting. The small meter beside each source shows its live level.
- **Adding models**: pick one from the library, drop a `.glb` on the window, or (local app, Online mode) describe an object for Claude to build in Blender.

**Save scene** writes `scenes/<id>.ts` locally. On the hosted site it saves in the browser instead; to move such a scene elsewhere, add it to a set and use **Save set…**. Logics and the macro sliders still apply on top of a studio scene: `intensity` scales reactions, `chaos` scales turbulence, `speed` scales time, `morph` adds to the morph position, `impulse` scales the beat burst, and `brightness` and `size` work as for any scene. `hue` and `hueSpread` are ignored, because a studio scene sets its own colours.

## File format

A saved studio scene is an ordinary scene file. It is plain JavaScript (so it needs no compiling in scene sets):

```js
// @ts-nocheck
const spec = { /* the StudioSpec, as JSON */ };

const scene = {
  id: "my-scene", name: "My Scene", description: "…", author: 'studio',
  particleCount: 60000,
  models: ["house"],            // every model the spec uses
  bloom: 0.8,
  camera: { position: [0, 8, 46], target: [0, 0, 0], autoRotate: 0.4, fov: 60 },
  studio: spec,                 // lets the studio reopen it
  setup(ctx) { ctx.helpers.studio.setup(ctx, spec); },
  update(ctx) { ctx.helpers.studio.update(ctx, spec); },
};

export default scene;
```

The spec (`StudioSpec` in [`src/studio/spec.ts`](../src/studio/spec.ts), which is the source of truth):

```jsonc
{
  "format": "music-visualiser-studio", "version": 1,
  "id": "my-scene", "name": "My Scene", "description": "",
  "particleCount": 60000,
  "space": { "color": "#020308", "glow": 0.8 },
  "camera": { "distance": 46, "height": 8, "fov": 60, "autoRotate": 0.4 },
  "light": { "enabled": true, "color": "#fff2dd", "intensity": 1, "azimuth": 35, "elevation": 40,
             "ambient": 0.45, "fill": "#3050ff", "fillIntensity": 0.25 },
  "motion": { "spring": 6, "damping": 3, "turbulence": 0.6, "burst": 2 },
  "morph": { "mode": "beats", "every": 16, "blend": 2.5, "position": 0 },  // mode: manual | time | beats
  "hueShift": 0, "brightness": 1,
  "layers": [
    {
      "id": "house1", "name": "House", "visible": true, "share": 60,
      "forms": [
        { "kind": "model", "model": "house", "shape": "sphere",
          "scale": 13, "position": [8, 0, 0], "rotation": [0, 20, 0],
          "color": { "mode": "model", "a": "#9fb4ff", "b": "#ff7ab8", "axis": "height" },
          "parts": {
            "roof": { "source": { "kind": "feature", "name": "bass" }, "lift": 5 },
            "windows": { "color": "#ffcc66", "source": { "kind": "band", "lo": 4000, "hi": 12000 }, "glow": 3 }
          } },
        { "kind": "shape", "shape": "galaxy", "model": "", "scale": 14, "position": [8, 0, 0], "rotation": [0, 0, 0],
          "color": { "mode": "gradient", "a": "#5b8cff", "b": "#ff6ad5", "axis": "radius" }, "parts": {} }
      ],
      "scale": 1, "lift": 0, "spin": 0, "size": 1, "brightness": 1, "explode": 0,
      "spectrum": { "axis": "height", "lo": 40, "hi": 8000, "push": 2, "glow": 1, "size": 0, "tint": "#ffffff", "tintAmount": 0 }
    }
  ],
  "mappings": [
    { "source": { "kind": "band", "lo": 60, "hi": 120 }, "target": "layer:house1.scale",
      "amount": 0.25, "curve": "square", "attack": 0, "release": 0.25, "enabled": true }
  ]
}
```

Notes:
- **Shapes**: `sphere`, `ball`, `cube`, `torus`, `knot`, `plane`, `galaxy`, `helix`, `lorenz`, `ring`. Every form is scaled so its largest half-extent equals `scale` (world units; the view is about ±30).
- **Colour** `mode`: `solid` (colour `a`), `gradient` (`a` → `b` along `axis`), `model` (the model's own colours; shapes fall back to `a`). **Axes**: `height`, `width`, `depth`, `radius`, `random`.
- **Sources**: `{ "kind": "feature", "name": … }` with a name from the logic sources (`rms`, `bass`, `lowMid`, `mid`, `high`, `centroid`, `flux`, `pulse`, `beat`, `constant`), or `{ "kind": "band", "lo": Hz, "hi": Hz }` (30 Hz to 16 kHz is analysed).
- **Spectrum** `axis`: `none`, one of the axes, or `part` (one band per part of the model).
- **Mapping targets**: `brightness`, `hueShift`, `morph.position`, `motion.turbulence`, `motion.spring`, `space.glow`, `light.intensity`, `light.ambient`, `light.azimuth`, `light.elevation`, and per layer `layer:<id>.scale`, `.lift`, `.spin`, `.size`, `.brightness`, `.explode`, `.spectrum.push`, `.spectrum.glow`. A mapping adds `curve(source) × amount` to its target, smoothed by `attack` and `release` (seconds).
- Layer `id`s are letters and digits only, and unique within the spec.
- Missing fields get defaults and out-of-range values are clamped (`normalizeSpec`), so a short hand-written spec is fine.

## For Claude: making a studio scene on request

When a request fits the studio's building blocks (shapes and models composed, morphed, lit and mapped to sound), prefer a studio scene over hand-written scene code: the user can then keep adjusting it in the studio.

1. Write `scenes/<id>.ts` in the form above. The simplest way to get the wrapper exactly right is to copy an existing studio scene, or call `studioSceneSource(normalizeSpec(spec))` from `src/studio/spec.ts`.
2. List every model the spec uses in `models: [...]`, and make sure each exists in `models/`.
3. Check it in the running app (`npm run dev`, Demo audio): it appears in the scene list, plays without errors, and **Edit in studio** opens it.

Use hand-written scene code ([SCENE_API.md](SCENE_API.md)) when the idea needs behaviour the studio doesn't have, such as flocking, physics, or custom per-particle maths.
