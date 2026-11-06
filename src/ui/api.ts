import type { LogicDefinition, SceneDefinition } from '../engine/types';

/**
 * Talks to the local server (server/plugin.ts). Everything here is localhost-only.
 *
 * In a production build (`npm run build`, e.g. the Vercel deploy) there is no server: scenes and
 * logics are bundled at build time and the library is read-only. Claude generation, new scenes and
 * saving logics only work when running locally with `npm run dev`.
 */
export const HOSTED = !import.meta.env.DEV;

// Lazy globs: nothing is imported until the hosted build asks for it (dev mode uses the server).
const sceneModules = import.meta.glob<{ default: SceneDefinition }>('/scenes/*.ts');
const sceneSources = import.meta.glob<string>('/scenes/*.ts', { query: '?raw', import: 'default' });
const logicModules = import.meta.glob<LogicDefinition>('/logics/*.json', { import: 'default' });
const modelUrls = import.meta.glob<string>('/models/*.glb', { eager: true, query: '?url', import: 'default' });
const fileId = (path: string) => path.replace(/^.*\/|\.(ts|json|glb)$/g, '');

function grab(src: string, key: string) {
  const m = src.match(new RegExp(`${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`));
  return m ? m[2] : undefined;
}

async function staticLibrary(): Promise<Library> {
  const scenes = await Promise.all(
    Object.entries(sceneSources)
      .filter(([p]) => !fileId(p).startsWith('_') && fileId(p) !== 'my-scene')
      .map(async ([p, load]) => {
        const src = await load();
        const id = fileId(p);
        return { id, name: grab(src, 'name') ?? id, description: grab(src, 'description') ?? '', author: grab(src, 'author') ?? '' };
      }),
  );
  const logics = await Promise.all(
    Object.entries(logicModules).map(async ([p, load]) => {
      const j = await load();
      return { id: fileId(p), name: j.name ?? fileId(p), description: j.description ?? '', author: j.author ?? '' };
    }),
  );
  const models = Object.keys(modelUrls).map((p) => ({ id: fileId(p), parts: [] }));
  return { scenes, logics, models };
}

const notHosted = () => Promise.reject(new Error('Not available in the hosted version. Run the app locally (npm run dev) for this.'));

export interface LibraryItem { id: string; name: string; description: string; author: string }
export interface ModelItem { id: string; parts: string[] }
export interface Library { scenes: LibraryItem[]; logics: LibraryItem[]; models: ModelItem[] }

async function json<T>(r: Response): Promise<T> {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
  return body as T;
}

export const api = {
  library: () => (HOSTED ? staticLibrary() : fetch('/api/library').then((r) => json<Library>(r))),

  async loadScene(id: string): Promise<SceneDefinition> {
    let mod: { default: SceneDefinition };
    if (HOSTED) {
      const load = sceneModules[`/scenes/${id}.ts`];
      if (!load) throw new Error(`Unknown scene "${id}"`);
      mod = await load();
    } else {
      // Cache-busting query so edited files are re-evaluated.
      mod = await import(/* @vite-ignore */ `/scenes/${id}.ts?t=${Date.now()}`);
    }
    const def = mod.default as SceneDefinition;
    if (!def || typeof def.update !== 'function') throw new Error(`scenes/${id}.ts must default-export an object with update()`);
    def.id = id;
    return def;
  },

  /** URL of models/<id>.glb. `version` busts the cache after the file changes (dev). */
  modelUrl(id: string, version = 0): string {
    if (HOSTED) {
      const url = modelUrls[`/models/${id}.glb`];
      if (!url) throw new Error(`Unknown model "${id}"`);
      return url;
    }
    return `/models/${id}.glb?v=${version}`;
  },

  uploadModel: (file: File) => HOSTED ? notHosted() :
    fetch(`/api/models?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file })
      .then((r) => json<{ id: string; replaced: boolean }>(r)),

  newScene: (name: string) => HOSTED ? notHosted() :
    fetch('/api/scenes/new', { method: 'POST', body: JSON.stringify({ name }) }).then((r) => json<{ id: string }>(r)),

  async loadLogic(id: string): Promise<LogicDefinition> {
    if (!HOSTED) return fetch(`/api/logics/${id}`).then((r) => json<LogicDefinition>(r));
    const load = logicModules[`/logics/${id}.json`];
    if (!load) throw new Error(`Unknown logic "${id}"`);
    return structuredClone(await load());
  },

  saveLogic: (logic: LogicDefinition) => HOSTED ? notHosted() :
    fetch('/api/logics', { method: 'POST', body: JSON.stringify(logic) }).then((r) => json<{ id: string }>(r)),

  status: () => fetch('/api/status').then((r) => json<{ hasKey: boolean; model: string }>(r)),
  onlineCheck: () => fetch('/api/online-check').then((r) => json<{ reachable: boolean }>(r)),

  claude: (body: Record<string, unknown>) => HOSTED ? notHosted() :
    fetch('/api/claude', { method: 'POST', body: JSON.stringify(body) })
      .then((r) => json<{ kind: 'scene' | 'logic'; id: string; name: string; summary: string }>(r)),
};
