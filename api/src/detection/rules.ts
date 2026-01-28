import type { DetectedRuntime } from '@fastest/shared';

export interface RuleMatch {
  filesAny?: string[];
  filesAll?: string[];
  depsAny?: string[];
  scriptsAny?: string[];
  contentIncludesAny?: string[];
}

export interface DetectionRule {
  id: string;
  confidence: number; // 0-1
  reason: string;
  match: RuleMatch;
  effect: {
    runtime?: DetectedRuntime;
    framework?: string;
    edgeCompatible?: boolean;
  };
}

export const RUNTIME_RULES: DetectionRule[] = [
  {
    id: 'node:package-json',
    confidence: 0.7,
    reason: 'Found package.json',
    match: { filesAny: ['package.json'] },
    effect: { runtime: 'node' },
  },
  {
    id: 'node:js-ts-files',
    confidence: 0.6,
    reason: 'Found .js/.ts files at root',
    match: { filesAny: ['*.js', '*.ts', '*.tsx', '*.mjs', '*.cjs'] },
    effect: { runtime: 'node' },
  },
  {
    id: 'python:config',
    confidence: 0.8,
    reason: 'Found Python config files',
    match: { filesAny: ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'] },
    effect: { runtime: 'python' },
  },
  {
    id: 'go:mod',
    confidence: 0.8,
    reason: 'Found go.mod or go.sum',
    match: { filesAny: ['go.mod', 'go.sum'] },
    effect: { runtime: 'go' },
  },
  {
    id: 'static:index',
    confidence: 0.6,
    reason: 'Found index.html at root',
    match: { filesAny: ['index.html'] },
    effect: { runtime: 'static' },
  },
];

export const FRAMEWORK_RULES: DetectionRule[] = [
  { id: 'framework:next', confidence: 0.85, reason: 'Next.js detected', match: { depsAny: ['next'], filesAny: ['next.config.js', 'next.config.mjs', 'next.config.ts'] }, effect: { framework: 'next' } },
  { id: 'framework:nuxt', confidence: 0.85, reason: 'Nuxt detected', match: { depsAny: ['nuxt'], filesAny: ['nuxt.config.js', 'nuxt.config.ts'] }, effect: { framework: 'nuxt' } },
  { id: 'framework:remix', confidence: 0.8, reason: 'Remix detected', match: { depsAny: ['remix'] }, effect: { framework: 'remix' } },
  { id: 'framework:express', confidence: 0.7, reason: 'Express detected', match: { depsAny: ['express'] }, effect: { framework: 'express' } },
  { id: 'framework:fastify', confidence: 0.7, reason: 'Fastify detected', match: { depsAny: ['fastify'] }, effect: { framework: 'fastify' } },
  { id: 'framework:hono', confidence: 0.7, reason: 'Hono detected', match: { depsAny: ['hono'] }, effect: { framework: 'hono' } },
  { id: 'framework:koa', confidence: 0.7, reason: 'Koa detected', match: { depsAny: ['koa'] }, effect: { framework: 'koa' } },
  { id: 'framework:nest', confidence: 0.7, reason: 'NestJS detected', match: { depsAny: ['nestjs', '@nestjs/core'] }, effect: { framework: 'nestjs' } },
  { id: 'framework:react', confidence: 0.6, reason: 'React detected', match: { depsAny: ['react'] }, effect: { framework: 'react' } },
  { id: 'framework:vue', confidence: 0.6, reason: 'Vue detected', match: { depsAny: ['vue'] }, effect: { framework: 'vue' } },
  { id: 'framework:svelte', confidence: 0.6, reason: 'Svelte detected', match: { depsAny: ['svelte', '@sveltejs/kit'] }, effect: { framework: 'svelte' } },
];

export const EDGE_RULES: DetectionRule[] = [
  {
    id: 'edge:wrangler',
    confidence: 0.8,
    reason: 'Found Cloudflare Wrangler config',
    match: { filesAny: ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'] },
    effect: { edgeCompatible: true },
  },
  {
    id: 'edge:deps',
    confidence: 0.6,
    reason: 'Found edge-oriented dependencies',
    match: { depsAny: ['@cloudflare/workers-types', 'hono', 'itty-router'] },
    effect: { edgeCompatible: true },
  },
  {
    id: 'edge:workers',
    confidence: 0.7,
    reason: 'Found Workers configuration',
    match: { filesAny: ['worker.js', 'worker.ts'] },
    effect: { edgeCompatible: true },
  },
  {
    id: 'edge:next-runtime',
    confidence: 0.6,
    reason: 'Found Next.js Edge runtime hint',
    match: { contentIncludesAny: ['runtime: \"edge\"', "runtime: 'edge'", 'edge-runtime'] },
    effect: { edgeCompatible: true },
  },
];

export const EDGE_NEGATIVE_PATTERNS = [
  "require('fs')",
  'from \"fs\"',
  "from 'fs'",
  "require('child_process')",
  'from \"child_process\"',
  "from 'child_process'",
  "require('net')",
  "from 'net'",
  'from \"net\"',
];
