import { del, get, list, put } from '@vercel/blob';

/**
 * Hosted library storage (Vercel Function): studio scenes and 3D models kept in a private
 * Vercel Blob store, so the hosted site can save them on the server instead of in one browser.
 *
 *   GET    /api/cloud                 → { enabled, scenes: [...], models: [...] }
 *   GET    /api/cloud?scene=<id>      → the scene's studio spec (JSON)
 *   GET    /api/cloud?model=<id>      → the model (.glb)
 *   PUT    /api/cloud?scene=<id>[&overwrite=1]   body: studio spec JSON
 *   PUT    /api/cloud?model=<id>[&overwrite=1]   body: .glb bytes (4 MB at most)
 *   DELETE /api/cloud?scene=<id> | ?model=<id>
 *
 * Only runs on Vercel, behind middleware.ts (the site password), which is the access control:
 * the store is private, and this function is the only way to read or write it. `npm run dev`
 * never calls it. Keep this file free of imports from src/: it is bundled on its own.
 */

const ACCESS = 'private' as const;
/** Vercel Functions accept request bodies up to 4.5 MB. */
const MAX_MODEL_BYTES = 4 * 1024 * 1024;
const MAX_SCENE_BYTES = 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{0,59}$/;
const INDEX = 'index.json';

interface SceneEntry { name: string; description: string; updatedAt: number }
interface ModelEntry { parts: string[]; size: number; updatedAt: number }
/** One small file listing everything, so loading the library is a single read. */
interface Index { scenes: Record<string, SceneEntry>; models: Record<string, ModelEntry> }

/** Use the store's read-write token when it is set (an explicit token always wins over other credentials). */
const auth = () => (process.env.BLOB_READ_WRITE_TOKEN ? { token: process.env.BLOB_READ_WRITE_TOKEN } : {});

const configured = () => !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const fail = (status: number, error: string) => json({ error }, status);

async function read(pathname: string) {
  const r = await get(pathname, { access: ACCESS, useCache: false, ...auth() });
  return r && r.statusCode === 200 && r.stream ? r : null;
}

async function readJson<T>(pathname: string): Promise<T | null> {
  const r = await read(pathname);
  if (!r) return null;
  try { return JSON.parse(await new Response(r.stream).text()) as T; } catch { return null; }
}

const writeJson = (pathname: string, value: unknown) =>
  put(pathname, JSON.stringify(value), { access: ACCESS, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60, ...auth() });

/** Mesh-bearing node names in a .glb (its JSON chunk): the parts a scene can animate. */
function glbParts(bytes: Uint8Array): string[] {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const len = view.getUint32(12, true);
    const j = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len)));
    const names = (j.nodes ?? []).filter((n: { mesh?: number }) => n.mesh !== undefined)
      .map((n: { name?: string; mesh: number }) => String(n.name || j.meshes?.[n.mesh]?.name || 'part')
        .replace(/_\d+$/, '').replace(/\.?\d{3}$/, '').toLowerCase());
    return [...new Set<string>(names)].slice(0, 64);
  } catch {
    return [];
  }
}

const sceneEntry = (spec: Record<string, unknown>, updatedAt: number): SceneEntry => ({
  name: String(spec.name ?? '').slice(0, 120) || 'Untitled',
  description: String(spec.description ?? '').slice(0, 400),
  updatedAt,
});

/** The index, rebuilt from the store's contents if it is missing or unreadable. */
async function loadIndex(): Promise<Index> {
  const saved = await readJson<Index>(INDEX);
  if (saved && typeof saved.scenes === 'object' && typeof saved.models === 'object') return saved;
  const index: Index = { scenes: {}, models: {} };
  let cursor: string | undefined;
  do {
    const page = await list({ cursor, limit: 1000, ...auth() });
    for (const b of page.blobs) {
      const at = new Date(b.uploadedAt).getTime();
      let m = /^scenes\/([a-z0-9-]+)\.json$/.exec(b.pathname);
      if (m) {
        const spec = await readJson<Record<string, unknown>>(b.pathname);
        if (spec) index.scenes[m[1]] = sceneEntry(spec, at);
        continue;
      }
      m = /^models\/([a-z0-9-]+)\.glb$/.exec(b.pathname);
      if (m) index.models[m[1]] = { parts: [], size: b.size, updatedAt: at };
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  await writeJson(INDEX, index);
  return index;
}

async function bodyBytes(request: Request, limit: number): Promise<Uint8Array | null> {
  if (Number(request.headers.get('content-length') ?? 0) > limit) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  return bytes.byteLength > limit ? null : bytes;
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const scene = url.searchParams.get('scene'), model = url.searchParams.get('model');
  const overwrite = url.searchParams.get('overwrite') === '1';
  const method = request.method;

  if (!configured()) {
    // No Blob store connected to this deployment: the app falls back to saving in the browser.
    return method === 'GET' && !scene && !model ? json({ enabled: false, scenes: [], models: [] }) : fail(501, 'Cloud storage is not set up for this site.');
  }
  if ((scene !== null && !ID.test(scene)) || (model !== null && !ID.test(model))) return fail(400, 'Bad id.');
  if (scene !== null && model !== null) return fail(400, 'Give a scene or a model, not both.');

  if (method === 'GET') {
    if (scene) {
      const spec = await readJson<unknown>(`scenes/${scene}.json`);
      return spec ? json(spec) : fail(404, 'No such scene.');
    }
    if (model) {
      const r = await read(`models/${model}.glb`);
      if (!r) return fail(404, 'No such model.');
      // A versioned URL (?v=…) never changes, so the browser may keep it.
      const cache = url.searchParams.has('v') ? 'private, max-age=31536000, immutable' : 'no-store';
      return new Response(r.stream, { headers: { 'Content-Type': 'model/gltf-binary', 'Cache-Control': cache } });
    }
    const index = await loadIndex();
    return json({
      enabled: true,
      scenes: Object.entries(index.scenes).map(([id, s]) => ({ id, ...s })),
      models: Object.entries(index.models).map(([id, m]) => ({ id, ...m })),
    });
  }

  if (method === 'PUT') {
    if (scene) {
      const bytes = await bodyBytes(request, MAX_SCENE_BYTES);
      if (!bytes) return fail(413, 'That scene is too large to save.');
      let spec: Record<string, unknown>;
      try { spec = JSON.parse(new TextDecoder().decode(bytes)); } catch { return fail(400, 'The scene is not valid JSON.'); }
      if (!spec || typeof spec !== 'object' || spec.format !== 'music-visualiser-studio') return fail(400, 'Not a studio scene.');
      const index = await loadIndex();
      if (index.scenes[scene] && !overwrite) return fail(409, `A scene with the id "${scene}" already exists.`);
      spec.id = scene;
      await writeJson(`scenes/${scene}.json`, spec);
      index.scenes[scene] = sceneEntry(spec, Date.now());
      await writeJson(INDEX, index);
      return json({ id: scene, ...index.scenes[scene] });
    }
    if (model) {
      const bytes = await bodyBytes(request, MAX_MODEL_BYTES);
      if (!bytes) return fail(413, `That model is larger than ${MAX_MODEL_BYTES / 1024 / 1024} MB, the most this site can store.`);
      if (new TextDecoder().decode(bytes.subarray(0, 4)) !== 'glTF') return fail(400, 'Not a valid .glb file.');
      const index = await loadIndex();
      const replaced = !!index.models[model];
      if (replaced && !overwrite) return fail(409, `A model with the id "${model}" already exists.`);
      await put(`models/${model}.glb`, Buffer.from(bytes), { access: ACCESS, allowOverwrite: true, contentType: 'model/gltf-binary', cacheControlMaxAge: 60, ...auth() });
      index.models[model] = { parts: glbParts(bytes), size: bytes.byteLength, updatedAt: Date.now() };
      await writeJson(INDEX, index);
      return json({ id: model, replaced, ...index.models[model] });
    }
    return fail(400, 'Say which scene or model to save.');
  }

  if (method === 'DELETE') {
    if (!scene && !model) return fail(400, 'Say which scene or model to delete.');
    const index = await loadIndex();
    if (scene) { await del(`scenes/${scene}.json`, auth()); delete index.scenes[scene]; }
    if (model) { await del(`models/${model}.glb`, auth()); delete index.models[model]; }
    await writeJson(INDEX, index);
    return json({ ok: true });
  }

  return fail(405, 'Method not allowed.');
}

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handle(request);
    } catch (e) {
      console.error('[cloud]', e);
      return fail(500, `Cloud storage error: ${(e as Error).message}`);
    }
  },
};
