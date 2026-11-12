import * as THREE from 'three';
import type { Engine } from '../engine/engine';
import { AUDIO_SOURCES, CURVES, type AudioSource, type SceneDefinition } from '../engine/types';
import { api, HOSTED, type ModelItem } from '../ui/api';
import { ask } from '../ui/dialog';
import { createStudioScene, sourceValue, type LayerData, type StudioState } from './runtime';
import {
  AXES, SHAPES, cameraPosition, canonicalSpec, liveValues, newForm, newLayer, newSpec, normalizeSpec, slug, specModels, studioTargets,
  type Leaf, type StudioForm, type StudioLayer, type StudioMapping, type StudioPart, type StudioSource, type StudioSpec,
} from './spec';

/**
 * The Scene Studio panel: builds and edits a StudioSpec while it plays on the stage.
 * Sliders change the running scene in place; colour changes repaint it; adding or swapping
 * layers, forms and models rebuilds it.
 */

export interface StudioHooks {
  engine: Engine;
  /** Models in the library. */
  models(): ModelItem[];
  /** Ids of every scene in the library (to pick a free name for a new scene). */
  sceneIds(): string[];
  /** Run a scene on the stage (loads its models first). */
  run(def: SceneDefinition): Promise<boolean>;
  /** The library changed on disk / in the browser: refresh lists. */
  refresh(): Promise<void>;
  /** The studio closed. `sceneId` is the saved scene to show, or null to go back to the previous one. */
  closed(sceneId: string | null): void;
  toast(msg: string): void;
  /** Null if Claude + Blender generation can run now, otherwise why not. */
  cannotGenerate(): Promise<string | null>;
  claudeModel(): string;
  /** Offer a first-time tip (shown once, if tips are on). */
  tip(id: string): void;
}

/** A loop being recorded: per setting, its keys so far. */
interface Recording {
  start: number;
  prevT: number;
  last: Record<string, Leaf>;
  tracks: Map<string, { t: number[]; v: Leaf[] }>;
}
const MAX_LOOP_SECONDS = 120;
const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/** live: read each frame, nothing to do. paint: recolour. build: geometry or models changed. */
type Change = 'live' | 'paint' | 'build';

type Attrs = Record<string, unknown>;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = String(v);
    else if (k.startsWith('on')) (e as unknown as Record<string, unknown>)[k] = v;
    else if (k in e && k !== 'list') (e as unknown as Record<string, unknown>)[k] = v;
    else e.setAttribute(k, String(v));
  }
  for (const c of kids) if (c) e.append(c);
  return e;
}

const FEATURE_LABELS: Record<string, string> = {
  rms: 'Loudness', bass: 'Bass (20–150 Hz)', lowMid: 'Low mids (150–600 Hz)', mid: 'Mids (600 Hz–2.5 kHz)', high: 'Highs (2.5–16 kHz)',
  centroid: 'Brightness of sound', flux: 'Change / onsets', pulse: 'Beat pulse', beat: 'Beat (instant)', constant: 'Always on',
};
const SHAPE_LABELS: Record<string, string> = {
  sphere: 'Sphere (shell)', ball: 'Ball (filled)', cube: 'Cube', torus: 'Torus', knot: 'Knot', plane: 'Flat plane',
  galaxy: 'Galaxy', helix: 'Helix', lorenz: 'Lorenz attractor', ring: 'Ring',
};
const AXIS_LABELS: Record<string, string> = {
  none: 'Off', height: 'Bottom → top', width: 'Left → right', depth: 'Back → front', radius: 'Centre → outside', random: 'Scattered', part: 'One band per part',
};

export class Studio {
  spec: StudioSpec = newSpec();
  isOpen = false;
  /** Id this scene was last saved under (null = never saved). */
  private savedId: string | null = null;
  private savedJson = '';
  private open_ = new Map<string, boolean>();
  private meters: { el: HTMLElement; source: () => StudioSource | undefined }[] = [];
  private generating = false;
  private log: { text: string; image?: string }[] = [];
  private applying: Promise<unknown> = Promise.resolve();
  /** Re-read values into the inputs on screen (after the view, a drag or a loop changed them). */
  private refreshers: (() => void)[] = [];
  private rec: Recording | null = null;
  private recTimer = 0;
  /** Move tool: drag layers in the view instead of the camera. */
  moveMode = false;
  private selected: string | null = null;
  private drag: { id: string; x: number; y: number } | null = null;
  private overlay = el('div', { class: 'st-overlay', hidden: true });
  private handles = new Map<string, HTMLElement>();
  private settleUntil = 0;

  constructor(private root: HTMLElement, private hooks: StudioHooks) {
    setInterval(() => {
      if (!this.isOpen) return;
      this.refreshMeters();
      if (this.spec.loop?.enabled || this.drag) this.refreshValues();
      this.refreshRecorder();
    }, 70);
    document.body.append(this.overlay);
    const r = hooks.engine.renderer;
    // The view has priority: when the user moves the camera, the camera settings follow.
    r.controls.addEventListener('change', () => {
      if (this.isOpen && (r.interacting || performance.now() < this.settleUntil)) this.syncCameraFromView();
    });
    r.controls.addEventListener('end', () => { if (this.isOpen) { this.settleUntil = performance.now() + 1200; this.syncCameraFromView(); } });
    const canvas = r.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', () => this.onPointerUp());
    canvas.addEventListener('pointercancel', () => this.onPointerUp());
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    const frame = () => { requestAnimationFrame(frame); if (this.isOpen) this.updateOverlay(); };
    requestAnimationFrame(frame);
    if (import.meta.hot) {
      import.meta.hot.on('vis:claude-progress', (p: { text: string; image?: string }) => {
        if (!this.generating) return;
        this.log.unshift(p);
        this.renderLog();
      });
    }
  }

  /** True if the studio is editing this scene (so the app doesn't reload it from disk under us). */
  owns(id: string) { return this.isOpen && (this.spec.id === id || this.savedId === id); }

  get dirty() { return this.snapshot() !== this.savedJson; }
  private snapshot() { return JSON.stringify(canonicalSpec(this.spec)); }

  /** Open with an existing studio spec, or a fresh scene. */
  async open(existing?: unknown) {
    if (existing) {
      this.spec = normalizeSpec(structuredClone(existing));
      this.savedId = this.spec.id;
      this.savedJson = this.snapshot();
    } else {
      const taken = new Set(this.hooks.sceneIds());
      let name = 'Studio scene', n = 2;
      while (taken.has(slug(name))) name = `Studio scene ${n++}`;
      this.spec = newSpec(name);
      this.savedId = null;
      this.savedJson = '';
    }
    this.spec.rev = 1;
    this.isOpen = true;
    this.log = [];
    this.root.hidden = false;
    this.root.parentElement?.classList.add('studio-open');
    this.selected = null;
    this.rec = null;
    this.render();
    await this.rebuild(false);
    this.hooks.tip('st-welcome');
  }

  private async close() {
    if (this.dirty && !(await ask(`"${this.spec.name}" has unsaved changes.\n\nLeave the studio without saving them?`, { ok: 'Discard changes', danger: true }))) return;
    if (this.rec) this.stopRecording(false);
    this.setMove(false);
    this.isOpen = false;
    this.root.hidden = true;
    this.root.parentElement?.classList.remove('studio-open');
    this.root.replaceChildren();
    this.meters = [];
    this.hooks.closed(this.savedId);
  }

  /** The model list changed (a .glb was added, or Claude built one). */
  libraryChanged() { if (this.isOpen) this.render(); }

  // ---------- Applying changes ----------

  /** Re-run the scene on the stage: needed when models, layers or the particle count change. */
  private rebuild(keepView = true) {
    this.applying = this.applying.then(async () => {
      if (!this.isOpen) return;
      // Restarting the scene resets the camera to the spec: take the current view first, so nothing jumps.
      if (keepView && this.hooks.engine.scene?.studio === this.spec && !this.loopDrivesCamera()) this.syncCameraFromView();
      await this.hooks.run(createStudioScene(this.spec));
      if (this.isOpen) this.render(); // part names are known once models have loaded
    });
    return this.applying;
  }

  private changed(kind: Change, rerender = false) {
    if (kind !== 'live') this.spec.rev = (this.spec.rev ?? 0) + 1;
    if (kind === 'build') {
      const scene = this.hooks.engine.scene;
      const loaded = Object.keys(this.hooks.engine.field?.ctx.models ?? {});
      const needsRun = specModels(this.spec).some((m) => !loaded.includes(m)) ||
        this.hooks.engine.field?.count !== this.spec.particleCount || scene?.studio !== this.spec;
      if (needsRun) { this.rebuild(); return; }
    }
    if (rerender) this.render();
    else this.refreshHead();
  }

  private async save() {
    const spec = this.spec;
    if (!spec.layers.length) return this.hooks.toast('Add at least one layer before saving.');
    if (this.savedId === null) spec.id = slug(spec.name);
    try {
      let res: { id: string; where: string };
      try {
        res = await api.saveStudio(spec, this.savedId === spec.id);
      } catch (e) {
        if ((e as Error).message !== 'EXISTS') throw e;
        if (!(await ask(`A scene with the id "${spec.id}" already exists.\n\nReplace it with this one?` +
          (HOSTED ? '' : ' (The old file is kept in scenes/.history/.)'), { ok: 'Replace', danger: true }))) return;
        res = await api.saveStudio(spec, true);
      }
      spec.id = res.id;
      this.savedId = res.id;
      this.savedJson = this.snapshot();
      await this.hooks.refresh();
      await this.rebuild(); // the running scene takes the saved id and name
      this.hooks.tip('st-saved');
      this.hooks.toast(`Saved "${spec.name}" to ${res.where}.` + (HOSTED
        ? '\n\nIt is kept in this browser only. To move it elsewhere or keep it safe, add it to a set and use "Save set…".'
        : '\n\nIt is now in the scene list, and can be added to sets like any scene.'));
    } catch (e) {
      this.hooks.toast(`Could not save: ${(e as Error).message}`);
    }
  }

  private async remove() {
    if (!this.savedId) return;
    if (!(await ask(`Delete "${this.spec.name}" from this browser? This can't be undone.`, { ok: 'Delete', danger: true }))) return;
    api.deleteStudio(this.savedId);
    this.savedId = null;
    this.savedJson = this.snapshot();
    await this.hooks.refresh();
    this.close();
  }

  private async generate(prompt: string) {
    if (this.generating || !prompt.trim()) return;
    const why = await this.hooks.cannotGenerate();
    if (why) return this.hooks.toast(why);
    this.generating = true;
    this.log = [{ text: 'Asking Claude to build it in Blender. This takes a few minutes…' }];
    this.render();
    try {
      const res = await api.claude({ mode: 'new-object', objectOnly: true, prompt, model: this.hooks.claudeModel() });
      await this.hooks.refresh();
      const layer = newLayer(res.name, newForm('model', res.id));
      this.spec.layers.push(layer);
      this.open_.set('layer:' + layer.id, true);
      this.log.unshift({ text: `✓ Added "${res.name}" as a layer (models/${res.id}.glb).` });
    } catch (e) {
      this.log.unshift({ text: `✗ ${(e as Error).message}` });
    } finally {
      this.generating = false;
    }
    this.changed('build', true);
  }

  // ---------- Camera: the view comes first ----------

  private refreshValues() { for (const f of this.refreshers) f(); }

  private loopDrivesCamera() {
    return !!this.spec.loop?.enabled && this.spec.loop.tracks.some((t) => t.path.startsWith('camera.'));
  }

  /** Point the real camera where the camera settings say (after a slider changed). */
  private applyCamera() {
    const c = this.spec.camera;
    this.hooks.engine.renderer.setCamera({ position: cameraPosition(c), target: [...c.target], fov: c.fov, autoRotate: c.autoRotate, autoTilt: c.autoTilt });
  }

  /** Copy the view's camera into the settings (after the user moved it, or before a rebuild). */
  private syncCameraFromView() {
    const o = this.hooks.engine.renderer.getOrbit(), c = this.spec.camera;
    let az = o.azimuth;
    while (az - c.azimuth > 180) az -= 360;
    while (az - c.azimuth < -180) az += 360;
    c.azimuth = +az.toFixed(2);
    c.elevation = +o.elevation.toFixed(2);
    c.distance = +o.distance.toFixed(2);
    c.target = o.target.map((v) => +v.toFixed(2)) as [number, number, number];
    this.refreshValues();
    this.refreshHead();
  }

  // ---------- Move tool: select and drag layers in the view ----------

  setMove(on: boolean) {
    if (on === this.moveMode) return;
    this.moveMode = on;
    const r = this.hooks.engine.renderer;
    r.controls.enabled = !on;
    r.renderer.domElement.style.cursor = on ? 'move' : '';
    this.overlay.hidden = !on;
    this.overlay.style.right = `${this.root.parentElement?.offsetWidth ?? 0}px`; // keep handles off the panel
    if (!on) { this.drag = null; this.selected = null; }
    if (this.isOpen) this.render();
    if (on) this.hooks.tip('st-move-on');
  }

  private runtimeLayers(): LayerData[] {
    return (this.hooks.engine.field?.ctx.state.studio as StudioState | undefined)?.layers ?? [];
  }

  /** Where a layer's centre is on screen, how big it looks, and how far away it is. */
  private project(ld: LayerData) {
    const r = this.hooks.engine.renderer, cam = r.camera;
    const rect = r.renderer.domElement.getBoundingClientRect();
    const c = new THREE.Vector3(ld.cx, ld.cy, ld.cz);
    const depth = c.clone().sub(cam.position).dot(cam.getWorldDirection(new THREE.Vector3()));
    const ndc = c.clone().project(cam);
    const perPx = (2 * Math.max(0.01, depth) * Math.tan((cam.fov * Math.PI) / 360)) / rect.height; // world units per pixel there
    return { x: rect.left + ((ndc.x + 1) / 2) * rect.width, y: rect.top + ((1 - ndc.y) / 2) * rect.height, radius: ld.cr / perPx, depth, perPx };
  }

  private pick(x: number, y: number): string | null {
    let best: string | null = null, bestScore = Infinity;
    for (const ld of this.runtimeLayers()) {
      const p = this.project(ld);
      if (p.depth <= 0) continue;
      const reach = Math.max(28, p.radius);
      const score = Math.hypot(x - p.x, y - p.y) / reach;
      if (score <= 1 && score < bestScore) { best = ld.id; bestScore = score; }
    }
    return best;
  }

  private onPointerDown(e: PointerEvent) {
    if (!this.isOpen || !this.moveMode || e.button !== 0) return;
    const id = this.pick(e.clientX, e.clientY);
    const was = this.selected;
    this.selected = id;
    if (id) {
      this.drag = { id, x: e.clientX, y: e.clientY };
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      this.open_.set('layer:' + id, true);
    }
    if (id !== was) this.render();
    e.preventDefault();
  }

  private onPointerMove(e: PointerEvent) {
    const d = this.drag;
    if (!d || !this.isOpen) return;
    const L = this.spec.layers.find((x) => x.id === d.id), ld = this.runtimeLayers().find((x) => x.id === d.id);
    if (!L || !ld) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    d.x = e.clientX; d.y = e.clientY;
    const cam = this.hooks.engine.renderer.camera, k = this.project(ld).perPx;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    // Shift: push the layer away from / towards the camera instead of across the view.
    const move = e.shiftKey
      ? cam.getWorldDirection(new THREE.Vector3()).multiplyScalar(-dy * k)
      : right.multiplyScalar(dx * k).add(up.multiplyScalar(-dy * k));
    for (const F of L.forms) {
      F.position[0] = +(F.position[0] + move.x).toFixed(3);
      F.position[1] = +(F.position[1] + move.y).toFixed(3);
      F.position[2] = +(F.position[2] + move.z).toFixed(3);
    }
    this.refreshHead();
  }

  private onPointerUp() {
    if (!this.drag) return;
    this.drag = null;
    this.refreshValues();
  }

  private onWheel(e: WheelEvent) {
    if (!this.isOpen || !this.moveMode) return;
    e.preventDefault();
    const L = this.spec.layers.find((x) => x.id === this.selected);
    if (!L) return;
    L.scale = +Math.min(4, Math.max(0.1, L.scale * Math.exp(-e.deltaY * 0.0015))).toFixed(3);
    this.refreshValues();
    this.refreshHead();
  }

  /** Handles drawn over the view in move mode: one per layer, the selected one ringed. */
  private updateOverlay() {
    if (!this.moveMode) return;
    const seen = new Set<string>();
    for (const ld of this.runtimeLayers()) {
      const L = this.spec.layers.find((x) => x.id === ld.id);
      if (!L) continue;
      seen.add(ld.id);
      let h = this.handles.get(ld.id);
      if (!h) { h = el('div', { class: 'st-handle' }, el('i'), el('span')); this.handles.set(ld.id, h); this.overlay.append(h); }
      const p = this.project(ld), sel = ld.id === this.selected;
      h.hidden = p.depth <= 0;
      h.classList.toggle('selected', sel);
      h.style.transform = `translate(${p.x}px, ${p.y}px)`;
      const size = sel ? Math.min(900, Math.max(40, p.radius * 2)) : 14;
      const ring = h.firstElementChild as HTMLElement;
      ring.style.width = ring.style.height = `${size}px`;
      (h.lastElementChild as HTMLElement).textContent = L.name;
      (h.lastElementChild as HTMLElement).style.top = `${size / 2 + 4}px`;
    }
    for (const [id, h] of this.handles) if (!seen.has(id)) { h.remove(); this.handles.delete(id); }
  }

  // ---------- Loop recorder ----------

  private sampleValues(): Record<string, Leaf> {
    const vals = liveValues(this.spec);
    const st = this.hooks.engine.field?.ctx.state.studio as StudioState | undefined;
    if (st && st.maxForms > 1 && this.spec.morph.mode !== 'manual') vals['@morph'] = +st.morphS.toFixed(4);
    return vals;
  }

  private startRecording() {
    if (this.spec.loop) this.spec.loop.enabled = false; // the old loop must not fight what is being recorded
    this.rec = { start: performance.now(), prevT: 0, last: this.sampleValues(), tracks: new Map() };
    this.recTimer = window.setInterval(() => this.recordSample(), 33);
    this.render();
    this.hooks.tip('st-recording');
  }

  private recordSample() {
    const rec = this.rec;
    if (!rec) return;
    const t = (performance.now() - rec.start) / 1000;
    const vals = this.sampleValues();
    for (const [path, raw] of Object.entries(vals)) {
      const v = typeof raw === 'number' ? +raw.toFixed(4) : raw, was = rec.last[path];
      if (was === undefined || v === was) continue;
      let tr = rec.tracks.get(path);
      if (!tr) { tr = { t: [0], v: [was] }; rec.tracks.set(path, tr); }
      // Hold the old value until just before the change, so a long still stretch isn't turned into a slow slide.
      if (tr.t[tr.t.length - 1] < rec.prevT) { tr.t.push(+rec.prevT.toFixed(3)); tr.v.push(was); }
      tr.t.push(+t.toFixed(3)); tr.v.push(v);
      rec.last[path] = v;
    }
    rec.prevT = t;
    if (t >= MAX_LOOP_SECONDS) this.stopRecording(true);
  }

  private stopRecording(keep: boolean) {
    const rec = this.rec;
    if (!rec) return;
    clearInterval(this.recTimer);
    this.recordSample();
    this.rec = null;
    const duration = +((performance.now() - rec.start) / 1000).toFixed(3);
    if (keep && duration >= 0.3 && rec.tracks.size) {
      const tracks = [...rec.tracks.entries()].map(([path, tr]) => {
        if (tr.t[tr.t.length - 1] < duration) { tr.t.push(duration); tr.v.push(tr.v[tr.v.length - 1]); }
        return { path, t: tr.t, v: tr.v };
      });
      this.spec.loop = { enabled: true, duration, tracks };
      const st = this.hooks.engine.field?.ctx.state.studio as StudioState | undefined;
      if (st) st.loopT = 0;
      this.hooks.tip('st-loop-made');
    } else if (keep) {
      if (this.spec.loop) this.spec.loop.enabled = true;
      this.hooks.toast('Nothing changed while recording, so there is no loop yet.\n\nPress Record, then move sliders, drag layers (✥ Move) or turn the camera, and press Stop.');
    }
    if (this.isOpen) this.render();
  }

  private refreshRecorder() {
    const b = this.root.querySelector<HTMLElement>('.st-rec');
    if (b && this.rec) b.textContent = `■ Stop  ${fmtClock((performance.now() - this.rec.start) / 1000)}`;
  }

  private loopBlock() {
    const loop = this.spec.loop;
    const kids: (Node | null)[] = [
      el('div', { class: 'hint st-note' }, 'Press Record, then play: move sliders, pick colours, drag layers, turn the camera, let it morph. Press Stop and your moves replay as a loop, also after saving.'),
      el('div', { class: 'row' },
        el('button', { class: 'st-rec' + (this.rec ? ' recording' : ''), onclick: () => (this.rec ? this.stopRecording(true) : this.startRecording()) },
          this.rec ? '■ Stop  0:00' : loop ? '● Record again' : '● Record'),
        loop && !this.rec ? el('button', { class: 'st-danger', onclick: () => { delete this.spec.loop; this.changed('live', true); } }, 'Delete loop') : null),
    ];
    if (loop && !this.rec) {
      const names = [...new Set(loop.tracks.map((t) => this.pathLabel(t.path)))];
      kids.push(
        this.check('Play the loop', loop, 'enabled', 'live', true),
        el('div', { class: 'hint st-note' }, `${loop.duration.toFixed(1)} s · ${loop.tracks.length} settings: ${names.slice(0, 6).join(', ')}${names.length > 6 ? '…' : ''}.` +
          (loop.enabled ? ' While it plays, the loop drives those settings.' : '')));
    }
    return this.details('loop', el('span', {}, 'Loop recorder', loop ? el('span', { class: 'hint' }, ` · ${loop.duration.toFixed(1)} s${loop.enabled ? ', playing' : ', paused'}`) : null), false, ...kids);
  }

  /** A short human name for a recorded setting. */
  private pathLabel(path: string) {
    if (path === '@morph') return 'morphing';
    const m = /^layer:([^.]+)\./.exec(path);
    if (m) return this.spec.layers.find((L) => L.id === m[1])?.name ?? 'a layer';
    return path.split('.')[0];
  }

  // ---------- Field builders ----------

  private details(key: string, title: string | Node, openByDefault: boolean, ...kids: (Node | null | false)[]) {
    const d = el('details', { class: 'st-block', open: this.open_.get(key) ?? openByDefault }, el('summary', {}, title), ...kids);
    d.ontoggle = () => this.open_.set(key, d.open);
    return d;
  }

  private slider<T extends object>(label: string, obj: T, key: keyof T, min: number, max: number, step: number, kind: Change = 'live', title = '', after?: () => void) {
    // The camera's angle around the scene keeps counting past ±180° (so loops don't spin back): show it wrapped.
    const shown = () => {
      const v = Number(obj[key]);
      return +((obj as unknown) === this.spec.camera && key === 'azimuth' ? wrap180(v) : v).toFixed(3);
    };
    const range = el('input', { type: 'range', min, max, step, value: shown() });
    const box = el('input', { type: 'number', min, max, step, value: shown(), class: 'st-num' });
    this.refreshers.push(() => {
      const v = String(shown());
      if (range.value !== v) range.value = v;
      if (document.activeElement !== box && box.value !== v) box.value = v;
    });
    const set = (v: number, from: HTMLInputElement, done: boolean) => {
      if (!isFinite(v)) return;
      v = Math.min(max, Math.max(min, v));
      (obj[key] as unknown as number) = v;
      if (from !== range) range.value = String(v);
      if (from !== box) box.value = String(v);
      after?.();
      // Rebuilding on every pixel of a drag would restart the scene: wait for the release.
      if (kind === 'build' && !done) return;
      this.changed(kind, kind === 'build');
    };
    range.oninput = () => set(+range.value, range, false);
    range.onchange = () => set(+range.value, range, true);
    box.onchange = () => set(+box.value, box, true);
    return el('label', { class: 'st-field', title }, el('span', {}, label), range, box);
  }

  private color<T extends object>(label: string, obj: T, key: keyof T, kind: Change = 'paint') {
    const input = el('input', { type: 'color', value: String(obj[key]) });
    input.oninput = () => { (obj[key] as unknown as string) = input.value; this.changed(kind); };
    return el('label', { class: 'st-field' }, el('span', {}, label), input);
  }

  private select<T extends object>(label: string, obj: T, key: keyof T, options: [string, string][], kind: Change, rerender = true) {
    const s = el('select', {}, ...options.map(([v, text]) => el('option', { value: v }, text)));
    s.value = String(obj[key]);
    s.onchange = () => { (obj[key] as unknown as string) = s.value; this.changed(kind, rerender); };
    return el('label', { class: 'st-field' }, el('span', {}, label), s);
  }

  private check<T extends object>(label: string, obj: T, key: keyof T, kind: Change, rerender = false) {
    const c = el('input', { type: 'checkbox', checked: !!obj[key] });
    c.onchange = () => { (obj[key] as unknown as boolean) = c.checked; this.changed(kind, rerender); };
    return el('label', { class: 'check' }, c, label);
  }

  private text<T extends object>(label: string, obj: T, key: keyof T, onDone?: () => void) {
    const t = el('input', { type: 'text', value: String(obj[key]) });
    t.oninput = () => { (obj[key] as unknown as string) = t.value; this.refreshHead(); };
    t.onchange = () => onDone?.();
    return el('label', { class: 'st-field' }, el('span', {}, label), t);
  }

  private vec3(label: string, v: [number, number, number], step: number, title = '') {
    const boxes = [0, 1, 2].map((i) => {
      const b = el('input', { type: 'number', step, value: v[i], class: 'st-num', title: 'xyz'[i] });
      b.oninput = () => { if (isFinite(+b.value)) { v[i] = +b.value; this.changed('live'); } };
      this.refreshers.push(() => { const s = String(+v[i].toFixed(2)); if (document.activeElement !== b && b.value !== s) b.value = s; });
      return b;
    });
    return el('label', { class: 'st-field st-vec', title }, el('span', {}, label), ...boxes);
  }

  /** Picks an audio feature or a frequency range. `get` returns undefined for "nothing". */
  private sourcePicker(get: () => StudioSource | undefined, set: (s: StudioSource | undefined) => void, allowNone: boolean) {
    const cur = get();
    const s = el('select', {},
      allowNone && el('option', { value: '' }, 'Nothing'),
      el('option', { value: 'band' }, 'Frequency range…'),
      ...AUDIO_SOURCES.map((n) => el('option', { value: n }, FEATURE_LABELS[n] ?? n)));
    s.value = !cur ? '' : cur.kind === 'band' ? 'band' : cur.name;
    s.onchange = () => {
      set(s.value === '' ? undefined : s.value === 'band' ? { kind: 'band', lo: 60, hi: 250 } : { kind: 'feature', name: s.value as AudioSource });
      this.changed('paint', true);
    };
    const meter = el('i', { class: 'st-meter' }, el('b'));
    this.meters.push({ el: meter.firstElementChild as HTMLElement, source: get });
    const row = el('div', { class: 'st-source' }, s, meter);
    if (cur?.kind === 'band') {
      const hz = (k: 'lo' | 'hi') => {
        const b = el('input', { type: 'number', min: 20, max: 20000, step: 10, value: cur[k], class: 'st-num' });
        b.onchange = () => {
          const v = Math.min(20000, Math.max(20, +b.value || cur[k]));
          cur[k] = v;
          if (cur.lo > cur.hi) [cur.lo, cur.hi] = [cur.hi, cur.lo];
          this.changed('live', true);
        };
        return b;
      };
      row.append(el('div', { class: 'st-hz' }, hz('lo'), '–', hz('hi'), el('span', { class: 'hint' }, 'Hz')));
    }
    return row;
  }

  private refreshMeters() {
    if (!this.isOpen) return;
    const audio = this.hooks.engine.audio.features;
    for (const m of this.meters) {
      const src = m.source();
      m.el.style.width = `${Math.round(Math.min(1, Math.max(0, src ? sourceValue(src, audio) : 0)) * 100)}%`;
    }
  }

  /** Shapes and library models, as options for "what this form is". */
  private formOptions() {
    return [
      el('optgroup', { label: 'Shapes' }, ...SHAPES.map((s) => el('option', { value: 'shape:' + s }, SHAPE_LABELS[s]))),
      el('optgroup', { label: '3D models' }, ...this.hooks.models().map((m) => el('option', { value: 'model:' + m.id }, m.id))),
    ];
  }
  private formFrom(value: string): StudioForm {
    const [kind, what] = value.split(/:(.*)/) as ['shape' | 'model', string];
    return newForm(kind, what);
  }

  // ---------- Rendering ----------

  private refreshHead() {
    const d = this.root.querySelector<HTMLElement>('.st-dirty');
    if (d) d.textContent = this.dirty ? (this.savedId ? 'Unsaved changes' : 'Not saved yet') : `Saved (${HOSTED ? 'this browser' : `scenes/${this.savedId}.ts`})`;
    const t = this.root.querySelector<HTMLElement>('.st-title');
    if (t) t.textContent = this.spec.name;
  }

  private render() {
    if (!this.isOpen) return;
    const scroll = this.root.parentElement?.scrollTop ?? 0;
    this.meters = [];
    this.refreshers = [];
    const s = this.spec;
    const back = el('button', { onclick: () => this.close(), title: 'Leave the studio' }, '← Back');
    const save = el('button', { class: 'accent', onclick: () => this.save() }, 'Save scene');
    const move = el('button', {
      class: 'st-move' + (this.moveMode ? ' active' : ''), onclick: () => this.setMove(!this.moveMode),
      title: 'Move layers with the mouse (M). While it is on, dragging the view moves a layer instead of the camera.',
    }, '✥ Move');
    const cam = (label: string, key: 'distance' | 'azimuth' | 'elevation' | 'fov' | 'autoRotate' | 'autoTilt', min: number, max: number, step: number, title = '') =>
      this.slider(label, s.camera, key, min, max, step, 'live', title, () => this.applyCamera());
    this.root.replaceChildren(
      el('div', { class: 'st-head' }, back, el('span', { class: 'st-title' }), move, save),
      el('div', { class: 'hint st-dirty' }),
      this.details('scene', 'Scene', true,
        this.text('Name', s, 'name'),
        this.text('Notes', s, 'description'),
        this.slider('Particles', s, 'particleCount', 5000, 150000, 5000, 'build', 'More particles look denser but cost speed. 60,000 is a good start.'),
        HOSTED && this.savedId ? el('button', { class: 'st-danger', onclick: () => this.remove() }, 'Delete from this browser') : null,
      ),
      this.loopBlock(),
      this.details('space', 'Space and camera', false,
        this.color('Space colour', s.space, 'color', 'live'),
        this.slider('Glow', s.space, 'glow', 0, 3, 0.05, 'live', 'Bloom around bright particles'),
        el('div', { class: 'hint st-note' }, 'Camera: drag the view to turn it, scroll to zoom, right-drag to slide. These settings follow what you see.'),
        cam('Distance', 'distance', 5, 150, 0.5),
        cam('Angle around', 'azimuth', -180, 180, 1, 'Where the camera stands around the scene: 0 is in front, 90 is from the right'),
        cam('Angle up/down', 'elevation', -89, 89, 1, 'Above (+) or below (−) the horizon'),
        cam('Field of view', 'fov', 20, 110, 1),
        cam('Auto-rotate', 'autoRotate', -4, 4, 0.05, 'Slowly circles the scene. 0 is off.'),
        cam('Auto up/down', 'autoTilt', -4, 4, 0.05, 'Slowly swings the camera up and down. 0 is off.'),
        el('button', { onclick: () => { s.camera.target = [0, 0, 0]; this.applyCamera(); this.changed('live'); } }, 'Look at the centre'),
      ),
      this.details('light', 'Lighting', false,
        this.check('Light the particles by their surface direction', s.light, 'enabled', 'live'),
        this.color('Key light', s.light, 'color', 'live'),
        this.slider('Intensity', s.light, 'intensity', 0, 4, 0.05),
        this.slider('Direction', s.light, 'azimuth', -180, 180, 1, 'live', 'Where the key light comes from, around the scene'),
        this.slider('Height', s.light, 'elevation', -90, 90, 1),
        this.slider('Ambient', s.light, 'ambient', 0, 1.5, 0.01, 'live', 'Light that reaches every particle'),
        this.color('Fill light', s.light, 'fill', 'live'),
        this.slider('Fill intensity', s.light, 'fillIntensity', 0, 3, 0.05, 'live', 'Light from the opposite side'),
      ),
      this.details('motion', 'Motion and morphing', false,
        this.slider('Tightness', s.motion, 'spring', 0.5, 30, 0.5, 'live', 'How firmly particles hold their place'),
        this.slider('Damping', s.motion, 'damping', 0.2, 12, 0.1),
        this.slider('Turbulence', s.motion, 'turbulence', 0, 8, 0.05),
        this.slider('Beat burst', s.motion, 'burst', 0, 20, 0.5, 'live', 'Outward kick on each beat'),
        this.slider('Brightness', s, 'brightness', 0, 3, 0.05),
        this.slider('Colour shift', s, 'hueShift', -0.5, 0.5, 0.01, 'live', 'Rotates every colour around the colour wheel'),
        el('div', { class: 'hint st-note' }, 'Morphing applies to layers with more than one form.'),
        this.select('Morph', s.morph, 'mode', [['beats', 'Every few beats'], ['time', 'Every few seconds'], ['manual', 'By the slider / mappings']], 'live'),
        s.morph.mode === 'manual'
          ? this.slider('Position', s.morph, 'position', 0, 1, 0.01)
          : this.slider(s.morph.mode === 'beats' ? 'Beats per form' : 'Seconds per form', s.morph, 'every', 1, 64, 1),
        this.slider('Transition (s)', s.morph, 'blend', 0.2, 12, 0.1),
      ),
      el('h3', {}, 'Layers ', el('span', { class: 'hint' }, 'shapes and models, side by side')),
      ...s.layers.map((L, i) => this.layerBlock(L, i)),
      this.addLayerRow(),
      el('h3', {}, 'Mappings ', el('span', { class: 'hint' }, 'sound → settings')),
      ...s.mappings.map((m, i) => this.mappingBlock(m, i)),
      el('button', { onclick: () => {
        s.mappings.push({ source: { kind: 'band', lo: 60, hi: 250 }, target: 'brightness', amount: 0.5, curve: 'linear', attack: 0, release: 0.2, enabled: true });
        this.changed('live', true);
      } }, '+ Mapping'),
      el('div', { class: 'hint st-note' }, 'The macro sliders and logics still apply on top: intensity scales reactions, chaos scales turbulence, morph and impulse add to morphing and the beat burst.'),
    );
    this.refreshHead();
    this.renderLog();
    if (this.root.parentElement) this.root.parentElement.scrollTop = scroll;
  }

  private addLayerRow() {
    const pick = el('select', {}, el('option', { value: '' }, '+ Add layer…'), ...this.formOptions());
    pick.onchange = () => {
      if (!pick.value) return;
      const form = this.formFrom(pick.value);
      const layer = newLayer(form.kind === 'model' ? form.model : SHAPE_LABELS[form.shape], form);
      this.spec.layers.push(layer);
      this.open_.set('layer:' + layer.id, true);
      this.changed('build', true);
    };
    const kids: Node[] = [pick];
    if (!HOSTED) {
      const prompt = el('textarea', { rows: 2, placeholder: 'Or describe a 3D object for Claude to build in Blender, e.g. "an old oak tree with a swing"' });
      const go = el('button', { disabled: this.generating, onclick: () => this.generate(prompt.value) }, this.generating ? 'Claude is modelling…' : 'Build with Claude + Blender');
      kids.push(prompt, go, el('div', { class: 'log st-log' }));
      kids.push(el('div', { class: 'hint st-note' }, 'You can also drop a .glb file exported from Blender anywhere on the window.'));
    }
    return el('div', { class: 'st-add' }, ...kids);
  }

  private renderLog() {
    const box = this.root.querySelector('.st-log');
    if (!box) return;
    box.replaceChildren(...this.log.slice(0, 12).map((p) =>
      el('div', { class: 'progress' }, p.text, p.image ? el('img', { src: p.image, alt: p.text }) : null)));
  }

  private layerBlock(L: StudioLayer, index: number) {
    const s = this.spec;
    const total = s.layers.filter((x) => x.visible).reduce((a, x) => a + x.share, 0) || 1;
    const pct = L.visible ? `${Math.round((L.share / total) * 100)}%` : 'hidden';
    const move = (by: number) => {
      const j = index + by;
      if (j < 0 || j >= s.layers.length) return;
      [s.layers[index], s.layers[j]] = [s.layers[j], s.layers[index]];
      this.changed('build', true);
    };
    const sp = L.spectrum;
    return this.details('layer:' + L.id, el('span', { class: L.id === this.selected ? 'st-selected' : '' }, L.name, el('span', { class: 'hint' }, ` · ${pct} of particles`)), index === 0,
      this.text('Name', L, 'name', () => this.render()),
      this.check('Visible', L, 'visible', 'build', true),
      this.slider('Share', L, 'share', 1, 100, 1, 'build', 'This layer\'s share of the particles, relative to the other layers'),
      ...L.forms.map((F, fi) => this.formBlock(L, F, fi)),
      (() => {
        const add = el('select', { title: 'Particles flow from one form to the next' }, el('option', { value: '' }, '+ Add a form to morph into…'), ...this.formOptions());
        add.onchange = () => {
          if (!add.value) return;
          L.forms.push(this.formFrom(add.value));
          this.open_.set(`form:${L.id}:${L.forms.length - 1}`, true);
          this.changed('build', true);
        };
        return add;
      })(),
      this.details('look:' + L.id, 'Look and movement', false,
        this.slider('Scale ×', L, 'scale', 0.1, 4, 0.01),
        this.slider('Lift', L, 'lift', -30, 30, 0.5),
        this.slider('Spin (°/s)', L, 'spin', -180, 180, 1),
        this.slider('Particle size', L, 'size', 0.1, 4, 0.05),
        this.slider('Brightness', L, 'brightness', 0, 4, 0.05),
        this.slider('Explode', L, 'explode', -10, 20, 0.1, 'live', 'Pushes particles outward along the surface'),
      ),
      this.details('spec:' + L.id, el('span', {}, 'Spectrum across the shape', el('span', { class: 'hint' }, ` · ${AXIS_LABELS[sp.axis]}`)), false,
        el('div', { class: 'hint st-note' }, 'Lays the spectrum over the layer: low frequencies at one end, high at the other, so each region reacts to its own part of the sound.'),
        this.select('Spread', sp, 'axis', ['none', ...AXES, 'part'].map((a) => [a, AXIS_LABELS[a]] as [string, string]), 'paint'),
        sp.axis !== 'none' && this.slider('From (Hz)', sp, 'lo', 20, 16000, 10),
        sp.axis !== 'none' && this.slider('To (Hz)', sp, 'hi', 20, 16000, 10),
        sp.axis !== 'none' && this.slider('Push out', sp, 'push', -10, 20, 0.1),
        sp.axis !== 'none' && this.slider('Glow', sp, 'glow', 0, 6, 0.05),
        sp.axis !== 'none' && this.slider('Grow', sp, 'size', 0, 4, 0.05, 'live', 'Particles get bigger where their frequency is loud'),
        sp.axis !== 'none' && this.color('Tint', sp, 'tint', 'live'),
        sp.axis !== 'none' && this.slider('Tint amount', sp, 'tintAmount', 0, 1, 0.01),
      ),
      el('div', { class: 'row' },
        el('button', { onclick: () => move(-1), disabled: index === 0, title: 'Move up' }, '↑'),
        el('button', { onclick: () => move(1), disabled: index === s.layers.length - 1, title: 'Move down' }, '↓'),
        el('button', { class: 'st-danger', onclick: () => {
          s.layers.splice(index, 1);
          s.mappings = s.mappings.filter((m) => !m.target.startsWith(`layer:${L.id}.`));
          this.changed('build', true);
        } }, 'Delete layer'),
      ),
    );
  }

  private formBlock(L: StudioLayer, F: StudioForm, fi: number) {
    const what = el('select', {}, ...this.formOptions());
    what.value = F.kind === 'model' ? 'model:' + F.model : 'shape:' + F.shape;
    if (what.value === '') what.prepend(el('option', { value: '', selected: true }, `Missing model "${F.model}"`));
    what.onchange = () => {
      const [kind, id] = what.value.split(/:(.*)/) as ['shape' | 'model', string];
      const wasModel = F.kind === 'model';
      F.kind = kind;
      if (kind === 'model') { F.model = id; if (!wasModel) { F.color.mode = 'model'; F.scale = 13; } }
      else { F.shape = id as StudioForm['shape']; F.model = ''; if (F.color.mode === 'model') F.color.mode = 'gradient'; }
      F.parts = {};
      this.changed('build', true);
    };
    const name = F.kind === 'model' ? F.model : SHAPE_LABELS[F.shape];
    const partNames = F.kind === 'model'
      ? this.hooks.engine.field?.ctx.models[F.model]?.partNames ?? this.hooks.models().find((m) => m.id === F.model)?.parts ?? []
      : [];
    const modes: [string, string][] = [['solid', 'One colour'], ['gradient', 'Gradient']];
    if (F.kind === 'model') modes.unshift(['model', 'The model\'s own colours']);
    return this.details(`form:${L.id}:${fi}`, el('span', {}, L.forms.length > 1 ? `Form ${fi + 1}: ` : 'Form: ', name), fi === 0,
      el('label', { class: 'st-field' }, el('span', {}, 'What'), what),
      this.slider('Size', F, 'scale', 0.5, 40, 0.1, 'live', 'Half-size in world units. The view is about ±30.'),
      this.vec3('Position', F.position, 0.5, 'x (right), y (up), z (towards you)'),
      this.vec3('Rotation °', F.rotation, 5, 'Degrees around x, y, z'),
      this.select('Colour', F.color, 'mode', modes, 'paint'),
      F.color.mode !== 'model' && this.color(F.color.mode === 'gradient' ? 'From' : 'Colour', F.color, 'a'),
      F.color.mode === 'gradient' && this.color('To', F.color, 'b'),
      F.color.mode === 'gradient' && this.select('Along', F.color, 'axis', AXES.map((a) => [a, AXIS_LABELS[a]] as [string, string]), 'paint', false),
      partNames.length > 0 && this.details(`parts:${L.id}:${fi}`, `Parts (${partNames.length})`, false,
        el('div', { class: 'hint st-note' }, 'Give a part its own colour, or make it react to a sound of its own.'),
        ...partNames.map((p) => this.partBlock(F, p))),
      L.forms.length > 1 && el('div', { class: 'row' },
        el('button', { disabled: fi === 0, title: 'Earlier in the morph order', onclick: () => { [L.forms[fi - 1], L.forms[fi]] = [L.forms[fi], L.forms[fi - 1]]; this.changed('build', true); } }, '↑'),
        el('button', { class: 'st-danger', onclick: () => { L.forms.splice(fi, 1); this.changed('build', true); } }, 'Remove form')),
    );
  }

  private partBlock(F: StudioForm, name: string) {
    const cfg = (): StudioPart => (F.parts[name] ??= {});
    const cur = F.parts[name] ?? {};
    const own = el('input', { type: 'checkbox', checked: !!cur.color, title: 'Use its own colour' });
    const pick = el('input', { type: 'color', value: cur.color ?? '#ffcc66', disabled: !cur.color });
    own.onchange = () => { if (own.checked) cfg().color = pick.value; else delete cfg().color; this.changed('paint', true); };
    pick.oninput = () => { cfg().color = pick.value; this.changed('paint'); };
    const amount = (label: string, key: 'lift' | 'push' | 'glow', min: number, max: number, step: number) => {
      const holder = { v: cur[key] ?? 0 };
      const row = this.slider(label, holder, 'v', min, max, step, 'paint');
      row.addEventListener('input', () => { if (holder.v) cfg()[key] = holder.v; else delete cfg()[key]; });
      row.addEventListener('change', () => { if (holder.v) cfg()[key] = holder.v; else delete cfg()[key]; });
      return row;
    };
    return el('div', { class: 'st-part' },
      el('div', { class: 'st-part-head' }, el('b', {}, name), own, pick),
      el('label', { class: 'st-field' }, el('span', {}, 'Reacts to'),
        this.sourcePicker(() => F.parts[name]?.source, (src) => { if (src) cfg().source = src; else delete cfg().source; }, true)),
      cur.source ? amount('Lift', 'lift', -15, 15, 0.1) : null,
      cur.source ? amount('Push out', 'push', -10, 15, 0.1) : null,
      cur.source ? amount('Glow', 'glow', 0, 6, 0.05) : null,
    );
  }

  private mappingBlock(m: StudioMapping, i: number) {
    const targets = studioTargets(this.spec);
    const groups = [...new Set(targets.map((t) => t.group))];
    const target = el('select', {}, ...groups.map((g) =>
      el('optgroup', { label: g }, ...targets.filter((t) => t.group === g).map((t) => el('option', { value: t.key }, t.label)))));
    target.value = m.target;
    target.onchange = () => {
      m.target = target.value;
      const t = targets.find((x) => x.key === m.target)!;
      m.amount = Math.min(t.max, Math.max(t.min, m.amount));
      this.changed('live', true);
    };
    const t = targets.find((x) => x.key === m.target) ?? { min: -3, max: 3 };
    const step = (t.max - t.min) / 200;
    return el('div', { class: 'st-map' + (m.enabled ? '' : ' off') },
      this.sourcePicker(() => m.source, (src) => { if (src) m.source = src; }, false),
      el('label', { class: 'st-field' }, el('span', {}, 'drives'), target),
      this.slider('Amount', m, 'amount', t.min, t.max, +step.toPrecision(1), 'live', 'How much is added at full signal. Negative reverses it.'),
      el('div', { class: 'st-map-row' },
        (() => {
          const c = el('select', { title: 'Response curve' }, ...CURVES.map((x) => el('option', { value: x }, x)));
          c.value = m.curve;
          c.onchange = () => { m.curve = c.value as StudioMapping['curve']; this.changed('live'); };
          return c;
        })(),
        ...(['attack', 'release'] as const).map((k) => {
          const b = el('input', { type: 'number', min: 0, max: 5, step: 0.05, value: m[k], class: 'st-num', title: `${k === 'attack' ? 'Rise' : 'Fall'} time in seconds` });
          b.onchange = () => { m[k] = Math.min(5, Math.max(0, +b.value || 0)); this.changed('live'); };
          return el('label', { class: 'hint' }, k === 'attack' ? 'rise ' : 'fall ', b);
        }),
        (() => {
          const on = el('input', { type: 'checkbox', checked: m.enabled, title: 'On / off' });
          on.onchange = () => { m.enabled = on.checked; this.changed('live', true); };
          return on;
        })(),
        el('button', { title: 'Remove mapping', onclick: () => { this.spec.mappings.splice(i, 1); this.changed('live', true); } }, '✕'),
      ),
    );
  }
}
