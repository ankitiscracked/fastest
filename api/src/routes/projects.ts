import { Hono } from 'hono';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
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
  BuildSuggestion,
  BuildSuggestionCategory,
  BuildSuggestionEffort,
  BuildSuggestionStatus,
} from '@fastest/shared';
import { getAuthUser } from '../middleware/auth';
import { createDb, projects, workspaces, snapshots, activityEvents, driftReports, projectEnvVars, conversations, buildSuggestions } from '../db';

const SUGGESTIONS_MODEL = '@cf/meta/llama-3.1-8b-instruct';

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

function normalizeSuggestionStatus(status: unknown): BuildSuggestionStatus | null {
  if (typeof status !== 'string') return null;
  const allowed: BuildSuggestionStatus[] = ['pending', 'started', 'completed', 'dismissed'];
  return allowed.includes(status as BuildSuggestionStatus) ? (status as BuildSuggestionStatus) : null;
}

function normalizeCategory(value: unknown): BuildSuggestionCategory {
  const allowed: BuildSuggestionCategory[] = ['feature', 'validation', 'launch', 'technical', 'user_research'];
  if (typeof value === 'string' && allowed.includes(value as BuildSuggestionCategory)) {
    return value as BuildSuggestionCategory;
  }
  return 'feature';
}

function normalizeEffort(value: unknown): BuildSuggestionEffort | null {
  const allowed: BuildSuggestionEffort[] = ['small', 'medium', 'large'];
  if (typeof value === 'string' && allowed.includes(value as BuildSuggestionEffort)) {
    return value as BuildSuggestionEffort;
  }
  return null;
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
      fork_snapshot_id: workspaces.forkSnapshotId,
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
      parent_snapshot_id: snapshots.parentSnapshotId,
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

  return c.json({
    project,
    workspaces: workspacesResult,
    snapshots: snapshotsResult,
    events: eventsResult
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

  // If fork_snapshot_id provided, verify it belongs to this project
  if (body.fork_snapshot_id) {
    const snapshotResult = await db
      .select({ id: snapshots.id })
      .from(snapshots)
      .where(and(eq(snapshots.id, body.fork_snapshot_id), eq(snapshots.projectId, projectId)))
      .limit(1);

    if (!snapshotResult[0]) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'fork_snapshot_id does not belong to this project' } }, 422);
    }
  }

  const workspaceId = generateULID();
  const now = new Date().toISOString();

  await db.insert(workspaces).values({
    id: workspaceId,
    projectId,
    name: body.name.trim(),
    machineId: body.machine_id || null,
    forkSnapshotId: body.fork_snapshot_id || null,
    currentSnapshotId: body.fork_snapshot_id || null,
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
    fork_snapshot_id: body.fork_snapshot_id || null,
    current_snapshot_id: body.fork_snapshot_id || null,
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
    fork_snapshot_id: workspaces.forkSnapshotId,
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
    parent_snapshot_id?: string;
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
      parent_snapshot_id: snapshots.parentSnapshotId,
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
    return c.json({ snapshot: existingById[0], created: false });
  }

  await db.insert(snapshots).values({
    id: snapshotId,
    projectId,
    workspaceId: body.workspace_id || null,
    manifestHash: body.manifest_hash,
    parentSnapshotId: body.parent_snapshot_id || null,
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
    parent_snapshot_id: body.parent_snapshot_id || null,
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
      parent_snapshot_id: snapshots.parentSnapshotId,
      source: snapshots.source,
      summary: snapshots.summary,
      created_at: snapshots.createdAt,
    })
    .from(snapshots)
    .where(eq(snapshots.projectId, projectId))
    .orderBy(desc(snapshots.createdAt))
    .limit(limit);

  return c.json({ snapshots: result });
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

// Build suggestions (product guidance)
projectRoutes.get('/:projectId/suggestions', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const status = c.req.query('status');
  const statusFilter = status ? normalizeSuggestionStatus(status) : null;
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
    id: buildSuggestions.id,
    project_id: buildSuggestions.projectId,
    title: buildSuggestions.title,
    description: buildSuggestions.description,
    rationale: buildSuggestions.rationale,
    category: buildSuggestions.category,
    priority: buildSuggestions.priority,
    effort: buildSuggestions.effort,
    status: buildSuggestions.status,
    helpful_count: buildSuggestions.helpfulCount,
    not_helpful_count: buildSuggestions.notHelpfulCount,
    model: buildSuggestions.model,
    generated_at: buildSuggestions.generatedAt,
    acted_on_at: buildSuggestions.actedOnAt,
  };

  const rows = statusFilter
    ? await db
        .select(selectFields)
        .from(buildSuggestions)
        .where(and(eq(buildSuggestions.projectId, projectId), eq(buildSuggestions.status, statusFilter)))
        .orderBy(desc(buildSuggestions.generatedAt))
    : await db
        .select(selectFields)
        .from(buildSuggestions)
        .where(eq(buildSuggestions.projectId, projectId))
        .orderBy(desc(buildSuggestions.generatedAt));

  return c.json({ suggestions: rows });
});

projectRoutes.post('/:projectId/suggestions/generate', async (c) => {
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
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Project brief is required to generate suggestions' } }, 422);
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
      title: buildSuggestions.title,
      status: buildSuggestions.status,
    })
    .from(buildSuggestions)
    .where(eq(buildSuggestions.projectId, projectId))
    .orderBy(desc(buildSuggestions.generatedAt))
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

  const prompt = `You are a product strategist. Using only the provided project context, generate 3-6 build suggestions.\n\nRules:\n- Align with intent and current stage\n- Be specific and actionable\n- Avoid duplicates with previous suggestions\n- Respect non-goals and decisions\n- Output JSON array only\n\nJSON shape:\n[{\"title\":\"...\",\"description\":\"...\",\"rationale\":\"...\",\"category\":\"feature|validation|launch|technical|user_research\",\"priority\":1|2|3,\"effort\":\"small|medium|large\"}]\n\nContext:\n${JSON.stringify(context, null, 2)}`;

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
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to generate suggestions' } }, 500);
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
    return c.json({ suggestions: [] });
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
        status: 'pending' as BuildSuggestionStatus,
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
      category: BuildSuggestionCategory;
      priority: 1 | 2 | 3;
      effort: BuildSuggestionEffort | null;
      status: BuildSuggestionStatus;
      model: string;
      generatedAt: string;
      actedOnAt: string | null;
    }>;

  if (inserts.length === 0) {
    return c.json({ suggestions: [] });
  }

  await db.insert(buildSuggestions).values(inserts);

  const suggestions: BuildSuggestion[] = inserts.map((item) => ({
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

  return c.json({ suggestions });
});

projectRoutes.patch('/:projectId/suggestions/:suggestionId', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const suggestionId = c.req.param('suggestionId');
  const body = await c.req.json<{ status?: unknown }>();
  const status = normalizeSuggestionStatus(body.status);

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
    .update(buildSuggestions)
    .set({
      status,
      actedOnAt,
    })
    .where(and(eq(buildSuggestions.id, suggestionId), eq(buildSuggestions.projectId, projectId)))
    .returning({
      id: buildSuggestions.id,
      project_id: buildSuggestions.projectId,
      title: buildSuggestions.title,
      description: buildSuggestions.description,
      rationale: buildSuggestions.rationale,
      category: buildSuggestions.category,
      priority: buildSuggestions.priority,
      effort: buildSuggestions.effort,
      status: buildSuggestions.status,
      helpful_count: buildSuggestions.helpfulCount,
      not_helpful_count: buildSuggestions.notHelpfulCount,
      model: buildSuggestions.model,
      generated_at: buildSuggestions.generatedAt,
      acted_on_at: buildSuggestions.actedOnAt,
    });

  if (updated.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Suggestion not found' } }, 404);
  }

  return c.json({ suggestion: updated[0] });
});

projectRoutes.post('/:projectId/suggestions/:suggestionId/feedback', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const suggestionId = c.req.param('suggestionId');
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
    .update(buildSuggestions)
    .set({
      helpfulCount: body.helpful ? sql`helpful_count + 1` : buildSuggestions.helpfulCount,
      notHelpfulCount: body.helpful ? buildSuggestions.notHelpfulCount : sql`not_helpful_count + 1`,
    })
    .where(and(eq(buildSuggestions.id, suggestionId), eq(buildSuggestions.projectId, projectId)))
    .returning({
      id: buildSuggestions.id,
      project_id: buildSuggestions.projectId,
      title: buildSuggestions.title,
      description: buildSuggestions.description,
      rationale: buildSuggestions.rationale,
      category: buildSuggestions.category,
      priority: buildSuggestions.priority,
      effort: buildSuggestions.effort,
      status: buildSuggestions.status,
      helpful_count: buildSuggestions.helpfulCount,
      not_helpful_count: buildSuggestions.notHelpfulCount,
      model: buildSuggestions.model,
      generated_at: buildSuggestions.generatedAt,
      acted_on_at: buildSuggestions.actedOnAt,
    });

  if (updated.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Suggestion not found' } }, 404);
  }

  return c.json({ suggestion: updated[0] });
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
