import { canonicalSpec, normalizeSpec, type StudioSpec } from './spec';

/**
 * Client for the hosted site's library storage (api/cloud.ts → a private Vercel Blob store).
 * Hosted builds only: the local app saves to files and never calls this. If the site has no
 * store connected, `enabled` stays false and the studio keeps saving in the browser.
 */

export interface CloudScene { id: string; name: string; description: string; updatedAt: number }
export interface CloudModel { id: string; parts: string[]; size: number; updatedAt: number }

/** Vercel Functions accept request bodies up to 4.5 MB (see api/cloud.ts). */
export const CLOUD_MAX_MODEL_BYTES = 4 * 1024 * 1024;

const URL_ = '/api/cloud';
const specs = new Map<string, { at: number; spec: StudioSpec }>();

async function call<T>(query: string, init?: RequestInit): Promise<T> {
  const r = await fetch(URL_ + query, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 409) throw new Error('EXISTS');
    if (r.status === 401) throw new Error('You are signed out. Reload the page and sign in again.');
    throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
  }
  return body as T;
}

export const cloud = {
  enabled: false,
  scenes: [] as CloudScene[],
  models: [] as CloudModel[],

  /** Load the list of what is stored. Never throws: on any failure the cloud is simply off. */
  async refresh() {
    try {
      const idx = await call<{ enabled: boolean; scenes: CloudScene[]; models: CloudModel[] }>('');
      this.enabled = !!idx.enabled;
      this.scenes = idx.scenes ?? [];
      this.models = idx.models ?? [];
    } catch {
      this.enabled = false;
      this.scenes = [];
      this.models = [];
    }
  },

  hasScene(id: string) { return this.scenes.some((s) => s.id === id); },
  hasModel(id: string) { return this.models.some((m) => m.id === id); },

  async spec(id: string): Promise<StudioSpec> {
    const at = this.scenes.find((s) => s.id === id)?.updatedAt ?? 0;
    const hit = specs.get(id);
    if (hit && hit.at === at) return structuredClone(hit.spec);
    const spec = normalizeSpec(await call<unknown>(`?scene=${id}`));
    spec.id = id;
    specs.set(id, { at, spec });
    return structuredClone(spec);
  },

  async saveSpec(spec: StudioSpec, overwrite: boolean) {
    const saved = await call<CloudScene>(`?scene=${spec.id}${overwrite ? '&overwrite=1' : ''}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(canonicalSpec(spec)),
    });
    this.scenes = [...this.scenes.filter((s) => s.id !== saved.id), saved];
    specs.delete(saved.id);
  },

  async removeScene(id: string) {
    await call(`?scene=${id}`, { method: 'DELETE' });
    this.scenes = this.scenes.filter((s) => s.id !== id);
    specs.delete(id);
  },

  /** The model's URL. The version makes it safe for the browser to cache until the model changes. */
  modelUrl(id: string) {
    return `${URL_}?model=${id}&v=${this.models.find((m) => m.id === id)?.updatedAt ?? 0}`;
  },

  async uploadModel(id: string, file: Blob): Promise<{ id: string; replaced: boolean }> {
    if (file.size > CLOUD_MAX_MODEL_BYTES) {
      throw new Error(`This model is ${(file.size / 1024 / 1024).toFixed(1)} MB. The hosted site can store models up to ${CLOUD_MAX_MODEL_BYTES / 1024 / 1024} MB; ` +
        'for a bigger one, simplify it in Blender or add it to the project\'s models/ folder.');
    }
    const saved = await call<CloudModel & { replaced: boolean }>(`?model=${id}&overwrite=1`, {
      method: 'PUT', headers: { 'Content-Type': 'model/gltf-binary' }, body: file,
    });
    this.models = [...this.models.filter((m) => m.id !== saved.id), saved];
    return { id: saved.id, replaced: saved.replaced };
  },
};
