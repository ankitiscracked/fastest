import type { DetectedRuntime, DetectedDatabase } from '@fastest/shared';
import type { Env } from '../index';

export interface LLMDetectionResult {
  runtime: DetectedRuntime;
  framework: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  databases: DetectedDatabase[];
  needsStorage: boolean;
  isEdgeCompatible: boolean;
  confidence: number; // 0-1
  reasons: string[];
}

const MAX_LLM_FILES = 8;
const MAX_FILE_CHARS = 6000;

const LLM_MODEL = '@cf/meta/llama-2-7b-chat-int8';

const IMPORTANT_FILES = [
  'package.json',
  'README.md',
  'README.mdx',
  'wrangler.toml',
  'wrangler.json',
  'wrangler.jsonc',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'nuxt.config.js',
  'nuxt.config.ts',
  'svelte.config.js',
  'svelte.config.ts',
  'vite.config.js',
  'vite.config.ts',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'tsconfig.json',
];

function truncate(content: string): string {
  if (content.length <= MAX_FILE_CHARS) return content;
  return content.slice(0, MAX_FILE_CHARS) + '\n... [truncated]';
}

export function selectFilesForLLM(files: Map<string, string>): Array<{ path: string; content: string }> {
  const selected: Array<{ path: string; content: string }> = [];

  for (const name of IMPORTANT_FILES) {
    const content = files.get(name);
    if (content) {
      selected.push({ path: name, content: truncate(content) });
    }
    if (selected.length >= MAX_LLM_FILES) break;
  }

  if (selected.length < MAX_LLM_FILES) {
    for (const [path, content] of files) {
      if (selected.some((f) => f.path === path)) continue;
      if (path.startsWith('src/') || path.startsWith('app/') || path.startsWith('server/')) {
        selected.push({ path, content: truncate(content) });
      }
      if (selected.length >= MAX_LLM_FILES) break;
    }
  }

  return selected;
}

export async function detectWithLLM(
  env: Env,
  files: Map<string, string>
): Promise<LLMDetectionResult | null> {
  if (!env.AI) return null;

  const selectedFiles = selectFilesForLLM(files);
  if (selectedFiles.length === 0) return null;

  const filesContext = selectedFiles
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join('\n\n');

  const prompt = `You are a deployment detector. Analyze the files and output ONLY JSON with this shape:
{
  "runtime": "node" | "python" | "go" | "static" | null,
  "framework": string | null,
  "buildCommand": string | null,
  "startCommand": string | null,
  "databases": [{"type":"postgres"|"mysql"|"redis","envVar":"DATABASE_URL"|"REDIS_URL"}],
  "needsStorage": boolean,
  "isEdgeCompatible": boolean,
  "confidence": number,
  "reasons": string[]
}
Use confidence 0-1. Only include databases if evidence exists. If unsure, set runtime to null.

Files:
${filesContext}`;

  try {
    const response = await env.AI.run(LLM_MODEL, {
      messages: [
        { role: 'system', content: 'Return only valid JSON. Do not include commentary.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 1200,
    });

    const responseText = typeof response === 'string'
      ? response
      : (response as { response?: string }).response || '';

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as LLMDetectionResult;
    if (!parsed || typeof parsed !== 'object') return null;

    return {
      runtime: parsed.runtime ?? null,
      framework: parsed.framework ?? null,
      buildCommand: parsed.buildCommand ?? null,
      startCommand: parsed.startCommand ?? null,
      databases: Array.isArray(parsed.databases) ? parsed.databases : [],
      needsStorage: Boolean(parsed.needsStorage),
      isEdgeCompatible: Boolean(parsed.isEdgeCompatible),
      confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0)),
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 6) : [],
    };
  } catch (error) {
    console.warn('LLM detection failed:', error);
    return null;
  }
}
