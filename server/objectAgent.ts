import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BlenderSession } from './blender';

/**
 * "New 3D object": Claude models an object in headless Blender (local), checks it with preview
 * renders, and exports it to models/<id>.glb (+ .blend). A matching scene is generated afterwards.
 */

export interface ObjectProgress { text: string; image?: string /* data URL */ }

export interface ObjectResult { id: string; name: string; summary: string; parts: string[] }

const MAX_OUTPUT = 6000;
const clip = (s: string, n = MAX_OUTPUT) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s);
const safeId = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'object';
const partOf = (name: string) => name.replace(/\.\d{3}$/, '').replace(/_\d+$/, '').toLowerCase();

const SYSTEM = (blenderVersion: string) => `You build 3D objects in Blender ${blenderVersion} (headless, Python API) for a music visualiser that turns them into glowing particles.

How the visualiser uses your model:
- It samples points evenly over every surface, so each point becomes one particle. Silhouettes and clear, readable forms matter far more than fine detail. Small features need enough surface area to show up.
- Each mesh object is a "part" that the music animates separately (e.g. a roof lifting on bass, windows glowing with the highs). Name objects with short lower-case part names: "roof", "walls", "windows". Several objects can share a part: "wheel", "wheel.001". Aim for 3–8 meaningful parts that suit musical motion.
- The particle colour comes from each material's Principled BSDF Base Color. Give every part a material with a clear colour. Textures are not needed.

Modelling rules:
- Z is up, units are metres, real-world scale, object resting on z = 0 and roughly centred on x = y = 0. The front faces -Y.
- The scene starts empty. You have bpy, bmesh, mathutils, math and random already imported. Do not import os, subprocess or anything that touches files, the network or the system.
- Background mode: there is no 3D view or UI context. Prefer bmesh and the data API (bpy.data, object.modifiers) over bpy.ops calls that need a viewport. Modifiers are applied automatically on export.
- Avoid hidden interior faces, duplicate overlapping surfaces and huge ground planes (they waste particles). Keep the total under ~150k triangles.
- Objects whose names start with "_" are ignored (use them for helpers/cutters, or delete them).

Workflow:
1. Plan the parts briefly, then build with run_blender_python (several calls are fine; state persists between calls).
2. Call render_preview to look at it from two angles. Fix anything that looks wrong or unclear.
3. When it's good, call finish_model. Keep your messages short.`;

export async function generateObject(opts: {
  prompt: string;
  apiKey: string;
  model: string;
  blenderPath: string;
  modelsDir: string;
  onProgress: (p: ObjectProgress) => void;
}): Promise<ObjectResult> {
  const { onProgress } = opts;
  onProgress({ text: 'Starting Blender…' });
  const blender = await BlenderSession.start(opts.blenderPath);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-object-'));
  let result: ObjectResult | null = null;
  let renders = 0;

  try {
    const ready = await blender.call({ cmd: 'info' });
    if (!ready.ok) throw new Error(ready.error);

    const runPython = betaZodTool({
      name: 'run_blender_python',
      description: 'Run Python code in the Blender session. State persists between calls. Returns printed output, or the traceback if it fails, plus a summary of the mesh objects in the scene.',
      inputSchema: z.object({
        code: z.string().describe('Python code to run. bpy, bmesh, mathutils, math and random are already imported.'),
      }),
      run: async ({ code }) => {
        const lines = code.split('\n').length;
        onProgress({ text: `Blender: running ${lines} lines of Python` });
        const r = await blender.call({ cmd: 'exec', code }, 120000);
        const info = await blender.call({ cmd: 'info' });
        const summary = info.ok
          ? `Scene: ${(info.objects as { name: string; dims: number[]; tris: number }[])
            .map((o) => `${o.name} [${o.dims.join(' × ')} m, ${o.tris} tris]`).join('; ') || 'no mesh objects'} (total ${info.total_tris} tris)`
          : '';
        if (!r.ok) {
          onProgress({ text: `Blender error: ${(r.error ?? '').trim().split('\n').pop()}` });
          return `ERROR\n${clip(r.error ?? 'unknown error')}${r.output ? `\nOutput before the error:\n${clip(r.output, 2000)}` : ''}\n\n${summary}`;
        }
        return `${r.output ? `Output:\n${clip(r.output)}\n\n` : ''}${summary}`;
      },
    });

    const renderPreview = betaZodTool({
      name: 'render_preview',
      description: 'Render the current model from the front-left and the back-right (solid shading with material colours). Use it to check shape, proportions and colours.',
      inputSchema: z.object({}),
      run: async () => {
        if (renders >= 8) return 'Preview limit reached (8). Finish the model now.';
        const n = ++renders;
        onProgress({ text: `Rendering preview ${n}…` });
        const paths = [path.join(tmp, `preview-${n}-a.png`), path.join(tmp, `preview-${n}-b.png`)];
        const r = await blender.call({ cmd: 'render', paths, size: 640 }, 180000);
        if (!r.ok) return `ERROR\n${clip(r.error ?? 'render failed')}`;
        const images = paths.map((p) => fs.readFileSync(p).toString('base64'));
        onProgress({ text: `Preview ${n}`, image: `data:image/png;base64,${images[0]}` });
        return [
          { type: 'text' as const, text: `Preview ${n}: front-left view, then back-right view.` },
          ...images.map((data) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data } })),
        ];
      },
    });

    const finishModel = betaZodTool({
      name: 'finish_model',
      description: 'Export the finished model to the visualiser. Call once, when the model looks right.',
      inputSchema: z.object({
        id: z.string().describe('kebab-case file id, e.g. "lighthouse"'),
        name: z.string().describe('Display name, e.g. "Lighthouse"'),
        summary: z.string().describe('One sentence describing the object and its parts.'),
      }),
      run: async ({ id, name, summary }) => {
        const info = await blender.call({ cmd: 'info' });
        const objects = (info.objects as { name: string }[] | undefined) ?? [];
        if (!info.ok || !objects.length) return 'ERROR: the scene has no mesh objects to export.';
        let fid = safeId(id), k = 2;
        while (fs.existsSync(path.join(opts.modelsDir, fid + '.glb'))) fid = `${safeId(id)}-${k++}`;
        // Write the .blend first: the .glb appearing is what the app reacts to.
        const r = await blender.call({ cmd: 'export', glb: path.join(tmp, 'export.glb'), blend: path.join(opts.modelsDir, fid + '.blend') }, 120000);
        if (!r.ok) return `ERROR\n${clip(r.error ?? 'export failed')}`;
        fs.copyFileSync(path.join(tmp, 'export.glb'), path.join(opts.modelsDir, fid + '.glb'));
        const parts = [...new Set(objects.map((o) => partOf(o.name)))];
        result = { id: fid, name, summary, parts };
        onProgress({ text: `Saved models/${fid}.glb (parts: ${parts.join(', ')})` });
        return `Exported as models/${fid}.glb with parts: ${parts.join(', ')}. Done.`;
      },
    });

    const client = new Anthropic({ apiKey: opts.apiKey });
    const runner = client.beta.messages.toolRunner({
      model: opts.model,
      max_tokens: 32000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: SYSTEM(String(ready.version ?? '')),
      tools: [runPython, renderPreview, finishModel],
      messages: [{ role: 'user', content: `Build this object: ${opts.prompt}` }],
      max_iterations: 30,
      stream: true,
    });

    let last: Anthropic.Beta.BetaMessage | null = null;
    for await (const stream of runner) {
      if (result) { stream.abort(); break; } // finish_model ran: no need for Claude's closing message
      last = await stream.finalMessage();
      for (const b of last.content) {
        if (b.type === 'text' && b.text.trim()) onProgress({ text: `Claude: ${clip(b.text.trim(), 400)}` });
      }
      if (last.stop_reason === 'refusal') throw new Error('Claude declined this request.');
    }
    if (!result) {
      const why = last?.stop_reason === 'max_tokens' ? ' (response cut off)' : '';
      throw new Error(`Claude stopped before finishing the model${why}. Try again or simplify the request.`);
    }
    return result;
  } finally {
    blender.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
