# Music Visualiser: notes for Claude

- Run: `npm run dev` (Vite + local API plugin at http://127.0.0.1:5173). Type-check: `npm run typecheck`.
- Scenes are `scenes/<id>.ts` and logics are `logics/<id>.json`. Follow `docs/SCENE_API.md` exactly. It is also the system reference for in-app generation, so update it whenever the scene/logic contract in `src/engine/types.ts` changes.
- Scene files must not have runtime imports (only `import type`). Everything comes through `ctx`. The `id` must match the file name.
- Keep per-frame scene work to one or two passes over the particles. Simulation runs on the CPU (about 50–80k particles at 60 fps).
- Saving a scene or logic file hot-reloads it in the running app (custom `vis:library` HMR event), and the audio keeps running.
- The browser exposes `window.vis = { engine, audio, api }` for debugging, e.g. `vis.engine.field.ctx`, `vis.engine.logic.macros`.
- Offline-first: nothing in `src/` may call external hosts. Only `server/claude.ts` and `server/objectAgent.ts` (Online mode) and `/api/online-check` touch the network.
- "New 3D object" runs Claude's Python in headless Blender: `server/blender.ts` spawns Blender with `server/blender_worker.py` (JSON lines over stdin/stdout, minimal env so no secrets reach Blender). `server/objectAgent.ts` runs the tool loop, then the normal scene generation runs for the new model.
- The Scene Studio (`src/studio/`) builds scenes as data: `spec.ts` is the format (no DOM imports: the server uses it too), `runtime.ts` plays a spec (`ctx.helpers.studio`), `ui.ts` is the panel, `store.ts` keeps hosted-site scenes in localStorage. A saved studio scene is a generated `scenes/<id>.ts` (plain JS with `// @ts-nocheck`) embedding its spec. Format and how to write one by hand: `docs/STUDIO.md`. Update that doc when `StudioSpec` changes.
- Scene sets are self-contained `*.set.json` files: entries (scene + logic + slider values) plus the scenes' code and their models. The format and how to make one on request are in `docs/SETS.md`. Pack a manifest with `npm run pack-set -- sets/<name>.set.json`.
- The hosted site is password-protected by `middleware.ts` (Vercel Routing Middleware, Node runtime), using the `SITE_PASSWORD` env var in Vercel. It fails closed if the var is unset. It must not affect `npm run dev`, and it must keep covering every path (assets and models too).
