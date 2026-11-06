# Scene sets (`*.set.json`)

A **scene set** is an ordered list of looks ("entries") for a show. Each entry is a scene, a logic and the slider values to use. A set is saved as **one self-contained JSON file**: besides the entries, it carries the code of every scene it uses and every 3D model those scenes need. So it plays anywhere, including the hosted site, even if those scenes were never deployed there.

In the app (Set section of the panel):
- **+ Add current**: adds the current scene, logic (including live mapping tweaks) and slider values as an entry. **Update** overwrites the selected entry with the current look.
- Click an entry, press **1–9**, or **Page Up / Page Down** to switch. These keys also work in the projector window.
- **Save set…** downloads `<name>.set.json` with everything embedded. **Open set…** (or dropping the file on the window) loads one.
- Locally, **Install into library** copies the set's scenes, models and logics into `scenes/`, `models/` and `logics/`. If a file would change, it asks first, and the old file is kept in `.history/`.
- With **Add new scenes to the set** ticked (Ask Claude), every scene Claude generates is added as an entry.

## File format

```jsonc
{
  "format": "music-visualiser-set",   // required, exactly this
  "version": 1,
  "name": "Friday gig",
  "description": "optional",
  "entries": [
    {
      "label": "Intro – Storm",          // shown in the list
      "scene": "storm-moon",             // scene id: a key of "scenes" below, or a library scene
      "logic": { /* full logic, same shape as logics/<id>.json */ },  // or a logic id string, e.g. "storm"
      "macros": { "intensity": 0.6, "hue": 0.62 },  // optional base macro values; missing keys come from the logic's base
      "params": { "wind": 1.5 }                     // optional scene params; missing keys use the scene's defaults
    }
  ],
  "scenes": {
    "storm-moon": {
      "source": "import type { SceneDefinition } ...",  // the full scenes/<id>.ts file (TypeScript)
      "js": "const scene = { ... }; export default scene;"  // the same scene compiled to an ES module
    }
  },
  "models": {
    "lighthouse-island": "<base64 of models/lighthouse-island.glb>"
  }
}
```

Rules:
- `scenes` keys are scene ids. A scene's `source` follows [SCENE_API.md](SCENE_API.md) exactly: no runtime imports, `id` equal to the key, everything through `ctx`. The app runs `js` from a blob URL, so a scene can't rely on its file path or import anything.
- `js` is optional in hand-written sets. The local app compiles missing `js` when it opens the set, but the hosted site can't. Saving from the app, or running `npm run pack-set`, fills it in.
- `models` holds every model listed in the scenes' `models: [...]`, base64-encoded `.glb`. Bundled models are used instead of library models with the same id.
- An entry's `logic` may be a library logic id. Saved and packed sets inline it, so the set doesn't depend on the library.
- If a bundled scene has exactly the same source as the library's, the library version is used (so editing it hot-reloads). Otherwise the set's version runs, labelled "from set".
- Opening a set with scene code that isn't already in the library asks the user first, because that code runs in the page.

## For Claude: making a set on demand

When asked for a set ("make a 5-part set for a techno night: calm intro, build, two drops, outro"):

1. **Plan the entries.** Write down each one's label, mood and what in the music should drive it. Reuse library scenes and logics where they fit (`scenes/`, `logics/`). Create new ones only where nothing fits.
2. **Write each new scene** as `scenes/<id>.ts` following [SCENE_API.md](SCENE_API.md), and new logics as `logics/<id>.json`. Keep per-frame work to one or two passes over the particles. Run `npm run typecheck`. Then check every new scene in the running app (`npm run dev`, Demo audio): visible, reacting, no console errors.
3. **Write the set manifest** at `sets/<name>.set.json`. It needs only `format`, `version`, `name`, `description` and `entries`. Point `scene` and `logic` at the ids from step 2. Use `macros` and `params` to make entries that share a scene feel different, e.g. a calm and a heavy version.
4. **Pack it:** `npm run pack-set -- sets/<name>.set.json`. This embeds each scene's source and compiled JS, inlines the logics and adds the needed models, so the file is self-contained. It fails with a clear message if a scene or model is missing.
5. Tell the user the file path, and that they can open it with **Open set…** locally or on the hosted site.

To change one scene inside an existing set: edit `scenes/<id>.ts` (installing the set first if the scene only exists in the set), check it in the app, then pack again. Or open the set in the app and save it again: saving re-embeds the current library version of every scene.

[`sets/demo-night.set.json`](../sets/demo-night.set.json) is a packed example.
