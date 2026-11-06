import GUI from 'lil-gui';
import type { Engine } from '../engine/engine';
import { AUDIO_SOURCES, CURVES, MACRO_RANGES, type LogicMapping, type Macros } from '../engine/types';

/**
 * lil-gui controls: live audio/macro readouts, base macro sliders, scene params, and the
 * logic mapping editor. Rebuilt whenever the scene or logic changes.
 */
export class Controls {
  private gui: GUI;
  private live!: GUI;
  private macros!: GUI;
  private params!: GUI;
  private mappings!: GUI;
  private liveData: Record<string, number> = {};

  constructor(container: HTMLElement, private engine: Engine) {
    this.gui = new GUI({ container, autoPlace: false, title: 'Controls' });
    this.gui.domElement.classList.add('root');
    this.rebuild();
    // Refresh live readouts ~10x/s
    setInterval(() => this.refreshLive(), 100);
  }

  rebuild() {
    for (const f of [...this.gui.folders]) f.destroy();
    this.buildLive();
    this.buildMacros();
    this.buildParams();
    this.buildMappings();
  }

  private refreshLive() {
    const a = this.engine.audio.features;
    const m = this.engine.logic.macros;
    Object.assign(this.liveData, {
      bass: a.bass, mid: a.mid, high: a.high, flux: a.flux, pulse: a.pulse,
      intensity: m.intensity, chaos: m.chaos, impulse: m.impulse, hue: m.hue,
    });
    this.live?.controllersRecursive().forEach((c) => c.updateDisplay());
  }

  private buildLive() {
    this.live = this.gui.addFolder('Live (audio → macros)');
    for (const k of ['bass', 'mid', 'high', 'flux', 'pulse', 'intensity', 'chaos', 'impulse', 'hue']) {
      this.liveData[k] = 0;
      const max = k === 'intensity' || k === 'chaos' || k === 'impulse' ? 2 : 1;
      this.live.add(this.liveData, k, 0, max).disable();
    }
    this.live.close();
  }

  private buildMacros() {
    this.macros = this.gui.addFolder('Macros (base values)');
    const base = this.engine.logic.baseMacros;
    for (const k of Object.keys(base) as (keyof Macros)[]) {
      const [lo, hi] = MACRO_RANGES[k];
      this.macros.add(base, k, lo, hi, 0.01);
    }
  }

  private buildParams() {
    const specs = this.engine.logic.paramSpecs;
    this.params = this.gui.addFolder('Scene params');
    const keys = Object.keys(specs);
    if (!keys.length) {
      this.params.add({ info: 'This scene has no params' }, 'info').disable();
      return;
    }
    for (const k of keys) {
      const s = specs[k];
      this.params.add(this.engine.logic.baseParams, k, s.min, s.max, s.step ?? (s.max - s.min) / 200).name(s.label ?? k);
    }
  }

  private buildMappings() {
    const logic = this.engine.logic.logic;
    this.mappings = this.gui.addFolder(`Mappings: ${logic.name}`);
    const targets = this.engine.logic.targets();
    logic.mappings.forEach((m, i) => {
      const f = this.mappings.addFolder(`${m.source} → ${m.target}`);
      const title = () => f.title(`${m.enabled === false ? '(off) ' : ''}${m.source} → ${m.target}`);
      m.curve ??= 'linear'; m.attack ??= 0; m.release ??= 0.15; m.mode ??= 'add'; m.enabled ??= true;
      f.add(m, 'enabled').onChange(title);
      f.add(m, 'source', AUDIO_SOURCES).onChange(title);
      f.add(m, 'target', targets.includes(m.target) ? targets : [...targets, m.target]).onChange(title);
      f.add(m, 'amount', -3, 3, 0.01);
      f.add(m, 'curve', CURVES);
      f.add(m, 'attack', 0, 3, 0.01);
      f.add(m, 'release', 0, 3, 0.01);
      f.add(m, 'mode', ['add', 'multiply', 'set']);
      f.add({ remove: () => { logic.mappings.splice(i, 1); this.engine.logic.syncMappings(); this.rebuild(); } }, 'remove').name('Remove mapping');
      f.close();
    });
  }

  addMapping() {
    const m: LogicMapping = { source: 'bass', target: 'macro.intensity', amount: 0.5, curve: 'linear', attack: 0, release: 0.2, mode: 'add', enabled: true };
    this.engine.logic.logic.mappings.push(m);
    this.engine.logic.syncMappings();
    this.rebuild();
    this.mappings.open();
    this.mappings.folders.at(-1)?.open();
  }
}
