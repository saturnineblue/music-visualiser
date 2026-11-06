import { Engine } from './engine/engine';
import { api, type Library } from './ui/api';
import { Controls } from './ui/controls';
import { DEFAULT_MACROS, type LogicDefinition } from './engine/types';

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

let library: Library = { scenes: [], logics: [] };
let currentLogicId = store.get('logic', '');

async function refreshLibrary() {
  library = await api.library();
  renderLists();
}

function renderLists() {
  const sceneList = $('#scene-list');
  sceneList.innerHTML = '';
  for (const s of library.scenes) {
    const li = document.createElement('li');
    li.className = engine.scene?.id === s.id ? 'active' : '';
    li.innerHTML = `<div><span class="name"></span><span class="badge"></span></div><div class="desc"></div>`;
    li.querySelector('.name')!.textContent = s.name;
    li.querySelector('.badge')!.textContent = s.author;
    li.querySelector('.desc')!.textContent = s.description;
    li.onclick = () => loadScene(s.id);
    sceneList.appendChild(li);
  }
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

async function loadScene(id: string): Promise<boolean> {
  try {
    const def = await api.loadScene(id);
    const ok = engine.setScene(def);
    if (ok) {
      store.set('scene', id);
      if (!currentLogicId && def.defaultLogic) await loadLogic(def.defaultLogic);
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
    if (kind === 'scene' && engine.scene?.id === id) loadScene(id);
    if (kind === 'logic' && currentLogicId === id) loadLogic(id);
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
      await audio.useDemo();
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
}
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
  await audio.init();
  startInput(b.dataset.start!);
}));

// ---------- Scenes / logics ----------
$('#new-scene').onclick = async () => {
  const name = prompt('Name for the new scene:', 'My Scene');
  if (!name) return;
  const { id } = await api.newScene(name);
  await refreshLibrary();
  await loadScene(id);
  showInfo(`Created scenes/${id}.ts — edit it in your editor (or ask Claude); it hot-reloads.`);
};
$('#add-mapping').onclick = () => controls.addMapping();
$('#save-logic').onclick = async () => {
  const cur = engine.logic.logic;
  const name = prompt('Save logic as:', cur.name);
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
let online = store.get('online', '0') === '1';
let hasKey = false;
const toggle = $<HTMLInputElement>('#online-toggle');
toggle.checked = online;

async function applyOnline() {
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
  $('#hud-text').textContent =
    `${engine.fps.toFixed(0)} fps · ${engine.scene?.name ?? '—'} · ${engine.logic.logic.name} · ` +
    `${engine.field?.count.toLocaleString() ?? 0} particles · ${f.bpm ? f.bpm + ' bpm' : '— bpm'} · ${online ? 'online' : 'offline'}`;
}, 1000 / 30);

// ---------- Keys ----------
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('input, textarea, select')) return;
  if (e.key === 'h' || e.key === 'H') {
    const hidden = $('#panel').classList.toggle('hidden');
    $('#hud').classList.toggle('hidden', hidden);
    engine.renderer.setInsetRight(hidden ? 0 : $('#panel').offsetWidth);
  }
  if (e.key === 'f' || e.key === 'F') {
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen();
  }
  if (e.key === ' ') { engine.paused = !engine.paused; e.preventDefault(); }
});

// ---------- Boot ----------
engine.renderer.setInsetRight($('#panel').offsetWidth);
(async () => {
  applyOnline();
  await refreshLibrary();
  if (currentLogicId && !library.logics.some((l) => l.id === currentLogicId)) currentLogicId = '';
  const sceneId = store.get('scene', 'morphing-forms');
  const ok = await loadScene(library.scenes.some((s) => s.id === sceneId) ? sceneId : 'morphing-forms');
  if (!ok && sceneId !== 'morphing-forms') await loadScene('morphing-forms');
  if (currentLogicId) await loadLogic(currentLogicId);
  else if (!engine.logic.logic.mappings.length) await loadLogic('balanced');
})();

// Debug handle (handy in the devtools console and for future tooling).
(window as unknown as { vis: unknown }).vis = { engine, audio, api };
