import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

/**
 * Generates scenes and logics with Claude. Only called when the app is in Online mode.
 * Uses structured outputs so the response is always parseable JSON.
 */

export const SceneOutput = z.object({
  id: z.string().describe('kebab-case id, e.g. "ocean-of-stars"'),
  name: z.string(),
  summary: z.string().describe('One or two sentences: what it looks like and how it reacts to music.'),
  code: z.string().describe('The full TypeScript source of the scene file.'),
});

const Mapping = z.object({
  source: z.enum(['rms', 'bass', 'lowMid', 'mid', 'high', 'centroid', 'flux', 'pulse', 'beat', 'constant']),
  target: z.string(),
  amount: z.number(),
  curve: z.enum(['linear', 'sqrt', 'square', 'exp', 'smooth', 'threshold']),
  attack: z.number(),
  release: z.number(),
  mode: z.enum(['add', 'multiply', 'set']),
});

export const LogicOutput = z.object({
  summary: z.string(),
  logic: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    base: z.object({
      intensity: z.number(), chaos: z.number(), speed: z.number(), hue: z.number(),
      hueSpread: z.number(), brightness: z.number(), size: z.number(), morph: z.number(), impulse: z.number(),
    }),
    mappings: z.array(Mapping),
  }),
});

export type GenerateMode = 'new-scene' | 'edit-scene' | 'fix-scene' | 'new-logic' | 'edit-logic';

export interface GenerateRequest {
  mode: GenerateMode;
  prompt: string;
  model?: string;
  /** Current scene source (edit/fix) */
  sceneSource?: string;
  sceneId?: string;
  /** Current logic JSON (edit) */
  logicJson?: string;
  /** Scene params, so logics can target them */
  sceneParams?: string[];
  error?: string;
  /** A short description of what the audio currently sounds like (feature averages). */
  audioSnapshot?: string;
}

export async function generate(
  req: GenerateRequest,
  ctx: { apiKey: string; defaultModel: string; apiDoc: string; exampleScene: string; exampleLogic: string },
) {
  const client = new Anthropic({ apiKey: ctx.apiKey });
  const isScene = req.mode.endsWith('scene');

  const system = [
    'You write scenes and audio-reactive "logics" for a local, offline particle-based music visualiser.',
    'Follow the API exactly; scene files must have no runtime imports (only `import type`).',
    'Keep per-frame work light: one loop over particles per frame, avoid allocations inside loops.',
    'Be bold and artistic: aim for striking, musical formations (landscapes, objects, abstract structures).',
    '',
    '<api_reference>',
    ctx.apiDoc,
    '</api_reference>',
    '',
    '<example_scene>',
    ctx.exampleScene,
    '</example_scene>',
    '',
    '<example_logic>',
    ctx.exampleLogic,
    '</example_logic>',
  ].join('\n');

  const parts: string[] = [];
  switch (req.mode) {
    case 'new-scene':
      parts.push(`Create a NEW scene: ${req.prompt}`);
      break;
    case 'edit-scene':
      parts.push(`Modify this scene (keep its id "${req.sceneId}") as follows: ${req.prompt}`, '<current_scene>', req.sceneSource ?? '', '</current_scene>');
      break;
    case 'fix-scene':
      parts.push(`This scene (id "${req.sceneId}") threw an error at runtime. Fix it, keeping the intent and id.`, `<error>${req.error}</error>`, '<current_scene>', req.sceneSource ?? '', '</current_scene>');
      if (req.prompt) parts.push(`Extra notes from the user: ${req.prompt}`);
      break;
    case 'new-logic':
      parts.push(`Create a NEW logic (audio→visual mapping): ${req.prompt}`);
      break;
    case 'edit-logic':
      parts.push(`Modify this logic as follows (keep its id): ${req.prompt}`, '<current_logic>', req.logicJson ?? '', '</current_logic>');
      break;
  }
  if (!isScene && req.sceneParams?.length) {
    parts.push(`The current scene exposes these params you may target as "param.<name>": ${req.sceneParams.join(', ')}. Prefer macro.* targets so the logic works with any scene.`);
  }
  if (req.audioSnapshot) parts.push(`What the input currently sounds like (feature averages over the last seconds): ${req.audioSnapshot}`);
  parts.push(isScene
    ? 'Return the scene as JSON: id, name, summary and code (the complete file).'
    : 'Return the logic as JSON: summary and logic. Use attack 0 and release 0.1-0.4 for punchy reactions, longer for smooth ones.');

  const schema = z.toJSONSchema(isScene ? SceneOutput : LogicOutput, { target: 'draft-7' }) as Record<string, unknown>;
  delete schema.$schema;

  const stream = client.beta.messages.stream({
    model: req.model || ctx.defaultModel,
    max_tokens: 32000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: parts.join('\n\n') }],
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') throw new Error('Claude declined this request.');
  if (message.stop_reason === 'max_tokens') throw new Error('Response was cut off (max_tokens). Try a simpler request.');
  const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  const json = JSON.parse(text);
  return isScene
    ? { kind: 'scene' as const, ...SceneOutput.parse(json) }
    : { kind: 'logic' as const, ...LogicOutput.parse(json) };
}
