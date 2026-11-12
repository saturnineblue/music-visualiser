/**
 * Tempo from the rhythm as a whole, not from the gaps between kicks.
 *
 * It keeps the last few seconds of "onset strength" (how much the spectrum jumped, frame by frame),
 * and looks for the delay at which that pattern best lines up with itself (autocorrelation). That
 * works for syncopated music, where kicks fall off the beat, and for sparse music, where most beats
 * have no kick at all: hats, snares and chords all count as evidence.
 *
 * The usual trap is the octave: a pattern that repeats every beat also repeats every two beats.
 * So after finding the best-supported tempo, it steps up to double time whenever the faster pulse is
 * nearly as well supported, and it leans gently towards tempos people actually tap (around 120).
 */

const RATE = 100;                 // envelope samples per second
const WINDOW = 8;                 // seconds analysed
const MIN_BPM = 60, MAX_BPM = 200;
const SIZE = RATE * WINDOW;
/** Estimates (two per second) a double- or half-time reading must persist before it replaces the current tempo. */
const OCTAVE_PATIENCE = 24;

export class TempoTracker {
  bpm = 0;
  /** How clearly the rhythm repeats at the reported tempo, 0..1 (for debugging / UI). */
  confidence = 0;
  /** Support for double time relative to the chosen tempo, before the octave check (for tuning). */
  half = 0;
  /** The best candidate tempos of the last estimate, strongest first (for tuning). */
  peaks: { bpm: number; ac: number; score: number }[] = [];

  private env = new Float32Array(SIZE);
  private head = 0;               // next write position
  private filled = 0;
  private lastIndex = -1;
  private sinceEstimate = 0;
  private recent: number[] = [];
  private octaveVotes = 0;
  private x = new Float32Array(SIZE);

  reset() {
    this.env.fill(0);
    this.head = 0; this.filled = 0; this.lastIndex = -1; this.sinceEstimate = 0;
    this.recent = [];
    this.octaveVotes = 0;
    this.bpm = 0; this.confidence = 0;
  }

  /** Feed one analysis frame: `onset` is the frame's onset strength, `clock` the running time in seconds. */
  push(onset: number, clock: number, dt: number) {
    // Frames arrive at the display's rate; spread each over the fixed-rate slots it covers.
    // Square-root compression: without it a few loud kicks drown out the hats, snares and chords
    // that carry the pulse in sparse music.
    onset = Math.sqrt(Math.max(0, onset));
    const index = Math.floor(clock * RATE);
    const from = this.lastIndex < 0 || index - this.lastIndex > RATE ? index : this.lastIndex + 1;
    for (let i = from; i <= index; i++) {
      this.env[this.head] = onset;
      this.head = (this.head + 1) % SIZE;
      if (this.filled < SIZE) this.filled++;
    }
    this.lastIndex = index;

    this.sinceEstimate += dt;
    if (this.sinceEstimate >= 0.5 && this.filled >= RATE * 4) {
      this.sinceEstimate = 0;
      this.estimate();
    }
  }

  private estimate() {
    const n = this.filled, x = this.x;
    // Oldest → newest, with the average removed so only the changes count.
    let mean = 0;
    for (let i = 0; i < n; i++) { const v = this.env[(this.head - n + i + SIZE * 2) % SIZE]; x[i] = v; mean += v; }
    mean /= n;
    let energy = 0;
    for (let i = 0; i < n; i++) { x[i] -= mean; energy += x[i] * x[i]; }
    if (energy / n < 1e-7) return; // silence: keep the last tempo

    const ac = (lag: number) => {
      let s = 0;
      for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
      return s / (n - lag) / (energy / n);
    };
    /** Autocorrelation at a fractional lag (between two slots). */
    const at = (lag: number) => {
      const a = Math.floor(lag), f = lag - a;
      return ac(a) * (1 - f) + (f > 0 ? ac(a + 1) * f : 0);
    };

    const minLag = Math.floor((60 / MAX_BPM) * RATE), maxLag = Math.min(n - RATE, Math.ceil((60 / MIN_BPM) * RATE));
    const longest = n - 2 * RATE; // beyond this there is too little overlap to trust
    let best = -1, bestScore = -Infinity;
    const acs = new Float32Array(maxLag + 2);
    for (let lag = minLag - 1; lag <= maxLag + 1; lag++) acs[lag] = ac(lag);
    const peaks: { bpm: number; ac: number; score: number }[] = [];
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (acs[lag] < acs[lag - 1] || acs[lag] < acs[lag + 1]) continue; // peaks only
      // A real beat also repeats at two and four beats (the bar). A rhythm that only happens to line
      // up at this delay, like the gap between two off-beat kicks, does not.
      let sum = acs[lag], weight = 1;
      for (const k of [2, 4]) if (lag * k <= longest) { sum += 0.75 * Math.max(0, ac(lag * k)); weight += 0.75; }
      const bpm = (60 * RATE) / lag;
      // A gentle preference for tempos near 120 (one octave away costs about 20%).
      const oct = Math.log2(bpm / 120);
      const score = (sum / weight) * Math.exp(-0.5 * (oct / 1.5) ** 2);
      peaks.push({ bpm: Math.round(bpm), ac: +acs[lag].toFixed(3), score: +score.toFixed(3) });
      if (score > bestScore) { bestScore = score; best = lag; }
    }
    this.peaks = peaks.sort((p, q) => q.score - p.score).slice(0, 6);
    if (best < 0 || acs[best] <= 0.02) return;

    // Refine the peak between slots.
    const a = acs[best - 1], b = acs[best], c = acs[best + 1];
    const denom = a - 2 * b + c;
    let lag = best + (denom < 0 ? (0.5 * (a - c)) / denom : 0);

    // Octave check: prefer double time when the faster pulse is nearly as strong.
    this.half = +(at(lag / 2) / Math.max(1e-6, at(lag))).toFixed(2);
    while ((60 * RATE) / (lag / 2) <= MAX_BPM && at(lag / 2) >= 0.9 * at(lag)) lag /= 2;

    const bpm = (60 * RATE) / lag;
    // Double and half time are the easy mistake: a passage with only hats, say, briefly looks twice
    // as fast. So once a tempo is established, a jump to exactly double or half must hold for a
    // while (about 12 s) before it is believed. Any other change is followed straight away.
    if (this.bpm > 0 && Math.abs(Math.abs(Math.log2(bpm / this.bpm)) - 1) < 0.08) {
      if (++this.octaveVotes < OCTAVE_PATIENCE) return;
      this.recent = [];
    }
    this.octaveVotes = 0;
    this.recent.push(bpm);
    if (this.recent.length > 5) this.recent.shift();
    const sorted = [...this.recent].sort((p, q) => p - q);
    this.bpm = Math.round(sorted[Math.floor(sorted.length / 2)]);
    this.confidence = Math.max(0, Math.min(1, at(lag)));
  }
}
