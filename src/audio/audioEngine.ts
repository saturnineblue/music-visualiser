import type { AudioFeatures } from '../engine/types';
import { DemoSynth } from './demoSynth';

export type InputKind = 'none' | 'mic' | 'file' | 'demo';

const BANDS = 64;
const WAVE = 512;

/** Adaptive normaliser: tracks a slowly-decaying peak so features stay ~0..1 at any input level. */
class AGC {
  private peak: number;
  constructor(private floor: number, private decayPerSec = 0.15) { this.peak = floor; }
  apply(v: number, dt: number): number {
    this.peak = Math.max(v, this.peak * Math.exp(-this.decayPerSec * dt), this.floor);
    return Math.min(1, v / this.peak);
  }
}

/**
 * Captures audio (microphone / line-in, an audio file, or the built-in demo synth),
 * and turns it into AudioFeatures every frame. No network access needed.
 */
export class AudioEngine {
  readonly features: AudioFeatures = {
    rms: 0, bass: 0, lowMid: 0, mid: 0, high: 0, centroid: 0, flux: 0,
    beat: false, pulse: 0, bpm: 0,
    spectrum: new Float32Array(BANDS),
    waveform: new Float32Array(WAVE),
  };

  kind: InputKind = 'none';
  /** Input gain applied before analysis (GUI-controlled). */
  gain = 1;
  /** Beat sensitivity: lower = more beats. */
  beatThreshold = 1.35;
  /** Play file/demo audio through speakers. Mic is never monitored (feedback). */
  monitor = true;

  private ctx: AudioContext | null = null;
  private analyser!: AnalyserNode;
  private inputGain!: GainNode;
  private monitorGain!: GainNode;
  private freq!: Uint8Array<ArrayBuffer>;
  private time!: Float32Array<ArrayBuffer>;
  private prevSpectrum = new Float32Array(BANDS);
  private bandEdges: number[] = [];
  private current: AudioNode | null = null;
  private stream: MediaStream | null = null;
  private fileEl: HTMLAudioElement | null = null;
  private fileSrc: MediaElementAudioSourceNode | null = null;
  private demo: DemoSynth | null = null;

  private agc = {
    rms: new AGC(0.02), bass: new AGC(0.1), lowMid: new AGC(0.1), mid: new AGC(0.1),
    high: new AGC(0.05), flux: new AGC(0.02),
  };
  private fluxHistory: number[] = [];
  private lastBeat = 0;
  private beatTimes: number[] = [];
  private clock = 0;

  get started() { return this.ctx !== null; }

  /** Must be called from a user gesture (browser autoplay policy). */
  async init() {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.55;
    this.analyser.minDecibels = -90;
    this.analyser.maxDecibels = -15;
    this.inputGain = this.ctx.createGain();
    this.monitorGain = this.ctx.createGain();
    this.inputGain.connect(this.analyser);
    this.monitorGain.connect(this.ctx.destination);
    this.freq = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
    this.time = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));

    // Log-spaced band edges 30 Hz .. 16 kHz, mapped to FFT bins.
    const nyq = this.ctx.sampleRate / 2;
    const bins = this.analyser.frequencyBinCount;
    for (let i = 0; i <= BANDS; i++) {
      const f = 30 * Math.pow(16000 / 30, i / BANDS);
      this.bandEdges.push(Math.min(bins - 1, Math.max(1, Math.round((f / nyq) * bins))));
    }
  }

  async listDevices(): Promise<MediaDeviceInfo[]> {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput');
  }

  private disconnectCurrent() {
    this.current?.disconnect();
    this.current = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.fileEl?.pause();
    this.demo?.stop();
    this.demo = null;
  }

  async useMic(deviceId?: string) {
    await this.init();
    this.disconnectCurrent();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      },
    });
    const src = this.ctx!.createMediaStreamSource(this.stream);
    src.connect(this.inputGain);
    this.current = src;
    this.kind = 'mic';
  }

  async useFile(file: File) {
    await this.init();
    this.disconnectCurrent();
    if (!this.fileEl) {
      this.fileEl = new Audio();
      this.fileEl.loop = true;
      // A media element can only be wrapped once, so keep the node.
      this.fileSrc = this.ctx!.createMediaElementSource(this.fileEl);
    }
    if (this.fileEl.src) URL.revokeObjectURL(this.fileEl.src);
    this.fileEl.src = URL.createObjectURL(file);
    const src = this.fileSrc!;
    src.connect(this.inputGain);
    if (this.monitor) src.connect(this.monitorGain);
    this.current = src;
    await this.fileEl.play();
    this.kind = 'file';
  }

  async useDemo() {
    await this.init();
    this.disconnectCurrent();
    this.demo = new DemoSynth(this.ctx!);
    this.demo.output.connect(this.inputGain);
    if (this.monitor) this.demo.output.connect(this.monitorGain);
    this.current = this.demo.output;
    this.demo.start();
    this.kind = 'demo';
  }

  setMonitor(on: boolean) {
    this.monitor = on;
    if (this.monitorGain) this.monitorGain.gain.value = on ? 1 : 0;
  }

  stop() {
    this.disconnectCurrent();
    this.kind = 'none';
  }

  /** Analyse the current frame. */
  update(dt: number) {
    const f = this.features;
    this.clock += dt;
    f.beat = false;
    f.pulse *= Math.exp(-dt * 5);
    if (!this.ctx || this.kind === 'none') {
      f.rms = f.bass = f.lowMid = f.mid = f.high = f.flux = 0;
      f.spectrum.fill(0);
      return;
    }
    this.inputGain.gain.value = this.gain;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.analyser.getByteFrequencyData(this.freq);
    this.analyser.getFloatTimeDomainData(this.time);

    // Waveform (downsampled) + RMS
    let sum = 0;
    const step = this.time.length / WAVE;
    for (let i = 0; i < this.time.length; i++) sum += this.time[i] * this.time[i];
    for (let i = 0; i < WAVE; i++) f.waveform[i] = this.time[Math.floor(i * step)];
    const rms = Math.sqrt(sum / this.time.length);

    // Bands
    let flux = 0, lowFlux = 0, wsum = 0, msum = 0;
    for (let b = 0; b < BANDS; b++) {
      const a = this.bandEdges[b], e = Math.max(a + 1, this.bandEdges[b + 1]);
      let acc = 0;
      for (let k = a; k < e; k++) acc += this.freq[k];
      const v = acc / (e - a) / 255;
      const d = v - this.prevSpectrum[b];
      if (d > 0) { flux += d; if (b < 16) lowFlux += d; }
      this.prevSpectrum[b] = v;
      f.spectrum[b] = v;
      wsum += v * b; msum += v;
    }

    const range = (lo: number, hi: number) => {
      let s = 0;
      for (let b = lo; b < hi; b++) s += f.spectrum[b];
      return s / (hi - lo);
    };
    // Band indices roughly: 0-14 ≈ 30-150Hz, 14-27 ≈ 150-600Hz, 27-41 ≈ 600-2.5k, 41-64 ≈ 2.5k-16k
    f.rms = this.agc.rms.apply(rms, dt);
    f.bass = this.agc.bass.apply(range(0, 14), dt);
    f.lowMid = this.agc.lowMid.apply(range(14, 27), dt);
    f.mid = this.agc.mid.apply(range(27, 41), dt);
    f.high = this.agc.high.apply(range(41, 64), dt);
    f.flux = this.agc.flux.apply(flux, dt);
    f.centroid = msum > 0.001 ? wsum / msum / BANDS : 0;

    // Onset / beat detection on low-frequency flux vs. its recent average.
    const hist = this.fluxHistory;
    hist.push(lowFlux);
    if (hist.length > 45) hist.shift();
    const mean = hist.reduce((a, c) => a + c, 0) / hist.length;
    if (lowFlux > mean * this.beatThreshold && lowFlux > 0.08 && this.clock - this.lastBeat > 0.22) {
      f.beat = true;
      f.pulse = 1;
      if (this.lastBeat > 0) {
        const iv = this.clock - this.lastBeat;
        if (iv > 0.25 && iv < 1.5) {
          this.beatTimes.push(iv);
          if (this.beatTimes.length > 12) this.beatTimes.shift();
          const sorted = [...this.beatTimes].sort((a, b) => a - b);
          f.bpm = Math.round(60 / sorted[Math.floor(sorted.length / 2)]);
        }
      }
      this.lastBeat = this.clock;
    }
  }
}
