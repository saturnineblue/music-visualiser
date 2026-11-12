# Scene Studio

The studio builds particle scenes without code. A studio scene is **data** (a "spec"): layers of shapes and 3D models, their colours, the lighting, the surrounding space, motion, and mappings from sound to settings. One shared engine (`src/studio/runtime.ts`) plays every spec.

## In the app

Open it with **✦ New in studio** in the Scenes section, or **Edit in studio** when the current scene was made there. The scene plays on the stage while you edit.

- **Scene**: name, notes, particle count.
The studio has three places:

- **The view** (the scene itself). On its left edge are the tool buttons: **Look** (or **N**) lets dragging turn the camera, **Move** (or **M**) lets dragging move objects instead, and **Record** records a loop. Click any object to open its settings in a pop-up next to it.
- **The object pop-up**: everything about one object. Its forms (a built-in shape or a 3D model, with size, position, rotation and colour), its parts, its share of the particles, its look and movement, and the spectrum spread. Drag the pop-up by its top edge; **Esc** or ✕ closes it.
- **The side panel**: only what concerns the whole scene. The list of objects (show or hide, reorder, add), the dramaturgy (loops, motion and morphing, sound mappings) and the look (space, camera, lighting). Audio input stays at the top: Mic, File, Demo and Stop, plus the seek bar for a file. The small screen button beside **Save scene** opens or closes the projector window, so the scene you are editing shows on the second screen live.

In detail:

- **Duplicate** (or **D**) appears among the tool buttons while an object is selected: it makes a copy with the same forms, look, spectrum and sound mappings, placed beside the original, and selects the copy.
- **Move**: click an object to select it (each has a handle with its name), drag to slide it across the view, hold **Shift** while dragging to push it away or pull it closer, and scroll to resize it.
- **Loops**: press **Record** in the view, then change things: sliders, colours, dragging objects, turning the camera, automatic morphing. Press it again and those changes replay as a loop. A scene can hold several loops; the **Loops** list in the panel picks the one that plays (or none), and renames or deletes them. Outside the studio, the scene's **Loop** slider (Controls → Scene params) picks the loop, so a set can hold one entry per loop of the same scene. A recording stops by itself after two minutes.
- **Space and camera**: space (background) colour and glow. Camera: distance, angle around the scene, angle up/down, field of view, and automatic rotation both around the scene and up and down. The view comes first: drag it to turn the camera, scroll to zoom, right-drag to slide, and the camera settings follow. Changing other settings never moves the camera.
- **Lighting**: a key light (colour, intensity, direction, height), ambient light, and a fill light from the opposite side. Particles are shaded by the direction of the surface they sit on.
- **Motion and morphing**: tightness, damping, turbulence, beat burst, overall brightness and colour shift. Morphing steps every few beats, every few seconds, or follows a slider that mappings can drive.
- **Objects** (called layers in the file format): each takes a share of the particles and shows one **form**: a built-in shape or a 3D model, with its own size, position, rotation and colour (one colour, a gradient, or the model's own colours). Several layers sit side by side.
  - A layer with **more than one form** morphs from one to the next.
  - **Parts** (models only): each named part can have its own colour and its own reaction (lift, push out, glow) to a sound source of its own.
  - **Spectrum across the shape**: lays a frequency range over the layer along an axis (or one band per part), so each region is pushed, glows, grows or is tinted by its own frequency.
- **Mappings**: a source (a frequency range in Hz, or a feature such as bass or beat pulse) drives any setting. The small meter beside each source shows its live level.
- **Adding models**: pick one from the library, drop a `.glb` on the window, or (local app, Online mode) describe an object for Claude to build in Blender.

**Save scene** writes `scenes/<id>.ts` locally. On the hosted site it saves to the site's storage (a private Vercel Blob store), so the scene is there on any device after signing in; dropped `.glb` models up to 4 MB are stored the same way. If the site has no storage connected, it saves in the browser instead; to move such a scene elsewhere, add it to a set and use **Save set…**. Logics and the macro sliders still apply on top of a studio scene: `intensity` scales reactions, `chaos` scales turbulence, `speed` scales time, `morph` adds to the morph position, `impulse` scales the beat burst, and `brightness` and `size` work as for any scene. `hue` and `hueSpread` are ignored, because a studio scene sets its own colours.

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
  camera: { position: [0, 8.16, 46.29], target: [0, 0, 0], autoRotate: 0.4, autoTilt: 0, fov: 60 },  // from the spec's camera angles
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
  "space": { "color": "#020308", "glow": 0.8, "particles": "auto" },   // particles: auto | glow | solid
  "camera": { "distance": 47, "azimuth": 0, "elevation": 10, "fov": 60,   // angles in degrees
              "autoRotate": 0.4, "autoTilt": 0, "target": [0, 0, 0] },
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
  ],
  "loops": [                      // recorded setting changes; one of them replays in a loop
    { "name": "Slide and circle", "duration": 8,
      "tracks": [
        { "path": "layer:house1.forms.0.position.0", "t": [0, 4, 8], "v": [8, -6, 8] },
        { "path": "camera.azimuth", "t": [0, 8], "v": [0, 360] }
      ] }
  ],
  "activeLoop": 0                 // index into "loops", or -1 for none
}
```

Notes:
- **Shapes**: `sphere`, `ball`, `cube`, `torus`, `knot`, `plane`, `galaxy`, `helix`, `lorenz`, `ring`. Every form is scaled so its largest half-extent equals `scale` (world units; the view is about ±30).
- **Colour** `mode`: `solid` (colour `a`), `gradient` (`a` → `b` along `axis`), `model` (the model's own colours; shapes fall back to `a`). **Axes**: `height`, `width`, `depth`, `radius`, `random`.
- **Sources**: `{ "kind": "feature", "name": … }` with a name from the logic sources (`rms`, `bass`, `lowMid`, `mid`, `high`, `centroid`, `flux`, `pulse`, `beat`, `constant`), or `{ "kind": "band", "lo": Hz, "hi": Hz }` (30 Hz to 16 kHz is analysed).
- **Spectrum** `axis`: `none`, one of the axes, or `part` (one band per part of the model).
- **Mapping targets**: `brightness`, `hueShift`, `morph.position`, `motion.turbulence`, `motion.spring`, `space.glow`, `light.intensity`, `light.ambient`, `light.azimuth`, `light.elevation`, and per layer `layer:<id>.scale`, `.lift`, `.spin`, `.size`, `.brightness`, `.explode`, `.spectrum.push`, `.spectrum.glow`. A mapping adds `curve(source) × amount` to its target, smoothed by `attack` and `release` (seconds).
- **Particles** (`space.particles`): `glow` adds each particle's light to the space behind it, so it needs a dark space colour and black shows nothing. `solid` draws opaque dots, so dark colours show on a light space; bloom is off in this mode. `auto` picks `solid` when the space colour is light.
- **Camera**: `azimuth` 0 looks from the front (+z), 90 from the right; `elevation` is degrees above the horizon. `autoTilt` swings the camera between ±60°. A spec with the older `height` field is converted.
- **Loop tracks**: `path` is a key of `liveValues(spec)`: any numeric, colour or on/off setting, written as its place in the spec with layers addressed by id (`space.glow`, `light.azimuth`, `layer:<id>.scale`, `layer:<id>.forms.0.color.a`, `mappings.0.amount`). `t` is seconds (ascending, within `duration`) and `v` the values: numbers are interpolated, colours and switches change at their time. The special path `@morph` records the automatic morph position. While a loop plays, it overwrites those settings every frame; when it stops or another takes over, they go back to what they were. A scene with loops gets a `loop` scene param (0 = none, 1 = the first loop…), which is what the engine reads: logics, the Controls panel and set entries can switch loops through it. A spec with the older single `loop` field is converted.
- Layer `id`s are letters and digits only, and unique within the spec.
- Missing fields get defaults and out-of-range values are clamped (`normalizeSpec`), so a short hand-written spec is fine.

## For Claude: making a studio scene on request

When a request fits the studio's building blocks (shapes and models composed, morphed, lit and mapped to sound), prefer a studio scene over hand-written scene code: the user can then keep adjusting it in the studio.

1. Write `scenes/<id>.ts` in the form above. The simplest way to get the wrapper exactly right is to copy an existing studio scene, or call `studioSceneSource(normalizeSpec(spec))` from `src/studio/spec.ts`.
2. List every model the spec uses in `models: [...]`, and make sure each exists in `models/`.
3. Check it in the running app (`npm run dev`, Demo audio): it appears in the scene list, plays without errors, and **Edit in studio** opens it.

Use hand-written scene code ([SCENE_API.md](SCENE_API.md)) when the idea needs behaviour the studio doesn't have, such as flocking, physics, or custom per-particle maths.
