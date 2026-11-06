import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ViteDevServer } from 'vite';
import { generate, type GenerateRequest } from './claude';

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
 *   POST /api/claude              → generate a scene/logic with Claude and save it
 *
 * Changes in scenes/ and logics/ are pushed to the browser as `vis:library` HMR events
 * (instead of a full page reload), so you can also edit scenes in any editor or with Claude Code.
 */

const ROOT = process.cwd();
const SCENES = path.join(ROOT, 'scenes');
const LOGICS = path.join(ROOT, 'logics');
const DOCS = path.join(ROOT, 'docs');

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
  return { scenes, logics };
}

export function visualiserApi(env: Record<string, string>): Plugin {
  const apiKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  const defaultModel = env.CLAUDE_MODEL || 'claude-opus-5-5';

  return {
    name: 'visualiser-api',
    configureServer(server: ViteDevServer) {
      server.watcher.add([SCENES, LOGICS]);
      // New / deleted library files (handleHotUpdate only sees changes).
      const onAddRemove = (file: string) => {
        if (file.includes(`${path.sep}.history${path.sep}`)) return;
        if (!file.startsWith(SCENES + path.sep) && !file.startsWith(LOGICS + path.sep)) return;
        const kind = file.startsWith(SCENES) ? 'scene' : 'logic';
        const id = path.basename(file).replace(/\.(ts|json)$/, '');
        server.ws.send({ type: 'custom', event: 'vis:library', data: { kind, id } });
      };
      server.watcher.on('add', onAddRemove);
      server.watcher.on('unlink', onAddRemove);

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const p = url.pathname;
        if (!p.startsWith('/api/')) return next();
        try {
          if (p === '/api/status' && req.method === 'GET') {
            return send(res, 200, { hasKey: !!apiKey, model: defaultModel });
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

          if (p === '/api/scenes/new' && req.method === 'POST') {
            const body = await readBody(req);
            const id = uniqueId(SCENES, safeId(body.name ?? 'my-scene'), '.ts');
            const tpl = fs.readFileSync(path.join(DOCS, 'scene-template.ts'), 'utf8')
              .replace(/__ID__/g, id)
              .replace(/__NAME__/g, String(body.name ?? id).replace(/['\\]/g, ''));
            fs.writeFileSync(path.join(SCENES, id + '.ts'), tpl);
            return send(res, 200, { id });
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
            const exampleScene = fs.readFileSync(path.join(SCENES, 'morphing-forms.ts'), 'utf8');
            const exampleLogic = fs.readFileSync(path.join(LOGICS, 'balanced.json'), 'utf8');

            const out = await generate(body, { apiKey, defaultModel, apiDoc, exampleScene, exampleLogic });

            if (out.kind === 'scene') {
              const editing = body.mode !== 'new-scene' && body.sceneId;
              const id = editing ? safeId(body.sceneId!) : uniqueId(SCENES, safeId(out.id), '.ts');
              if (editing) backup(SCENES, id + '.ts');
              // Make sure the file's id matches its filename.
              const code = out.code.replace(/(\bid\s*:\s*)(['"`])[^'"`]*\2/, `$1'${id}'`);
              fs.writeFileSync(path.join(SCENES, id + '.ts'), code);
              return send(res, 200, { kind: 'scene', id, name: out.name, summary: out.summary });
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

    // Library files: notify the app instead of reloading the page (keeps audio running).
    handleHotUpdate({ file, server }) {
      if (file.startsWith(SCENES + path.sep) || file.startsWith(LOGICS + path.sep)) {
        if (file.includes(`${path.sep}.history${path.sep}`)) return [];
        const kind = file.startsWith(SCENES) ? 'scene' : 'logic';
        const id = path.basename(file).replace(/\.(ts|json)$/, '');
        server.ws.send({ type: 'custom', event: 'vis:library', data: { kind, id } });
        return [];
      }
    },
  };
}
