import { Engine } from './engine/engine';
import { api, HOSTED, type Library } from './ui/api';
import { Controls } from './ui/controls';
import { DEFAULT_MACROS, type LogicDefinition, type PointModel, type SceneDefinition } from './engine/types';
import { loadPointModel, invalidateModel } from './engine/models';
import { SetManager, entryMacros, type SetEntry } from './ui/sets';
import { askText } from './ui/dialog';
import { Studio } from './studio/ui';
import { Tips } from './ui/tips';
import { DEMO_PATTERNS } from './audio/demoSynth';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const store = {
  get: (k: string, d: string) => localStorage.getItem('vis.' + k) ?? d,
  set: (k: string, v: string) => localStorage.setItem('vis.' + k, v),
};

// ---------- Engine ----------
let lastError: { sceneId: string; message: string } | null = null;

const engine = new Engine($('#stage'), {
  onSceneError(sceneId, error, phase) {
    console.error(`[scene ${sceneId}] ${phase}:`, error);
    lastError = { sceneId, message: `${error.name}: ${error.message}\n${(error.stack ?? '').split('\n').slice(1, 4).join('\n')}` };
    showToast(`Scene "${sceneId}" failed during ${phase} — previous scene restored.\n\n${lastError.message}`, true);
  },
});
const controls = new Controls($('#gui'), engine);

// ---------- Scene sets ----------
const sets = new SetManager($('#set-section'), {
  async apply(e: SetEntry) {
    if (!(await loadScene(e.scene, true))) return false;
    try {
      const logic = typeof e.logic === 'string' ? await api.loadLogic(e.logic) : structuredClone(e.logic);
      engine.setLogic(logic);
      currentLogicId = logic.id;
      Object.assign(engine.logic.baseMacros, entryMacros(e, logic));
      for (const [k, v] of Object.entries(e.params ?? {})) {
        const spec = engine.logic.paramSpecs[k];
        if (spec && typeof v === 'number' && isFinite(v)) engine.logic.baseParams[k] = Math.min(spec.max, Math.max(spec.min, v));
      }
    } catch (err) {
      showToast(`Entry "${e.label}": could not load logic: ${(err as Error).message}`, false);
    }
    controls.rebuild();
    renderLists();
    return true;
  },
  capture() {
    if (!engine.scene) return null;
    return {
      label: engine.scene.name,
      scene: engine.scene.id,
      logic: structuredClone(engine.logic.logic),
      macros: { ...engine.logic.baseMacros },
      params: { ...engine.logic.baseParams },
    };
  },
  libraryScenes: () => library.scenes,
  loadLibraryScene: (id) => api.loadScene(id),
  changed() { renderLists(); },
  toast: (msg) => showToast(msg, false),
});

// ---------- Scene Studio ----------
let beforeStudio = '';
const studio = new Studio($('#studio-section'), {
  engine,
  models: () => library.models,
  sceneIds: () => library.scenes.map((s) => s.id),
  async run(def) {
    try {
      const models = await loadModels(def);
      const ok = engine.setScene(def, models);
      controls.rebuild();
      return ok;
    } catch (e) {
      showToast(`Could not show the scene: ${(e as Error).message}`, false);
      return false;
    }
  },
  refresh: () => refreshLibrary(),
  async closed(sceneId) {
    engine.renderer.setInsetRight($('#panel').offsetWidth);
    const id = sceneId ?? beforeStudio;
    if (!(await loadScene(library.scenes.some((s) => s.id === id) || sets.sceneDef(id) ? id : 'morphing-forms'))) await loadScene('morphing-forms');
  },
  toast: (msg) => showToast(msg, false),
  async cannotGenerate() {
    if (HOSTED) return 'Building models with Claude and Blender only works in the local app.';
    if (!online) return 'Switch to Online (top of the panel) to let Claude build models.';
    try {
      const s = await api.status();
      if (!s.hasKey) return 'No ANTHROPIC_API_KEY. Add it to .env and restart `npm run dev`.';
      if (!s.blender) return 'Blender was not found. Install it, or set BLENDER_PATH in .env.';
      return null;
    } catch (e) {
      return `Status check failed: ${(e as Error).message}`;
    }
  },
  claudeModel: () => $<HTMLSelectElement>('#claude-model').value,
  tip: (id) => tips.show(id),
  toggleOutput: () => toggleOutput(),
  outputOpen: () => engine.renderer.outputOpen,
});

// ---------- First-time tips ----------
const tips = new Tips(() => (studio.isOpen ? 'studio' : 'main'));
const tipsToggle = $<HTMLInputElement>('#tips-toggle');
tipsToggle.checked = tips.enabled;
tipsToggle.onchange = () => tips.setEnabled(tipsToggle.checked);
tips.onToggle = (on) => { tipsToggle.checked = on; };
function openStudio(existing?: unknown) {
  beforeStudio = engine.scene?.id ?? '';
  if (engine.renderer.outputOpen) ensurePreview();
  studio.open(existing).then(() => engine.renderer.setInsetRight($('#panel').offsetWidth));
}
$('#studio-new').onclick = () => openStudio();
$('#studio-edit').onclick = () => { if (engine.scene?.studio) openStudio(engine.scene.studio); };

let library: Library = { scenes: [], logics: [], models: [] };
let currentLogicId = store.get('logic', '');

async function refreshLibrary() {
  library = await api.library();
  renderLists();
  studio.libraryChanged();
  if (HOSTED) {
    $('#model-drop-hint').hidden = !api.canUploadModels();
    $('#online-status').innerHTML =
      `Hosted version: scenes you build in the studio are saved ${api.canUploadModels() ? 'on the site' : 'in this browser'}. To generate scenes or 3D models with Claude, ` +
      '<a href="https://github.com/saturnineblue/music-visualiser" target="_blank" rel="noopener">run it locally</a>.';
  }
}

function renderLists() {
  $('#studio-edit').hidden = !engine.scene?.studio;
  const sceneList = $('#scene-list');
  sceneList.innerHTML = '';
  for (const s of [...library.scenes, ...sets.extraScenes()]) {
    const li = document.createElement('li');
    li.className = engine.scene?.id === s.id ? 'active' : '';
    li.innerHTML = `<div><span class="name"></span><span class="badge"></span></div><div class="desc"></div>`;
    li.querySelector('.name')!.textContent = s.name;
    li.querySelector('.badge')!.textContent = s.author;
    li.querySelector('.desc')!.textContent = s.description;
    li.onclick = () => loadScene(s.id);
    sceneList.appendChild(li);
  }
  const modelList = $('#model-list');
  modelList.textContent = library.models.length
    ? library.models.map((m) => m.parts.length ? `${m.id} (${m.parts.join(', ')})` : m.id).join(' · ')
    : 'none yet';
  const logicList = $('#logic-list');
  logicList.innerHTML = '';
  for (const l of library.logics) {
    const li = document.createElement('li');
    li.className = currentLogicId === l.id ? 'active' : '';
    li.innerHTML = `<div><span class="name"></span><span class="badge"></span></div><div class="desc"></div>`;
    li.querySelector('.name')!.textContent = l.name;
    li.querySelector('.badge')!.textContent = l.author;
    li.querySelector('.desc')!.textContent = l.description;
    li.onclick = () => loadLogic(l.id);
    logicList.appendChild(li);
  }
}

// Bumped when a model file changes, so its URL (and cache entry) changes too.
const modelVersions: Record<string, number> = {};

async function loadModels(def: SceneDefinition): Promise<Record<string, PointModel>> {
  const count = Engine.particleCount(def);
  const out: Record<string, PointModel> = {};
  await Promise.all((def.models ?? []).map(async (mid) => {
    const fromSet = sets.modelUrl(mid);
    if (!fromSet && !library.models.some((m) => m.id === mid)) throw new Error(`Model "${mid}" not found. Put ${mid}.glb in models/.`);
    out[mid] = await loadPointModel(mid, fromSet ?? await api.modelUrl(mid, modelVersions[mid] ?? 0), count);
  }));
  return out;
}

async function loadScene(id: string, fromSet = false): Promise<boolean> {
  try {
    // A scene set may carry its own version of a scene; it wins over the library's.
    const def = sets.sceneDef(id) ?? await api.loadScene(id);
    const models = await loadModels(def);
    const ok = engine.setScene(def, models);
    if (ok) {
      store.set('scene', id);
      if (!fromSet) sets.sceneChanged(id);
      if (!fromSet && !currentLogicId && def.defaultLogic) await loadLogic(def.defaultLogic);
    }
    controls.rebuild();
    renderLists();
    return ok;
  } catch (e) {
    const err = e as Error;
    lastError = { sceneId: id, message: err.message };
    showToast(`Could not load scene "${id}":\n${err.message}`, true);
    return false;
  }
}

async function loadLogic(id: string) {
  try {
    const logic = await api.loadLogic(id);
    engine.setLogic(logic);
    currentLogicId = id;
    store.set('logic', id);
    controls.rebuild();
    renderLists();
  } catch (e) {
    showToast(`Could not load logic "${id}": ${(e as Error).message}`, false);
  }
}

// Hot reload: files in scenes/ and logics/ changed (by you, Claude Code, or the Claude panel).
if (import.meta.hot) {
  import.meta.hot.on('vis:library', async ({ kind, id }: { kind: string; id: string }) => {
    await refreshLibrary();
    // The studio is editing this scene live: its own save must not swap the running scene.
    if (kind === 'scene' && engine.scene?.id === id && !studio.owns(id)) loadScene(id);
    if (kind === 'logic' && currentLogicId === id) loadLogic(id);
    if (kind === 'model') {
      invalidateModel(id);
      modelVersions[id] = (modelVersions[id] ?? 0) + 1;
      if (engine.scene?.models?.includes(id) && !studio.isOpen) loadScene(engine.scene.id);
    }
  });
}

// ---------- Toast ----------
function showToast(msg: string, offerFix: boolean) {
  $('#toast-msg').textContent = msg;
  $('#toast-fix').hidden = !(offerFix && online && hasKey);
  $('#toast').hidden = false;
}
$('#toast-close').onclick = () => ($('#toast').hidden = true);
$('#toast-fix').onclick = () => {
  if (!lastError) return;
  $('#toast').hidden = true;
  runClaude({ mode: 'fix-scene', sceneId: lastError.sceneId, error: lastError.message, prompt: '' });
};

// ---------- Audio ----------
const audio = engine.audio;
const fileInput = $<HTMLInputElement>('#file-input');

async function startInput(kind: string) {
  try {
    if (kind === 'mic') {
      await audio.useMic(store.get('device', '') || undefined);
      await fillDevices();
    } else if (kind === 'file') {
      fileInput.click();
      return;
    } else if (kind === 'demo') {
      // Pressing Demo while a demo beat is playing steps to the next one; otherwise the last one used comes back.
      const count = DEMO_PATTERNS.length;
      const next = audio.kind === 'demo' ? (audio.demoPattern + 1) % count : Math.min(count - 1, Math.max(0, +store.get('demo', '0') || 0));
      await audio.useDemo(next);
      store.set('demo', String(next));
    } else {
      audio.stop();
    }
    store.set('input', kind);
  } catch (e) {
    showToast(`Audio input failed: ${(e as Error).message}`, false);
  }
  markInput();
}
fileInput.onchange = async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  try { await audio.useFile(f); } catch (e) { showToast(`Could not play file: ${(e as Error).message}`, false); }
  markInput();
};
function markInput() {
  document.querySelectorAll<HTMLButtonElement>('[data-input]').forEach((b) =>
    b.classList.toggle('active', b.dataset.input === audio.kind));
  const demo = audio.kind === 'demo', p = DEMO_PATTERNS[audio.demoPattern];
  $('[data-input="demo"]').textContent = demo ? `Demo ${audio.demoPattern + 1}` : 'Demo';
  $('#demo-name').hidden = !demo;
  if (demo) $('#demo-name').textContent = `Demo ${audio.demoPattern + 1} of ${DEMO_PATTERNS.length}: ${p.name}, ${p.bpm} BPM. ${p.about[0].toUpperCase()}${p.about.slice(1)}. Press Demo again for the next one.`;
  refreshTransport();
}

// File transport: seek bar, play/pause, mouse wheel and arrow-key skipping.
const seek = $<HTMLInputElement>('#seek');
const playPause = $<HTMLButtonElement>('#play-pause');
let seeking = false;
const fmtTime = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
function refreshTransport() {
  const isFile = audio.kind === 'file';
  $('#transport').hidden = !isFile;
  if (!isFile) return;
  const d = audio.fileDuration, t = audio.fileTime;
  $('#track-name').textContent = audio.fileName;
  $('#track-name').title = audio.fileName;
  seek.max = String(d || 1);
  if (!seeking) seek.value = String(t);
  $('#time').textContent = `${fmtTime(seeking ? +seek.value : t)} / ${fmtTime(d)}`;
  playPause.textContent = audio.filePaused ? '▶' : '⏸';
}
function skipFile(by: number) {
  audio.seekFile(audio.fileTime + by);
  refreshTransport();
}
seek.oninput = () => { seeking = true; audio.seekFile(+seek.value); refreshTransport(); };
seek.onchange = () => { seeking = false; refreshTransport(); };
seek.addEventListener('wheel', (e) => {
  e.preventDefault();
  const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  skipFile(Math.sign(delta) * (e.shiftKey ? 30 : 5));
}, { passive: false });
playPause.onclick = async () => {
  try { await audio.toggleFilePlay(); } catch (e) { showToast(`Could not play file: ${(e as Error).message}`, false); }
  refreshTransport();
};
setInterval(refreshTransport, 250);
document.querySelectorAll<HTMLButtonElement>('[data-input]').forEach((b) => (b.onclick = () => startInput(b.dataset.input!)));

async function fillDevices() {
  const sel = $<HTMLSelectElement>('#device');
  const devices = await audio.listDevices();
  sel.innerHTML = devices.map((d) => `<option value="${d.deviceId}">${d.label || 'Input ' + d.deviceId.slice(0, 6)}</option>`).join('');
  sel.value = store.get('device', devices[0]?.deviceId ?? '');
  sel.hidden = devices.length === 0;
}
$<HTMLSelectElement>('#device').hidden = true;
$<HTMLSelectElement>('#device').onchange = (e) => {
  const id = (e.target as HTMLSelectElement).value;
  store.set('device', id);
  if (audio.kind === 'mic') audio.useMic(id);
};
const gain = $<HTMLInputElement>('#gain');
gain.value = store.get('gain', '1');
audio.gain = +gain.value;
gain.oninput = () => { audio.gain = +gain.value; store.set('gain', gain.value); };
const sens = $<HTMLInputElement>('#beat-sens');
sens.value = store.get('beatSens', '1.35');
audio.beatThreshold = +sens.value;
sens.oninput = () => { audio.beatThreshold = +sens.value; store.set('beatSens', sens.value); };
$<HTMLInputElement>('#monitor').onchange = (e) => audio.setMonitor((e.target as HTMLInputElement).checked);

// Start overlay
document.querySelectorAll<HTMLButtonElement>('[data-start]').forEach((b) => (b.onclick = async () => {
  $('#start').classList.add('hidden');
  tips.start();
  await audio.init();
  startInput(b.dataset.start!);
}));

// ---------- Scenes / logics ----------
$('#new-scene').onclick = async () => {
  const name = await askText('Name for the new scene:', 'My Scene', { ok: 'Create' });
  if (!name) return;
  const { id } = await api.newScene(name);
  await refreshLibrary();
  await loadScene(id);
  showInfo(`Created scenes/${id}.ts — edit it in your editor (or ask Claude); it hot-reloads.`);
};
$('#add-mapping').onclick = () => controls.addMapping();
$('#save-logic').onclick = async () => {
  const cur = engine.logic.logic;
  const name = await askText('Save logic as:', cur.name, { ok: 'Save' });
  if (!name) return;
  const logic: LogicDefinition = {
    ...cur,
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name,
    author: cur.author === 'built-in' ? 'you' : cur.author,
    base: { ...DEFAULT_MACROS, ...engine.logic.baseMacros },
  };
  const { id } = await api.saveLogic(logic);
  currentLogicId = id;
  store.set('logic', id);
  await refreshLibrary();
};

// ---------- Online / offline + Claude ----------
let online = !HOSTED && store.get('online', '0') === '1';
let hasKey = false;
const toggle = $<HTMLInputElement>('#online-toggle');
toggle.checked = online;

async function applyOnline() {
  if (HOSTED) {
    $('#online-status').innerHTML =
      'Hosted version: build scenes in the studio (saved in this browser) and play sets. To generate scenes or 3D models with Claude, ' +
      '<a href="https://github.com/saturnineblue/music-visualiser" target="_blank" rel="noopener">run it locally</a>.';
    return;
  }
  $('#online-label').textContent = online ? 'Online' : 'Offline';
  $('#claude-online').hidden = !online;
  $('#claude-offline').hidden = online;
  const status = $('#online-status');
  if (!online) {
    status.innerHTML = 'Offline: no network requests. All scenes and logics run locally.';
    return;
  }
  status.textContent = 'Checking connection…';
  try {
    const s = await api.status();
    hasKey = s.hasKey;
    $<HTMLSelectElement>('#claude-model').value = s.model;
    const objectOption = $<HTMLOptionElement>('#claude-mode option[value="new-object"]');
    objectOption.disabled = !s.blender;
    objectOption.textContent = s.blender ? 'New 3D object (Blender)' : 'New 3D object (needs Blender)';
    if (!s.hasKey) {
      status.innerHTML = '<span style="color:var(--warn)">No ANTHROPIC_API_KEY. Add it to .env and restart <code>npm run dev</code>.</span>';
      return;
    }
    const { reachable } = await api.onlineCheck();
    status.innerHTML = reachable
      ? '<span style="color:var(--ok)">Connected to Claude.</span>'
      : '<span style="color:var(--warn)">Claude API unreachable — check your internet connection.</span>';
  } catch (e) {
    status.textContent = `Status check failed: ${(e as Error).message}`;
  }
}
toggle.onchange = () => {
  online = toggle.checked;
  store.set('online', online ? '1' : '0');
  applyOnline();
};

// Rolling averages of audio features, so Claude can be told what the music is like.
const avg = { rms: 0, bass: 0, mid: 0, high: 0, centroid: 0, flux: 0 };
setInterval(() => {
  const f = audio.features;
  for (const k of Object.keys(avg) as (keyof typeof avg)[]) avg[k] = avg[k] * 0.98 + f[k] * 0.02;
}, 50);
function audioSnapshot() {
  const f = audio.features;
  const parts = Object.entries(avg).map(([k, v]) => `${k}=${v.toFixed(2)}`);
  return `input=${audio.kind}, bpm=${f.bpm || 'unknown'}, ${parts.join(', ')}`;
}

const log = $('#claude-log');
function logLine(text: string, cls = '') {
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = text;
  log.prepend(div);
}
function showInfo(text: string) { logLine(text, 'ok'); }

// Live progress from long generations (New 3D object): text lines and preview renders.
if (import.meta.hot) {
  import.meta.hot.on('vis:claude-progress', ({ text, image }: { text: string; image?: string }) => {
    if (!busy) return;
    const div = document.createElement('div');
    div.className = 'progress';
    div.textContent = text;
    if (image) {
      const img = document.createElement('img');
      img.src = image;
      img.alt = text;
      div.appendChild(img);
    }
    log.prepend(div);
  });
}

let busy = false;
async function runClaude(req: { mode: string; prompt: string; sceneId?: string; error?: string }) {
  if (!online) return showToast('Switch to Online to use Claude.', false);
  if (busy) return;
  busy = true;
  const btn = $<HTMLButtonElement>('#claude-go');
  btn.disabled = true;
  btn.textContent = 'Claude is working…';
  const started = performance.now();
  logLine(`→ ${req.mode}: ${req.prompt || req.error?.split('\n')[0] || ''}`);
  try {
    const body: Record<string, unknown> = {
      ...req,
      model: $<HTMLSelectElement>('#claude-model').value,
      sceneParams: Object.keys(engine.logic.paramSpecs),
    };
    if (req.mode === 'edit-scene' && !req.sceneId) body.sceneId = engine.scene?.id;
    if (req.mode === 'edit-logic') body.logicJson = JSON.stringify(engine.logic.logic, null, 2);
    if ($<HTMLInputElement>('#claude-audio').checked && audio.kind !== 'none') body.audioSnapshot = audioSnapshot();

    const res = await api.claude(body);
    const secs = ((performance.now() - started) / 1000).toFixed(0);
    await refreshLibrary();
    if (res.kind === 'scene') {
      const ok = await loadScene(res.id);
      if (ok && $<HTMLInputElement>('#claude-to-set').checked) sets.addCurrent();
      logLine(`✓ ${ok ? 'Loaded' : 'Saved (but failed to run)'} scene "${res.name}" (scenes/${res.id}.ts, ${secs}s)\n${res.summary}`, ok ? 'ok' : 'err');
    } else {
      await loadLogic(res.id);
      logLine(`✓ Loaded logic "${res.name}" (logics/${res.id}.json, ${secs}s)\n${res.summary}`, 'ok');
    }
  } catch (e) {
    logLine(`✗ ${(e as Error).message}`, 'err');
  } finally {
    busy = false;
    btn.disabled = false;
    btn.textContent = 'Generate';
  }
}
const PLACEHOLDERS: Record<string, string> = {
  'new-scene': 'e.g. A flock of birds that scatters on every snare and regroups into a mountain range on the chorus',
  'edit-scene': 'e.g. Make it calmer and add a slow colour drift',
  'new-logic': 'e.g. Bass swells everything, hi-hats add sparkle, beats flash',
  'edit-logic': 'e.g. Less reaction to vocals, stronger kicks',
  'new-object': 'e.g. A lighthouse on rocks with a lamp room, a spiral of windows and waves around the base. Takes a few minutes: Claude models it in Blender, checks renders, then writes a scene for it.',
};
$('#claude-mode').onchange = () => {
  $<HTMLTextAreaElement>('#claude-prompt').placeholder = PLACEHOLDERS[$<HTMLSelectElement>('#claude-mode').value] ?? '';
};

$('#claude-go').onclick = () => {
  const prompt = $<HTMLTextAreaElement>('#claude-prompt').value.trim();
  if (!prompt) return;
  runClaude({ mode: $<HTMLSelectElement>('#claude-mode').value, prompt });
};

// ---------- HUD ----------
const spec = $<HTMLCanvasElement>('#spectrum');
const sctx = spec.getContext('2d')!;
setInterval(() => {
  const f = audio.features;
  sctx.clearRect(0, 0, spec.width, spec.height);
  const w = spec.width / f.spectrum.length;
  for (let i = 0; i < f.spectrum.length; i++) {
    const v = f.spectrum[i];
    sctx.fillStyle = `hsla(${200 + i * 2}, 80%, ${50 + f.pulse * 20}%, 0.9)`;
    sctx.fillRect(i * w, spec.height - v * spec.height, w - 1, v * spec.height);
  }
  // Light space colours need dark text over the view (status line, object labels, tool hints).
  const bg = engine.renderer.scene.background as { r: number; g: number; b: number } | null;
  document.body.classList.toggle('light-stage', !!bg && 0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b > 0.3);
  $('#hud-text').textContent =
    `${engine.fps.toFixed(0)} fps · ${engine.scene?.name ?? '—'} · ${engine.logic.logic.name} · ` +
    `${engine.field?.count.toLocaleString() ?? 0} particles · ${f.bpm ? f.bpm + ' bpm' : '— bpm'} · ${online ? 'online' : 'offline'}`;
}, 1000 / 30);

// ---------- Output (projector) window ----------
const outputBtn = $<HTMLButtonElement>('#output-btn');
const outputPreview = $<HTMLInputElement>('#output-preview');
outputPreview.checked = store.get('outputPreview', '1') === '1';
engine.renderer.preview = outputPreview.checked;
function refreshOutput() {
  const open = engine.renderer.outputOpen;
  if (open && studio.isOpen) ensurePreview();
  studio.outputChanged();
  outputBtn.textContent = open ? '✕ Close projector window' : '⧉ Open projector window';
  outputBtn.classList.toggle('accent', !open);
  outputBtn.classList.toggle('active', open);
  $('#output-preview-row').hidden = !open;
  $('#output-note').hidden = !open || outputPreview.checked;
  $('#stage').style.visibility = open && !outputPreview.checked ? 'hidden' : '';
  $('#output-status').textContent = open
    ? 'Projector window open. Drag it to the projector, then press F or double-click it for fullscreen (Esc exits). Keep this window visible: it drives the show.'
    : 'Opens a window with only the visuals. Drag it to the projector and press F (or double-click) for fullscreen. Keep this window visible: it drives the show.';
}
engine.renderer.onOutputChange = refreshOutput;
engine.renderer.onOutputKey = handleKey;
outputPreview.onchange = () => {
  engine.renderer.preview = outputPreview.checked;
  store.set('outputPreview', outputPreview.checked ? '1' : '0');
  refreshOutput();
};

/** Chrome/Edge: with the Window Management permission, move the output window onto another screen. */
async function placeOnOtherScreen(win: Window) {
  const w = window as unknown as { getScreenDetails?: () => Promise<{ screens: ScreenLike[]; currentScreen: ScreenLike }> };
  type ScreenLike = { availLeft: number; availTop: number; availWidth: number; availHeight: number; isPrimary: boolean };
  if (!w.getScreenDetails) return;
  try {
    const perm = await navigator.permissions.query({ name: 'window-management' as PermissionName }).catch(() => null);
    if (perm?.state === 'denied') return;
    const details = await w.getScreenDetails();
    const cur = details.currentScreen;
    const other = details.screens.find((s) => s.availLeft !== cur.availLeft || s.availTop !== cur.availTop);
    if (!other || win.closed) return;
    win.moveTo(other.availLeft, other.availTop);
    win.resizeTo(other.availWidth, other.availHeight);
  } catch { /* not supported or not allowed: the user drags it over */ }
}

outputBtn.onclick = () => toggleOutput();
function toggleOutput() {
  if (engine.renderer.outputOpen) { engine.renderer.closeOutput(); return; }
  let win: Window | null = null;
  try {
    win = engine.renderer.openOutput();
  } catch (e) {
    showToast(`Could not start the projector window: ${(e as Error).message}`, false);
    return;
  }
  if (!win) {
    showToast('The browser blocked the projector window. Allow pop-ups for this site, then click the button again.', false);
    return;
  }
  placeOnOtherScreen(win);
}
/** The studio edits what is on screen here, so it needs the preview even while the projector shows the scene. */
function ensurePreview() {
  if (outputPreview.checked) return;
  outputPreview.checked = true;
  outputPreview.onchange?.(new Event('change'));
}
refreshOutput();

// ---------- Keys ----------
// Also receives keys pressed in the projector window (except F, its own fullscreen).
function handleKey(e: KeyboardEvent) {
  if (e.key === 'h' || e.key === 'H') {
    const hidden = $('#panel').classList.toggle('hidden');
    $('#hud').classList.toggle('hidden', hidden);
    engine.renderer.setInsetRight(hidden ? 0 : $('#panel').offsetWidth);
  }
  if (e.key === 'f' || e.key === 'F') {
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen();
  }
  if (e.key === ' ') { engine.paused = !engine.paused; e.preventDefault(); }
  if (studio.isOpen) {
    if (e.key === 'm' || e.key === 'M') studio.setTool(studio.tool === 'move' ? 'navigate' : 'move');
    if (e.key === 'n' || e.key === 'N') studio.setTool('navigate');
    if ((e.key === 'd' || e.key === 'D') && !e.metaKey && !e.ctrlKey && !e.altKey) studio.duplicateSelected();
    if (e.key === 'Escape') studio.escape();
  } else {
    if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) sets.go(+e.key - 1);
    if (e.key === 'PageDown') { sets.next(); e.preventDefault(); }
    if (e.key === 'PageUp') { sets.prev(); e.preventDefault(); }
  }
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && audio.kind === 'file') {
    skipFile((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 30 : 5));
    e.preventDefault();
  }
}
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest?.('input, textarea, select')) return;
  handleKey(e);
});

// ---------- Drag & drop 3D models ----------
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); document.body.classList.add('dropping'); }
});
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
window.addEventListener('drop', async (e) => {
  document.body.classList.remove('dropping');
  const files = [...(e.dataTransfer?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  for (const file of files) {
    if (/\.json$/i.test(file.name)) { await sets.openFile(file); continue; }
    if (!/\.glb$/i.test(file.name)) {
      showToast(`"${file.name}" isn't a .glb model. In Blender: File → Export → glTF 2.0, format "glTF Binary (.glb)".`, false);
      continue;
    }
    try {
      const { id, replaced } = await api.uploadModel(file);
      await refreshLibrary();
      showToast(
        `${replaced ? 'Updated' : 'Added'} model "${id}"${HOSTED ? '' : ` (models/${id}.glb)`}.\n\n` +
        (HOSTED ? 'Add it as a layer in the studio ("+ Add layer…").'
          : `Use it in a scene with  models: ['${id}']  and  ctx.models['${id}'], or ask Claude for a scene that uses it.`),
        false,
      );
    } catch (err) {
      showToast(`Could not import "${file.name}": ${(err as Error).message}`, false);
    }
  }
});

// ---------- Boot ----------
if (HOSTED) {
  for (const sel of ['.switch', '#claude-section', '#new-scene', '#save-logic', '#model-drop-hint']) ($(sel) as HTMLElement).hidden = true;
}
engine.renderer.setInsetRight($('#panel').offsetWidth);
(async () => {
  applyOnline();
  await refreshLibrary();
  await sets.restore();
  if (currentLogicId && !library.logics.some((l) => l.id === currentLogicId)) currentLogicId = '';
  const sceneId = store.get('scene', 'morphing-forms');
  const ok = await loadScene(library.scenes.some((s) => s.id === sceneId) ? sceneId : 'morphing-forms');
  if (!ok && sceneId !== 'morphing-forms') await loadScene('morphing-forms');
  if (currentLogicId) await loadLogic(currentLogicId);
  else if (!engine.logic.logic.mappings.length) await loadLogic('balanced');
})();

// Debug handle (handy in the devtools console and for future tooling).
(window as unknown as { vis: unknown }).vis = { engine, audio, api, sets, studio };
