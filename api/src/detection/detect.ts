import type {
  DetectedRequirements,
  DetectedDatabase,
  DetectedRuntime,
  ResourceType,
  InfraProvider,
  DetectionMetadata,
  DetectionSignal,
} from '@fastest/shared';
import { getDefaultProviderNameForType, getProviderCandidatesForType } from '@fastest/shared';
import { RUNTIME_RULES, FRAMEWORK_RULES, EDGE_RULES, EDGE_NEGATIVE_PATTERNS } from './rules';
import { detectWithLLM } from './llm';
import type { Env } from '../index';

/**
 * Suggested resource based on detection
 */
export interface SuggestedResource {
  type: ResourceType;
  provider: InfraProvider;
  provider_candidates?: InfraProvider[];
  name: string;
  envVar?: string;
}

/**
 * Package.json structure (partial)
 */
interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface DetectionContext {
  files: Map<string, string>;
  filePaths: string[];
  packageJson: PackageJson | null;
  deps: Record<string, string>;
  scripts: Record<string, string>;
}

interface DetectionResult {
  requirements: DetectedRequirements;
  metadata: DetectionMetadata;
}

/**
 * Detect requirements from project files
 */
export async function detectRequirements(
  files: Map<string, string>
): Promise<DetectedRequirements> {
  return (await detectRequirementsWithMetadata(files)).requirements;
}

export async function detectRequirementsWithMetadata(
  files: Map<string, string>
): Promise<DetectionResult> {
  const { context, requirements } = buildBaseRequirements(files);
  const signals: DetectionSignal[] = [];

  const { runtime, runtimeConfidence, runtimeReasons } = detectRuntimeWithRules(context, signals);
  const { framework, frameworkConfidence, frameworkReasons } = detectFrameworkWithRules(context, signals);

  requirements.runtime = runtime;
  requirements.framework = framework;

  if (context.packageJson) {
    requirements.buildCommand = context.scripts.build || null;
    requirements.startCommand =
      context.scripts.start ||
      context.scripts.serve ||
      null;
  }

  requirements.databases = detectDatabases(files, context.packageJson, signals);
  requirements.isEdgeCompatible = detectEdgeCompatibility(context, signals);
  requirements.needsStorage = detectStorageNeeds(context, signals);

  const overallConfidence = Math.max(0, Math.min(1,
    (runtimeConfidence * 0.6) + (frameworkConfidence * 0.25) + (requirements.runtime ? 0.15 : 0)
  ));

  const reasons = [...runtimeReasons, ...frameworkReasons];
  const metadata: DetectionMetadata = {
    confidence: overallConfidence,
    reasons: reasons.slice(0, 6),
    signals,
    source: 'rules',
  };

  return { requirements, metadata };
}

export async function detectRequirementsWithFallback(
  files: Map<string, string>,
  env: Env
): Promise<DetectionResult> {
  const base = await detectRequirementsWithMetadata(files);
  if (base.metadata.confidence >= 0.6) {
    return base;
  }

  const llmResult = await detectWithLLM(env, files);
  if (!llmResult) {
    return base;
  }

  const requirements = { ...base.requirements };
  if (!requirements.runtime && llmResult.runtime) requirements.runtime = llmResult.runtime;
  if (!requirements.framework && llmResult.framework) requirements.framework = llmResult.framework;
  if (!requirements.buildCommand && llmResult.buildCommand) requirements.buildCommand = llmResult.buildCommand;
  if (!requirements.startCommand && llmResult.startCommand) requirements.startCommand = llmResult.startCommand;
  if (requirements.databases.length === 0 && llmResult.databases.length > 0) {
    requirements.databases = llmResult.databases;
  }
  if (!requirements.needsStorage && llmResult.needsStorage) requirements.needsStorage = true;
  if (!requirements.isEdgeCompatible && llmResult.isEdgeCompatible) {
    requirements.isEdgeCompatible = true;
  }

  const metadata: DetectionMetadata = {
    confidence: Math.max(base.metadata.confidence, llmResult.confidence),
    reasons: [...base.metadata.reasons, ...llmResult.reasons].slice(0, 6),
    signals: base.metadata.signals,
    source: 'rules+llm',
  };

  return { requirements, metadata };
}

function buildBaseRequirements(files: Map<string, string>) {
  const requirements: DetectedRequirements = {
    runtime: null,
    runtimeVersion: null,
    framework: null,
    databases: [],
    isEdgeCompatible: false,
    needsStorage: false,
    buildCommand: null,
    startCommand: null,
  };

  const packageJsonContent = files.get('package.json');
  let packageJson: PackageJson | null = null;

  if (packageJsonContent) {
    try {
      packageJson = JSON.parse(packageJsonContent);
    } catch {
      // Invalid JSON, continue without it
    }
  }

  const deps = {
    ...(packageJson?.dependencies || {}),
    ...(packageJson?.devDependencies || {}),
  };

  const scripts = packageJson?.scripts || {};

  const context: DetectionContext = {
    files,
    filePaths: Array.from(files.keys()),
    packageJson,
    deps,
    scripts,
  };

  return { context, requirements };
}

function detectRuntimeWithRules(
  context: DetectionContext,
  signals: DetectionSignal[]
): { runtime: DetectedRuntime; runtimeConfidence: number; runtimeReasons: string[] } {
  const scores: Record<Exclude<DetectedRuntime, null>, number> = {
    node: 0,
    python: 0,
    go: 0,
    static: 0,
  };
  const reasons: Record<string, string[]> = { node: [], python: [], go: [], static: [] };

  for (const rule of RUNTIME_RULES) {
    if (!matchRule(rule.match, context)) continue;
    const runtime = rule.effect.runtime;
    if (!runtime) continue;
    scores[runtime] += rule.confidence;
    reasons[runtime].push(rule.reason);
    signals.push({ id: rule.id, confidence: rule.confidence, reason: rule.reason });
  }

  let best: DetectedRuntime = null;
  let bestScore = 0;
  let totalScore = 0;

  for (const runtime of Object.keys(scores) as Array<Exclude<DetectedRuntime, null>>) {
    totalScore += scores[runtime];
    if (scores[runtime] > bestScore) {
      bestScore = scores[runtime];
      best = runtime;
    }
  }

  const runtimeConfidence = totalScore > 0 ? bestScore / totalScore : 0;
  return { runtime: best, runtimeConfidence, runtimeReasons: best ? reasons[best] : [] };
}

function detectFrameworkWithRules(
  context: DetectionContext,
  signals: DetectionSignal[]
): { framework: string | null; frameworkConfidence: number; frameworkReasons: string[] } {
  const scores: Record<string, number> = {};
  const reasons: Record<string, string[]> = {};

  for (const rule of FRAMEWORK_RULES) {
    if (!matchRule(rule.match, context)) continue;
    const framework = rule.effect.framework;
    if (!framework) continue;
    scores[framework] = (scores[framework] || 0) + rule.confidence;
    reasons[framework] = reasons[framework] || [];
    reasons[framework].push(rule.reason);
    signals.push({ id: rule.id, confidence: rule.confidence, reason: rule.reason });
  }

  let bestFramework: string | null = null;
  let bestScore = 0;
  let totalScore = 0;
  for (const key of Object.keys(scores)) {
    totalScore += scores[key];
    if (scores[key] > bestScore) {
      bestScore = scores[key];
      bestFramework = key;
    }
  }

  const frameworkConfidence = totalScore > 0 ? bestScore / totalScore : 0;
  return {
    framework: bestFramework,
    frameworkConfidence,
    frameworkReasons: bestFramework ? reasons[bestFramework] : [],
  };
}

function matchRule(match: { filesAny?: string[]; filesAll?: string[]; depsAny?: string[]; scriptsAny?: string[]; contentIncludesAny?: string[] }, context: DetectionContext): boolean {
  const { filesAny, filesAll, depsAny, scriptsAny, contentIncludesAny } = match;
  const filePaths = context.filePaths;

  if (filesAny && filesAny.length > 0) {
    const matched = filesAny.some((pattern) => fileMatchesPattern(filePaths, pattern));
    if (!matched) return false;
  }

  if (filesAll && filesAll.length > 0) {
    const matchedAll = filesAll.every((pattern) => fileMatchesPattern(filePaths, pattern));
    if (!matchedAll) return false;
  }

  if (depsAny && depsAny.length > 0) {
    const matched = depsAny.some((dep) => context.deps[dep]);
    if (!matched) return false;
  }

  if (scriptsAny && scriptsAny.length > 0) {
    const matched = scriptsAny.some((script) => context.scripts[script]);
    if (!matched) return false;
  }

  if (contentIncludesAny && contentIncludesAny.length > 0) {
    const matched = contentIncludesAny.some((needle) => fileContentIncludes(context.files, needle));
    if (!matched) return false;
  }

  return true;
}

function fileMatchesPattern(filePaths: string[], pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    return filePaths.some((path) => path.endsWith(pattern.slice(1)));
  }
  return filePaths.includes(pattern);
}

function fileContentIncludes(files: Map<string, string>, needle: string): boolean {
  for (const content of files.values()) {
    if (content.includes(needle)) return true;
  }
  return false;
}

/**
 * Detect database requirements
 */
function detectDatabases(
  files: Map<string, string>,
  packageJson: PackageJson | null,
  signals: DetectionSignal[]
): DetectedDatabase[] {
  const databases: DetectedDatabase[] = [];
  const deps = packageJson
    ? { ...packageJson.dependencies, ...packageJson.devDependencies }
    : {};

  // Check for PostgreSQL
  const needsPostgres =
    deps['pg'] ||
    deps['postgres'] ||
    deps['@prisma/client'] ||
    deps['prisma'] ||
    deps['drizzle-orm'] ||
    deps['typeorm'] ||
    deps['sequelize'] ||
    deps['knex'] ||
    files.has('prisma/schema.prisma');

  if (needsPostgres) {
    signals.push({ id: 'db:postgres:deps', confidence: 0.7, reason: 'Detected Postgres-related dependencies' });
    // Check Prisma schema for specific database
    const prismaSchema = files.get('prisma/schema.prisma');
    if (prismaSchema) {
      if (prismaSchema.includes('provider = "mysql"')) {
        databases.push({ type: 'mysql', envVar: 'DATABASE_URL' });
      } else {
        // Default to postgres for Prisma
        databases.push({ type: 'postgres', envVar: 'DATABASE_URL' });
      }
    } else {
      databases.push({ type: 'postgres', envVar: 'DATABASE_URL' });
    }
  }

  // Check for MySQL (if not already added via Prisma)
  const needsMysql =
    deps['mysql'] ||
    deps['mysql2'] ||
    (deps['typeorm'] && !needsPostgres);

  if (needsMysql && !databases.some((d) => d.type === 'mysql')) {
    signals.push({ id: 'db:mysql:deps', confidence: 0.6, reason: 'Detected MySQL-related dependencies' });
    databases.push({ type: 'mysql', envVar: 'DATABASE_URL' });
  }

  // Check for Redis
  const needsRedis =
    deps['redis'] ||
    deps['ioredis'] ||
    deps['@upstash/redis'] ||
    deps['bull'] ||
    deps['bullmq'];

  if (needsRedis) {
    signals.push({ id: 'db:redis:deps', confidence: 0.6, reason: 'Detected Redis-related dependencies' });
    databases.push({ type: 'redis', envVar: 'REDIS_URL' });
  }

  // Check for env var references in code
  for (const [path, content] of files) {
    if (!path.endsWith('.ts') && !path.endsWith('.js') && !path.endsWith('.tsx')) {
      continue;
    }

    // Look for DATABASE_URL usage
    if (
      content.includes('DATABASE_URL') &&
      !databases.some((d) => d.envVar === 'DATABASE_URL')
    ) {
      signals.push({ id: 'db:env:postgres', confidence: 0.5, reason: 'Found DATABASE_URL usage in code' });
      databases.push({ type: 'postgres', envVar: 'DATABASE_URL' });
    }

    // Look for REDIS_URL usage
    if (
      content.includes('REDIS_URL') &&
      !databases.some((d) => d.envVar === 'REDIS_URL')
    ) {
      signals.push({ id: 'db:env:redis', confidence: 0.5, reason: 'Found REDIS_URL usage in code' });
      databases.push({ type: 'redis', envVar: 'REDIS_URL' });
    }
  }

  return databases;
}

/**
 * Detect if project is edge-compatible (can run on Cloudflare Workers)
 */
function detectEdgeCompatibility(
  context: DetectionContext,
  signals: DetectionSignal[]
): boolean {
  let score = 0;

  for (const rule of EDGE_RULES) {
    if (!matchRule(rule.match, context)) continue;
    score += rule.confidence;
    signals.push({ id: rule.id, confidence: rule.confidence, reason: rule.reason });
  }

  for (const needle of EDGE_NEGATIVE_PATTERNS) {
    if (fileContentIncludes(context.files, needle)) {
      score -= 0.6;
      signals.push({
        id: 'edge:negative',
        confidence: 0.6,
        reason: 'Detected Node-only APIs that are not edge-compatible',
      });
      break;
    }
  }

  return score >= 0.6;
}

/**
 * Detect if project needs blob storage
 */
function detectStorageNeeds(
  context: DetectionContext,
  signals: DetectionSignal[]
): boolean {
  const deps = context.deps;

  // Check for storage-related dependencies
  if (
    deps['@aws-sdk/client-s3'] ||
    deps['aws-sdk'] ||
    deps['@google-cloud/storage'] ||
    deps['multer'] ||
    deps['formidable']
  ) {
    signals.push({ id: 'storage:deps', confidence: 0.6, reason: 'Detected storage-related dependencies' });
    return true;
  }

  // Check for R2 bindings in wrangler config
  const wranglerConfig =
    context.files.get('wrangler.toml') ||
    context.files.get('wrangler.jsonc') ||
    context.files.get('wrangler.json');

  if (wranglerConfig && wranglerConfig.includes('r2_buckets')) {
    signals.push({ id: 'storage:r2', confidence: 0.7, reason: 'Detected R2 bucket configuration' });
    return true;
  }

  return false;
}

/**
 * Generate suggested resources based on detected requirements
 */
export function suggestResources(
  requirements: DetectedRequirements
): SuggestedResource[] {
  const suggestions: SuggestedResource[] = [];

  // Suggest compute resource
  if (requirements.runtime) {
    const computeType: ResourceType = requirements.isEdgeCompatible
      ? 'compute:edge'
      : 'compute';
    const providerCandidates = getProviderCandidatesForType(computeType);
    const provider = getDefaultProviderNameForType(computeType) || providerCandidates[0];
    if (provider) {
      suggestions.push({
        type: computeType,
        provider,
        provider_candidates: providerCandidates,
        name: 'app',
      });
    }
  }

  // Suggest databases
  for (const db of requirements.databases) {
    const dbType: ResourceType = `database:${db.type}` as ResourceType;
    const providerCandidates = getProviderCandidatesForType(dbType);
    const provider = getDefaultProviderNameForType(dbType) || providerCandidates[0];
    if (provider) {
      suggestions.push({
        type: dbType,
        provider,
        provider_candidates: providerCandidates,
        name: db.type,
        envVar: db.envVar,
      });
    }
  }

  // Suggest storage if needed
  if (requirements.needsStorage) {
    const providerCandidates = getProviderCandidatesForType('storage:blob');
    const provider = getDefaultProviderNameForType('storage:blob') || providerCandidates[0];
    if (provider) {
      suggestions.push({
        type: 'storage:blob',
        provider,
        provider_candidates: providerCandidates,
        name: 'storage',
      });
    }
  }

  return suggestions;
}
