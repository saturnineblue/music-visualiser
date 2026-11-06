import { DEFAULT_MACROS, MACRO_RANGES, type LogicDefinition, type Macros, type SceneDefinition } from '../engine/types';
import { api, HOSTED, type LibraryItem } from './api';

/**
 * Scene sets: an ordered list of entries (scene + logic + slider values) for a show, saved as one
 * self-contained `.set.json` file that also carries the scenes' code and the models they use.
 * Format: docs/SETS.md.
 */

export const SET_FORMAT = 'music-visualiser-set';

export interface SetEntry {
  label: string;
  /** Scene id: bundled in the set's `scenes`, or a scene in the library. */
  scene: string;
  /** Full logic (live mapping tweaks included), or the id of a library logic. */
  logic: LogicDefinition | string;
  /** Base macro values (the Macros sliders). Missing keys use the logic's base. */
  macros?: Partial<Macros>;
  /** Scene param values. Missing keys use the scene's defaults. */
  params?: Record<string, number>;
}

export interface SetScene {
  /** TypeScript source (what gets installed into scenes/). */
  source: string;
  /** The same scene compiled to an ES module; lets the hosted site run it. Filled in on save. */
  js?: string;
}

export interface SetFile {
  format: typeof SET_FORMAT;
  version: 1;
  name: string;
  description?: string;
  entries: SetEntry[];
  /** Scene code, by scene id. */
  scenes?: Record<string, SetScene>;
  /** .glb models used by the scenes, base64, by model id. */
  models?: Record<string, string>;
}

export interface SetHooks {
  /** Switch to an entry. Return false if it could not be shown. */
  apply(entry: SetEntry): Promise<boolean>;
  /** The current scene/logic/sliders, for "Add current" / "Update". */
  capture(): SetEntry | null;
  /** Library scenes (to tell bundled-only scenes and missing ones apart). */
  libraryScenes(): LibraryItem[];
  /** Load a library scene (to read which models it uses when saving). */
  loadLibraryScene(id: string): Promise<SceneDefinition>;
  /** Called after opening/installing, so lists and the current scene can refresh. */
  changed(kind: 'opened' | 'installed' | 'edited'): void;
  toast(msg: string): void;
}

const STORE_KEY = 'vis.set';
const DIRTY_KEY = 'vis.setDirty';
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'set';

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Throws with a readable message if `raw` isn't a usable set. */
export function parseSet(raw: unknown): SetFile {
  const s = raw as SetFile;
  if (!s || typeof s !== 'object' || s.format !== SET_FORMAT) throw new Error(`Not a scene set (expected "format": "${SET_FORMAT}").`);
  if (!Array.isArray(s.entries)) throw new Error('The set has no "entries" list.');
  s.entries.forEach((e, i) => {
    if (!e || typeof e.scene !== 'string') throw new Error(`Entry ${i + 1} has no "scene".`);
    if (typeof e.logic !== 'string' && (!e.logic || !Array.isArray(e.logic.mappings))) throw new Error(`Entry ${i + 1} needs a "logic" (an object with mappings, or a logic id).`);
    if (typeof e.label !== 'string') e.label = e.scene;
  });
  for (const [id, sc] of Object.entries(s.scenes ?? {})) {
    if (!sc || typeof sc.source !== 'string') throw new Error(`Scene "${id}" in the set has no "source".`);
  }
  return { ...s, name: typeof s.name === 'string' && s.name ? s.name : 'Untitled set', version: 1 };
}

export class SetManager {
  set: SetFile = { format: SET_FORMAT, version: 1, name: 'Untitled set', entries: [] };
  active = -1;
  /** Changed since it was last opened, saved or cleared. */
  dirty = false;
  /** Bundled scenes that differ from (or are missing in) the library: these run from the set. */
  private bundledDefs = new Map<string, SceneDefinition>();
  private modelUrls = new Map<string, string>();

  constructor(private root: HTMLElement, private hooks: SetHooks) {
    root.querySelector<HTMLButtonElement>('#set-add')!.onclick = () => this.addCurrent();
    root.querySelector<HTMLButtonElement>('#set-update')!.onclick = () => this.updateActive();
    root.querySelector<HTMLButtonElement>('#set-clear')!.onclick = () => this.clearSet();
    root.querySelector<HTMLButtonElement>('#set-open')!.onclick = () => this.fileInput.click();
    root.querySelector<HTMLButtonElement>('#set-save')!.onclick = () => this.save();
    root.querySelector<HTMLButtonElement>('#set-install')!.onclick = () => this.install();
    root.querySelector<HTMLElement>('#set-name')!.onclick = () => this.rename();
    this.fileInput.onchange = () => {
      const f = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (f) this.openFile(f);
    };
  }

  private get fileInput() { return this.root.querySelector<HTMLInputElement>('#set-file')!; }

  // ---------- Used by the app ----------

  /** The set's own version of a scene, if it should run instead of the library's. */
  sceneDef(id: string): SceneDefinition | null { return this.bundledDefs.get(id) ?? null; }
  /** Blob URL of a model bundled in the set. */
  modelUrl(id: string): string | null { return this.modelUrls.get(id) ?? null; }
  /** Scenes that exist only in the set (shown in the scene list too). */
  extraScenes(): LibraryItem[] {
    const lib = new Set(this.hooks.libraryScenes().map((s) => s.id));
    return [...this.bundledDefs.entries()].filter(([id]) => !lib.has(id))
      .map(([id, d]) => ({ id, name: d.name ?? id, description: d.description ?? '', author: 'from set' }));
  }

  async go(i: number) {
    const e = this.set.entries[i];
    if (!e) return;
    if (this.isMissing(e)) { this.hooks.toast(`Entry ${i + 1}: scene "${e.scene}" is not in this set or the library.`); return; }
    const prev = this.active;
    this.active = i;
    this.render();
    if (!(await this.hooks.apply(e))) { this.active = prev; this.render(); }
  }
  next() { if (this.set.entries.length) this.go(Math.min(this.set.entries.length - 1, this.active + 1)); }
  prev() { if (this.set.entries.length) this.go(Math.max(0, this.active - 1)); }

  /** After a scene is (re)loaded outside the set, so the highlight doesn't lie. */
  sceneChanged(id: string) {
    if (this.active >= 0 && this.set.entries[this.active]?.scene !== id) { this.active = -1; this.render(); }
  }

  addCurrent() {
    const e = this.hooks.capture();
    if (!e) return;
    this.set.entries.push(e);
    this.active = this.set.entries.length - 1;
    this.edited();
  }

  // ---------- Editing ----------

  private updateActive() {
    if (this.active < 0) return this.hooks.toast('Pick an entry first (click it), then Update saves the current look into it.');
    const e = this.hooks.capture();
    if (!e) return;
    e.label = this.set.entries[this.active].label;
    this.set.entries[this.active] = e;
    this.edited();
  }

  private edited() {
    this.dirty = true;
    this.persist();
    this.render();
  }

  /** True if it's fine to replace the current set (nothing unsaved, or the user agreed). */
  private confirmDiscard(action: string) {
    if (!this.dirty || !this.set.entries.length) return true;
    return confirm(`"${this.set.name}" has unsaved changes (${this.set.entries.length} entries).\n\n` +
      `${action} anyway? To keep them, cancel and use "Save set…" first.`);
  }

  /** Empty the set (entries, its bundled scenes and models) to start designing from scratch. */
  clearSet() {
    if (!this.confirmDiscard('Clear the set')) return;
    this.load({ format: SET_FORMAT, version: 1, name: 'Untitled set', entries: [] }, new Map());
    this.hooks.changed('opened');
  }

  private rename() {
    const name = prompt('Set name:', this.set.name);
    if (!name) return;
    this.set.name = name;
    this.edited();
  }

  // ---------- Open ----------

  async openFile(file: File) {
    try {
      const set = parseSet(JSON.parse(await file.text()));
      if (!this.confirmDiscard(`Open "${set.name}"`)) return;
      await this.openSet(set, true);
      this.hooks.toast(`Opened "${set.name}" (${set.entries.length} entries). Click an entry or press 1–9 to switch, Page Up/Down to step.`);
    } catch (e) {
      this.hooks.toast(`Could not open "${file.name}": ${(e as Error).message}`);
    }
  }

  /**
   * Load a parsed set. Bundled scenes identical to the library's use the library (so edits hot-reload);
   * the others run from the set, after the user OKs running code from the file.
   */
  async openSet(set: SetFile, ask: boolean) {
    const runFromSet: string[] = [];
    const inLibrary = new Set(this.hooks.libraryScenes().map((s) => s.id));
    for (const [id, sc] of Object.entries(set.scenes ?? {})) {
      const lib = inLibrary.has(id) ? await api.sceneSource(id).catch(() => null) : null;
      if (lib !== sc.source) runFromSet.push(id);
    }
    if (ask && runFromSet.length && !confirm(
      `This set contains code for ${runFromSet.length} scene(s) that will run in this page:\n\n${runFromSet.join(', ')}\n\n` +
      'Only open sets you made yourself or got from someone you trust. Continue?')) throw new Error('Cancelled.');

    const defs = new Map<string, SceneDefinition>();
    for (const id of runFromSet) {
      const sc = set.scenes![id];
      let js = sc.js;
      if (!js) {
        if (HOSTED) throw new Error(`Scene "${id}" has no compiled code. Open the set once in the local app (npm run dev) and save it again.`);
        js = await api.compileScene(id, sc.source);
        sc.js = js;
      }
      defs.set(id, await importScene(id, js));
    }
    this.load(set, defs);
    this.hooks.changed('opened');
  }

  private load(set: SetFile, defs: Map<string, SceneDefinition>) {
    for (const url of this.modelUrls.values()) URL.revokeObjectURL(url);
    this.modelUrls.clear();
    for (const [id, b64] of Object.entries(set.models ?? {})) {
      this.modelUrls.set(id, URL.createObjectURL(new Blob([fromBase64(b64)], { type: 'model/gltf-binary' })));
    }
    this.set = set;
    this.bundledDefs = defs;
    this.active = -1;
    this.dirty = false;
    this.persist();
    this.render();
  }

  // ---------- Save ----------

  /** Pack the set with every scene's code and every model it uses. */
  async pack(): Promise<SetFile> {
    const scenes: Record<string, SetScene> = {};
    const modelIds = new Set<string>();
    for (const id of new Set(this.set.entries.map((e) => e.scene))) {
      const own = this.bundledDefs.get(id);
      if (own) {
        scenes[id] = this.set.scenes![id];
        own.models?.forEach((m) => modelIds.add(m));
        continue;
      }
      const source = await api.sceneSource(id);
      if (source == null) {
        const kept = this.set.scenes?.[id];
        if (kept) { scenes[id] = kept; continue; }
        throw new Error(`Scene "${id}" is in neither the set nor the library.`);
      }
      const js = await api.sceneCompiled(id) ?? undefined;
      scenes[id] = { source, js };
      (await this.hooks.loadLibraryScene(id)).models?.forEach((m) => modelIds.add(m));
    }
    const models: Record<string, string> = {};
    for (const id of modelIds) {
      const kept = this.set.models?.[id];
      if (kept) { models[id] = kept; continue; }
      const r = await fetch(await api.modelUrl(id));
      if (!r.ok) throw new Error(`Model "${id}" could not be read.`);
      models[id] = toBase64(await r.arrayBuffer());
    }
    return { format: SET_FORMAT, version: 1, name: this.set.name, description: this.set.description, entries: this.set.entries, scenes, models };
  }

  private async save() {
    if (!this.set.entries.length) return this.hooks.toast('The set is empty: add entries with "+ Add current" first.');
    const btn = this.root.querySelector<HTMLButtonElement>('#set-save')!;
    btn.disabled = true;
    try {
      const packed = await this.pack();
      const blob = new Blob([JSON.stringify(packed)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${slug(this.set.name)}.set.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      this.dirty = false;
      this.persist();
      this.render();
      this.hooks.toast(`Saved "${a.download}" (${(blob.size / 1024).toFixed(0)} KB): ${packed.entries.length} entries, ` +
        `${Object.keys(packed.scenes ?? {}).length} scenes, ${Object.keys(packed.models ?? {}).length} models.`);
    } catch (e) {
      this.hooks.toast(`Could not save the set: ${(e as Error).message}`);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- Install (local only) ----------

  private async install() {
    const scenes: Record<string, string> = {};
    for (const id of this.bundledDefs.keys()) scenes[id] = this.set.scenes![id].source;
    const models: Record<string, string> = { ...(this.set.models ?? {}) };
    const logics: Record<string, unknown> = {};
    for (const e of this.set.entries) if (typeof e.logic !== 'string') logics[e.logic.id] = e.logic;
    try {
      let res = await api.installSet({ scenes, models, logics });
      if (res.conflicts.length) {
        if (!confirm(`These already exist in your library with different content:\n\n${res.conflicts.join('\n')}\n\n` +
          'Replace them with the set\'s versions? (The old files are kept in .history/.)')) {
          // Install only what's new.
          const keep = (kind: string, id: string) => !res.conflicts.includes(`${kind} "${id}"`);
          res = await api.installSet({
            scenes: Object.fromEntries(Object.entries(scenes).filter(([id]) => keep('scene', id))),
            models: Object.fromEntries(Object.entries(models).filter(([id]) => keep('model', id))),
            logics: Object.fromEntries(Object.entries(logics).filter(([id]) => keep('logic', id))),
          });
        } else {
          res = await api.installSet({ scenes, models, logics, overwrite: true });
        }
      }
      // Installed scenes now come from the library (and hot-reload when edited).
      for (const id of [...this.bundledDefs.keys()]) {
        const now = await api.sceneSource(id).catch(() => null);
        if (now === this.set.scenes![id].source) this.bundledDefs.delete(id);
      }
      this.hooks.toast(res.installed.length ? `Installed into the library:\n${res.installed.join('\n')}` : 'Nothing new to install: the library already has everything in this set.');
      this.hooks.changed('installed');
      this.render();
    } catch (e) {
      this.hooks.toast(`Install failed: ${(e as Error).message}`);
    }
  }

  // ---------- UI ----------

  private isMissing(e: SetEntry) {
    return !this.bundledDefs.has(e.scene) && !this.hooks.libraryScenes().some((s) => s.id === e.scene) && !this.set.scenes?.[e.scene];
  }

  render() {
    this.root.querySelector('#set-name')!.textContent = this.set.name;
    this.root.querySelector<HTMLElement>('#set-dirty')!.hidden = !(this.dirty && this.set.entries.length);
    const list = this.root.querySelector<HTMLOListElement>('#set-list')!;
    list.innerHTML = '';
    this.set.entries.forEach((e, i) => {
      const li = document.createElement('li');
      li.className = (i === this.active ? 'active' : '') + (this.isMissing(e) ? ' missing' : '');
      li.innerHTML = '<span class="key"></span><div class="what"><span class="name"></span><span class="desc"></span></div>' +
        '<span class="tools"><button data-a="up" title="Move up">↑</button><button data-a="down" title="Move down">↓</button>' +
        '<button data-a="rename" title="Rename">✎</button><button data-a="del" title="Remove">✕</button></span>';
      li.querySelector('.key')!.textContent = i < 9 ? String(i + 1) : '';
      li.querySelector('.name')!.textContent = e.label;
      const logicName = typeof e.logic === 'string' ? e.logic : e.logic.name;
      const sceneName = this.bundledDefs.get(e.scene)?.name ?? this.hooks.libraryScenes().find((s) => s.id === e.scene)?.name ?? e.scene;
      li.querySelector('.desc')!.textContent = this.isMissing(e) ? `missing scene "${e.scene}"` : `${sceneName} · ${logicName}${this.bundledDefs.has(e.scene) ? ' · from set' : ''}`;
      li.onclick = (ev) => {
        const a = (ev.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.a;
        if (!a) return this.go(i);
        ev.stopPropagation();
        const E = this.set.entries;
        if (a === 'up' && i > 0) { [E[i - 1], E[i]] = [E[i], E[i - 1]]; if (this.active === i) this.active--; else if (this.active === i - 1) this.active++; }
        if (a === 'down' && i < E.length - 1) { [E[i + 1], E[i]] = [E[i], E[i + 1]]; if (this.active === i) this.active++; else if (this.active === i + 1) this.active--; }
        if (a === 'rename') { const n = prompt('Entry name:', e.label); if (n) e.label = n; }
        if (a === 'del') { E.splice(i, 1); if (this.active === i) this.active = -1; else if (this.active > i) this.active--; }
        this.edited();
      };
      list.appendChild(li);
    });
    this.root.querySelector<HTMLElement>('#set-empty')!.hidden = this.set.entries.length > 0;
    const canInstall = !HOSTED && (this.bundledDefs.size > 0 || Object.keys(this.set.models ?? {}).length > 0);
    this.root.querySelector<HTMLElement>('#set-install')!.hidden = !canInstall;
  }

  /** Keep the set across reloads (skipped quietly if it's too big for localStorage). */
  private persist() {
    try {
      const json = JSON.stringify(this.set);
      if (json.length < 4_000_000) localStorage.setItem(STORE_KEY, json);
      else localStorage.removeItem(STORE_KEY);
      localStorage.setItem(DIRTY_KEY, this.dirty ? '1' : '0');
    } catch { /* quota: fine */ }
  }

  /** Restore the set from the last session (no prompt: the user already accepted its code). */
  async restore() {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return this.render();
    const wasDirty = localStorage.getItem(DIRTY_KEY) === '1';
    try {
      await this.openSet(parseSet(JSON.parse(raw)), false);
      this.dirty = wasDirty;
      this.persist();
      this.render();
    } catch (e) {
      console.warn('Could not restore the scene set:', e);
      this.render();
    }
  }
}

/** Run a compiled scene module from a blob URL. */
async function importScene(id: string, js: string): Promise<SceneDefinition> {
  const url = URL.createObjectURL(new Blob([js], { type: 'text/javascript' }));
  try {
    const mod = await import(/* @vite-ignore */ url);
    const def = mod.default as SceneDefinition;
    if (!def || typeof def.update !== 'function') throw new Error(`Scene "${id}" in the set must default-export an object with update().`);
    def.id = id;
    return def;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Clamp an entry's macros into range, filling gaps from the logic's base. */
export function entryMacros(e: SetEntry, logic: LogicDefinition): Macros {
  const out = { ...DEFAULT_MACROS, ...(logic.base ?? {}) } as Macros;
  for (const k of Object.keys(DEFAULT_MACROS) as (keyof Macros)[]) {
    const v = e.macros?.[k];
    if (typeof v === 'number' && isFinite(v)) {
      const [lo, hi] = MACRO_RANGES[k];
      out[k] = Math.min(hi, Math.max(lo, v));
    }
  }
  return out;
}
