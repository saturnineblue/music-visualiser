import * as THREE from 'three';
import type { Engine } from '../engine/engine';
import { AUDIO_SOURCES, CURVES, type AudioSource, type SceneDefinition } from '../engine/types';
import { api, HOSTED, type ModelItem } from '../ui/api';
import { ask, askText } from '../ui/dialog';
import { createStudioScene, settleLoop, sourceValue, type LayerData, type StudioState } from './runtime';
import {
  AXES, SHAPES, cameraPosition, canonicalSpec, liveValues, setLive, newForm, newId, newLayer, newSpec, normalizeSpec, slug, specModels, studioTargets,
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
  /** Open or close the projector window, and whether it is open. */
  toggleOutput(): void;
  outputOpen(): boolean;
}

/** A loop being recorded: per setting, its keys so far. */
interface Recording {
  /** The loop that was playing before, to go back to if nothing gets recorded. */
  before: number;
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

const svg = (d: string) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  // Look around: an orbit around a centre.
  navigate: svg('<circle cx="12" cy="12" r="2.2"/><path d="M20.5 12a8.5 3.6 0 1 1-4.2-3.1"/><path d="M16.6 5.6l-.3 3.3 3.3.3"/>'),
  // Move: arrows in four directions.
  move: svg('<path d="M12 3v18M3 12h18"/><path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>'),
  // Projector: a screen on a stand.
  output: svg('<rect x="3" y="4.5" width="18" height="11.5" rx="1.5"/><path d="M12 16v3.5M8 19.5h8"/>'),
  // Duplicate: one sheet over another.
  duplicate: svg('<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 5.5v-.5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h.5"/>'),
  record: '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="6.5" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 24 24" width="18" height="18"><rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/></svg>',
  eye: svg('<path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>'),
  eyeOff: svg('<path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" opacity="0.45"/><path d="M4 4l16 16"/>'),
};
const POP_WIDTH = 330;

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
  /** What dragging in the view does: turn the camera, or move objects. */
  tool: 'navigate' | 'move' = 'navigate';
  /** The object whose settings pop-up is open. */
  private selected: string | null = null;
  private drag: { id: string; x: number; y: number } | null = null;
  private press: { x: number; y: number } | null = null;
  // Things drawn over the view: object handles, the tool buttons, and the selected object's settings.
  private overlay = el('div', { class: 'st-overlay', hidden: true });
  private handles = new Map<string, HTMLElement>();
  private tools = el('div', { class: 'st-tools', hidden: true });
  private pop = el('div', { class: 'st-pop', hidden: true });
  private popPos = { x: 16, y: 90 };
  private settleUntil = 0;

  constructor(private root: HTMLElement, private hooks: StudioHooks) {
    setInterval(() => {
      if (!this.isOpen) return;
      this.refreshMeters();
      if (this.spec.activeLoop >= 0 || this.drag) this.refreshValues();
      this.refreshRecorder();
    }, 70);
    document.body.append(this.overlay, this.tools, this.pop);
    const r = hooks.engine.renderer;
    // The view has priority: when the user moves the camera, the camera settings follow.
    r.controls.addEventListener('change', () => {
      if (this.isOpen && (r.interacting || performance.now() < this.settleUntil)) this.syncCameraFromView();
    });
    r.controls.addEventListener('end', () => { if (this.isOpen) { this.settleUntil = performance.now() + 1200; this.syncCameraFromView(); } });
    const canvas = r.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointercancel', () => { this.drag = null; this.press = null; });
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
    this.tool = 'navigate';
    this.overlay.hidden = false;
    this.tools.hidden = false;
    this.render();
    await this.rebuild(false);
    this.hooks.tip('st-welcome');
  }

  private async close() {
    if (this.dirty && !(await ask(`"${this.spec.name}" has unsaved changes.\n\nLeave the studio without saving them?`, { ok: 'Discard changes', danger: true }))) return;
    if (this.rec) this.stopRecording(false);
    this.setTool('navigate');
    this.isOpen = false;
    this.selected = null;
    this.root.hidden = true;
    this.root.parentElement?.classList.remove('studio-open');
    this.root.replaceChildren();
    this.overlay.hidden = true;
    this.tools.hidden = true;
    this.pop.hidden = true;
    this.pop.replaceChildren();
    this.meters = [];
    this.hooks.closed(this.savedId);
  }

  /** The projector window opened or closed: show it on the studio's small button. */
  outputChanged() {
    const b = this.root.querySelector<HTMLElement>('.st-out');
    if (!b) return;
    const open = this.hooks.outputOpen();
    b.classList.toggle('active', open);
    b.title = open
      ? 'Close the projector window'
      : 'Open the projector window: only the visuals, for a projector or second screen. What you edit here shows there live.';
  }

  /** The model list changed (a .glb was added, or Claude built one). */
  libraryChanged() { if (this.isOpen) this.render(); }

  // ---------- Applying changes ----------

  /** Re-run the scene on the stage: needed when models, layers, loops or the particle count change. */
  private rebuild(keepView = true) {
    this.applying = this.applying.then(async () => {
      if (!this.isOpen) return;
      const engine = this.hooks.engine;
      if (engine.scene?.studio === this.spec && engine.field) {
        // A playing loop holds some settings mid-way: put them back first, so the restart begins from the real values.
        settleLoop(engine.field.ctx, this.spec);
        // Restarting resets the camera to the spec: take the current view first, so nothing jumps.
        if (keepView) this.syncCameraFromView();
      }
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
    if (!spec.layers.length) return this.hooks.toast('Add at least one object before saving.');
    if (this.savedId === null) spec.id = slug(spec.name);
    // Save what is on screen: the camera may have drifted (auto-rotation) since it was last copied.
    if (this.hooks.engine.scene?.studio === spec && !this.loopDrivesCamera()) this.syncCameraFromView();
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
      this.savedJson = this.snapshot(); // restarting nudges the camera angle while it auto-rotates; that isn't an edit
      this.refreshHead();
      this.hooks.tip('st-saved');
      this.hooks.toast(`Saved "${spec.name}" to ${res.where}.` + (!HOSTED
        ? '\n\nIt is now in the scene list, and can be added to sets like any scene.'
        : res.where === 'this browser'
          ? '\n\nIt is kept in this browser only. To move it elsewhere or keep it safe, add it to a set and use "Save set…".'
          : '\n\nIt is stored on the site, so it is there on any device you sign in from.'));
    } catch (e) {
      this.hooks.toast(`Could not save: ${(e as Error).message}`);
    }
  }

  private async remove() {
    if (!this.savedId) return;
    if (!(await ask(`Delete "${this.spec.name}" from ${api.studioWhere(this.savedId)}? This can't be undone.`, { ok: 'Delete', danger: true }))) return;
    await api.deleteStudio(this.savedId);
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
      this.selected = layer.id;
      this.popPos = { x: 16, y: 90 };
      this.log.unshift({ text: `✓ Added "${res.name}" as an object (models/${res.id}.glb).` });
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
    return !!this.spec.loops[this.spec.activeLoop]?.tracks.some((t) => t.path.startsWith('camera.'));
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

  // ---------- Tools in the view: look around, move objects, select ----------

  setTool(tool: 'navigate' | 'move') {
    if (tool === this.tool) return;
    this.tool = tool;
    const r = this.hooks.engine.renderer;
    r.controls.enabled = tool === 'navigate';
    r.renderer.domElement.style.cursor = tool === 'move' ? 'move' : '';
    this.drag = null;
    if (this.isOpen) this.renderTools();
    if (tool === 'move') this.hooks.tip('st-move-on');
  }

  /** Esc: close the open settings pop-up, or go back to looking around. */
  escape() {
    if (this.selected) this.selectObject(null);
    else this.setTool('navigate');
  }

  private panelWidth() {
    const p = this.root.parentElement;
    return p && !p.classList.contains('hidden') ? p.offsetWidth : 0;
  }

  /** Open an object's settings pop-up next to it (null closes it). */
  private selectObject(id: string | null) {
    this.selected = id;
    if (id) {
      const ld = this.runtimeLayers().find((l) => l.id === id);
      const stageW = window.innerWidth - this.panelWidth();
      let x = 16, y = 90;
      if (ld) {
        const p = this.project(ld), r = Math.min(p.radius, 170);
        x = p.x + r + 28;
        if (x + POP_WIDTH > stageW - 12) x = p.x - r - 28 - POP_WIDTH; // no room on the right: go left of it
        if (x < 12) x = Math.max(12, stageW - POP_WIDTH - 12);
        y = p.y - 170;
      }
      this.popPos = { x, y: Math.min(Math.max(64, y), Math.max(64, window.innerHeight - 440)) };
      this.hooks.tip('st-popup');
    }
    this.render();
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
    if (!this.isOpen || e.button !== 0) return;
    this.press = { x: e.clientX, y: e.clientY };
    if (this.tool !== 'move') return;
    const id = this.pick(e.clientX, e.clientY);
    if (id) {
      this.drag = { id, x: e.clientX, y: e.clientY };
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      if (id !== this.selected) this.selectObject(id);
    }
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

  private onPointerUp(e: PointerEvent) {
    const press = this.press, dragged = this.drag;
    this.press = null;
    this.drag = null;
    if (dragged) this.refreshValues();
    if (!this.isOpen || !press || Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5) return; // that was a drag
    // A plain click: open the settings of the object under it, or close them on empty space.
    const id = this.pick(e.clientX, e.clientY);
    if (id !== this.selected) this.selectObject(id);
  }

  private onWheel(e: WheelEvent) {
    if (!this.isOpen || this.tool !== 'move') return;
    e.preventDefault();
    const L = this.spec.layers.find((x) => x.id === this.selected);
    if (!L) return;
    L.scale = +Math.min(4, Math.max(0.1, L.scale * Math.exp(-e.deltaY * 0.0015))).toFixed(3);
    this.refreshValues();
    this.refreshHead();
  }

  /** Each frame: keep the object handles on their objects (and off the panel). */
  private updateOverlay() {
    const panelW = this.panelWidth();
    const right = `${panelW}px`;
    if (this.overlay.style.right !== right) this.overlay.style.right = right; // keep handles off the panel
    const seen = new Set<string>();
    for (const ld of this.runtimeLayers()) {
      const L = this.spec.layers.find((x) => x.id === ld.id);
      const sel = ld.id === this.selected;
      // Move shows a handle on every object; otherwise only the selected one is ringed.
      if (!L || (this.tool !== 'move' && !sel)) continue;
      seen.add(ld.id);
      let h = this.handles.get(ld.id);
      if (!h) { h = el('div', { class: 'st-handle' }, el('i'), el('span')); this.handles.set(ld.id, h); this.overlay.append(h); }
      const p = this.project(ld);
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

  private renderTools() {
    const tool = (name: 'navigate' | 'move', label: string, title: string) =>
      el('button', { class: 'st-tool' + (this.tool === name ? ' active' : ''), title, onclick: () => this.setTool(name) },
        el('span', { class: 'st-icon', innerHTML: ICONS[name] }), label);
    const rec = el('button', {
      class: 'st-tool st-rec' + (this.rec ? ' recording' : ''),
      title: this.rec ? 'Stop recording and keep the loop' : 'Record a loop: press, then change things (sliders, colours, objects, the camera), and press again',
      onclick: () => (this.rec ? this.stopRecording(true) : this.startRecording()),
    }, el('span', { class: 'st-icon', innerHTML: this.rec ? ICONS.stop : ICONS.record }), el('span', { class: 'st-rec-time' }, this.rec ? '0:00' : 'Record'));
    // Actions on the selected object appear only while one is selected.
    const picked = this.spec.layers.find((x) => x.id === this.selected);
    const dup = picked && el('button', {
      class: 'st-tool', title: `Duplicate “${picked.name}”: a copy with the same settings, placed beside it (D)`, onclick: () => this.duplicateSelected(),
    }, el('span', { class: 'st-icon', innerHTML: ICONS.duplicate }), 'Duplicate');
    this.tools.replaceChildren(
      tool('navigate', 'Look', 'Look around: drag to turn the camera, scroll to zoom, right-drag to slide (N)'),
      tool('move', 'Move', 'Move objects: drag one to slide it, scroll to resize it, Shift-drag for depth (M)'),
      ...(dup ? [el('i', { class: 'st-tool-sep' }), dup] : []),
      el('i', { class: 'st-tool-sep' }),
      rec,
    );
  }

  /** Copy the selected object (its forms, look, spectrum and sound mappings) and select the copy. */
  duplicateSelected() {
    const s = this.spec, i = s.layers.findIndex((x) => x.id === this.selected);
    if (i < 0 || this.rec) return;
    const src = s.layers[i];
    const copy: StudioLayer = structuredClone(src);
    copy.id = newId();
    const names = new Set(s.layers.map((l) => l.name));
    let name = `${src.name} copy`, n = 2;
    while (names.has(name)) name = `${src.name} copy ${n++}`;
    copy.name = name;
    // Put it beside the original (to the camera's right), so the two don't sit on top of each other.
    const right = new THREE.Vector3().setFromMatrixColumn(this.hooks.engine.renderer.camera.matrixWorld, 0);
    const step = Math.max(2, (src.forms[0]?.scale ?? 8) * src.scale * 1.2);
    for (const F of copy.forms) {
      F.position = [+(F.position[0] + right.x * step).toFixed(2), +(F.position[1] + right.y * step).toFixed(2), +(F.position[2] + right.z * step).toFixed(2)];
    }
    s.layers.splice(i + 1, 0, copy);
    // Sound mappings that drive the original drive the copy too.
    for (const m of [...s.mappings]) {
      if (m.target.startsWith(`layer:${src.id}.`)) s.mappings.push({ ...structuredClone(m), target: m.target.replace(`layer:${src.id}.`, `layer:${copy.id}.`) });
    }
    this.selected = copy.id;
    this.popPos = { x: this.popPos.x + 24, y: this.popPos.y + 24 };
    this.changed('build', true);
  }

  /** The selected object's settings, floating in the view next to it. */
  private renderPopup() {
    const L = this.spec.layers.find((x) => x.id === this.selected);
    if (!this.isOpen || !L) {
      this.pop.hidden = true;
      this.pop.replaceChildren();
      return;
    }
    const scroll = this.pop.querySelector('.st-pop-body')?.scrollTop ?? 0;
    const name = el('input', { type: 'text', value: L.name, class: 'st-pop-name', title: 'Rename this object' });
    name.oninput = () => { L.name = name.value; };
    name.onchange = () => this.render();
    const head = el('div', { class: 'st-pop-head', title: 'Drag to move this window' }, name,
      el('button', { title: 'Close (Esc)', onclick: () => this.selectObject(null) }, '✕'));
    head.onpointerdown = (e) => {
      if ((e.target as HTMLElement).closest('input, button')) return;
      const ox = e.clientX - this.popPos.x, oy = e.clientY - this.popPos.y;
      head.setPointerCapture(e.pointerId);
      head.onpointermove = (m) => {
        this.popPos = {
          x: Math.min(window.innerWidth - 80, Math.max(-POP_WIDTH + 80, m.clientX - ox)),
          y: Math.min(window.innerHeight - 40, Math.max(0, m.clientY - oy)),
        };
        this.placePopup();
      };
      head.onpointerup = () => { head.onpointermove = null; head.onpointerup = null; };
    };
    const body = el('div', { class: 'st-pop-body' }, ...this.layerBody(L, this.spec.layers.indexOf(L)));
    this.pop.replaceChildren(head, body);
    this.pop.hidden = false;
    this.placePopup();
    body.scrollTop = scroll;
  }

  private placePopup() {
    this.pop.style.left = `${this.popPos.x}px`;
    this.pop.style.top = `${this.popPos.y}px`;
  }

  // ---------- Loops ----------

  /** Choose which loop plays (-1 = none). The scene's "loop" param is what the engine reads. */
  private setActiveLoop(index: number, rerender = true) {
    this.spec.activeLoop = index;
    const base = this.hooks.engine.logic.baseParams;
    if ('loop' in base) base.loop = index + 1;
    this.changed('live', rerender);
  }

  private sampleValues(): Record<string, Leaf> {
    const vals = liveValues(this.spec);
    const st = this.hooks.engine.field?.ctx.state.studio as StudioState | undefined;
    if (st && st.maxForms > 1 && this.spec.morph.mode !== 'manual') vals['@morph'] = +st.morphS.toFixed(4);
    return vals;
  }

  private startRecording() {
    const before = this.spec.activeLoop;
    // A playing loop must not fight what is being recorded: stop it and put its settings back first.
    const engine = this.hooks.engine;
    if (engine.scene?.studio === this.spec && engine.field) settleLoop(engine.field.ctx, this.spec);
    this.setActiveLoop(-1, false);
    this.rec = { before, start: performance.now(), prevT: 0, last: this.sampleValues(), tracks: new Map() };
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
      const names = new Set(this.spec.loops.map((l) => l.name));
      let n = this.spec.loops.length + 1;
      while (names.has(`Loop ${n}`)) n++;
      // Put the settings back to where the recording started: the loop replays them from there.
      for (const tr of tracks) if (!tr.path.startsWith('@')) setLive(this.spec, tr.path, tr.v[0]);
      this.spec.loops.push({ name: `Loop ${n}`, duration, tracks });
      this.spec.activeLoop = this.spec.loops.length - 1;
      this.open_.set('loops', true);
      this.spec.rev = (this.spec.rev ?? 0) + 1;
      this.rebuild(); // the scene's "loop" control now has one more step
      this.hooks.tip('st-loop-made');
      return;
    }
    if (keep) {
      this.hooks.toast('Nothing changed while recording, so there is no new loop.\n\nPress Record, then move sliders, drag objects (Move) or turn the camera, and press it again.');
    }
    this.setActiveLoop(rec.before, false);
    if (this.isOpen) this.render();
  }

  private refreshRecorder() {
    const b = this.tools.querySelector<HTMLElement>('.st-rec-time');
    if (b && this.rec) b.textContent = fmtClock((performance.now() - this.rec.start) / 1000);
  }

  private async renameLoop(index: number) {
    const loop = this.spec.loops[index];
    const name = await askText('Loop name:', loop.name, { ok: 'Rename' });
    if (!name) return;
    loop.name = name.slice(0, 60);
    this.rebuild();
  }

  private deleteLoop(index: number) {
    const engine = this.hooks.engine;
    if (engine.scene?.studio === this.spec && engine.field) settleLoop(engine.field.ctx, this.spec);
    const active = this.spec.activeLoop;
    this.spec.loops.splice(index, 1);
    this.spec.activeLoop = active === index ? -1 : active > index ? active - 1 : active;
    this.rebuild();
  }

  /** The scene's loops: pick the one that plays, rename or delete them. Recording happens in the view. */
  private loopsBlock() {
    const s = this.spec;
    const row = (index: number, name: string, meta: string) => {
      const on = s.activeLoop === index;
      return el('div', { class: 'st-row st-loop' + (on ? ' active' : ''), onclick: () => this.setActiveLoop(index), title: on ? 'Playing' : 'Click to play this one' },
        el('span', { class: 'st-radio' + (on ? ' on' : '') }),
        el('span', { class: 'st-row-name' }, name), el('span', { class: 'hint' }, meta),
        index >= 0 ? el('button', { title: 'Rename', onclick: (e: Event) => { e.stopPropagation(); this.renameLoop(index); } }, '✎') : null,
        index >= 0 ? el('button', { title: 'Delete this loop', onclick: (e: Event) => { e.stopPropagation(); this.deleteLoop(index); } }, '✕') : null);
    };
    return this.details('loops', el('span', {}, 'Loops', el('span', { class: 'hint' }, s.loops.length ? ` · ${s.loops.length}, ${s.activeLoop >= 0 ? `playing “${s.loops[s.activeLoop].name}”` : 'none playing'}` : ' · none yet')), true,
      el('div', { class: 'hint st-note' }, s.loops.length
        ? 'One loop plays at a time. Each replays the changes you recorded: sliders, colours, moved objects, the camera, morphing.'
        : 'A loop replays changes you record: sliders, colours, moved objects, the camera, morphing. Press Record in the view, change things, and press it again.'),
      s.loops.length ? row(-1, 'No loop', 'the scene as set') : null,
      ...s.loops.map((l, i) => row(i, l.name, `${l.duration.toFixed(1)} s · ${[...new Set(l.tracks.map((t) => this.pathLabel(t.path)))].slice(0, 3).join(', ')}`)),
      s.loops.length ? el('div', { class: 'hint st-note' }, 'Outside the studio, the scene\'s “Loop” slider (Controls → Scene params) picks the loop, so a set can hold one entry per loop.') : null,
    );
  }

  /** A short human name for a recorded setting. */
  private pathLabel(path: string) {
    if (path === '@morph') return 'morphing';
    const m = /^layer:([^.]+)\./.exec(path);
    if (m) return this.spec.layers.find((L) => L.id === m[1])?.name ?? 'an object';
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
    if (d) d.textContent = this.dirty ? (this.savedId ? 'Unsaved changes' : 'Not saved yet') : `Saved (${api.studioWhere(this.savedId ?? '')})`;
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
    const cam = (label: string, key: 'distance' | 'azimuth' | 'elevation' | 'fov' | 'autoRotate' | 'autoTilt', min: number, max: number, step: number, title = '') =>
      this.slider(label, s.camera, key, min, max, step, 'live', title, () => this.applyCamera());
    const out = el('button', { class: 'st-out', onclick: () => this.hooks.toggleOutput(), innerHTML: ICONS.output });
    this.root.replaceChildren(
      el('div', { class: 'st-head' }, back, el('span', { class: 'st-title' }), out, save),
      el('div', { class: 'hint st-dirty' }),
      this.details('scene', 'Scene', true,
        this.text('Name', s, 'name'),
        this.text('Notes', s, 'description'),
        this.slider('Particles', s, 'particleCount', 5000, 150000, 5000, 'build', 'More particles look denser but cost speed. 60,000 is a good start.'),
        HOSTED && this.savedId ? el('button', { class: 'st-danger', onclick: () => this.remove() }, 'Delete this scene') : null,
      ),

      el('h3', {}, 'Objects ', el('span', { class: 'hint' }, 'click one, here or in the view, for its settings')),
      ...s.layers.map((L, i) => this.layerRow(L, i)),
      this.addLayerRow(),

      el('h3', {}, 'Dramaturgy ', el('span', { class: 'hint' }, 'what happens, and when')),
      this.loopsBlock(),
      this.details('motion', 'Motion and morphing', false,
        this.slider('Tightness', s.motion, 'spring', 0.5, 30, 0.5, 'live', 'How firmly particles hold their place'),
        this.slider('Damping', s.motion, 'damping', 0.2, 12, 0.1),
        this.slider('Turbulence', s.motion, 'turbulence', 0, 8, 0.05),
        this.slider('Beat burst', s.motion, 'burst', 0, 20, 0.5, 'live', 'Outward kick on each beat'),
        el('div', { class: 'hint st-note' }, 'Morphing applies to objects with more than one form.'),
        this.select('Morph', s.morph, 'mode', [['beats', 'Every few beats'], ['time', 'Every few seconds'], ['manual', 'By the slider / mappings']], 'live'),
        s.morph.mode === 'manual'
          ? this.slider('Position', s.morph, 'position', 0, 1, 0.01)
          : this.slider(s.morph.mode === 'beats' ? 'Beats per form' : 'Seconds per form', s.morph, 'every', 1, 64, 1),
        this.slider('Transition (s)', s.morph, 'blend', 0.2, 12, 0.1),
      ),
      this.details('maps', el('span', {}, 'Sound mappings', el('span', { class: 'hint' }, ` · ${s.mappings.length}`)), false,
        el('div', { class: 'hint st-note' }, 'A sound (a frequency range, bass, the beat…) drives a setting.'),
        ...s.mappings.map((m, i) => this.mappingBlock(m, i)),
        el('button', { onclick: () => {
          s.mappings.push({ source: { kind: 'band', lo: 60, hi: 250 }, target: 'brightness', amount: 0.5, curve: 'linear', attack: 0, release: 0.2, enabled: true });
          this.changed('live', true);
        } }, '+ Mapping'),
        el('div', { class: 'hint st-note' }, 'The macro sliders and logics still apply on top: intensity scales reactions, chaos scales turbulence, morph and impulse add to morphing and the beat burst.'),
      ),

      el('h3', {}, 'Look ', el('span', { class: 'hint' }, 'space, camera and light')),
      this.details('space', 'Space and camera', false,
        this.color('Space colour', s.space, 'color', 'live'),
        this.select('Particles', s.space, 'particles', [
          ['auto', 'Automatic'], ['glow', 'Glowing (adds light, for dark space)'], ['solid', 'Solid dots (for light space)'],
        ], 'live', false),
        this.slider('Glow', s.space, 'glow', 0, 3, 0.05, 'live', 'Bloom around bright particles. Not used with solid dots.'),
        this.slider('Brightness', s, 'brightness', 0, 3, 0.05),
        this.slider('Colour shift', s, 'hueShift', -0.5, 0.5, 0.01, 'live', 'Rotates every colour around the colour wheel'),
        el('div', { class: 'hint st-note' }, 'Camera: with Look on, drag the view to turn it, scroll to zoom, right-drag to slide. These settings follow what you see.'),
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
    );
    this.refreshHead();
    this.outputChanged();
    this.renderLog();
    if (this.root.parentElement) this.root.parentElement.scrollTop = scroll;
    this.renderTools();
    this.renderPopup();
  }

  private addLayerRow() {
    const pick = el('select', {}, el('option', { value: '' }, '+ Add an object…'), ...this.formOptions());
    pick.onchange = () => {
      if (!pick.value) return;
      const form = this.formFrom(pick.value);
      const layer = newLayer(form.kind === 'model' ? form.model : SHAPE_LABELS[form.shape], form);
      this.spec.layers.push(layer);
      this.selected = layer.id; // open its settings straight away
      this.popPos = { x: 16, y: 90 };
      this.changed('build', true);
    };
    const kids: Node[] = [pick];
    if (!HOSTED) {
      const prompt = el('textarea', { rows: 2, placeholder: 'Or describe a 3D object for Claude to build in Blender, e.g. "an old oak tree with a swing"' });
      const go = el('button', { disabled: this.generating, onclick: () => this.generate(prompt.value) }, this.generating ? 'Claude is modelling…' : 'Build with Claude + Blender');
      kids.push(prompt, go, el('div', { class: 'log st-log' }));
    }
    if (api.canUploadModels()) {
      kids.push(el('div', { class: 'hint st-note' }, 'You can also drop a .glb file exported from Blender anywhere on the window' + (HOSTED ? ' (up to 4 MB here).' : '.')));
    }
    return el('div', { class: 'st-add' }, ...kids);
  }

  private renderLog() {
    const box = this.root.querySelector('.st-log');
    if (!box) return;
    box.replaceChildren(...this.log.slice(0, 12).map((p) =>
      el('div', { class: 'progress' }, p.text, p.image ? el('img', { src: p.image, alt: p.text }) : null)));
  }

  /** One object in the panel's list: show/hide, order, and a click to open its settings. */
  private layerRow(L: StudioLayer, index: number) {
    const s = this.spec;
    const total = s.layers.filter((x) => x.visible).reduce((a, x) => a + x.share, 0) || 1;
    const stop = (fn: () => void) => (e: Event) => { e.stopPropagation(); fn(); };
    const move = (by: number) => {
      const j = index + by;
      if (j < 0 || j >= s.layers.length) return;
      [s.layers[index], s.layers[j]] = [s.layers[j], s.layers[index]];
      this.changed('build', true);
    };
    const what = L.forms.map((F) => (F.kind === 'model' ? F.model : SHAPE_LABELS[F.shape].replace(/ \(.*/, ''))).join(' → ');
    return el('div', {
      class: 'st-row' + (L.id === this.selected ? ' active' : '') + (L.visible ? '' : ' off'),
      title: 'Open this object\'s settings', onclick: () => this.selectObject(L.id === this.selected ? null : L.id),
    },
      el('button', { class: 'st-eye', title: L.visible ? 'Hide' : 'Show', innerHTML: L.visible ? ICONS.eye : ICONS.eyeOff, onclick: stop(() => { L.visible = !L.visible; this.changed('build', true); }) }),
      el('span', { class: 'st-row-name' }, L.name),
      el('span', { class: 'hint' }, L.visible ? `${what} · ${Math.round((L.share / total) * 100)}%` : 'hidden'),
      el('button', { title: 'Move up', disabled: index === 0, onclick: stop(() => move(-1)) }, '↑'),
      el('button', { title: 'Move down', disabled: index === s.layers.length - 1, onclick: stop(() => move(1)) }, '↓'),
    );
  }

  /** Everything about one object: what goes in its pop-up. */
  private layerBody(L: StudioLayer, index: number): (Node | null | false)[] {
    const s = this.spec;
    const sp = L.spectrum;
    void index;
    return [
      this.check('Visible', L, 'visible', 'build', true),
      this.slider('Share', L, 'share', 1, 100, 1, 'build', 'This object\'s share of the particles, relative to the others'),
      this.slider('Particle size', L, 'size', 0.1, 4, 0.05, 'live', 'How big this object\'s particles are'),
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
        this.slider('Brightness', L, 'brightness', 0, 4, 0.05),
        this.slider('Explode', L, 'explode', -10, 20, 0.1, 'live', 'Pushes particles outward along the surface'),
      ),
      this.details('spec:' + L.id, el('span', {}, 'Spectrum across the shape', el('span', { class: 'hint' }, ` · ${AXIS_LABELS[sp.axis]}`)), false,
        el('div', { class: 'hint st-note' }, 'Lays the spectrum over the object: low frequencies at one end, high at the other, so each region reacts to its own part of the sound.'),
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
        el('button', { class: 'st-danger', onclick: () => {
          s.layers.splice(s.layers.indexOf(L), 1);
          s.mappings = s.mappings.filter((m) => !m.target.startsWith(`layer:${L.id}.`));
          this.selected = null;
          this.changed('build', true);
        } }, 'Delete this object'),
      ),
    ];
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
