# Music Visualiser

A local, offline-first audio-reactive particle visualiser. It listens to a mic, line-in, or audio file and drives particle **scenes** (landscapes, objects, abstract forms) through swappable **logics** (audio → visual mappings). In **Online** mode you can ask Claude to write new scenes and logics. They are saved as plain files and keep working offline.

## Run

```bash
npm install
npm run dev        # http://127.0.0.1:5173
```

Pick an input: Microphone / line-in, Audio file, or **Demo beat** (a built-in synth loop, handy for testing). Keys: **H** hides the panel, **F** toggles fullscreen, **Space** pauses.

For VJing with a projector, click **⧉ Open projector window** (Output section). It opens a second window with only the visuals: drag it to the projector and press **F** or double-click it for fullscreen, and keep the controls on your main screen. Keep the main window visible, since it drives both (browsers slow down hidden windows). In Chrome/Edge, if you allow window management, the window moves to the other screen by itself. Untick **Show preview here** to save GPU time.

**Scene sets** (Set section) are cue lists for a show. Add the current scene, logic and slider values with **+ Add current**, switch with a click, **1–9** or **Page Up / Page Down**, and **Save set…** to download one self-contained `.set.json`. It includes the scenes' code and models, so it also plays on the hosted site. **Open set…**, or drop the file on the window, to load one. Format and how to have Claude build a set: [docs/SETS.md](docs/SETS.md). Example: `sets/demo-night.set.json`.

**Live site (password-protected):** https://music-visualiser-theta.vercel.app. The hosted version is a static build (`npm run build`) with the built-in scenes and logics bundled in. It is read-only: creating scenes, saving logics and Claude generation need the local server, so run it locally for those. Redeploy with `vercel deploy --prod --scope sergey-fadeevs-projects`.

**Password:** the hosted site is private. [`middleware.ts`](middleware.ts) (Vercel Routing Middleware) shows a sign-in page and refuses every page, script and model until the right password is entered. A correct sign-in lasts 30 days on that browser; `/__logout` signs out. The password is the `SITE_PASSWORD` environment variable in Vercel. Set or change it with the command below (it asks for the value), then redeploy. Changing it signs everyone out. Without it the site stays locked rather than open. Local `npm run dev` isn't affected.

```bash
vercel env add SITE_PASSWORD production --sensitive --force --scope sergey-fadeevs-projects
```

### Online mode (optional)

```bash
cp .env.example .env   # then set ANTHROPIC_API_KEY=...
```

Restart `npm run dev`, then flip the **Online** switch. While Offline, the app makes no network requests. The API key stays on the local server and is never sent to the browser.

**New 3D object (Blender):** in the Ask Claude panel, describe an object ("a lighthouse on rocks with a lamp room…"). Claude models it in a headless Blender on your machine (no window opens), checks preview renders from two angles and fixes problems, then saves `models/<id>.glb` plus an editable `models/<id>.blend`, and writes a scene that animates its parts. It takes a few minutes and you can watch the progress and previews in the panel. Needs Blender installed (found automatically, or set `BLENDER_PATH` in `.env`). Claude's Blender code runs on your computer with your user's permissions, but without your environment variables or API key.

## How it's organised

```
scenes/*.ts        WHAT the particles form   (one file per scene, hot-reloaded)
logics/*.json      HOW the music drives it   (audio feature → macro/param mappings)
models/*.glb       3D objects scenes can turn into particles (named parts react separately)
docs/SCENE_API.md  The authoring guide, also sent to Claude as its reference
docs/scene-template.ts  Starting point for "+ Blank scene"

src/audio/         Mic / file / demo input → features (bass, mid, high, flux, beat, pulse, bpm, spectrum…)
src/logic/         Evaluates a logic each frame → macros + scene params
src/engine/        Particle buffers, physics helpers, formations, renderer (Three.js + bloom)
src/studio/        Scene Studio: scene format, the engine that plays it, and its panel
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
- **Scene Studio:** `✦ New in studio` (Scenes section) builds a scene without code. Add layers of shapes and 3D models side by side, let a layer morph between several forms, and set colours, lighting, the space colour, glow and camera. Map any frequency range or audio feature to any setting, spread the spectrum across a shape, and give each part of a model its own colour and reaction. It plays live while you edit. Saved scenes are ordinary `scenes/<id>.ts` files (on the hosted site they are kept in the browser) and reopen with `Edit in studio`. Details: `docs/STUDIO.md`.
- **3D objects:** drop a `.glb` onto the app (or export one from Blender into `models/`). Name the parts in Blender (`roof`, `windows`…) and scenes can animate each one separately. See *Dream House* and the Models section of `docs/SCENE_API.md`.
- **With Claude Code / any editor:** edit files in `scenes/` or `logics/`. The running app hot-reloads them without restarting the audio.

## Next steps

- GPU compute (Three.js WebGPU/TSL) for 500k–1M+ particles
- An MCP server inside the app (live audio features, set params, screenshot) so Claude can tune scenes while watching them
- Image/text sampling for formations, and point-cloud / Gaussian-splat `.ply` import
- Scene playlists and transitions driven by song sections
