import type { LogicDefinition, SceneDefinition } from '../engine/types';

/** Talks to the local server (server/plugin.ts). Everything here is localhost-only. */

export interface LibraryItem { id: string; name: string; description: string; author: string }
export interface Library { scenes: LibraryItem[]; logics: LibraryItem[] }

async function json<T>(r: Response): Promise<T> {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
  return body as T;
}

export const api = {
  library: () => fetch('/api/library').then((r) => json<Library>(r)),

  async loadScene(id: string): Promise<SceneDefinition> {
    // Cache-busting query so edited files are re-evaluated.
    const mod = await import(/* @vite-ignore */ `/scenes/${id}.ts?t=${Date.now()}`);
    const def = mod.default as SceneDefinition;
    if (!def || typeof def.update !== 'function') throw new Error(`scenes/${id}.ts must default-export an object with update()`);
    def.id = id;
    return def;
  },

  newScene: (name: string) =>
    fetch('/api/scenes/new', { method: 'POST', body: JSON.stringify({ name }) }).then((r) => json<{ id: string }>(r)),

  loadLogic: (id: string) => fetch(`/api/logics/${id}`).then((r) => json<LogicDefinition>(r)),

  saveLogic: (logic: LogicDefinition) =>
    fetch('/api/logics', { method: 'POST', body: JSON.stringify(logic) }).then((r) => json<{ id: string }>(r)),

  status: () => fetch('/api/status').then((r) => json<{ hasKey: boolean; model: string }>(r)),
  onlineCheck: () => fetch('/api/online-check').then((r) => json<{ reachable: boolean }>(r)),

  claude: (body: Record<string, unknown>) =>
    fetch('/api/claude', { method: 'POST', body: JSON.stringify(body) })
      .then((r) => json<{ kind: 'scene' | 'logic'; id: string; name: string; summary: string }>(r)),
};
