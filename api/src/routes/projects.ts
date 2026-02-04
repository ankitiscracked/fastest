import { Hono } from 'hono';
import { eq, and, desc, sql, inArray, gt } from 'drizzle-orm';
import type { Env } from '../index';
import type {
  Project,
  Workspace,
  Snapshot,
  CreateProjectRequest,
  CreateWorkspaceRequest,
  SetEnvVarRequest,
  ProjectEnvVar,
  ListProjectDocsResponse,
  GetDocContentResponse,
  WorkspaceDocs,
  DocFile,
  ProjectBrief,
  ProjectIntent,
  NextStep,
  NextStepCategory,
  NextStepEffort,
  NextStepStatus,
  ProjectDecision,
  ProjectDecisionCategory,
  AtlasSearchResult,
} from '@fastest/shared';
import { getAuthUser } from '../middleware/auth';
import {
  createDb,
  projects,
  workspaces,
  snapshots,
  activityEvents,
  driftReports,
  projectEnvVars,
  conversations,
  nextSteps,
  projectDecisions,
  atlasConcepts,
  atlasEdges,
  atlasChunks,
  deployments,
  atlasEmbeddings,
  atlasDecisionLinks,
  atlasDiagrams,
} from '../db';

const SUGGESTIONS_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const ATLAS_SEARCH_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const ATLAS_EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';
const ATLAS_MAX_CHUNK_CHARS = 4000;
const ATLAS_MAX_FILES_DEFAULT = 200;

const ATLAS_IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.fst',
  '.fast',
  '.next',
  'coverage',
]);

function isAtlasIgnoredPath(path: string) {
  const parts = path.split('/');
  if (parts.length === 0) return true;
  const first = parts[0];
  if (!first) return true;
  if (first.startsWith('.')) return true;
  if (ATLAS_IGNORED_DIRS.has(first)) return true;
  return false;
}

function deriveAtlasConcepts(manifest: { files: Array<{ path: string; hash: string; size: number }> }): AtlasSearchResult[] {
  const systems = new Map<string, { name: string; files: Set<string>; modules: Set<string> }>();
  const modules = new Map<string, { name: string; files: Set<string> }>();
  const concepts: AtlasSearchResult[] = [];

  for (const file of manifest.files) {
    if (isAtlasIgnoredPath(file.path)) continue;
    const parts = file.path.split('/');
    const systemKey = parts.length > 1 ? parts[0] : 'root';
    const systemName = systemKey === 'root' ? 'Root' : systemKey;
    if (!systems.has(systemKey)) {
      systems.set(systemKey, { name: systemName, files: new Set(), modules: new Set() });
    }
    const moduleKey = parts.length > 2
      ? `${parts[0]}/${parts[1]}`
      : (parts.length > 1 ? parts[0] : 'root');
    const moduleName = moduleKey === 'root' ? 'Root' : moduleKey;
    if (!modules.has(moduleKey)) {
      modules.set(moduleKey, { name: moduleName, files: new Set() });
    }
    systems.get(systemKey)!.files.add(file.path);
    systems.get(systemKey)!.modules.add(moduleKey);
    modules.get(moduleKey)!.files.add(file.path);

    concepts.push({
      id: `code:${file.path}`,
      name: file.path.split('/').pop() || file.path,
      description: file.path,
      layer: 'code',
    });
  }

  for (const [systemKey, system] of systems.entries()) {
    concepts.push({
      id: `system:${systemKey}`,
      name: system.name,
      description: `Top-level area with ${system.files.size} files`,
      layer: 'system',
    });
  }

  for (const [moduleKey, module] of modules.entries()) {
    concepts.push({
      id: `module:${moduleKey}`,
      name: module.name,
      description: `Contains ${module.files.size} files`,
      layer: 'module',
    });
  }

  return concepts;
}

function tokenizeQuery(value: string) {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
}

function scoreConcept(queryTokens: string[], concept: AtlasSearchResult) {
  const haystack = `${concept.name} ${concept.description}`.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += 1;
  }
  return score;
}

function rankConcepts(query: string, concepts: AtlasSearchResult[], limit: number) {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];
  return concepts
    .map((concept) => ({ concept, score: scoreConcept(tokens, concept) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.concept);
}

type AtlasIndexItem = {
  concept: AtlasSearchResult;
  kind: 'system' | 'module' | 'code';
  path?: string;
  hash?: string;
  size?: number;
  moduleId?: string;
  systemId?: string;
};

function buildAtlasIndexItems(manifest: { files: Array<{ path: string; hash: string; size: number }> }) {
  const systems = new Map<string, { id: string; name: string; files: Set<string>; modules: Set<string> }>();
  const modules = new Map<string, { id: string; name: string; files: Set<string>; systemId: string }>();
  const items: AtlasIndexItem[] = [];

  for (const file of manifest.files) {
    if (isAtlasIgnoredPath(file.path)) continue;
    const parts = file.path.split('/');
    const systemKey = parts.length > 1 ? parts[0] : 'root';
    const systemId = `system:${systemKey}`;
    const systemName = systemKey === 'root' ? 'Root' : systemKey;

    if (!systems.has(systemId)) {
      systems.set(systemId, { id: systemId, name: systemName, files: new Set(), modules: new Set() });
    }

    const moduleKey = parts.length > 2
      ? `${parts[0]}/${parts[1]}`
      : (parts.length > 1 ? parts[0] : 'root');
    const moduleId = `module:${moduleKey}`;
    const moduleName = moduleKey === 'root' ? 'Root' : moduleKey;

    if (!modules.has(moduleId)) {
      modules.set(moduleId, { id: moduleId, name: moduleName, files: new Set(), systemId });
    }

    systems.get(systemId)!.files.add(file.path);
    systems.get(systemId)!.modules.add(moduleId);
    modules.get(moduleId)!.files.add(file.path);

    items.push({
      concept: {
        id: `code:${file.path}`,
        name: file.path.split('/').pop() || file.path,
        description: file.path,
        layer: 'code',
      },
      kind: 'code',
      path: file.path,
      hash: file.hash,
      size: file.size,
      moduleId,
      systemId,
    });
  }

  for (const system of systems.values()) {
    items.push({
      concept: {
        id: system.id,
        name: system.name,
        description: `Top-level area with ${system.files.size} files`,
        layer: 'system',
      },
      kind: 'system',
    });
  }

  for (const module of modules.values()) {
    items.push({
      concept: {
        id: module.id,
        name: module.name,
        description: `Contains ${module.files.size} files`,
        layer: 'module',
      },
      kind: 'module',
      systemId: module.systemId,
    });
  }

  return { items, systems, modules };
}

async function loadLatestSnapshotManifest(env: Env, userId: string, projectId: string) {
  const db = createDb(env.DB);
  const [project] = await db
    .select({
      id: projects.id,
      last_snapshot_id: projects.lastSnapshotId,
    })
    .from(projects)
    .where(eq(projects.id, projectId));

  if (!project) return null;

  let snapshot = null as null | { id: string; manifest_hash: string };
  if (project.last_snapshot_id) {
    const [snapRow] = await db
      .select({ id: snapshots.id, manifest_hash: snapshots.manifestHash })
      .from(snapshots)
      .where(eq(snapshots.id, project.last_snapshot_id));
    snapshot = snapRow || null;
  } else {
    const [snapRow] = await db
      .select({ id: snapshots.id, manifest_hash: snapshots.manifestHash })
      .from(snapshots)
      .where(eq(snapshots.projectId, projectId))
      .orderBy(desc(snapshots.createdAt))
      .limit(1);
    snapshot = snapRow || null;
  }

  if (!snapshot) return null;

  const manifestKey = `${userId}/manifests/${snapshot.manifest_hash}.json`;
  const manifestObj = await env.BLOBS.get(manifestKey);
  if (!manifestObj) {
    return null;
  }

  let manifest: { files: Array<{ path: string; hash: string; size: number }> };
  try {
    manifest = JSON.parse(await manifestObj.text());
  } catch {
    return null;
  }

  return { snapshotId: snapshot.id, manifestHash: snapshot.manifest_hash, manifest };
}

function parseBrief(value: string | null): ProjectBrief | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as ProjectBrief;
  } catch {
    return null;
  }
}

function toProjectIntent(value: unknown): ProjectIntent | null {
  if (typeof value !== 'string') return null;
  const allowed: ProjectIntent[] = [
    'startup',
    'personal_tool',
    'learning',
    'fun',
    'portfolio',
    'creative',
    'exploration',
    'open_source',
  ];
  return allowed.includes(value as ProjectIntent) ? (value as ProjectIntent) : null;
}

function parseJsonArray(text: string): Array<Record<string, unknown>> | null {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeNextStepStatus(status: unknown): NextStepStatus | null {
  if (typeof status !== 'string') return null;
  const allowed: NextStepStatus[] = ['pending', 'started', 'completed', 'dismissed'];
  return allowed.includes(status as NextStepStatus) ? (status as NextStepStatus) : null;
}

function normalizeCategory(value: unknown): NextStepCategory {
  const allowed: NextStepCategory[] = ['feature', 'validation', 'launch', 'technical', 'user_research'];
  if (typeof value === 'string' && allowed.includes(value as NextStepCategory)) {
    return value as NextStepCategory;
  }
  return 'feature';
}

function normalizeEffort(value: unknown): NextStepEffort | null {
  const allowed: NextStepEffort[] = ['small', 'medium', 'large'];
  if (typeof value === 'string' && allowed.includes(value as NextStepEffort)) {
    return value as NextStepEffort;
  }
  return null;
}

function normalizeDecisionCategory(value: unknown): ProjectDecisionCategory | null {
  const allowed: ProjectDecisionCategory[] = ['architecture', 'scope', 'tech_choice', 'approach', 'process', 'product'];
  if (typeof value === 'string' && allowed.includes(value as ProjectDecisionCategory)) {
    return value as ProjectDecisionCategory;
  }
  return null;
}

function isBinaryPath(path: string) {
  const ext = path.split('.').pop()?.toLowerCase();
  if (!ext) return false;
  const binary = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'svg',
    'pdf', 'zip', 'gz', 'tar', '7z', 'woff', 'woff2',
    'mp4', 'mov', 'mp3', 'wav', 'ogg', 'bin', 'dylib',
  ]);
  return binary.has(ext);
}

async function embedText(env: Env, text: string): Promise<number[] | null> {
  if (!env.AI) return null;
  try {
    const response = await env.AI.run(ATLAS_EMBEDDING_MODEL, { text });
    const payload = response as unknown as Record<string, unknown>;
    if (Array.isArray(payload)) return payload as number[];
    if (Array.isArray(payload.embedding)) return payload.embedding as number[];
    if (Array.isArray(payload.data)) {
      const first = (payload.data as Array<unknown>)[0] as Record<string, unknown> | number[] | undefined;
      if (Array.isArray(first)) return first as number[];
      if (first && Array.isArray((first as Record<string, unknown>).embedding)) {
        return (first as Record<string, unknown>).embedding as number[];
      }
    }
  } catch (err) {
    console.error('Embedding failed:', err);
  }
  return null;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function buildDiagramData(args: {
  conceptId?: string | null;
  type: string;
  concepts: Array<{ id: string; name: string }>;
  edges: Array<{ from_concept_id: string; to_concept_id: string; type: string }>;
}) {
  const { conceptId, type, concepts, edges } = args;
  const nodeMap = new Map(concepts.map((c) => [c.id, c.name]));
  const nodes: Array<{ id: string; label: string; type: string }> = [];
  const diagramEdges: Array<{ from: string; to: string; label?: string; type: string }> = [];
  const include = new Set<string>();

  if (conceptId && nodeMap.has(conceptId)) {
    include.add(conceptId);
    for (const edge of edges) {
      if (edge.from_concept_id === conceptId || edge.to_concept_id === conceptId) {
        include.add(edge.from_concept_id);
        include.add(edge.to_concept_id);
        diagramEdges.push({
          from: edge.from_concept_id,
          to: edge.to_concept_id,
          label: edge.type,
          type: edge.type,
        });
      }
    }
  } else {
    for (const edge of edges.slice(0, 40)) {
      include.add(edge.from_concept_id);
      include.add(edge.to_concept_id);
      diagramEdges.push({
        from: edge.from_concept_id,
        to: edge.to_concept_id,
        label: edge.type,
        type: edge.type,
      });
    }
  }

  for (const id of include) {
    const label = nodeMap.get(id) || id;
    nodes.push({ id, label, type: 'component' });
  }

  return {
    id: `diag-${Date.now()}`,
    type,
    title: conceptId ? `Diagram for ${nodeMap.get(conceptId) || conceptId}` : 'Project diagram',
    nodes,
    edges: diagramEdges,
  };
}

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || `concept-${Math.random().toString(36).slice(2, 8)}`;
}

// Doc file patterns - files that are considered documentation
const DOC_PATTERNS = [
  /\.md$/i,
  /\.txt$/i,
  /\.mdx$/i,
  /^readme$/i,
  /^changelog$/i,
  /^license$/i,
  /^contributing$/i,
  /^todo$/i,
  /^notes$/i,
];

function isDocFile(path: string): boolean {
  const filename = path.split('/').pop() || '';
  return DOC_PATTERNS.some(pattern => pattern.test(filename) || pattern.test(path));
}

export const projectRoutes = new Hono<{ Bindings: Env }>();

// Create a new project
projectRoutes.post('/', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const body = await c.req.json<CreateProjectRequest>();

  if (!body.name || body.name.trim() === '') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Project name is required' } }, 422);
  }

  const db = createDb(c.env.DB);
  const projectId = generateULID();
  const now = new Date().toISOString();

  // Insert project
  await db.insert(projects).values({
    id: projectId,
    ownerUserId: user.id,
    name: body.name.trim(),
    createdAt: now,
    updatedAt: now,
  });

  // Insert activity event
  const eventId = generateULID();
  await db.insert(activityEvents).values({
    id: eventId,
    projectId,
    actor: 'web',
    type: 'project.created',
    message: `Project "${body.name.trim()}" created`,
    createdAt: now,
  });

  const project: Project = {
    id: projectId,
    owner_user_id: user.id,
    name: body.name.trim(),
    intent: null,
    brief: null,
    created_at: now,
    updated_at: now,
    last_snapshot_id: null,
    main_workspace_id: null,
  };

  return c.json({ project }, 201);
});

// List user's projects
projectRoutes.get('/', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const db = createDb(c.env.DB);

  const result = await db
    .select({
      id: projects.id,
      owner_user_id: projects.ownerUserId,
      name: projects.name,
      intent: projects.intent,
      brief: projects.brief,
      created_at: projects.createdAt,
      updated_at: projects.updatedAt,
      last_snapshot_id: projects.lastSnapshotId,
      main_workspace_id: projects.mainWorkspaceId,
    })
    .from(projects)
    .where(eq(projects.ownerUserId, user.id))
    .orderBy(desc(projects.updatedAt));

  const formatted = result.map((project) => ({
    ...project,
    intent: project.intent ? toProjectIntent(project.intent) : null,
    brief: parseBrief(project.brief),
  }));

  return c.json({ projects: formatted });
});

// Get project by ID
projectRoutes.get('/:projectId', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DB);

  // Fetch project
  const projectResult = await db
    .select({
      id: projects.id,
      owner_user_id: projects.ownerUserId,
      name: projects.name,
      intent: projects.intent,
      brief: projects.brief,
      created_at: projects.createdAt,
      updated_at: projects.updatedAt,
      last_snapshot_id: projects.lastSnapshotId,
      main_workspace_id: projects.mainWorkspaceId,
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)))
    .limit(1);

  const projectRaw = projectResult[0];

  if (!projectRaw) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  const project = {
    ...projectRaw,
    intent: projectRaw.intent ? toProjectIntent(projectRaw.intent) : null,
    brief: parseBrief(projectRaw.brief),
  };

  // Fetch workspaces
  const workspacesResult = await db
    .select({
      id: workspaces.id,
      project_id: workspaces.projectId,
      name: workspaces.name,
      machine_id: workspaces.machineId,
      base_snapshot_id: workspaces.baseSnapshotId,
      current_snapshot_id: workspaces.currentSnapshotId,
      local_path: workspaces.localPath,
      last_seen_at: workspaces.lastSeenAt,
      created_at: workspaces.createdAt,
    })
    .from(workspaces)
    .where(eq(workspaces.projectId, projectId))
    .orderBy(desc(workspaces.createdAt));

  // Fetch recent snapshots
  const snapshotsResult = await db
    .select({
      id: snapshots.id,
      project_id: snapshots.projectId,
      workspace_id: snapshots.workspaceId,
      manifest_hash: snapshots.manifestHash,
      parent_snapshot_ids: snapshots.parentSnapshotIds,
      source: snapshots.source,
      summary: snapshots.summary,
      created_at: snapshots.createdAt,
    })
    .from(snapshots)
    .where(eq(snapshots.projectId, projectId))
    .orderBy(desc(snapshots.createdAt))
    .limit(10);

  // Fetch recent events
  const eventsResult = await db
    .select({
      id: activityEvents.id,
      project_id: activityEvents.projectId,
      workspace_id: activityEvents.workspaceId,
      actor: activityEvents.actor,
      type: activityEvents.type,
      snapshot_id: activityEvents.snapshotId,
      message: activityEvents.message,
      created_at: activityEvents.createdAt,
    })
    .from(activityEvents)
    .where(eq(activityEvents.projectId, projectId))
    .orderBy(desc(activityEvents.createdAt))
    .limit(20);

  const lastMergeResult = await db
    .select({ created_at: activityEvents.createdAt })
    .from(activityEvents)
    .where(and(
      eq(activityEvents.projectId, projectId),
      eq(activityEvents.type, 'merge.completed')
    ))
    .orderBy(desc(activityEvents.createdAt))
    .limit(1);

  const lastMergeAt = lastMergeResult[0]?.created_at ?? null;

  const lastDeployResult = await db
    .select({ started_at: deployments.startedAt })
    .from(deployments)
    .where(eq(deployments.projectId, projectId))
    .orderBy(desc(deployments.startedAt))
    .limit(1);

  const lastDeployAt = lastDeployResult[0]?.started_at ?? null;

  const snapshotsSinceLastMerge = lastMergeAt
    ? (await db
        .select({ total: sql<number>`count(*)`.as('total') })
        .from(snapshots)
        .where(and(
          eq(snapshots.projectId, projectId),
          gt(snapshots.createdAt, lastMergeAt)
        )))[0]?.total ?? 0
    : null;

  const snapshotsSinceLastDeploy = lastDeployAt
    ? (await db
        .select({ total: sql<number>`count(*)`.as('total') })
        .from(snapshots)
        .where(and(
          eq(snapshots.projectId, projectId),
          gt(snapshots.createdAt, lastDeployAt)
        )))[0]?.total ?? 0
    : null;

  const snapshotsWithParents = snapshotsResult.map(s => ({
    ...s,
    parent_snapshot_ids: JSON.parse(s.parent_snapshot_ids || '[]'),
  }));

  return c.json({
    project,
    workspaces: workspacesResult,
    snapshots: snapshotsWithParents,
    events: eventsResult,
    snapshot_insights: {
      last_merge_at: lastMergeAt,
      last_deploy_at: lastDeployAt,
      snapshots_since_last_merge: snapshotsSinceLastMerge,
      snapshots_since_last_deploy: snapshotsSinceLastDeploy,
    }
  });
});

// Get project status
projectRoutes.get('/:projectId/status', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DB);

  const projectResult = await db
    .select({
      last_snapshot_id: projects.lastSnapshotId,
      updated_at: projects.updatedAt,
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)))
    .limit(1);

  const project = projectResult[0];

  if (!project) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  // Get last activity
  const eventResult = await db
    .select({
      type: activityEvents.type,
      created_at: activityEvents.createdAt,
    })
    .from(activityEvents)
    .where(eq(activityEvents.projectId, projectId))
    .orderBy(desc(activityEvents.createdAt))
    .limit(1);

  const lastEvent = eventResult[0];

  return c.json({
    last_snapshot_id: project.last_snapshot_id,
    updated_at: project.updated_at,
    last_activity: lastEvent || null
  });
});

// Get project events
projectRoutes.get('/:projectId/events', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
  const db = createDb(c.env.DB);

  // Verify ownership
  const projectResult = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)))
    .limit(1);

  if (!projectResult[0]) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  const result = await db
    .select({
      id: activityEvents.id,
      project_id: activityEvents.projectId,
      workspace_id: activityEvents.workspaceId,
      actor: activityEvents.actor,
      type: activityEvents.type,
      snapshot_id: activityEvents.snapshotId,
      message: activityEvents.message,
      created_at: activityEvents.createdAt,
    })
    .from(activityEvents)
    .where(eq(activityEvents.projectId, projectId))
    .orderBy(desc(activityEvents.createdAt))
    .limit(limit);

  return c.json({ events: result });
});

// Create workspace for project
projectRoutes.post('/:projectId/workspaces', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const body = await c.req.json<CreateWorkspaceRequest>();
  const db = createDb(c.env.DB);

  // Verify ownership
  const projectResult = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)))
    .limit(1);

  if (!projectResult[0]) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  if (!body.name || body.name.trim() === '') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Workspace name is required' } }, 422);
  }

  // If base_snapshot_id provided, verify it belongs to this project
  if (body.base_snapshot_id) {
    const snapshotResult = await db
      .select({ id: snapshots.id })
      .from(snapshots)
      .where(and(eq(snapshots.id, body.base_snapshot_id), eq(snapshots.projectId, projectId)))
      .limit(1);

    if (!snapshotResult[0]) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'base_snapshot_id does not belong to this project' } }, 422);
    }
  }

  const workspaceId = generateULID();
  const now = new Date().toISOString();

  await db.insert(workspaces).values({
    id: workspaceId,
    projectId,
    name: body.name.trim(),
    machineId: body.machine_id || null,
    baseSnapshotId: body.base_snapshot_id || null,
    currentSnapshotId: body.base_snapshot_id || null,
    localPath: body.local_path || null,
    createdAt: now,
  });

  // Insert activity event
  const eventId = generateULID();
  await db.insert(activityEvents).values({
    id: eventId,
    projectId,
    workspaceId,
    actor: 'cli',
    type: 'workspace.created',
    message: `Workspace "${body.name.trim()}" created`,
    createdAt: now,
  });

  const workspace: Workspace = {
    id: workspaceId,
    project_id: projectId,
    name: body.name.trim(),
    machine_id: body.machine_id || null,
    base_snapshot_id: body.base_snapshot_id || null,
    current_snapshot_id: body.base_snapshot_id || null,
    local_path: body.local_path || null,
    last_seen_at: null,
    created_at: now
  };

  return c.json({ workspace }, 201);
});

// List workspaces for project
projectRoutes.get('/:projectId/workspaces', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DB);

  // Verify ownership
  const projectResult = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)))
    .limit(1);

  if (!projectResult[0]) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  // Get workspaces with their latest drift report using a subquery
  // Since Drizzle doesn't directly support window functions in joins, we'll do two queries
  const workspacesResult = await db
    .select({
      id: workspaces.id,
      project_id: workspaces.projectId,
      name: workspaces.name,
      machine_id: workspaces.machineId,
    base_snapshot_id: workspaces.baseSnapshotId,
    current_snapshot_id: workspaces.currentSnapshotId,
    local_path: workspaces.localPath,
    last_seen_at: workspaces.lastSeenAt,
    created_at: workspaces.createdAt,
    })
    .from(workspaces)
    .where(eq(workspaces.projectId, projectId))
    .orderBy(desc(workspaces.createdAt));

  // Get latest drift report for each workspace
  const workspaceIds = workspacesResult.map(w => w.id);

  const driftMap = new Map<string, {
    files_added: number | null;
    files_modified: number | null;
    files_deleted: number | null;
    bytes_changed: number | null;
    summary: string | null;
    reported_at: string;
  }>();

  if (workspaceIds.length > 0) {
    // Get latest drift for each workspace
    for (const wsId of workspaceIds) {
      const driftResult = await db
        .select({
          files_added: driftReports.filesAdded,
          files_modified: driftReports.filesModified,
          files_deleted: driftReports.filesDeleted,
          bytes_changed: driftReports.bytesChanged,
          summary: driftReports.summary,
          reported_at: driftReports.reportedAt,
        })
        .from(driftReports)
        .where(eq(driftReports.workspaceId, wsId))
        .orderBy(desc(driftReports.reportedAt))
        .limit(1);

      if (driftResult[0]) {
        driftMap.set(wsId, driftResult[0]);
      }
    }
  }

  // Transform results to include drift as nested object
  const result = workspacesResult.map((row) => ({
    ...row,
    drift: driftMap.get(row.id) || null
  }));

  return c.json({ workspaces: result });
});

// Create snapshot for project
projectRoutes.post('/:projectId/snapshots', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const body = await c.req.json<{
    snapshot_id?: string;
    manifest_hash: string;
    parent_snapshot_ids?: string[];
    workspace_id?: string;
    source?: 'cli' | 'web';
  }>();
  const db = createDb(c.env.DB);

  // Verify ownership
  const projectResult = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)))
    .limit(1);

  if (!projectResult[0]) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  if (!body.manifest_hash) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'manifest_hash is required' } }, 422);
  }

  const parentSnapshotIds = Array.from(new Set((body.parent_snapshot_ids || []).filter(Boolean)));

  if (body.workspace_id) {
    const wsResult = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.id, body.workspace_id), eq(workspaces.projectId, projectId)))
      .limit(1);

    if (!wsResult[0]) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'workspace_id does not belong to this project' } }, 422);
    }
  }

  if (parentSnapshotIds.length > 0) {
    const parents = await db
      .select({ id: snapshots.id })
      .from(snapshots)
      .where(and(eq(snapshots.projectId, projectId), inArray(snapshots.id, parentSnapshotIds)));

    if (parents.length !== parentSnapshotIds.length) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'parent_snapshot_ids must belong to this project' } }, 422);
    }
  }

  // Ensure manifest exists in object store before registering snapshot
  const manifestKey = `${user.id}/manifests/${body.manifest_hash}.json`;
  const manifestObj = await c.env.BLOBS.get(manifestKey);
  if (!manifestObj) {
    return c.json({ error: { code: 'MANIFEST_NOT_FOUND', message: 'Manifest not found in object store' } }, 422);
  }

  const snapshotId = body.snapshot_id || generateSnapshotID();
  const now = new Date().toISOString();
  const source = body.source || 'cli';

  // Idempotency by snapshot ID (not by manifest hash)
  const existingById = await db
    .select({
      id: snapshots.id,
      project_id: snapshots.projectId,
      workspace_id: snapshots.workspaceId,
      manifest_hash: snapshots.manifestHash,
      parent_snapshot_ids: snapshots.parentSnapshotIds,
      source: snapshots.source,
      summary: snapshots.summary,
      created_at: snapshots.createdAt,
    })
    .from(snapshots)
    .where(and(eq(snapshots.id, snapshotId), eq(snapshots.projectId, projectId)))
    .limit(1);

  if (existingById[0]) {
    if (existingById[0].manifest_hash !== body.manifest_hash) {
      return c.json({ error: { code: 'CONFLICT', message: 'snapshot_id already exists with different manifest_hash' } }, 409);
    }
    const existingParents = JSON.parse(existingById[0].parent_snapshot_ids || '[]');
    if (JSON.stringify(existingParents) !== JSON.stringify(parentSnapshotIds)) {
      return c.json({ error: { code: 'CONFLICT', message: 'snapshot_id already exists with different parent_snapshot_ids' } }, 409);
    }
    return c.json({
      snapshot: {
        ...existingById[0],
        parent_snapshot_ids: JSON.parse(existingById[0].parent_snapshot_ids || '[]'),
      },
      created: false,
    });
  }

  await db.insert(snapshots).values({
    id: snapshotId,
    projectId,
    workspaceId: body.workspace_id || null,
    manifestHash: body.manifest_hash,
    parentSnapshotIds: JSON.stringify(parentSnapshotIds),
    source,
    createdAt: now,
  });

  if (body.workspace_id) {
    await db
      .update(workspaces)
      .set({
        currentManifestHash: body.manifest_hash,
        currentSnapshotId: snapshotId,
      })
      .where(eq(workspaces.id, body.workspace_id));
  }

  // Update project's last_snapshot_id and updated_at
  await db
    .update(projects)
    .set({ lastSnapshotId: snapshotId, updatedAt: now })
    .where(eq(projects.id, projectId));

  // Insert activity event
  const eventId = generateULID();
  await db.insert(activityEvents).values({
    id: eventId,
    projectId,
    actor: source,
    type: 'snapshot.pushed',
    snapshotId,
    message: `Snapshot ${snapshotId.slice(0, 8)}... pushed`,
    createdAt: now,
  });

  const snapshot: Snapshot = {
    id: snapshotId,
    project_id: projectId,
    workspace_id: body.workspace_id || null,
    manifest_hash: body.manifest_hash,
    parent_snapshot_ids: parentSnapshotIds,
    source,
    summary: null,
    created_at: now
  };

  return c.json({ snapshot, created: true }, 201);
});

// List snapshots for project
projectRoutes.get('/:projectId/snapshots', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const db = createDb(c.env.DB);

  // Verify ownership
  const projectResult = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)))
    .limit(1);

  if (!projectResult[0]) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  const result = await db
    .select({
      id: snapshots.id,
      project_id: snapshots.projectId,
      workspace_id: snapshots.workspaceId,
      manifest_hash: snapshots.manifestHash,
      parent_snapshot_ids: snapshots.parentSnapshotIds,
      source: snapshots.source,
      summary: snapshots.summary,
      created_at: snapshots.createdAt,
    })
    .from(snapshots)
    .where(eq(snapshots.projectId, projectId))
    .orderBy(desc(snapshots.createdAt))
    .limit(limit);

  const snapshotsWithParents = result.map(s => ({
    ...s,
    parent_snapshot_ids: JSON.parse(s.parent_snapshot_ids || '[]'),
  }));

  return c.json({ snapshots: snapshotsWithParents });
});

// =====================
// Environment Variables
// =====================

// List env vars for a project
projectRoutes.get('/:projectId/env-vars', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DB);

  // Verify ownership
  const projectResult = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)))
    .limit(1);

  if (!projectResult[0]) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  // Get env vars
  const vars = await db
    .select()
    .from(projectEnvVars)
    .where(eq(projectEnvVars.projectId, projectId))
    .orderBy(projectEnvVars.key);

  // Mask secret values
  const result: ProjectEnvVar[] = vars.map(v => ({
    id: v.id,
    project_id: v.projectId,
    key: v.key,
    value: v.isSecret ? maskSecret(v.value) : v.value,
    is_secret: Boolean(v.isSecret),
    created_at: v.createdAt,
    updated_at: v.updatedAt,
  }));

  return c.json({ variables: result });
});

// Set a single env var
projectRoutes.post('/:projectId/env-vars', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DB);

  // Verify ownership
  const projectResult = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)))
    .limit(1);

  if (!projectResult[0]) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  const body = await c.req.json<SetEnvVarRequest>();

  // Validate key format
  if (!body.key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(body.key)) {
    return c.json({
      error: { code: 'VALIDATION_ERROR', message: 'Key must start with letter or underscore and contain only alphanumeric characters' }
    }, 422);
  }

  if (body.value === undefined || body.value === null) {
    return c.json({
      error: { code: 'VALIDATION_ERROR', message: 'Value is required' }
    }, 422);
  }

  const now = new Date().toISOString();

  // Check if exists
  const existing = await db
    .select({ id: projectEnvVars.id })
    .from(projectEnvVars)
    .where(and(eq(projectEnvVars.projectId, projectId), eq(projectEnvVars.key, body.key)))
    .limit(1);

  if (existing[0]) {
    // Update
    await db
      .update(projectEnvVars)
      .set({
        value: body.value,
        isSecret: body.is_secret ? 1 : 0,
        updatedAt: now,
      })
      .where(eq(projectEnvVars.id, existing[0].id));
  } else {
    // Insert
    await db.insert(projectEnvVars).values({
      id: generateULID(),
      projectId,
      key: body.key,
      value: body.value,
      isSecret: body.is_secret ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  return c.json({ success: true });
});

// Bulk set env vars
projectRoutes.put('/:projectId/env-vars', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DB);

  // Verify ownership
  const projectResult = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)))
    .limit(1);

  if (!projectResult[0]) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  const { variables } = await c.req.json<{ variables: SetEnvVarRequest[] }>();

  if (!Array.isArray(variables)) {
    return c.json({
      error: { code: 'VALIDATION_ERROR', message: 'variables array is required' }
    }, 422);
  }

  const now = new Date().toISOString();

  for (const v of variables) {
    if (!v.key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.key)) continue;

    const existing = await db
      .select({ id: projectEnvVars.id })
      .from(projectEnvVars)
      .where(and(eq(projectEnvVars.projectId, projectId), eq(projectEnvVars.key, v.key)))
      .limit(1);

    if (existing[0]) {
      await db
        .update(projectEnvVars)
        .set({
          value: v.value,
          isSecret: v.is_secret ? 1 : 0,
          updatedAt: now,
        })
        .where(eq(projectEnvVars.id, existing[0].id));
    } else {
      await db.insert(projectEnvVars).values({
        id: generateULID(),
        projectId,
        key: v.key,
        value: v.value,
        isSecret: v.is_secret ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  return c.json({ success: true, count: variables.length });
});

// Delete an env var
projectRoutes.delete('/:projectId/env-vars/:key', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const key = c.req.param('key');
  const db = createDb(c.env.DB);

  // Verify ownership
  const projectResult = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)))
    .limit(1);

  if (!projectResult[0]) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  await db
    .delete(projectEnvVars)
    .where(and(eq(projectEnvVars.projectId, projectId), eq(projectEnvVars.key, key)));

  return c.json({ success: true });
});

// Internal: Get env vars with unmasked values (for deployment)
projectRoutes.get('/:projectId/env-vars/values', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DB);

  // Verify ownership
  const projectResult = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)))
    .limit(1);

  if (!projectResult[0]) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  // Get env vars with actual values
  const vars = await db
    .select({
      key: projectEnvVars.key,
      value: projectEnvVars.value,
      is_secret: projectEnvVars.isSecret,
    })
    .from(projectEnvVars)
    .where(eq(projectEnvVars.projectId, projectId));

  return c.json({
    variables: vars.map(v => ({
      key: v.key,
      value: v.value,
      is_secret: Boolean(v.is_secret),
    }))
  });
});

// =====================
// Project Documentation
// =====================

// List all docs across all workspaces in a project
projectRoutes.get('/:projectId/docs', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DB);

  // Verify project ownership
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)));

  if (!project) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  // Get all workspaces for this project
  const projectWorkspaces = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.projectId, projectId));

  const workspaceDocs: WorkspaceDocs[] = [];
  let totalFiles = 0;

  // For each workspace, get docs from its latest manifest
  for (const workspace of projectWorkspaces) {
    if (!workspace.currentManifestHash) continue;

    try {
      // Get the manifest for this workspace's snapshot
      const manifestKey = `${user.id}/manifests/${workspace.currentManifestHash}.json`;
      const manifestObj = await c.env.BLOBS.get(manifestKey);

      if (!manifestObj) continue;

      const manifest = JSON.parse(await manifestObj.text()) as { files: Array<{ path: string; hash: string; size: number }> };

      // Filter for doc files
      const docFiles: DocFile[] = manifest.files
        .filter(f => isDocFile(f.path))
        .map(f => ({
          path: f.path,
          workspace_id: workspace.id,
          workspace_name: workspace.name,
          size: f.size,
          hash: f.hash,
        }));

      if (docFiles.length > 0) {
        workspaceDocs.push({
          workspace_id: workspace.id,
          workspace_name: workspace.name,
          files: docFiles,
        });
        totalFiles += docFiles.length;
      }
    } catch (err) {
      console.error(`Failed to get docs for workspace ${workspace.id}:`, err);
      // Continue with other workspaces
    }
  }

  // Sort workspaces: main first, then alphabetically
  workspaceDocs.sort((a, b) => {
    if (a.workspace_name === 'main') return -1;
    if (b.workspace_name === 'main') return 1;
    return a.workspace_name.localeCompare(b.workspace_name);
  });

  const response: ListProjectDocsResponse = {
    workspaces: workspaceDocs,
    total_files: totalFiles,
  };

  return c.json(response);
});

// Get content of a specific doc file
projectRoutes.get('/:projectId/docs/content', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const workspaceId = c.req.query('workspace');
  const filePath = c.req.query('path');

  if (!workspaceId || !filePath) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'workspace and path query params required' } }, 422);
  }

  const db = createDb(c.env.DB);

  // Verify project ownership
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)));

  if (!project) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  // Get the workspace
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.projectId, projectId)));

  if (!workspace) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } }, 404);
  }

  if (!workspace.currentManifestHash) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workspace has no manifest' } }, 404);
  }

  try {
    // Get the manifest
    const manifestKey = `${user.id}/manifests/${workspace.currentManifestHash}.json`;
    const manifestObj = await c.env.BLOBS.get(manifestKey);

    if (!manifestObj) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Snapshot not found' } }, 404);
    }

    const manifest = JSON.parse(await manifestObj.text()) as { files: Array<{ path: string; hash: string; size: number }> };

    // Find the file
    const file = manifest.files.find(f => f.path === filePath);
    if (!file) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'File not found' } }, 404);
    }

    // Get the blob content
    const blobKey = `${user.id}/blobs/${file.hash}`;
    const blobObj = await c.env.BLOBS.get(blobKey);

    if (!blobObj) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'File content not found' } }, 404);
    }

    const content = await blobObj.text();

    const response: GetDocContentResponse = {
      content,
      path: filePath,
      workspace_id: workspace.id,
      workspace_name: workspace.name,
      size: file.size,
    };

    return c.json(response);
  } catch (err) {
    console.error('Failed to get doc content:', err);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get doc content' } }, 500);
  }
});

// Project brief
projectRoutes.get('/:projectId/brief', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DB);

  const [project] = await db
    .select({
      id: projects.id,
      owner_user_id: projects.ownerUserId,
      intent: projects.intent,
      brief: projects.brief,
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)));

  if (!project) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  return c.json({
    intent: project.intent ? toProjectIntent(project.intent) : null,
    brief: parseBrief(project.brief),
  });
});

projectRoutes.patch('/:projectId/brief', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const body = await c.req.json<{ intent?: unknown; brief?: unknown }>();
  const intent = toProjectIntent(body.intent);

  if (!intent || !body.brief || typeof body.brief !== 'object') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Valid intent and brief are required' } }, 422);
  }

  const brief = body.brief as ProjectBrief;
  if (brief.intent !== intent) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Brief intent must match intent field' } }, 422);
  }

  const db = createDb(c.env.DB);
  const now = new Date().toISOString();

  const result = await db
    .update(projects)
    .set({
      intent,
      brief: JSON.stringify(brief),
      updatedAt: now,
    })
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)))
    .returning({
      intent: projects.intent,
      brief: projects.brief,
    });

  if (result.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  return c.json({
    intent: intent,
    brief,
  });
});

// Next steps (product guidance)
projectRoutes.get('/:projectId/next-steps', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const status = c.req.query('status');
  const statusFilter = status ? normalizeNextStepStatus(status) : null;
  if (status && !statusFilter) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid status filter' } }, 422);
  }

  const db = createDb(c.env.DB);

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)));

  if (!project) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  const selectFields = {
    id: nextSteps.id,
    project_id: nextSteps.projectId,
    title: nextSteps.title,
    description: nextSteps.description,
    rationale: nextSteps.rationale,
    category: nextSteps.category,
    priority: nextSteps.priority,
    effort: nextSteps.effort,
    status: nextSteps.status,
    helpful_count: nextSteps.helpfulCount,
    not_helpful_count: nextSteps.notHelpfulCount,
    model: nextSteps.model,
    generated_at: nextSteps.generatedAt,
    acted_on_at: nextSteps.actedOnAt,
  };

  const rows = statusFilter
    ? await db
        .select(selectFields)
        .from(nextSteps)
        .where(and(eq(nextSteps.projectId, projectId), eq(nextSteps.status, statusFilter)))
        .orderBy(desc(nextSteps.generatedAt))
    : await db
        .select(selectFields)
        .from(nextSteps)
        .where(eq(nextSteps.projectId, projectId))
        .orderBy(desc(nextSteps.generatedAt));

  return c.json({ next_steps: rows });
});

projectRoutes.post('/:projectId/next-steps/generate', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  if (!c.env.AI) {
    return c.json({ error: { code: 'NOT_IMPLEMENTED', message: 'AI provider not configured' } }, 501);
  }

  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DB);

  const [project] = await db
    .select({
      id: projects.id,
      name: projects.name,
      intent: projects.intent,
      brief: projects.brief,
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)));

  if (!project) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  const intent = project.intent ? toProjectIntent(project.intent) : null;
  const brief = parseBrief(project.brief);

  if (!intent || !brief) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Project brief is required to generate next steps' } }, 422);
  }

  const workspaceIds = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.projectId, projectId));

  const workspaceIdList = workspaceIds.map((w) => w.id);

  const recentConversations = workspaceIdList.length
    ? await db
        .select({
          title: conversations.title,
          updated_at: conversations.updatedAt,
        })
        .from(conversations)
        .where(inArray(conversations.workspaceId, workspaceIdList))
        .orderBy(desc(conversations.updatedAt))
        .limit(6)
    : [];

  const snapshotStats = await db
    .select({
      total: sql<number>`count(*)`.as('total'),
      last: sql<string | null>`max(${snapshots.createdAt})`.as('last'),
    })
    .from(snapshots)
    .where(eq(snapshots.projectId, projectId));

  const previousSuggestions = await db
    .select({
      title: nextSteps.title,
      status: nextSteps.status,
    })
    .from(nextSteps)
    .where(eq(nextSteps.projectId, projectId))
    .orderBy(desc(nextSteps.generatedAt))
    .limit(20);

  const context = {
    project: {
      id: project.id,
      name: project.name,
      intent,
      brief,
    },
    activity: {
      snapshots_total: snapshotStats[0]?.total || 0,
      last_snapshot_at: snapshotStats[0]?.last || null,
      recent_conversations: recentConversations
        .filter((conv) => conv.title)
        .map((conv) => ({ title: conv.title, updated_at: conv.updated_at })),
    },
    previous_suggestions: previousSuggestions,
  };

  const prompt = `You are a product strategist. Using only the provided project context, generate 3-6 next steps.\n\nRules:\n- Align with intent and current stage\n- Be specific and actionable\n- Avoid duplicates with previous suggestions\n- Respect non-goals and decisions\n- Output JSON array only\n\nJSON shape:\n[{\"title\":\"...\",\"description\":\"...\",\"rationale\":\"...\",\"category\":\"feature|validation|launch|technical|user_research\",\"priority\":1|2|3,\"effort\":\"small|medium|large\"}]\n\nContext:\n${JSON.stringify(context, null, 2)}`;

  let responseText = '';
  try {
    const response = await c.env.AI.run(SUGGESTIONS_MODEL, {
      messages: [
        { role: 'system', content: 'Return only valid JSON. Do not include commentary.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 1600,
    });
    responseText = typeof response === 'string' ? response : (response as { response?: string }).response || '';
  } catch (err) {
    console.error('Suggestion generation failed:', err);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to generate next steps' } }, 500);
  }

  const jsonMatch = responseText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Invalid AI response' } }, 500);
  }

  let parsed: Array<Record<string, unknown>> = [];
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Invalid AI response' } }, 500);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return c.json({ next_steps: [] });
  }

  const existingTitles = new Set(
    previousSuggestions.map((s) => s.title.trim().toLowerCase())
  );

  const now = new Date().toISOString();
  const model = SUGGESTIONS_MODEL;
  const inserts = parsed
    .map((item) => {
      const title = typeof item.title === 'string' ? item.title.trim() : '';
      if (!title) return null;
      if (existingTitles.has(title.toLowerCase())) return null;
      const priority = item.priority === 1 || item.priority === 2 || item.priority === 3 ? item.priority : 2;
      return {
        id: generateULID(),
        projectId,
        title: title.slice(0, 140),
        description: typeof item.description === 'string' ? item.description.slice(0, 1000) : null,
        rationale: typeof item.rationale === 'string' ? item.rationale.slice(0, 1000) : null,
        category: normalizeCategory(item.category),
        priority,
        effort: normalizeEffort(item.effort),
        status: 'pending' as NextStepStatus,
        helpfulCount: 0,
        notHelpfulCount: 0,
        model,
        generatedAt: now,
        actedOnAt: null,
      };
    })
    .filter(Boolean) as Array<{
      id: string;
      projectId: string;
      title: string;
      description: string | null;
      rationale: string | null;
      category: NextStepCategory;
      priority: 1 | 2 | 3;
      effort: NextStepEffort | null;
      status: NextStepStatus;
      model: string;
      generatedAt: string;
      actedOnAt: string | null;
    }>;

  if (inserts.length === 0) {
    return c.json({ next_steps: [] });
  }

  await db.insert(nextSteps).values(inserts);

  const nextStepsResult: NextStep[] = inserts.map((item) => ({
    id: item.id,
    project_id: item.projectId,
    title: item.title,
    description: item.description,
    rationale: item.rationale,
    category: item.category,
    priority: item.priority,
    effort: item.effort,
    status: item.status,
    helpful_count: item.helpfulCount,
    not_helpful_count: item.notHelpfulCount,
    model: item.model,
    generated_at: item.generatedAt,
    acted_on_at: item.actedOnAt,
  }));

  return c.json({ next_steps: nextStepsResult });
});

projectRoutes.patch('/:projectId/next-steps/:nextStepId', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const nextStepId = c.req.param('nextStepId');
  const body = await c.req.json<{ status?: unknown }>();
  const status = normalizeNextStepStatus(body.status);

  if (!status) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Valid status is required' } }, 422);
  }

  const db = createDb(c.env.DB);

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)));

  if (!project) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  const now = new Date().toISOString();
  const actedOnAt = status === 'pending' ? null : now;

  const updated = await db
    .update(nextSteps)
    .set({
      status,
      actedOnAt,
    })
    .where(and(eq(nextSteps.id, nextStepId), eq(nextSteps.projectId, projectId)))
    .returning({
      id: nextSteps.id,
      project_id: nextSteps.projectId,
      title: nextSteps.title,
      description: nextSteps.description,
      rationale: nextSteps.rationale,
      category: nextSteps.category,
      priority: nextSteps.priority,
      effort: nextSteps.effort,
      status: nextSteps.status,
      helpful_count: nextSteps.helpfulCount,
      not_helpful_count: nextSteps.notHelpfulCount,
      model: nextSteps.model,
      generated_at: nextSteps.generatedAt,
      acted_on_at: nextSteps.actedOnAt,
    });

  if (updated.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Suggestion not found' } }, 404);
  }

  return c.json({ next_step: updated[0] });
});

projectRoutes.post('/:projectId/next-steps/:nextStepId/feedback', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const nextStepId = c.req.param('nextStepId');
  const body = await c.req.json<{ helpful?: unknown }>();

  if (typeof body.helpful !== 'boolean') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'helpful boolean is required' } }, 422);
  }

  const db = createDb(c.env.DB);

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)));

  if (!project) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  const updated = await db
    .update(nextSteps)
    .set({
      helpfulCount: body.helpful ? sql`helpful_count + 1` : nextSteps.helpfulCount,
      notHelpfulCount: body.helpful ? nextSteps.notHelpfulCount : sql`not_helpful_count + 1`,
    })
    .where(and(eq(nextSteps.id, nextStepId), eq(nextSteps.projectId, projectId)))
    .returning({
      id: nextSteps.id,
      project_id: nextSteps.projectId,
      title: nextSteps.title,
      description: nextSteps.description,
      rationale: nextSteps.rationale,
      category: nextSteps.category,
      priority: nextSteps.priority,
      effort: nextSteps.effort,
      status: nextSteps.status,
      helpful_count: nextSteps.helpfulCount,
      not_helpful_count: nextSteps.notHelpfulCount,
      model: nextSteps.model,
      generated_at: nextSteps.generatedAt,
      acted_on_at: nextSteps.actedOnAt,
    });

  if (updated.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Suggestion not found' } }, 404);
  }

  return c.json({ next_step: updated[0] });
});

// Project decisions
projectRoutes.get('/:projectId/decisions', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DB);

  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)));

  if (!project) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  const rows = await db
    .select({
      id: projectDecisions.id,
      project_id: projectDecisions.projectId,
      conversation_id: projectDecisions.conversationId,
      decision: projectDecisions.decision,
      rationale: projectDecisions.rationale,
      category: projectDecisions.category,
      decided_at: projectDecisions.decidedAt,
    })
    .from(projectDecisions)
    .where(eq(projectDecisions.projectId, projectId))
    .orderBy(desc(projectDecisions.decidedAt));

  // Refresh decision links
  const concepts = await db
    .select({
      id: atlasConcepts.id,
      name: atlasConcepts.name,
    })
    .from(atlasConcepts)
    .where(eq(atlasConcepts.projectId, projectId));

  if (concepts.length > 0 && rows.length > 0) {
    await db.delete(atlasDecisionLinks).where(eq(atlasDecisionLinks.projectId, projectId));
    const links: Array<{
      id: string;
      projectId: string;
      decisionId: string;
      conceptId: string;
      confidence: number;
      createdAt: string;
    }> = [];

    for (const decision of rows) {
      const haystack = `${decision.decision} ${decision.rationale || ''}`.toLowerCase();
      for (const concept of concepts) {
        const name = concept.name.toLowerCase();
        if (name.length < 3 || name === 'root') continue;
        if (haystack.includes(name)) {
          links.push({
            id: generateULID(),
            projectId,
            decisionId: decision.id,
            conceptId: concept.id,
            confidence: 70,
            createdAt: new Date().toISOString(),
          });
        }
      }
    }

    if (links.length > 0) {
      await db.insert(atlasDecisionLinks).values(links);
    }
  }

  return c.json({ decisions: rows });
});

projectRoutes.post('/:projectId/decisions/extract', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  if (!c.env.AI) {
    return c.json({ error: { code: 'NOT_IMPLEMENTED', message: 'AI provider not configured' } }, 501);
  }

  const projectId = c.req.param('projectId');
  const body = await c.req.json<{
    max_conversations?: number;
    messages_per_conversation?: number;
    conversation_id?: string;
  }>().catch(() => ({}));
  const maxConversations = Math.min(Math.max(body.max_conversations ?? 4, 1), 10);
  const messagesPerConversation = Math.min(Math.max(body.messages_per_conversation ?? 10, 4), 20);
  const conversationId = body.conversation_id;

  const db = createDb(c.env.DB);
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)));

  if (!project) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  let recentConversations: Array<{ id: string; updated_at: string }> = [];
  if (conversationId) {
    const [conv] = await db
      .select({
        id: conversations.id,
        updated_at: conversations.updatedAt,
      })
      .from(conversations)
      .innerJoin(workspaces, eq(conversations.workspaceId, workspaces.id))
      .innerJoin(projects, eq(workspaces.projectId, projects.id))
      .where(and(
        eq(conversations.id, conversationId),
        eq(projects.id, projectId),
        eq(projects.ownerUserId, user.id)
      ))
      .limit(1);
    if (conv) {
      recentConversations = [conv];
    }
  } else {
    const workspaceIds = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.projectId, projectId));

    const workspaceIdList = workspaceIds.map((w) => w.id);
    if (workspaceIdList.length === 0) {
      return c.json({ decisions: [] });
    }

    recentConversations = await db
      .select({
        id: conversations.id,
        updated_at: conversations.updatedAt,
      })
      .from(conversations)
      .where(inArray(conversations.workspaceId, workspaceIdList))
      .orderBy(desc(conversations.updatedAt))
      .limit(maxConversations);
  }

  const existing = await db
    .select({ decision: projectDecisions.decision })
    .from(projectDecisions)
    .where(eq(projectDecisions.projectId, projectId));
  const existingSet = new Set(existing.map((row) => row.decision.trim().toLowerCase()));

  const inserts: ProjectDecision[] = [];
  for (const conversation of recentConversations) {
    const doId = c.env.ConversationSession.idFromName(`conversation:${conversation.id}`);
    const stub = c.env.ConversationSession.get(doId);
    const response = await stub.fetch(new Request(`http://do/messages?limit=${messagesPerConversation}`));
    if (!response.ok) continue;
    const { messages } = await response.json() as { messages?: Array<{ role: string; content: string }> };
    if (!messages || messages.length === 0) continue;

    const transcript = messages
      .map((m) => `${m.role}: ${m.content}`.slice(0, 600))
      .join('\n');

    const prompt = `Extract explicit project decisions from this conversation.\n\nRules:\n- Only include clear decisions or tradeoffs.\n- If none, return []\n- Return JSON array only.\n\nJSON shape:\n[{\"decision\":\"...\",\"rationale\":\"...\",\"category\":\"architecture|scope|tech_choice|approach|process|product\"}]\n\nConversation:\n${transcript}`;

    let responseText = '';
    try {
      const aiResponse = await c.env.AI.run(ATLAS_SEARCH_MODEL, {
        messages: [
          { role: 'system', content: 'Return only valid JSON. Do not include commentary.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 800,
      });
      responseText = typeof aiResponse === 'string' ? aiResponse : (aiResponse as { response?: string }).response || '';
    } catch (err) {
      console.error('Decision extraction failed:', err);
      continue;
    }

    const parsed = parseJsonArray(responseText);
    if (!parsed || parsed.length === 0) continue;

    for (const item of parsed) {
      const decision = typeof item.decision === 'string' ? item.decision.trim() : '';
      if (!decision) continue;
      const normalizedDecision = decision.toLowerCase();
      if (existingSet.has(normalizedDecision)) continue;
      const rationale = typeof item.rationale === 'string' ? item.rationale.trim() : null;
      const category = normalizeDecisionCategory(item.category);
      const id = generateULID();
      const decidedAt = new Date().toISOString();
      existingSet.add(normalizedDecision);
      inserts.push({
        id,
        project_id: projectId,
        conversation_id: conversation.id,
        decision: decision.slice(0, 240),
        rationale: rationale ? rationale.slice(0, 1000) : null,
        category,
        decided_at: decidedAt,
      });
    }
  }

  if (inserts.length > 0) {
    await db.insert(projectDecisions).values(inserts.map((decision) => ({
      id: decision.id,
      projectId: decision.project_id,
      conversationId: decision.conversation_id,
      decision: decision.decision,
      rationale: decision.rationale,
      category: decision.category,
      decidedAt: decision.decided_at,
    })));
  }

  const rows = await db
    .select({
      id: projectDecisions.id,
      project_id: projectDecisions.projectId,
      conversation_id: projectDecisions.conversationId,
      decision: projectDecisions.decision,
      rationale: projectDecisions.rationale,
      category: projectDecisions.category,
      decided_at: projectDecisions.decidedAt,
    })
    .from(projectDecisions)
    .where(eq(projectDecisions.projectId, projectId))
    .orderBy(desc(projectDecisions.decidedAt));

  return c.json({ decisions: rows });
});

// Atlas semantic search
projectRoutes.post('/:projectId/atlas/search', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const body = await c.req.json<{ query?: string; limit?: number }>().catch(() => ({}));
  const query = (body.query || '').trim();
  const limit = Math.min(Math.max(body.limit ?? 8, 1), 20);
  if (!query) {
    return c.json({ results: [] });
  }

  const db = createDb(c.env.DB);
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)));

  if (!project) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  const storedConcepts = await db
    .select({
      id: atlasConcepts.id,
      name: atlasConcepts.name,
      description: atlasConcepts.description,
      layer: atlasConcepts.layer,
    })
    .from(atlasConcepts)
    .where(eq(atlasConcepts.projectId, projectId));

  if (storedConcepts.length > 0) {
    const concepts = storedConcepts.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description || '',
      layer: row.layer as AtlasSearchResult['layer'],
    }));

    const queryVector = await embedText(c.env, query);
    if (queryVector) {
      const rows = await db
        .select({
          vector: atlasEmbeddings.vector,
          concept_id: atlasChunks.conceptId,
        })
        .from(atlasEmbeddings)
        .innerJoin(atlasChunks, eq(atlasEmbeddings.chunkId, atlasChunks.id))
        .where(eq(atlasChunks.projectId, projectId))
        .limit(2000);

      const conceptScores = new Map<string, number>();
      for (const row of rows) {
        if (!row.concept_id) continue;
        let vector: number[] | null = null;
        try {
          vector = JSON.parse(row.vector);
        } catch {
          vector = null;
        }
        if (!vector) continue;
        const score = cosineSimilarity(queryVector, vector);
        const prev = conceptScores.get(row.concept_id) ?? 0;
        if (score > prev) {
          conceptScores.set(row.concept_id, score);
        }
      }

      const ranked = concepts
        .map((concept) => ({ concept, score: conceptScores.get(concept.id) ?? 0 }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((entry) => entry.concept);

      if (ranked.length > 0) {
        return c.json({ results: ranked });
      }
    }

    const lexical = rankConcepts(query, concepts, limit);
    return c.json({ results: lexical });
  }

  const snapshot = await loadLatestSnapshotManifest(c.env, user.id, projectId);
  if (!snapshot) {
    return c.json({ results: [] });
  }

  const concepts = deriveAtlasConcepts(snapshot.manifest);
  const candidates = rankConcepts(query, concepts, 60);

  if (!c.env.AI || candidates.length === 0) {
    return c.json({ results: candidates.slice(0, limit) });
  }

  const prompt = `You are ranking project concepts for a user query.\nReturn a JSON array of concept ids in relevance order.\n\nQuery: ${query}\n\nConcepts:\n${candidates.map((c) => JSON.stringify(c)).join('\n')}`;

  let responseText = '';
  try {
    const response = await c.env.AI.run(ATLAS_SEARCH_MODEL, {
      messages: [
        { role: 'system', content: 'Return only valid JSON. Do not include commentary.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 400,
    });
    responseText = typeof response === 'string' ? response : (response as { response?: string }).response || '';
  } catch (err) {
    console.error('Atlas search failed:', err);
    return c.json({ results: candidates.slice(0, limit) });
  }

  const parsed = parseJsonArray(responseText) as string[] | null;
  if (!parsed) {
    return c.json({ results: candidates.slice(0, limit) });
  }

  const candidateMap = new Map(candidates.map((c) => [c.id, c]));
  const ranked: AtlasSearchResult[] = [];
  for (const id of parsed) {
    if (typeof id !== 'string') continue;
    const concept = candidateMap.get(id);
    if (concept) ranked.push(concept);
  }

  if (ranked.length === 0) {
    return c.json({ results: candidates.slice(0, limit) });
  }

  return c.json({ results: ranked.slice(0, limit) });
});

// Get stored Atlas index
projectRoutes.get('/:projectId/atlas', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DB);

  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)));

  if (!project) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  const concepts = await db
    .select({
      id: atlasConcepts.id,
      project_id: atlasConcepts.projectId,
      name: atlasConcepts.name,
      layer: atlasConcepts.layer,
      type: atlasConcepts.type,
      description: atlasConcepts.description,
      source_snapshot_id: atlasConcepts.sourceSnapshotId,
      source_manifest_hash: atlasConcepts.sourceManifestHash,
      metadata: atlasConcepts.metadata,
      created_at: atlasConcepts.createdAt,
      updated_at: atlasConcepts.updatedAt,
    })
    .from(atlasConcepts)
    .where(eq(atlasConcepts.projectId, projectId));

  const edges = await db
    .select({
      id: atlasEdges.id,
      project_id: atlasEdges.projectId,
      from_concept_id: atlasEdges.fromConceptId,
      to_concept_id: atlasEdges.toConceptId,
      type: atlasEdges.type,
      weight: atlasEdges.weight,
      created_at: atlasEdges.createdAt,
    })
    .from(atlasEdges)
    .where(eq(atlasEdges.projectId, projectId));

  const decisionLinks = await db
    .select({
      id: atlasDecisionLinks.id,
      project_id: atlasDecisionLinks.projectId,
      decision_id: atlasDecisionLinks.decisionId,
      concept_id: atlasDecisionLinks.conceptId,
      confidence: atlasDecisionLinks.confidence,
      created_at: atlasDecisionLinks.createdAt,
    })
    .from(atlasDecisionLinks)
    .where(eq(atlasDecisionLinks.projectId, projectId));

  return c.json({ concepts, edges, decision_links: decisionLinks });
});

// Build Atlas index from latest snapshot
projectRoutes.post('/:projectId/atlas/index', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const body = await c.req.json<{ max_files?: number }>().catch(() => ({}));
  const maxFiles = Math.min(Math.max(body.max_files ?? ATLAS_MAX_FILES_DEFAULT, 20), 1000);

  const db = createDb(c.env.DB);
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)));

  if (!project) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  const latest = await loadLatestSnapshotManifest(c.env, user.id, projectId);
  if (!latest) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'No snapshot manifest found' } }, 404);
  }

  // Clear previous index
  await db.delete(atlasEmbeddings).where(sql`${atlasEmbeddings.chunkId} in (select id from atlas_chunks where project_id = ${projectId})`);
  await db.delete(atlasChunks).where(eq(atlasChunks.projectId, projectId));
  await db.delete(atlasDecisionLinks).where(eq(atlasDecisionLinks.projectId, projectId));
  await db.delete(atlasEdges).where(eq(atlasEdges.projectId, projectId));
  await db.delete(atlasConcepts).where(eq(atlasConcepts.projectId, projectId));

  const { items } = buildAtlasIndexItems(latest.manifest);
  const conceptRows = new Map<string, AtlasSearchResult>();
  for (const item of items) {
    conceptRows.set(item.concept.id, item.concept);
  }

  for (const decision of decisionRows) {
    conceptRows.set(`narrative:decision:${decision.id}`, {
      id: `narrative:decision:${decision.id}`,
      name: decision.decision,
      description: decision.rationale || '',
      layer: 'narrative',
    });
  }

  if (c.env.AI) {
    const systems = Array.from(conceptRows.values())
      .filter((c) => c.layer === 'system')
      .map((c) => c.name)
      .slice(0, 20);
    const modules = Array.from(conceptRows.values())
      .filter((c) => c.layer === 'module')
      .map((c) => c.name)
      .slice(0, 30);
    const decisions = decisionRows.map((d) => `${d.decision}${d.rationale ? ` (${d.rationale})` : ''}`).slice(0, 12);

    const prompt = `Generate 3-8 capability concepts for this project based on the systems/modules and decisions.\nReturn JSON array only.\n\nJSON shape:\n[{\"name\":\"...\",\"description\":\"...\"}]\n\nSystems:\n${systems.join(', ')}\n\nModules:\n${modules.join(', ')}\n\nDecisions:\n${decisions.join('\\n')}`;

    try {
      const response = await c.env.AI.run(ATLAS_SEARCH_MODEL, {
        messages: [
          { role: 'system', content: 'Return only valid JSON. Do not include commentary.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 800,
      });
      const responseText = typeof response === 'string' ? response : (response as { response?: string }).response || '';
      const parsed = parseJsonArray(responseText);
      if (parsed && parsed.length > 0) {
        for (const item of parsed) {
          const name = typeof item.name === 'string' ? item.name.trim() : '';
          if (!name) continue;
          const description = typeof item.description === 'string' ? item.description.trim() : '';
          const id = `capability:${slugify(name)}`;
          conceptRows.set(id, {
            id,
            name: name.slice(0, 120),
            description: description.slice(0, 400),
            layer: 'capability',
          });
        }
      }
    } catch (err) {
      console.error('Capability extraction failed:', err);
    }
  }

  const conceptInserts = Array.from(conceptRows.values()).map((concept) => ({
    id: concept.id,
    projectId,
    name: concept.name,
    layer: concept.layer,
    type: null,
    description: concept.description,
    sourceSnapshotId: latest.snapshotId,
    sourceManifestHash: latest.manifestHash,
    metadata: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));

  if (conceptInserts.length) {
    await db.insert(atlasConcepts).values(conceptInserts);
  }

  const edgeSet = new Set<string>();
  const edgeInserts: Array<{
    id: string;
    projectId: string;
    fromConceptId: string;
    toConceptId: string;
    type: string;
    weight: number | null;
    createdAt: string;
  }> = [];

  for (const item of items) {
    if (item.kind === 'module' && item.systemId) {
      const key = `${item.systemId}::${item.concept.id}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edgeInserts.push({
          id: generateULID(),
          projectId,
          fromConceptId: item.systemId,
          toConceptId: item.concept.id,
          type: 'contains',
          weight: null,
          createdAt: new Date().toISOString(),
        });
      }
    }
    if (item.kind === 'code' && item.moduleId) {
      const key = `${item.moduleId}::${item.concept.id}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edgeInserts.push({
          id: generateULID(),
          projectId,
          fromConceptId: item.moduleId,
          toConceptId: item.concept.id,
          type: 'contains',
          weight: null,
          createdAt: new Date().toISOString(),
        });
      }
    }
  }

  if (edgeInserts.length) {
    await db.insert(atlasEdges).values(edgeInserts);
  }

  const chunkInserts: Array<{
    id: string;
    projectId: string;
    conceptId: string;
    kind: string;
    content: string;
    filePath?: string | null;
    symbol?: string | null;
    sourceHash?: string | null;
    createdAt: string;
  }> = [];

  const chunkEmbeddings: Array<{ chunkId: string; vector: number[] }> = [];
  let processedFiles = 0;

  for (const item of items) {
    if (processedFiles >= maxFiles) break;
    if (item.kind !== 'code' || !item.path || !item.hash) continue;
    if (isBinaryPath(item.path)) continue;
    if (item.size && item.size > 400_000) continue;

    const blob = await c.env.BLOBS.get(`${user.id}/blobs/${item.hash}`);
    if (!blob) continue;
    let content = '';
    try {
      const buf = await blob.arrayBuffer();
      content = new TextDecoder().decode(buf);
    } catch {
      continue;
    }

    if (!content.trim()) continue;
    if (content.length > ATLAS_MAX_CHUNK_CHARS) {
      content = content.slice(0, ATLAS_MAX_CHUNK_CHARS);
    }

    const chunkId = generateULID();
    chunkInserts.push({
      id: chunkId,
      projectId,
      conceptId: item.concept.id,
      kind: 'code',
      content,
      filePath: item.path,
      symbol: null,
      sourceHash: item.hash,
      createdAt: new Date().toISOString(),
    });

    const vector = await embedText(c.env, content);
    if (vector) {
      chunkEmbeddings.push({ chunkId, vector });
    }
    processedFiles += 1;
  }

  const decisionRows = await db
    .select({
      id: projectDecisions.id,
      decision: projectDecisions.decision,
      rationale: projectDecisions.rationale,
    })
    .from(projectDecisions)
    .where(eq(projectDecisions.projectId, projectId));

  for (const decision of decisionRows) {
    const content = `${decision.decision}${decision.rationale ? `\n${decision.rationale}` : ''}`.slice(0, ATLAS_MAX_CHUNK_CHARS);
    const chunkId = generateULID();
    chunkInserts.push({
      id: chunkId,
      projectId,
      conceptId: null,
      kind: 'decision',
      content,
      filePath: null,
      symbol: null,
      sourceHash: null,
      createdAt: new Date().toISOString(),
    });
    const vector = await embedText(c.env, content);
    if (vector) {
      chunkEmbeddings.push({ chunkId, vector });
    }
  }

  if (chunkInserts.length) {
    await db.insert(atlasChunks).values(chunkInserts);
  }

  if (chunkEmbeddings.length) {
    const embeddingInserts = chunkEmbeddings.map((embedding) => ({
      id: generateULID(),
      chunkId: embedding.chunkId,
      model: ATLAS_EMBEDDING_MODEL,
      vector: JSON.stringify(embedding.vector),
      createdAt: new Date().toISOString(),
    }));
    await db.insert(atlasEmbeddings).values(embeddingInserts);
  }

  return c.json({
    concepts: conceptInserts.length,
    edges: edgeInserts.length,
    chunks: chunkInserts.length,
    embeddings: chunkEmbeddings.length,
  });
});

// List Atlas diagrams
projectRoutes.get('/:projectId/atlas/diagrams', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const conceptId = c.req.query('concept_id');
  const db = createDb(c.env.DB);

  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)));

  if (!project) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  const rows = conceptId
    ? await db
        .select({
          id: atlasDiagrams.id,
          project_id: atlasDiagrams.projectId,
          concept_id: atlasDiagrams.conceptId,
          type: atlasDiagrams.type,
          data: atlasDiagrams.data,
          created_at: atlasDiagrams.createdAt,
        })
        .from(atlasDiagrams)
        .where(and(eq(atlasDiagrams.projectId, projectId), eq(atlasDiagrams.conceptId, conceptId)))
        .orderBy(desc(atlasDiagrams.createdAt))
    : await db
        .select({
          id: atlasDiagrams.id,
          project_id: atlasDiagrams.projectId,
          concept_id: atlasDiagrams.conceptId,
          type: atlasDiagrams.type,
          data: atlasDiagrams.data,
          created_at: atlasDiagrams.createdAt,
        })
        .from(atlasDiagrams)
        .where(eq(atlasDiagrams.projectId, projectId))
        .orderBy(desc(atlasDiagrams.createdAt))
        .limit(20);

  return c.json({ diagrams: rows });
});

// Create Atlas diagram (simple derived)
projectRoutes.post('/:projectId/atlas/diagrams', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const body = await c.req.json<{ concept_id?: string | null; type?: string }>().catch(() => ({}));
  const type = body.type || 'dependency';
  const conceptId = body.concept_id || null;

  const db = createDb(c.env.DB);
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)));

  if (!project) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  const concepts = await db
    .select({
      id: atlasConcepts.id,
      name: atlasConcepts.name,
    })
    .from(atlasConcepts)
    .where(eq(atlasConcepts.projectId, projectId));

  const edges = await db
    .select({
      from_concept_id: atlasEdges.fromConceptId,
      to_concept_id: atlasEdges.toConceptId,
      type: atlasEdges.type,
    })
    .from(atlasEdges)
    .where(eq(atlasEdges.projectId, projectId));

  const diagramData = buildDiagramData({
    conceptId,
    type,
    concepts,
    edges,
  });

  const diagramId = generateULID();
  const createdAt = new Date().toISOString();
  await db.insert(atlasDiagrams).values({
    id: diagramId,
    projectId,
    conceptId,
    type,
    data: JSON.stringify(diagramData),
    createdAt,
  });

  return c.json({
    diagram: {
      id: diagramId,
      project_id: projectId,
      concept_id: conceptId,
      type,
      data: JSON.stringify(diagramData),
      created_at: createdAt,
    }
  });
});

// Helper: Generate ULID
function generateULID(): string {
  const timestamp = Date.now().toString(36).padStart(10, '0');
  const random = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 36).toString(36)
  ).join('');
  return (timestamp + random).toUpperCase();
}

function generateSnapshotID(): string {
  return `snap-${generateULID()}`;
}

// Helper: Mask secret value
function maskSecret(value: string): string {
  if (value.length <= 4) return '****';
  return '****' + value.slice(-4);
}
