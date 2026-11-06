/**
 * A tiny offline drum-and-bass-line loop so the visualiser can be tested without a mic or file.
 * 120 BPM: kick on quarters, hats on eighths, snare on 2 & 4, a bass line and a slow pad.
 */
export class DemoSynth {
  readonly output: GainNode;
  private timer: number | null = null;
  private nextTime = 0;
  private step = 0;
  private noise: AudioBuffer;
  private pad: OscillatorNode[] = [];

  constructor(private ctx: AudioContext) {
    this.output = ctx.createGain();
    this.output.gain.value = 0.5;
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  start() {
    this.nextTime = this.ctx.currentTime + 0.05;
    this.timer = window.setInterval(() => this.schedule(), 25);
    const padGain = this.ctx.createGain();
    padGain.gain.value = 0.04;
    padGain.connect(this.output);
    for (const f of [220, 277.18, 329.63]) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      o.connect(lp).connect(padGain);
      o.start();
      this.pad.push(o);
    }
  }

  stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.pad.forEach((o) => o.stop());
    this.pad = [];
    this.output.disconnect();
  }

  private schedule() {
    const eighth = 0.25;
    while (this.nextTime < this.ctx.currentTime + 0.1) {
      const s = this.step % 16;
      if (s % 2 === 0) this.kick(this.nextTime);
      if (s === 4 || s === 12) this.snare(this.nextTime);
      this.hat(this.nextTime, s % 2 === 1 ? 0.12 : 0.06);
      const bassNotes = [55, 55, 65.41, 49];
      if (s % 4 === 0) this.bass(this.nextTime, bassNotes[Math.floor(this.step / 16) % 4]);
      this.nextTime += eighth;
      this.step++;
    }
  }

  private kick(t: number) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.15);
    g.gain.setValueAtTime(1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(g).connect(this.output);
    o.start(t); o.stop(t + 0.4);
  }

  private snare(t: number) {
    const n = this.ctx.createBufferSource();
    n.buffer = this.noise;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 1200;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    n.connect(hp).connect(g).connect(this.output);
    n.start(t); n.stop(t + 0.2);
  }

  private hat(t: number, vol: number) {
    const n = this.ctx.createBufferSource();
    n.buffer = this.noise;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 7000;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    n.connect(hp).connect(g).connect(this.output);
    n.start(t); n.stop(t + 0.05);
  }

  private bass(t: number, f: number) {
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = f;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(600, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + 0.45);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.48);
    o.connect(lp).connect(g).connect(this.output);
    o.start(t); o.stop(t + 0.5);
  }
}
