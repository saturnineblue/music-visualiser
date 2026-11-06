import type { LogicDefinition, SceneDefinition } from '../engine/types';
import type { Library } from './api';

/**
 * The hosted (production) library: scenes, logics and models bundled at build time.
 * Only imported in production builds. In dev these globs would make Vite watch scenes/ and
 * models/ and reload the page whenever a file is added (e.g. mid-generation).
 */

const sceneModules = import.meta.glob<{ default: SceneDefinition }>('/scenes/*.ts');
const sceneSources = import.meta.glob<string>('/scenes/*.ts', { query: '?raw', import: 'default' });
const logicModules = import.meta.glob<LogicDefinition>('/logics/*.json', { import: 'default' });
const modelUrls = import.meta.glob<string>('/models/*.glb', { eager: true, query: '?url', import: 'default' });
const fileId = (path: string) => path.replace(/^.*\/|\.(ts|json|glb)$/g, '');

function grab(src: string, key: string) {
  const m = src.match(new RegExp(`${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`));
  return m ? m[2] : undefined;
}

export async function staticLibrary(): Promise<Library> {
  const scenes = await Promise.all(
    Object.entries(sceneSources)
      .filter(([p]) => !fileId(p).startsWith('_') && fileId(p) !== 'my-scene')
      .map(async ([p, load]) => {
        const src = await load();
        const id = fileId(p);
        return { id, name: grab(src, 'name') ?? id, description: grab(src, 'description') ?? '', author: grab(src, 'author') ?? '' };
      }),
  );
  const logics = await Promise.all(
    Object.entries(logicModules).map(async ([p, load]) => {
      const j = await load();
      return { id: fileId(p), name: j.name ?? fileId(p), description: j.description ?? '', author: j.author ?? '' };
    }),
  );
  const models = Object.keys(modelUrls).map((p) => ({ id: fileId(p), parts: [] }));
  return { scenes, logics, models };
}

export async function loadSceneModule(id: string): Promise<{ default: SceneDefinition }> {
  const load = sceneModules[`/scenes/${id}.ts`];
  if (!load) throw new Error(`Unknown scene "${id}"`);
  return load();
}

export async function loadLogic(id: string): Promise<LogicDefinition> {
  const load = logicModules[`/logics/${id}.json`];
  if (!load) throw new Error(`Unknown logic "${id}"`);
  return structuredClone(await load());
}

export function modelUrl(id: string): string {
  const url = modelUrls[`/models/${id}.glb`];
  if (!url) throw new Error(`Unknown model "${id}"`);
  return url;
}
