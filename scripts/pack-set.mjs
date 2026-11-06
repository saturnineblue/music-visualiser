#!/usr/bin/env node
/**
 * Make a scene set self-contained: embed every entry's scene (TypeScript source + compiled JS)
 * and every model those scenes use. See docs/SETS.md.
 *
 *   npm run pack-set -- sets/my-gig.set.json            (rewrites the file in place)
 *   npm run pack-set -- sets/my-gig.set.json -o out.set.json
 *
 * Scenes are taken from the set's own `scenes` if present, otherwise from scenes/<id>.ts.
 * Logics given as an id string are inlined from logics/<id>.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { transformWithEsbuild } from 'vite';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('-'));
const oi = args.indexOf('-o');
const output = oi >= 0 ? args[oi + 1] : input;
if (!input) {
  console.error('Usage: npm run pack-set -- <file.set.json> [-o <out.set.json>]');
  process.exit(1);
}

const set = JSON.parse(fs.readFileSync(input, 'utf8'));
if (set.format !== 'music-visualiser-set') throw new Error('Not a scene set: "format" must be "music-visualiser-set".');
if (!Array.isArray(set.entries) || !set.entries.length) throw new Error('The set needs a non-empty "entries" list.');
set.version = 1;
set.name ||= path.basename(input).replace(/\.set\.json$|\.json$/, '');

const compile = async (id, source) =>
  (await transformWithEsbuild(source, `${id}.ts`, { loader: 'ts', format: 'esm', target: 'es2022', sourcemap: false })).code;

const scenes = {};
const modelIds = new Set();
for (const e of set.entries) {
  e.label ||= e.scene;
  if (typeof e.logic === 'string') {
    const f = path.join(ROOT, 'logics', `${e.logic}.json`);
    if (!fs.existsSync(f)) throw new Error(`Entry "${e.label}": logic "${e.logic}" not found in logics/.`);
    e.logic = { ...JSON.parse(fs.readFileSync(f, 'utf8')), id: e.logic };
  }
  if (scenes[e.scene]) continue;
  let source = set.scenes?.[e.scene]?.source;
  if (!source) {
    const f = path.join(ROOT, 'scenes', `${e.scene}.ts`);
    if (!fs.existsSync(f)) throw new Error(`Entry "${e.label}": scene "${e.scene}" is neither in the set nor in scenes/.`);
    source = fs.readFileSync(f, 'utf8');
  }
  const js = await compile(e.scene, source);
  // Evaluate the module to read which models it declares (scenes have no imports, so this is safe to load).
  const def = (await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)).default;
  if (!def || typeof def.update !== 'function') throw new Error(`Scene "${e.scene}" must default-export an object with update().`);
  if (def.id !== e.scene) console.warn(`warning: scene "${e.scene}" declares id "${def.id}"; the set uses "${e.scene}".`);
  (def.models ?? []).forEach((m) => modelIds.add(m));
  scenes[e.scene] = { source, js };
}

const models = {};
for (const id of modelIds) {
  if (set.models?.[id]) { models[id] = set.models[id]; continue; }
  const f = path.join(ROOT, 'models', `${id}.glb`);
  if (!fs.existsSync(f)) throw new Error(`Model "${id}" not found in models/.`);
  models[id] = fs.readFileSync(f).toString('base64');
}

const out = { format: set.format, version: 1, name: set.name, description: set.description, entries: set.entries, scenes, models };
fs.writeFileSync(output, JSON.stringify(out));
const kb = (fs.statSync(output).size / 1024).toFixed(0);
console.log(`Packed "${out.name}" → ${output} (${kb} KB): ${out.entries.length} entries, ${Object.keys(scenes).length} scenes, ${Object.keys(models).length} models.`);
