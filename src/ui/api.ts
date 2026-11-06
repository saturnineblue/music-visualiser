import type { LogicDefinition, SceneDefinition } from '../engine/types';

/**
 * Talks to the local server (server/plugin.ts). Everything here is localhost-only.
 *
 * In a production build (`npm run build`, e.g. the Vercel deploy) there is no server: scenes and
 * logics are bundled at build time and the library is read-only. Claude generation, new scenes and
 * saving logics only work when running locally with `npm run dev`.
 */
export const HOSTED = !import.meta.env.DEV;

// Production-only bundle of the library; never loaded in dev (see hostedLibrary.ts).
const hosted = () => import('./hostedLibrary');

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
  library: async () => (HOSTED ? (await hosted()).staticLibrary() : fetch('/api/library').then((r) => json<Library>(r))),

  async loadScene(id: string): Promise<SceneDefinition> {
    let mod: { default: SceneDefinition };
    if (HOSTED) {
      mod = await (await hosted()).loadSceneModule(id);
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
  async modelUrl(id: string, version = 0): Promise<string> {
    if (HOSTED) return (await hosted()).modelUrl(id);
    return `/models/${id}.glb?v=${version}`;
  },

  uploadModel: (file: File) => HOSTED ? notHosted() :
    fetch(`/api/models?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file })
      .then((r) => json<{ id: string; replaced: boolean }>(r)),

  newScene: (name: string) => HOSTED ? notHosted() :
    fetch('/api/scenes/new', { method: 'POST', body: JSON.stringify({ name }) }).then((r) => json<{ id: string }>(r)),

  async loadLogic(id: string): Promise<LogicDefinition> {
    if (!HOSTED) return fetch(`/api/logics/${id}`).then((r) => json<LogicDefinition>(r));
    return (await hosted()).loadLogic(id);
  },

  saveLogic: (logic: LogicDefinition) => HOSTED ? notHosted() :
    fetch('/api/logics', { method: 'POST', body: JSON.stringify(logic) }).then((r) => json<{ id: string }>(r)),

  status: () => fetch('/api/status').then((r) => json<{ hasKey: boolean; model: string; blender: boolean }>(r)),
  onlineCheck: () => fetch('/api/online-check').then((r) => json<{ reachable: boolean }>(r)),

  claude: (body: Record<string, unknown>) => HOSTED ? notHosted() :
    fetch('/api/claude', { method: 'POST', body: JSON.stringify(body) })
      .then((r) => json<{ kind: 'scene' | 'logic'; id: string; name: string; summary: string }>(r)),
};
