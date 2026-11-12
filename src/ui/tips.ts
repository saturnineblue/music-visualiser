/**
 * Friendly first-time tips: one small bubble at a time in the bottom-left corner, each shown once.
 * They never block anything, fade on their own, and can be switched off (and back on) for good.
 */

type Where = 'main' | 'studio';

interface Tip { id: string; where: Where; text: string }

/** Shown in this order when nothing more specific is waiting. */
const TIPS: Tip[] = [
  { id: 'welcome', where: 'main', text: 'Hello! Pick a scene on the right and watch it dance to your sound. There are no wrong moves here.' },
  { id: 'orbit', where: 'main', text: 'Psst: drag the picture to fly around it, and scroll to zoom. The particles don\'t mind.' },
  { id: 'logics', where: 'main', text: 'Same scene, new mood: try another logic to change how the music pushes things around.' },
  { id: 'keys', where: 'main', text: 'H hides this panel, F goes fullscreen, Space freezes time. Very dramatic.' },
  { id: 'studio', where: 'main', text: 'Feeling creative? “✦ New in studio” lets you build a scene of your own. No code, just sliders and curiosity.' },
  { id: 'sets', where: 'main', text: 'Found a look you love? “+ Add current” tucks it into a set, ready for showtime.' },
  { id: 'projector', where: 'main', text: 'Got a projector or a second screen? “Open projector window” sends the visuals there and keeps the buttons here.' },

  { id: 'st-welcome', where: 'studio', text: 'Welcome to the studio! Everything here changes the scene while it plays, so poke at things and see what happens.' },
  { id: 'st-camera', where: 'studio', text: 'Drag the view to frame your shot. The camera settings follow you, so what you see is what you save.' },
  { id: 'st-layers', where: 'studio', text: 'One layer gets lonely. Add another shape or a 3D model with “+ Add layer…”.' },
  { id: 'st-move', where: 'studio', text: 'Press “✥ Move” (or M), then drag a shape in the view to slide it around.' },
  { id: 'st-morph', where: 'studio', text: 'Give a layer a second form and it will melt from one into the other. Try a sphere that becomes a galaxy.' },
  { id: 'st-map', where: 'studio', text: 'Mappings are the fun part: pick a sound, pick a setting, and let the music do the work.' },
  { id: 'st-spectrum', where: 'studio', text: '“Spectrum across the shape” turns a layer into a living equaliser: bass at one end, sparkle at the other.' },
  { id: 'st-record', where: 'studio', text: 'Open “Loop recorder”, hit Record and wiggle things. Your moves come back as a loop.' },
  { id: 'st-save', where: 'studio', text: 'Like what you made? “Save scene” keeps it in your scene list.' },

  // Shown only when something happens (never in the idle rotation).
  { id: 'st-move-on', where: 'studio', text: 'Move is on: click a shape to grab it and drag. Scroll to resize it, hold Shift to push it away or pull it closer. Press M when you\'re done.' },
  { id: 'st-recording', where: 'studio', text: 'Recording! Move sliders, drag layers, swing the camera. Press Stop when you\'ve had your fun.' },
  { id: 'st-loop-made', where: 'studio', text: 'That\'s a loop! It keeps playing here and in the saved scene. Untick “Play the loop” to pause it.' },
  { id: 'st-saved', where: 'studio', text: 'Saved. Head “← Back” to find it in the scene list, or keep tinkering.' },
];
const ON_EVENT_ONLY = new Set(['st-move-on', 'st-recording', 'st-loop-made', 'st-saved']);

const KEY_ON = 'vis.tips', KEY_SEEN = 'vis.tipsSeen';
const SHOW_MS = 14000, GAP_MS = 22000;

export class Tips {
  enabled = localStorage.getItem(KEY_ON) !== '0';
  private seen = new Set<string>(JSON.parse(localStorage.getItem(KEY_SEEN) ?? '[]'));
  private box: HTMLElement;
  private text: HTMLElement;
  private hideTimer = 0;
  private lastShown = 0;
  private started = false;
  /** Called when tips are switched on or off from the bubble, so a checkbox elsewhere can follow. */
  onToggle?: (on: boolean) => void;

  constructor(private where: () => Where) {
    this.box = document.createElement('div');
    this.box.id = 'tip';
    this.box.hidden = true;
    this.box.setAttribute('role', 'status');
    this.box.innerHTML = '<div class="tip-text"></div><div class="tip-row"><button data-a="ok">Got it</button><button data-a="off" class="tip-off">No more tips</button></div>';
    this.text = this.box.querySelector('.tip-text')!;
    this.box.querySelector<HTMLButtonElement>('[data-a="ok"]')!.onclick = () => this.hide();
    this.box.querySelector<HTMLButtonElement>('[data-a="off"]')!.onclick = () => { this.setEnabled(false); this.onToggle?.(false); };
    document.body.append(this.box);
    // Every so often, when nothing is showing, offer the next tip that fits where the user is.
    setInterval(() => {
      if (!this.enabled || !this.started || !this.box.hidden || document.hidden) return;
      if (performance.now() - this.lastShown < GAP_MS) return;
      const next = TIPS.find((t) => t.where === this.where() && !ON_EVENT_ONLY.has(t.id) && !this.seen.has(t.id));
      if (next) this.display(next);
    }, 2000);
  }

  /** Begin the idle rotation (once the user has started the app). */
  start() { this.started = true; this.lastShown = performance.now() - GAP_MS + 1500; }

  /** Show one tip now, if tips are on and it hasn't been shown before. */
  show(id: string) {
    const tip = TIPS.find((t) => t.id === id);
    if (tip && this.enabled && !this.seen.has(id)) this.display(tip);
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    localStorage.setItem(KEY_ON, on ? '1' : '0');
    if (!on) this.hide();
    else {
      // Switched back on: start over, so the tips are there for whoever asked for them.
      this.seen.clear();
      localStorage.setItem(KEY_SEEN, '[]');
      this.lastShown = performance.now() - GAP_MS + 800;
    }
  }

  private display(tip: Tip) {
    this.seen.add(tip.id);
    localStorage.setItem(KEY_SEEN, JSON.stringify([...this.seen]));
    this.text.textContent = tip.text;
    this.box.hidden = false;
    this.lastShown = performance.now();
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.hide(), SHOW_MS);
  }

  private hide() {
    clearTimeout(this.hideTimer);
    this.box.hidden = true;
    this.lastShown = performance.now();
  }
}
