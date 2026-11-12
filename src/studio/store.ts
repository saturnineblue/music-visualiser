import { normalizeSpec, type StudioSpec } from './spec';

/**
 * Studio scenes kept in this browser (localStorage). The hosted site has no server to write
 * scene files, so that's where its studio saves. Locally, scenes are saved as scenes/<id>.ts instead.
 */

const KEY = 'vis.studio.scenes';

function readAll(): Record<string, StudioSpec> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export const studioStore = {
  list(): StudioSpec[] {
    return Object.values(readAll()).map((s) => normalizeSpec(s));
  },
  get(id: string): StudioSpec | null {
    const s = readAll()[id];
    return s ? normalizeSpec(s) : null;
  },
  /** Throws if the browser's storage is full or blocked. */
  put(spec: StudioSpec) {
    const all = readAll();
    const clean = { ...spec };
    delete clean.rev;
    all[spec.id] = clean;
    localStorage.setItem(KEY, JSON.stringify(all));
  },
  remove(id: string) {
    const all = readAll();
    delete all[id];
    localStorage.setItem(KEY, JSON.stringify(all));
  },
};
