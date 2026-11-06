# Music Visualiser

A local, offline-first audio-reactive particle visualiser. It listens to a mic, line-in, or audio file and drives particle **scenes** (landscapes, objects, abstract forms) through swappable **logics** (audio → visual mappings). In **Online** mode you can ask Claude to write new scenes and logics. They are saved as plain files and keep working offline.

## Run

```bash
npm install
npm run dev        # http://127.0.0.1:5173
```

Pick an input: Microphone / line-in, Audio file, or **Demo beat** (a built-in synth loop, handy for testing). Keys: **H** hides the panel, **F** toggles fullscreen, **Space** pauses.

**Live demo:** https://music-visualiser-theta.vercel.app. The hosted version is a static build (`npm run build`) with the built-in scenes and logics bundled in. It is read-only: creating scenes, saving logics and Claude generation need the local server, so run it locally for those. Redeploy with `vercel deploy --prod --scope sergey-fadeevs-projects`.

### Online mode (optional)

```bash
cp .env.example .env   # then set ANTHROPIC_API_KEY=...
```

Restart `npm run dev`, then flip the **Online** switch. While Offline, the app makes no network requests. The API key stays on the local server and is never sent to the browser.

## How it's organised

```
scenes/*.ts        WHAT the particles form   (one file per scene, hot-reloaded)
logics/*.json      HOW the music drives it   (audio feature → macro/param mappings)
docs/SCENE_API.md  The authoring guide, also sent to Claude as its reference
docs/scene-template.ts  Starting point for "+ Blank scene"

src/audio/         Mic / file / demo input → features (bass, mid, high, flux, beat, pulse, bpm, spectrum…)
src/logic/         Evaluates a logic each frame → macros + scene params
src/engine/        Particle buffers, physics helpers, formations, renderer (Three.js + bloom)
src/ui/            Panel, controls (lil-gui), local API client
server/            Vite plugin: local API (library, save, Claude generation), hot-reload events
```

Each frame: `audio → features → logic → macros/params → scene.update(ctx) → GPU`.

- **Macros** (`intensity, chaos, speed, hue, hueSpread, brightness, size, morph, impulse`) are a shared vocabulary, so any logic works with any scene.
- Scenes run in a try/catch. If a scene (for example a freshly generated one) throws, the app shows the error, offers **Fix with Claude** when Online, and falls back to the last working scene.
- When Claude edits a scene or logic, the old version is saved to `scenes/.history/` or `logics/.history/` first.

## Making new stuff

- **In the app:** `+ Blank scene` creates `scenes/<name>.ts` from the template. `+ Mapping` and `Save logic as…` let you build logics by hand.
- **With Claude in the app (Online):** choose New scene, Change current scene, New logic, or Change current logic, then describe what you want. You can also send Claude a summary of what's playing.
- **With Claude Code / any editor:** edit files in `scenes/` or `logics/`. The running app hot-reloads them without restarting the audio.

## Next steps

- GPU compute (Three.js WebGPU/TSL) for 500k–1M+ particles
- An MCP server inside the app (live audio features, set params, screenshot) so Claude can tune scenes while watching them
- Mesh/image/text sampling for object formations (GLTF via `MeshSurfaceSampler`)
- Scene playlists and transitions driven by song sections
