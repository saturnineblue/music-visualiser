/**
 * Built-in demo beats, synthesised offline, so the visualiser can be tested without a mic or a file.
 * Three styles, each built to exercise something different:
 *
 *   1  House, 120 BPM. Steady: kick on every beat, backbeat snare, even hats, a bass line and a
 *      held pad. The baseline for beat detection and tempo.
 *   2  Breakbeat, 172 BPM. Fast and syncopated: off-beat kicks, snare on 2 and 4, accented
 *      sixteenth hats and a sliding sub bass. Every eighth bar is a break with a snare roll and a
 *      riser, so it also tests a build, a near-silence and the hit that follows.
 *   3  Downtempo, 84 BPM. Sparse and swung, in a 16-bar arc: four quiet bars of pad and bells,
 *      then the beat comes in, then bass and claps. The pad's filter sweeps slowly, so it tests
 *      quiet passages, slow changes and timbre (brightness) rather than punch.
 */

export interface DemoPattern { name: string; bpm: number; about: string }

export const DEMO_PATTERNS: DemoPattern[] = [
  { name: 'House', bpm: 120, about: 'steady kick on every beat: the baseline for beat and tempo' },
  { name: 'Breakbeat', bpm: 172, about: 'fast, off-beat kicks; a snare roll and a break every 8 bars' },
  { name: 'Downtempo', bpm: 84, about: 'sparse and swung; builds from a quiet pad over 16 bars, with a slow filter sweep' },
];

const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

export class DemoSynth {
  readonly output: GainNode;
  private timer: number | null = null;
  private nextTime = 0;
  /** Sixteenth notes since the start. */
  private step = 0;
  private noise: AudioBuffer;
  private held: OscillatorNode[] = [];
  private readonly sixteenth: number;

  constructor(private ctx: AudioContext, readonly pattern = 0) {
    this.output = ctx.createGain();
    this.output.gain.value = 0.5;
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.sixteenth = 60 / DEMO_PATTERNS[pattern].bpm / 4;
  }

  start() {
    this.nextTime = this.ctx.currentTime + 0.05;
    this.timer = window.setInterval(() => this.schedule(), 25);
    if (this.pattern === 0) {
      // A held A-major pad under the house beat.
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
        this.held.push(o);
      }
    }
  }

  stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.held.forEach((o) => o.stop());
    this.held = [];
    this.output.disconnect();
  }

  private schedule() {
    while (this.nextTime < this.ctx.currentTime + 0.1) {
      const t = this.nextTime, n = this.step;
      if (this.pattern === 1) this.breakbeat(t, n);
      else if (this.pattern === 2) this.downtempo(t, n);
      else this.house(t, n);
      this.nextTime += this.sixteenth;
      this.step++;
    }
  }

  // ---------- Patterns (n = sixteenth-note counter; 16 per bar) ----------

  private house(t: number, n: number) {
    const s = n % 16, bar = Math.floor(n / 16);
    if (s % 4 === 0) this.kick(t);
    if (s === 8) this.snare(t);
    if (s % 2 === 0) this.hat(t, s % 4 === 2 ? 0.12 : 0.06);
    if (s % 8 === 0) this.bass(t, [55, 55, 65.41, 49][Math.floor(bar / 2) % 4], 0.48);
  }

  private breakbeat(t: number, n: number) {
    const s = n % 16, bar = Math.floor(n / 16) % 8, six = this.sixteenth;
    const root = [38, 38, 41, 36][Math.floor(Math.floor(n / 16) / 2) % 4]; // D, D, F, C

    if (bar === 7) {
      // The break: no kick or bass; a snare roll that doubles up, under a rising noise sweep.
      if (s === 0) { this.riser(t, six * 16); this.pad(t, [root + 24, root + 31, root + 34], six * 16, 0.035, 500, 3500); }
      const vol = 0.18 + (s / 16) * 0.4;
      if (s < 8 ? s % 2 === 0 : true) this.snare(t, vol, 0.09);
      if (s >= 12) this.snare(t + six / 2, vol, 0.07); // 32nds in the last beat
      return;
    }
    if (bar === 0 && s === 0) this.crash(t); // the hit after the break
    if (s === 0 && bar % 2 === 0) this.pad(t, [root + 24, root + 31, root + 34], six * 32, 0.03, 700, 1400);

    // Two-step: kick on 1 and the "and" of 2 (plus a pickup every other bar), snare on 2 and 4.
    if (s === 0 || s === 10 || (bar % 2 === 1 && s === 7)) this.kick(t, 1, 170);
    if (s === 4 || s === 12) this.snare(t, 0.55);
    if (bar % 4 === 3 && s === 15) this.snare(t, 0.25, 0.08); // ghost note into the next bar
    this.hat(t, s % 4 === 2 ? 0.13 : s % 2 === 0 ? 0.07 : 0.035, s === 14 ? 0.18 : 0.04);
    // Sub bass: long notes that slide, following the kick.
    if (s === 0) this.sub(t, midi(root), midi(root), six * 6);
    if (s === 10) this.sub(t, midi(root + 7), midi(root), six * 5);
  }

  private downtempo(t: number, n: number) {
    const s = n % 16, barAll = Math.floor(n / 16), bar = barAll % 16, six = this.sixteenth;
    // Swing: every second sixteenth comes late.
    const ts = t + (s % 2 === 1 ? six * 0.3 : 0);
    // Four chords, two bars each: Am9, Fmaj7, Cmaj7, G6.
    const chords = [[57, 60, 64, 71], [53, 57, 60, 64], [48, 55, 59, 64], [55, 59, 62, 64]];
    const chord = chords[Math.floor(bar / 2) % 4];
    const full = bar >= 8, beat = bar >= 4;

    if (s === 0 && bar % 2 === 0) {
      // The pad's filter opens through the first half of the arc and closes through the second.
      const phase = bar / 16, open = (p: number) => 350 + 2600 * Math.sin(Math.PI * Math.min(1, Math.max(0, p)));
      this.pad(t, chord.map((m) => m), six * 34, 0.05, open(phase), open(phase + 1 / 8));
    }
    // Bells: a slow arpeggio up high (it carries the quiet opening bars).
    if (s % 4 === 2 || (full && s === 11)) this.bell(ts, midi(chord[(Math.floor(n / 4) * 3) % 4] + 24), beat ? 0.07 : 0.1);

    if (beat) {
      if (s === 0 || s === 10) this.kick(ts, s === 0 ? 0.9 : 0.6, 120);
      if (s % 2 === 0 || s === 15) this.hat(ts, s % 4 === 2 ? 0.07 : 0.035, 0.03);
    }
    if (full) {
      if (s === 8) this.clap(ts);
      if (s === 0 || s === 6 || s === 10) this.bass(ts, midi(chord[0] - 24), six * (s === 0 ? 5 : 3), 'triangle', 0.3);
    }
    if (bar === 15 && s === 12) this.riser(t, six * 4, 0.05); // a small lift back into the quiet bars
  }

  // ---------- Voices ----------

  private kick(t: number, vol = 1, from = 150) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.15);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(g).connect(this.output);
    o.start(t); o.stop(t + 0.4);
  }

  private noiseBurst(t: number, type: BiquadFilterType, freq: number, vol: number, len: number, q = 1) {
    const n = this.ctx.createBufferSource();
    n.buffer = this.noise;
    n.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    n.connect(f).connect(g).connect(this.output);
    n.start(t, Math.random() * 0.5); n.stop(t + len);
  }

  private snare(t: number, vol = 0.5, len = 0.2) {
    this.noiseBurst(t, 'highpass', 1200, vol, len);
    // A short tone gives it body.
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(140, t + 0.08);
    g.gain.setValueAtTime(vol * 0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    o.connect(g).connect(this.output);
    o.start(t); o.stop(t + 0.1);
  }

  private hat(t: number, vol: number, len = 0.05) {
    this.noiseBurst(t, 'highpass', 7000, vol, len);
  }

  private clap(t: number) {
    for (const d of [0, 0.012, 0.026]) this.noiseBurst(t + d, 'bandpass', 1500, 0.28, d === 0.026 ? 0.22 : 0.03, 1.2);
  }

  private crash(t: number) {
    this.noiseBurst(t, 'highpass', 4500, 0.3, 1.6);
  }

  /** Rising filtered noise: the "build" before a hit. */
  private riser(t: number, len: number, vol = 0.14) {
    const n = this.ctx.createBufferSource();
    n.buffer = this.noise;
    n.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 2;
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(9000, t + len);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + len * 0.95);
    g.gain.linearRampToValueAtTime(0, t + len);
    n.connect(f).connect(g).connect(this.output);
    n.start(t); n.stop(t + len + 0.02);
  }

  private bass(t: number, f: number, len: number, type: OscillatorType = 'square', vol = 0.25) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(600, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + len * 0.94);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    o.connect(lp).connect(g).connect(this.output);
    o.start(t); o.stop(t + len + 0.02);
  }

  /** A sine sub that slides from one pitch to another. */
  private sub(t: number, from: number, to: number, len: number) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + len * 0.5);
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.5, t + 0.012);
    g.gain.setValueAtTime(0.5, t + len * 0.7);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    o.connect(g).connect(this.output);
    o.start(t); o.stop(t + len + 0.02);
  }

  /** A chord of detuned saws through a low-pass that moves from one cutoff to another. */
  private pad(t: number, notes: number[], len: number, vol: number, cutFrom: number, cutTo: number) {
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.max(60, cutFrom), t);
    lp.frequency.linearRampToValueAtTime(Math.max(60, cutTo), t + len);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(vol, t + Math.min(1.2, len * 0.3));
    g.gain.setValueAtTime(vol, t + len * 0.8);
    g.gain.linearRampToValueAtTime(0, t + len);
    lp.connect(g).connect(this.output);
    for (const m of notes) {
      for (const cents of [-7, 7]) {
        const o = this.ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midi(m);
        o.detune.value = cents;
        o.connect(lp);
        o.start(t); o.stop(t + len + 0.05);
      }
    }
  }

  private bell(t: number, f: number, vol: number) {
    for (const [mult, v] of [[1, 1], [2.76, 0.35]] as const) {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f * mult;
      // A few milliseconds of attack: starting at full level would add a click that reads as a low thump.
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol * v, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
      o.connect(g).connect(this.output);
      o.start(t); o.stop(t + 1.15);
    }
  }
}
