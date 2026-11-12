import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { transformWithEsbuild, type Plugin, type ViteDevServer } from 'vite';
import { generate, type GenerateRequest } from './claude';
import { findBlender } from './blender';
import { generateObject } from './objectAgent';
import { normalizeSpec, studioSceneSource } from '../src/studio/spec';

/**
 * Local API, served by the Vite dev server (so there's a single `npm run dev` process):
 *
 *   GET  /api/status              → { hasKey, model }
 *   GET  /api/online-check        → { reachable }   (only called when the user switches Online)
 *   GET  /api/library             → { scenes, logics }
 *   GET  /api/scenes/:id/source   → raw TS source
 *   POST /api/scenes/new          → { id, name } copy the template into scenes/
 *   GET  /api/logics/:id          → logic JSON
 *   POST /api/logics              → save logic JSON
 *   POST /api/models?name=x.glb   → save an uploaded .glb into models/ (raw body)
 *   POST /api/studio              → save a Scene Studio spec as scenes/<id>.ts
 *   POST /api/claude              → generate a scene/logic with Claude and save it
 *   GET  /api/scenes/:id/compiled → the scene compiled to plain JS (for scene sets)
 *   POST /api/compile             → { source } → { js }  compile scene TS from a set file
 *   POST /api/sets/install        → write a set's bundled scenes/models/logics into the library
 *
 * Changes in scenes/ and logics/ are pushed to the browser as `vis:library` HMR events
 * (instead of a full page reload), so you can also edit scenes in any editor or with Claude Code.
 */

const ROOT = process.cwd();
const SCENES = path.join(ROOT, 'scenes');
const LOGICS = path.join(ROOT, 'logics');
const MODELS = path.join(ROOT, 'models');
const DOCS = path.join(ROOT, 'docs');
const MAX_MODEL_BYTES = 100 * 1024 * 1024;

const safeId = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled';

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.end(type === 'application/json' ? JSON.stringify(body) : String(body));
}

function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error(`File too large (max ${limit / 1024 / 1024} MB)`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Mesh-bearing node names in a .glb (its JSON chunk), i.e. the parts a scene can animate. */
function glbParts(file: string): string[] {
  try {
    const b = fs.readFileSync(file);
    if (b.toString('ascii', 0, 4) !== 'glTF') return [];
    const len = b.readUInt32LE(12);
    const j = JSON.parse(b.toString('utf8', 20, 20 + len));
    const names = (j.nodes ?? []).filter((n: { mesh?: number }) => n.mesh !== undefined)
      .map((n: { name?: string; mesh: number }) => (n.name || j.meshes?.[n.mesh]?.name || 'part')
        .replace(/\.\d{3}$/, '').replace(/_\d+$/, '').toLowerCase());
    return [...new Set<string>(names)];
  } catch {
    return [];
  }
}

/**
 * Scene TypeScript → a plain ES module the browser can import from a blob URL (scene sets).
 * Scenes have no runtime imports, so stripping types is all that's needed.
 */
export async function compileScene(source: string, id = 'scene'): Promise<string> {
  const out = await transformWithEsbuild(source, `${id}.ts`, { loader: 'ts', format: 'esm', target: 'es2022', sourcemap: false });
  return out.code;
}

function backup(dir: string, file: string) {
  const src = path.join(dir, file);
  if (!fs.existsSync(src)) return;
  const hist = path.join(dir, '.history');
  fs.mkdirSync(hist, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(src, path.join(hist, `${stamp}-${file}`));
}

function uniqueId(dir: string, id: string, ext: string) {
  let out = id, n = 2;
  while (fs.existsSync(path.join(dir, out + ext))) out = `${id}-${n++}`;
  return out;
}

function grab(src: string, key: string) {
  const m = src.match(new RegExp(`${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`));
  return m ? m[2] : undefined;
}

function library() {
  const scenes = fs.readdirSync(SCENES)
    .filter((f) => f.endsWith('.ts') && !f.startsWith('_'))
    .map((f) => {
      const src = fs.readFileSync(path.join(SCENES, f), 'utf8');
      const id = f.replace(/\.ts$/, '');
      return { id, name: grab(src, 'name') ?? id, description: grab(src, 'description') ?? '', author: grab(src, 'author') ?? '' };
    });
  const logics = fs.readdirSync(LOGICS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(LOGICS, f), 'utf8'));
        return { id: f.replace(/\.json$/, ''), name: j.name ?? f, description: j.description ?? '', author: j.author ?? '' };
      } catch {
        return { id: f.replace(/\.json$/, ''), name: f + ' (invalid JSON)', description: '', author: '' };
      }
    });
  const models = fs.existsSync(MODELS)
    ? fs.readdirSync(MODELS).filter((f) => f.endsWith('.glb'))
      .map((f) => ({ id: f.replace(/\.glb$/, ''), parts: glbParts(path.join(MODELS, f)) }))
    : [];
  return { scenes, logics, models };
}

/** Which library a changed file belongs to (history backups and other files: none). */
function libraryKind(file: string): 'scene' | 'logic' | 'model' | null {
  if (file.includes(`${path.sep}.history${path.sep}`)) return null;
  if (file.startsWith(SCENES + path.sep) && file.endsWith('.ts')) return 'scene';
  if (file.startsWith(LOGICS + path.sep) && file.endsWith('.json')) return 'logic';
  if (file.startsWith(MODELS + path.sep) && file.endsWith('.glb')) return 'model';
  return null;
}

export function visualiserApi(env: Record<string, string>): Plugin {
  const apiKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  const defaultModel = env.CLAUDE_MODEL || 'claude-opus-5-5';
  const blenderPath = () => findBlender(env.BLENDER_PATH);

  return {
    name: 'visualiser-api',
    configureServer(server: ViteDevServer) {
      fs.mkdirSync(MODELS, { recursive: true });
      server.watcher.add([SCENES, LOGICS, MODELS]);

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const p = url.pathname;
        if (!p.startsWith('/api/')) return next();
        try {
          if (p === '/api/status' && req.method === 'GET') {
            return send(res, 200, { hasKey: !!apiKey, model: defaultModel, blender: !!blenderPath() });
          }

          if (p === '/api/online-check') {
            try {
              const r = await fetch('https://api.anthropic.com/v1/models', { method: 'GET', signal: AbortSignal.timeout(4000) });
              return send(res, 200, { reachable: r.status > 0 });
            } catch {
              return send(res, 200, { reachable: false });
            }
          }

          if (p === '/api/library') return send(res, 200, library());

          let m = p.match(/^\/api\/scenes\/([a-z0-9-]+)\/source$/);
          if (m && req.method === 'GET') {
            const f = path.join(SCENES, m[1] + '.ts');
            if (!fs.existsSync(f)) return send(res, 404, { error: 'not found' });
            return send(res, 200, fs.readFileSync(f, 'utf8'), 'text/plain');
          }

          m = p.match(/^\/api\/scenes\/([a-z0-9-]+)\/compiled$/);
          if (m && req.method === 'GET') {
            const f = path.join(SCENES, m[1] + '.ts');
            if (!fs.existsSync(f)) return send(res, 404, { error: 'not found' });
            return send(res, 200, await compileScene(fs.readFileSync(f, 'utf8'), m[1]), 'text/javascript');
          }

          if (p === '/api/compile' && req.method === 'POST') {
            const body = await readBody(req);
            if (typeof body.source !== 'string') return send(res, 400, { error: 'source missing' });
            try {
              return send(res, 200, { js: await compileScene(body.source, safeId(body.id ?? 'scene')) });
            } catch (e) {
              return send(res, 400, { error: `Scene "${body.id}" does not compile: ${(e as Error).message}` });
            }
          }

          if (p === '/api/sets/install' && req.method === 'POST') {
            // { scenes: {id: source}, models: {id: base64}, logics: {id: LogicDefinition}, overwrite }
            const body = await readBody(req);
            const plan: { dir: string; file: string; data: Buffer; kind: string; id: string }[] = [];
            for (const [rawId, src] of Object.entries<string>(body.scenes ?? {})) {
              const id = safeId(rawId);
              const code = String(src).replace(/(\bid\s*:\s*)(['"`])[^'"`]*\2/, `$1'${id}'`);
              plan.push({ dir: SCENES, file: id + '.ts', data: Buffer.from(code, 'utf8'), kind: 'scene', id });
            }
            for (const [rawId, b64] of Object.entries<string>(body.models ?? {})) {
              const data = Buffer.from(String(b64), 'base64');
              if (data.toString('ascii', 0, 4) !== 'glTF') return send(res, 400, { error: `Model "${rawId}" in the set is not a valid .glb.` });
              const id = safeId(rawId);
              plan.push({ dir: MODELS, file: id + '.glb', data, kind: 'model', id });
            }
            for (const [rawId, logic] of Object.entries<Record<string, unknown>>(body.logics ?? {})) {
              const id = safeId(rawId);
              plan.push({ dir: LOGICS, file: id + '.json', data: Buffer.from(JSON.stringify({ ...logic, id }, null, 2)), kind: 'logic', id });
            }
            const changed = plan.filter((f) => {
              const full = path.join(f.dir, f.file);
              return !fs.existsSync(full) || !fs.readFileSync(full).equals(f.data);
            });
            const conflicts = changed.filter((f) => fs.existsSync(path.join(f.dir, f.file))).map((f) => `${f.kind} "${f.id}"`);
            if (conflicts.length && !body.overwrite) return send(res, 200, { installed: [], conflicts });
            for (const f of changed) {
              backup(f.dir, f.file);
              fs.writeFileSync(path.join(f.dir, f.file), f.data);
            }
            return send(res, 200, { installed: changed.map((f) => `${f.kind} "${f.id}"`), conflicts: [] });
          }

          if (p === '/api/scenes/new' && req.method === 'POST') {
            const body = await readBody(req);
            const id = uniqueId(SCENES, safeId(body.name ?? 'my-scene'), '.ts');
            const tpl = fs.readFileSync(path.join(DOCS, 'scene-template.ts'), 'utf8')
              .replace(/__ID__/g, id)
              .replace(/__NAME__/g, String(body.name ?? id).replace(/['\\]/g, ''));
            fs.writeFileSync(path.join(SCENES, id + '.ts'), tpl);
            return send(res, 200, { id });
          }

          if (p === '/api/studio' && req.method === 'POST') {
            const body = await readBody(req);
            const spec = normalizeSpec(body.spec);
            spec.id = safeId(spec.id);
            const file = path.join(SCENES, spec.id + '.ts');
            if (fs.existsSync(file)) {
              // Never silently replace a scene, least of all a hand-written one.
              if (!body.overwrite) return send(res, 409, { error: `A scene with the id "${spec.id}" already exists.` });
              backup(SCENES, spec.id + '.ts');
            }
            fs.writeFileSync(file, studioSceneSource(spec));
            return send(res, 200, { id: spec.id });
          }

          if (p === '/api/models' && req.method === 'POST') {
            const name = url.searchParams.get('name') ?? 'model.glb';
            if (!/\.glb$/i.test(name)) return send(res, 400, { error: 'Only .glb files are supported (in Blender: File → Export → glTF 2.0, format "glTF Binary").' });
            const data = await readRaw(req, MAX_MODEL_BYTES);
            if (data.toString('ascii', 0, 4) !== 'glTF') return send(res, 400, { error: 'Not a valid .glb file.' });
            const id = safeId(name.replace(/\.glb$/i, ''));
            const file = path.join(MODELS, id + '.glb');
            const replaced = fs.existsSync(file);
            if (replaced) backup(MODELS, id + '.glb');
            fs.writeFileSync(file, data);
            return send(res, 200, { id, replaced });
          }

          m = p.match(/^\/api\/logics\/([a-z0-9-]+)$/);
          if (m && req.method === 'GET') {
            const f = path.join(LOGICS, m[1] + '.json');
            if (!fs.existsSync(f)) return send(res, 404, { error: 'not found' });
            return send(res, 200, JSON.parse(fs.readFileSync(f, 'utf8')));
          }

          if (p === '/api/logics' && req.method === 'POST') {
            const body = await readBody(req);
            const id = safeId(body.id ?? body.name ?? 'logic');
            backup(LOGICS, id + '.json');
            fs.writeFileSync(path.join(LOGICS, id + '.json'), JSON.stringify({ ...body, id }, null, 2));
            return send(res, 200, { id });
          }

          if (p === '/api/claude' && req.method === 'POST') {
            if (!apiKey) return send(res, 400, { error: 'No ANTHROPIC_API_KEY in .env — add one and restart `npm run dev`.' });
            const body = (await readBody(req)) as GenerateRequest;
            if (body.sceneId) {
              const f = path.join(SCENES, safeId(body.sceneId) + '.ts');
              if (fs.existsSync(f)) body.sceneSource = fs.readFileSync(f, 'utf8');
            }
            const apiDoc = fs.readFileSync(path.join(DOCS, 'SCENE_API.md'), 'utf8');
            const exampleFile = (name: string) => {
              const f = path.join(SCENES, name);
              return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
            };
            let exampleScene = exampleFile('morphing-forms.ts');
            const exampleLogic = fs.readFileSync(path.join(LOGICS, 'balanced.json'), 'utf8');

            const progress = (p: { text: string; image?: string }) =>
              server.ws.send({ type: 'custom', event: 'vis:claude-progress', data: p });

            let modelNote = '';
            if (body.mode === 'new-object') {
              const bin = blenderPath();
              if (!bin) return send(res, 400, { error: 'Blender not found. Install it, or set BLENDER_PATH in .env to the Blender executable, then restart `npm run dev`.' });
              const obj = await generateObject({
                prompt: body.prompt, apiKey, model: body.model || defaultModel,
                blenderPath: bin, modelsDir: MODELS, onProgress: progress,
              });
              // The Scene Studio only wants the model: it becomes a layer there.
              if ((body as { objectOnly?: boolean }).objectOnly) {
                return send(res, 200, { kind: 'model', id: obj.id, name: obj.name, summary: obj.summary, parts: obj.parts });
              }
              progress({ text: `Writing a scene for "${obj.name}"…` });
              modelNote = `Model: ${obj.summary}`;
              exampleScene = exampleFile('dream-house.ts') || exampleScene; // shows how to animate model parts
              body.mode = 'new-scene';
              body.prompt =
                `A scene built around the 3D model "${obj.id}" (${obj.name}; parts: ${obj.parts.join(', ')}), ` +
                `which was just made for this request: "${body.prompt}". Declare models: ['${obj.id}'] and make the music ` +
                `animate the parts separately in ways that suit each part, as the example scene does with its house.`;
            }

            const out = await generate(body, { apiKey, defaultModel, apiDoc, exampleScene, exampleLogic, models: library().models });

            if (out.kind === 'scene') {
              const editing = body.mode !== 'new-scene' && body.sceneId;
              const id = editing ? safeId(body.sceneId!) : uniqueId(SCENES, safeId(out.id), '.ts');
              if (editing) backup(SCENES, id + '.ts');
              // Make sure the file's id matches its filename.
              const code = out.code.replace(/(\bid\s*:\s*)(['"`])[^'"`]*\2/, `$1'${id}'`);
              fs.writeFileSync(path.join(SCENES, id + '.ts'), code);
              return send(res, 200, { kind: 'scene', id, name: out.name, summary: [modelNote, out.summary].filter(Boolean).join('\n') });
            } else {
              const editing = body.mode === 'edit-logic';
              const id = editing ? safeId(out.logic.id) : uniqueId(LOGICS, safeId(out.logic.id), '.json');
              if (editing) backup(LOGICS, id + '.json');
              const logic = { ...out.logic, id, author: 'claude' };
              fs.writeFileSync(path.join(LOGICS, id + '.json'), JSON.stringify(logic, null, 2));
              return send(res, 200, { kind: 'logic', id, name: logic.name, summary: out.summary });
            }
          }

          return send(res, 404, { error: 'unknown endpoint' });
        } catch (e) {
          const err = e as Error;
          console.error('[visualiser-api]', err);
          return send(res, 500, { error: err.message });
        }
      });
    },

    // Production build: `/scenes/<id>.ts?scenejs` is the scene compiled to JS, as a string
    // (hostedLibrary.ts uses it so the hosted site can save self-contained scene sets).
    async load(id) {
      if (!id.endsWith('.ts?scenejs')) return null;
      const file = id.slice(0, -'?scenejs'.length);
      const js = await compileScene(fs.readFileSync(file, 'utf8'), path.basename(file, '.ts'));
      return `export default ${JSON.stringify(js)};`;
    },

    // Library files (created, changed or deleted): notify the app instead of letting Vite reload
    // the page, so audio keeps running and long Claude generations aren't interrupted.
    // (The older handleHotUpdate hook only sees changes, not new or deleted files.)
    hotUpdate({ file }) {
      const kind = libraryKind(file);
      const inLibrary = [SCENES, LOGICS, MODELS].some((d) => file.startsWith(d + path.sep));
      if (!kind && !inLibrary) return;
      if (kind && this.environment.name === 'client') {
        const id = path.basename(file).replace(/\.(ts|json|glb)$/, '');
        this.environment.hot.send({ type: 'custom', event: 'vis:library', data: { kind, id } });
      }
      return [];
    },
  };
}
