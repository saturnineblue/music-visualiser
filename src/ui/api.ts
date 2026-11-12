import type { LogicDefinition, SceneDefinition } from '../engine/types';
import { studioSceneSource, type StudioSpec } from '../studio/spec';
import { createStudioScene } from '../studio/runtime';
import { studioStore } from '../studio/store';
import { cloud } from '../studio/cloud';

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
  async library(): Promise<Library> {
    if (!HOSTED) return fetch('/api/library').then((r) => json<Library>(r));
    const lib = await (await hosted()).staticLibrary();
    // Scenes made in the studio on this site: stored on the site (cloud) if it has storage, else in this browser.
    await cloud.refresh();
    const mine = [
      ...cloud.scenes.map((s) => ({ id: s.id, name: s.name, description: s.description || 'Made in the Scene Studio.', author: 'studio · cloud' })),
      ...studioStore.list().filter((s) => !cloud.hasScene(s.id))
        .map((s) => ({ id: s.id, name: s.name, description: s.description || 'Made in the Scene Studio.', author: 'studio · this browser' })),
    ];
    return {
      ...lib,
      scenes: [...lib.scenes.filter((s) => !mine.some((m) => m.id === s.id)), ...mine],
      models: [...lib.models.filter((m) => !cloud.hasModel(m.id)), ...cloud.models.map((m) => ({ id: m.id, parts: m.parts }))],
    };
  },

  /** A studio scene saved on the hosted site (cloud first, then this browser), or null. */
  async hostedSpec(id: string): Promise<StudioSpec | null> {
    if (cloud.hasScene(id)) return cloud.spec(id);
    return studioStore.get(id);
  },

  /** Where a saved studio scene lives, in words. */
  studioWhere(id: string): string {
    if (!HOSTED) return `scenes/${id}.ts`;
    return cloud.hasScene(id) ? 'the site\'s storage' : 'this browser';
  },

  /** True if .glb models can be added here (always locally; on the hosted site only with storage). */
  canUploadModels: () => !HOSTED || cloud.enabled,

  async loadScene(id: string): Promise<SceneDefinition> {
    let mod: { default: SceneDefinition };
    if (HOSTED) {
      const mine = await this.hostedSpec(id);
      if (mine) return createStudioScene(mine);
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
    if (HOSTED) return cloud.hasModel(id) ? cloud.modelUrl(id) : (await hosted()).modelUrl(id);
    return `/models/${id}.glb?v=${version}`;
  },

  async uploadModel(file: File): Promise<{ id: string; replaced: boolean }> {
    if (HOSTED) {
      if (!cloud.enabled) throw new Error('This site has no storage for models. Run the app locally to add them.');
      const id = file.name.replace(/\.glb$/i, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'model';
      return cloud.uploadModel(id, file);
    }
    return fetch(`/api/models?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file })
      .then((r) => json<{ id: string; replaced: boolean }>(r));
  },

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

  /** A library scene's TypeScript source, or null if there is no such scene. */
  async sceneSource(id: string): Promise<string | null> {
    if (HOSTED) {
      const mine = await this.hostedSpec(id);
      return mine ? studioSceneSource(mine) : (await hosted()).sceneSource(id);
    }
    const r = await fetch(`/api/scenes/${id}/source`);
    return r.ok ? r.text() : null;
  },

  /** A library scene compiled to plain JS (what scene-set files carry), or null. */
  async sceneCompiled(id: string): Promise<string | null> {
    if (HOSTED) {
      const mine = await this.hostedSpec(id);
      return mine ? studioSceneSource(mine) : (await hosted()).sceneCompiled(id); // studio scenes are already plain JS
    }
    const r = await fetch(`/api/scenes/${id}/compiled`);
    return r.ok ? r.text() : null;
  },

  /** Compile scene TS to JS (local server only; the hosted site can't compile). */
  compileScene: (id: string, source: string) => HOSTED ? notHosted() as Promise<string> :
    fetch('/api/compile', { method: 'POST', body: JSON.stringify({ id, source }) }).then((r) => json<{ js: string }>(r)).then((r) => r.js),

  installSet: (body: { scenes: Record<string, string>; models: Record<string, string>; logics: Record<string, unknown>; overwrite?: boolean }) =>
    HOSTED ? notHosted() as Promise<{ installed: string[]; conflicts: string[] }> :
    fetch('/api/sets/install', { method: 'POST', body: JSON.stringify(body) }).then((r) => json<{ installed: string[]; conflicts: string[] }>(r)),

  claude: (body: Record<string, unknown>) => HOSTED ? notHosted() :
    fetch('/api/claude', { method: 'POST', body: JSON.stringify(body) })
      .then((r) => json<{ kind: 'scene' | 'logic' | 'model'; id: string; name: string; summary: string; parts?: string[] }>(r)),

  /**
   * Save a studio scene: as scenes/<id>.ts locally, in this browser on the hosted site.
   * `overwrite` replaces an existing scene with the same id.
   */
  async saveStudio(spec: StudioSpec, overwrite: boolean): Promise<{ id: string; where: string }> {
    if (HOSTED) {
      const taken = cloud.hasScene(spec.id) || !!studioStore.get(spec.id) || (await (await hosted()).sceneSource(spec.id)) != null;
      if (!overwrite && taken) throw new Error('EXISTS');
      if (cloud.enabled) {
        await cloud.saveSpec(spec, true);
        studioStore.remove(spec.id); // a browser copy would now only be a stale duplicate
      } else {
        studioStore.put(spec);
      }
      return { id: spec.id, where: this.studioWhere(spec.id) };
    }
    const r = await fetch('/api/studio', { method: 'POST', body: JSON.stringify({ spec, overwrite }) });
    if (r.status === 409) throw new Error('EXISTS');
    const { id } = await json<{ id: string }>(r);
    return { id, where: `scenes/${id}.ts` };
  },

  /** Remove a studio scene saved on the hosted site (from its storage and from this browser). */
  async deleteStudio(id: string) {
    if (cloud.hasScene(id)) await cloud.removeScene(id);
    studioStore.remove(id);
  },
};
