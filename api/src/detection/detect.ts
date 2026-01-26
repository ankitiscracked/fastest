import type {
  DetectedRequirements,
  DetectedDatabase,
  DetectedRuntime,
  ResourceType,
  InfraProvider,
} from '@fastest/shared';
import { getDefaultProviderNameForType } from '../providers';

/**
 * Suggested resource based on detection
 */
export interface SuggestedResource {
  type: ResourceType;
  provider: InfraProvider;
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

/**
 * Detect requirements from project files
 */
export async function detectRequirements(
  files: Map<string, string>
): Promise<DetectedRequirements> {
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

  // Parse package.json if exists
  const packageJsonContent = files.get('package.json');
  let packageJson: PackageJson | null = null;

  if (packageJsonContent) {
    try {
      packageJson = JSON.parse(packageJsonContent);
    } catch {
      // Invalid JSON, continue without it
    }
  }

  // Detect runtime
  requirements.runtime = detectRuntime(files, packageJson);

  // Detect framework
  if (packageJson) {
    requirements.framework = detectFramework(packageJson);
    requirements.buildCommand = packageJson.scripts?.build || null;
    requirements.startCommand =
      packageJson.scripts?.start ||
      packageJson.scripts?.serve ||
      null;
  }

  // Detect databases
  requirements.databases = detectDatabases(files, packageJson);

  // Check for edge compatibility
  requirements.isEdgeCompatible = detectEdgeCompatibility(files, packageJson);

  // Check for storage needs
  requirements.needsStorage = detectStorageNeeds(files, packageJson);

  return requirements;
}

/**
 * Detect runtime from files
 */
function detectRuntime(
  files: Map<string, string>,
  packageJson: PackageJson | null
): DetectedRuntime {
  // Check for Node.js
  if (packageJson || files.has('package.json')) {
    return 'node';
  }

  // Check for Python
  if (
    files.has('requirements.txt') ||
    files.has('pyproject.toml') ||
    files.has('setup.py') ||
    files.has('Pipfile')
  ) {
    return 'python';
  }

  // Check for Go
  if (files.has('go.mod') || files.has('go.sum')) {
    return 'go';
  }

  // Check for static site (HTML files at root)
  if (files.has('index.html')) {
    return 'static';
  }

  // Check file extensions
  for (const path of files.keys()) {
    if (path.endsWith('.ts') || path.endsWith('.js') || path.endsWith('.mjs')) {
      return 'node';
    }
    if (path.endsWith('.py')) {
      return 'python';
    }
    if (path.endsWith('.go')) {
      return 'go';
    }
  }

  return null;
}

/**
 * Detect framework from package.json
 */
function detectFramework(packageJson: PackageJson): string | null {
  const deps = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };

  // Node.js frameworks
  if (deps['next']) return 'next';
  if (deps['nuxt']) return 'nuxt';
  if (deps['remix']) return 'remix';
  if (deps['express']) return 'express';
  if (deps['fastify']) return 'fastify';
  if (deps['hono']) return 'hono';
  if (deps['koa']) return 'koa';
  if (deps['nestjs'] || deps['@nestjs/core']) return 'nestjs';
  if (deps['react']) return 'react';
  if (deps['vue']) return 'vue';
  if (deps['svelte'] || deps['@sveltejs/kit']) return 'svelte';

  return null;
}

/**
 * Detect database requirements
 */
function detectDatabases(
  files: Map<string, string>,
  packageJson: PackageJson | null
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
      databases.push({ type: 'postgres', envVar: 'DATABASE_URL' });
    }

    // Look for REDIS_URL usage
    if (
      content.includes('REDIS_URL') &&
      !databases.some((d) => d.envVar === 'REDIS_URL')
    ) {
      databases.push({ type: 'redis', envVar: 'REDIS_URL' });
    }
  }

  return databases;
}

/**
 * Detect if project is edge-compatible (can run on Cloudflare Workers)
 */
function detectEdgeCompatibility(
  files: Map<string, string>,
  packageJson: PackageJson | null
): boolean {
  // Check for wrangler config
  if (files.has('wrangler.toml') || files.has('wrangler.jsonc') || files.has('wrangler.json')) {
    return true;
  }

  // Check for Cloudflare-specific dependencies
  const deps = packageJson
    ? { ...packageJson.dependencies, ...packageJson.devDependencies }
    : {};

  if (
    deps['@cloudflare/workers-types'] ||
    deps['hono'] ||  // Hono is edge-first
    deps['itty-router']
  ) {
    return true;
  }

  // Check for Next.js edge runtime
  for (const [path, content] of files) {
    if (path.endsWith('.ts') || path.endsWith('.tsx') || path.endsWith('.js')) {
      if (content.includes("runtime = 'edge'") || content.includes('runtime: "edge"')) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Detect if project needs blob storage
 */
function detectStorageNeeds(
  files: Map<string, string>,
  packageJson: PackageJson | null
): boolean {
  const deps = packageJson
    ? { ...packageJson.dependencies, ...packageJson.devDependencies }
    : {};

  // Check for storage-related dependencies
  if (
    deps['@aws-sdk/client-s3'] ||
    deps['aws-sdk'] ||
    deps['@google-cloud/storage'] ||
    deps['multer'] ||
    deps['formidable']
  ) {
    return true;
  }

  // Check for R2 bindings in wrangler config
  const wranglerConfig =
    files.get('wrangler.toml') ||
    files.get('wrangler.jsonc') ||
    files.get('wrangler.json');

  if (wranglerConfig && wranglerConfig.includes('r2_buckets')) {
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

    suggestions.push({
      type: computeType,
      provider: getDefaultProviderNameForType(computeType),
      name: 'app',
    });
  }

  // Suggest databases
  for (const db of requirements.databases) {
    const dbType: ResourceType = `database:${db.type}` as ResourceType;
    suggestions.push({
      type: dbType,
      provider: getDefaultProviderNameForType(dbType),
      name: db.type,
      envVar: db.envVar,
    });
  }

  // Suggest storage if needed
  if (requirements.needsStorage) {
    suggestions.push({
      type: 'storage:blob',
      provider: getDefaultProviderNameForType('storage:blob'),
      name: 'storage',
    });
  }

  return suggestions;
}
