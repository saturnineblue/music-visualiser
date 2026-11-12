import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { CameraSpec } from './types';

/** A WebGL canvas + bloom pipeline drawing the shared scene through a camera. */
class View {
  readonly renderer: THREE.WebGLRenderer;
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  pixelRatio: number;

  constructor(scene: THREE.Scene, camera: THREE.Camera, canvas: HTMLCanvasElement | undefined, w: number, h: number, pixelRatio: number, bloom: number) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    this.pixelRatio = pixelRatio;
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(w, h, false);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), bloom, 0.35, 0.25);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  setPixelRatio(pr: number) {
    this.pixelRatio = pr;
    this.renderer.setPixelRatio(pr);
    this.composer.setPixelRatio(pr);
  }

  setSize(w: number, h: number) {
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
  }

  dispose() {
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

/**
 * A second window (e.g. on a projector) that shows only the visualisation.
 * It is drawn by this window's frame loop; the camera follows the main one.
 */
class OutputWindow {
  readonly camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2000);
  readonly view: View;
  private canvas: HTMLCanvasElement;

  constructor(readonly win: Window, scene: THREE.Scene, bloom: number, onKey?: (e: KeyboardEvent) => void) {
    const doc = win.document;
    this.canvas = doc.getElementById('out') as HTMLCanvasElement;
    const w = win.innerWidth || 1280, h = win.innerHeight || 720;
    this.view = new View(scene, this.camera, this.canvas, w, h, Math.min(win.devicePixelRatio || 1, 2), bloom);
    win.addEventListener('resize', () => this.resize());
    this.resize();

    // Fullscreen on double-click or F; hide the cursor and tip when the mouse rests.
    const toggleFs = () => {
      if (doc.fullscreenElement) doc.exitFullscreen();
      else doc.documentElement.requestFullscreen().catch(() => {});
    };
    doc.addEventListener('dblclick', toggleFs);
    doc.addEventListener('keydown', (e) => {
      if (e.key === 'f' || e.key === 'F') toggleFs();
      else onKey?.(e);
    });
    let idle = 0;
    const wake = () => {
      doc.body.classList.remove('idle');
      win.clearTimeout(idle);
      idle = win.setTimeout(() => doc.body.classList.add('idle'), 2500);
    };
    doc.addEventListener('mousemove', wake);
    idle = win.setTimeout(() => doc.body.classList.add('idle'), 6000);
  }

  resize() {
    const w = this.win.innerWidth, h = this.win.innerHeight;
    if (!w || !h) return;
    const pr = Math.min(this.win.devicePixelRatio || 1, 2);
    if (pr !== this.view.pixelRatio) this.view.setPixelRatio(pr);
    this.view.setSize(w, h);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
  }

  sync(main: THREE.PerspectiveCamera) {
    this.camera.position.copy(main.position);
    this.camera.quaternion.copy(main.quaternion);
    this.camera.fov = main.fov;
    this.camera.near = main.near;
    this.camera.far = main.far;
    this.camera.aspect = this.win.innerWidth / Math.max(1, this.win.innerHeight);
    this.camera.updateProjectionMatrix();
  }
}

const OUTPUT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Music Visualiser — Output</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #020205; }
  canvas { display: block; position: fixed; inset: 0; }
  body.idle { cursor: none; }
  #tip { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); padding: 10px 16px; border-radius: 8px;
    background: rgba(10, 12, 24, 0.85); color: #cfd3e6; font: 13px system-ui, sans-serif; transition: opacity 0.6s; pointer-events: none; }
  body.idle #tip, :fullscreen #tip { opacity: 0; }
</style></head>
<body><canvas id="out"></canvas>
<div id="tip">Drag this window to the projector, then double-click or press F for fullscreen (Esc exits).</div>
</body></html>`;

/** Owns the WebGL renderer, camera, controls and post-processing. Scene-agnostic. */
export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private main: View;
  private output: OutputWindow | null = null;
  private bloomStrength = 0.7;
  private mainPixelRatio = Math.min(window.devicePixelRatio, 2);
  /** When the output window is open: also draw in this window (preview), at a reduced resolution. */
  preview = true;
  /** Called when the output window opens or closes. */
  onOutputChange?: (open: boolean) => void;
  /** Keys pressed in the output window (other than F, which toggles its fullscreen). */
  onOutputKey?: (e: KeyboardEvent) => void;

  constructor(container: HTMLElement) {
    this.scene.background = new THREE.Color(0x020205);
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
    this.camera.position.set(0, 8, 50);

    this.main = new View(this.scene, this.camera, undefined, window.innerWidth, window.innerHeight, this.mainPixelRatio, this.bloomStrength);
    this.renderer = this.main.renderer;
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.4;
    this.controls.addEventListener('start', () => { this.interacting = true; });
    this.controls.addEventListener('end', () => { this.interacting = false; });

    window.addEventListener('resize', () => this.resize());
    window.addEventListener('pagehide', () => this.output?.win.close());
  }

  private insetRight = 0;

  /** Automatic up-and-down swing of the camera, in OrbitControls auto-rotate units (0 = off). */
  autoTilt = 0;
  private tiltDir = 1;
  private lastRender = performance.now();
  /** True while the user is dragging / zooming the view. */
  interacting = false;

  /** The camera as orbit angles (degrees) around its target. */
  getOrbit(): { azimuth: number; elevation: number; distance: number; target: [number, number, number] } {
    const t = this.controls.target, p = this.camera.position;
    const dx = p.x - t.x, dy = p.y - t.y, dz = p.z - t.z;
    const distance = Math.hypot(dx, dy, dz) || 1;
    return {
      azimuth: (Math.atan2(dx, dz) * 180) / Math.PI,
      elevation: (Math.asin(Math.max(-1, Math.min(1, dy / distance))) * 180) / Math.PI,
      distance,
      target: [t.x, t.y, t.z],
    };
  }

  /** Swing the camera up and down between ±60° while auto-tilt is on. */
  private tilt(dt: number) {
    if (!this.autoTilt || this.interacting) return;
    const o = this.getOrbit();
    let el = o.elevation + this.tiltDir * this.autoTilt * 6 * dt; // same speed scale as auto-rotate
    if (el > 60) { el = 60; this.tiltDir = -Math.sign(this.autoTilt); }
    if (el < -60) { el = -60; this.tiltDir = Math.sign(this.autoTilt); }
    const az = (o.azimuth * Math.PI) / 180, e = (el * Math.PI) / 180;
    this.camera.position.set(
      o.target[0] + o.distance * Math.sin(az) * Math.cos(e),
      o.target[1] + o.distance * Math.sin(e),
      o.target[2] + o.distance * Math.cos(az) * Math.cos(e),
    );
  }

  /** Keep the visual centred in the area not covered by the side panel. */
  setInsetRight(px: number) {
    this.insetRight = px;
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = (w + this.insetRight) / h;
    if (this.insetRight > 0) this.camera.setViewOffset(w + this.insetRight, h, this.insetRight, 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.main.composer.setSize(w, h);
  }

  setCamera(spec: CameraSpec) {
    if (spec.position) this.camera.position.set(...spec.position);
    if (spec.target) this.controls.target.set(...spec.target);
    if (spec.fov) { this.camera.fov = spec.fov; this.camera.updateProjectionMatrix(); }
    if (spec.autoRotate !== undefined) {
      this.controls.autoRotate = spec.autoRotate !== 0;
      this.controls.autoRotateSpeed = spec.autoRotate;
    }
    if (spec.autoTilt !== undefined) this.autoTilt = spec.autoTilt;
  }

  setBackground(r: number, g: number, b: number) {
    (this.scene.background as THREE.Color).setRGB(r, g, b);
  }

  setBloom(strength: number) {
    this.bloomStrength = strength;
    this.main.bloom.strength = strength;
    if (this.output) this.output.view.bloom.strength = strength;
  }

  // ---------- Output (projector) window ----------

  get outputOpen() { return this.output !== null; }
  get outputWindow() { return this.output?.win ?? null; }

  /**
   * Open the visuals-only window. Must be called from a click (pop-up blockers).
   * Returns the window, or null if the browser blocked it.
   */
  openOutput(): Window | null {
    if (this.output && !this.output.win.closed) { this.output.win.focus(); return this.output.win; }
    const win = window.open('', 'vis-output', 'popup,width=1280,height=720');
    if (!win) return null;
    win.document.open();
    win.document.write(OUTPUT_HTML);
    win.document.close();
    try {
      this.output = new OutputWindow(win, this.scene, this.bloomStrength, (e) => this.onOutputKey?.(e));
    } catch (e) {
      win.close();
      throw e;
    }
    win.addEventListener('pagehide', () => this.closeOutput());
    // Save GPU time while the projector does the real work.
    this.main.setPixelRatio(1);
    this.resize();
    this.onOutputChange?.(true);
    return win;
  }

  closeOutput() {
    const out = this.output;
    if (!out) return;
    this.output = null;
    out.view.dispose();
    if (!out.win.closed) out.win.close();
    this.main.setPixelRatio(this.mainPixelRatio);
    this.resize();
    this.onOutputChange?.(false);
  }

  /** Point-size uniforms are in device pixels, so they follow whichever canvas is being drawn. */
  private setPointPixelRatio(pr: number) {
    for (const obj of this.scene.children) {
      const mat = (obj as THREE.Points).material as THREE.ShaderMaterial | undefined;
      const u = mat?.uniforms?.uPixelRatio;
      if (u) u.value = pr;
    }
  }

  render() {
    const now = performance.now();
    this.tilt(Math.min(0.1, (now - this.lastRender) / 1000));
    this.lastRender = now;
    this.controls.update();
    const out = this.output;
    if (out) {
      if (out.win.closed) { this.closeOutput(); }
      else {
        out.sync(this.camera);
        // Point sizes are in pixels: scale them with the output's height so it looks like the main view, just bigger or smaller.
        this.setPointPixelRatio(out.view.pixelRatio * (out.win.innerHeight || 1) / Math.max(1, window.innerHeight));
        out.view.composer.render();
        if (!this.preview) return;
      }
    }
    this.setPointPixelRatio(this.main.pixelRatio);
    this.main.composer.render();
  }
}
