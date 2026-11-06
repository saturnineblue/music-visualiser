import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { CameraSpec } from './types';

/** Owns the WebGL renderer, camera, controls and post-processing. Scene-agnostic. */
export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x020205);
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
    this.camera.position.set(0, 8, 50);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.4;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.7, 0.35, 0.25);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    window.addEventListener('resize', () => this.resize());
  }

  private insetRight = 0;

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
    this.composer.setSize(w, h);
  }

  setCamera(spec: CameraSpec) {
    if (spec.position) this.camera.position.set(...spec.position);
    if (spec.target) this.controls.target.set(...spec.target);
    if (spec.fov) { this.camera.fov = spec.fov; this.camera.updateProjectionMatrix(); }
    if (spec.autoRotate !== undefined) {
      this.controls.autoRotate = spec.autoRotate !== 0;
      this.controls.autoRotateSpeed = spec.autoRotate;
    }
  }

  setBackground(r: number, g: number, b: number) {
    (this.scene.background as THREE.Color).setRGB(r, g, b);
  }

  setBloom(strength: number) {
    this.bloom.strength = strength;
  }

  render() {
    this.controls.update();
    this.composer.render();
  }
}
