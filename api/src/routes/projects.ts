import { Hono } from 'hono';
import { eq, and, desc, sql } from 'drizzle-orm';
import type { Env } from '../index';
import type { Project, Workspace, Snapshot, CreateProjectRequest, CreateWorkspaceRequest, SetEnvVarRequest, ProjectEnvVar } from '@fastest/shared';
import { getAuthUser } from '../middleware/auth';
import { createDb, projects, workspaces, snapshots, activityEvents, driftReports, projectEnvVars } from '../db';

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
    created_at: now,
    updated_at: now,
    last_snapshot_id: null
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
      created_at: projects.createdAt,
      updated_at: projects.updatedAt,
      last_snapshot_id: projects.lastSnapshotId,
    })
    .from(projects)
    .where(eq(projects.ownerUserId, user.id))
    .orderBy(desc(projects.updatedAt));

  return c.json({ projects: result });
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
      created_at: projects.createdAt,
      updated_at: projects.updatedAt,
      last_snapshot_id: projects.lastSnapshotId,
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)))
    .limit(1);

  const project = projectResult[0];

  if (!project) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  // Fetch workspaces
  const workspacesResult = await db
    .select({
      id: workspaces.id,
      project_id: workspaces.projectId,
      name: workspaces.name,
      machine_id: workspaces.machineId,
      base_snapshot_id: workspaces.baseSnapshotId,
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
      manifest_hash: snapshots.manifestHash,
      parent_snapshot_id: snapshots.parentSnapshotId,
      source: snapshots.source,
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
    manifest_hash: string;
    parent_snapshot_id?: string;
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

  // Check if snapshot with same manifest already exists
  const existingResult = await db
    .select({ id: snapshots.id })
    .from(snapshots)
    .where(and(eq(snapshots.projectId, projectId), eq(snapshots.manifestHash, body.manifest_hash)))
    .limit(1);

  const existing = existingResult[0];

  if (existing) {
    // Return existing snapshot (idempotent)
    const snapshotResult = await db
      .select({
        id: snapshots.id,
        project_id: snapshots.projectId,
        manifest_hash: snapshots.manifestHash,
        parent_snapshot_id: snapshots.parentSnapshotId,
        source: snapshots.source,
        created_at: snapshots.createdAt,
      })
      .from(snapshots)
      .where(eq(snapshots.id, existing.id))
      .limit(1);

    return c.json({ snapshot: snapshotResult[0], created: false });
  }

  const snapshotId = generateULID();
  const now = new Date().toISOString();
  const source = body.source || 'cli';

  await db.insert(snapshots).values({
    id: snapshotId,
    projectId,
    manifestHash: body.manifest_hash,
    parentSnapshotId: body.parent_snapshot_id || null,
    source,
    createdAt: now,
  });

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
    manifest_hash: body.manifest_hash,
    parent_snapshot_id: body.parent_snapshot_id || null,
    source,
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
      manifest_hash: snapshots.manifestHash,
      parent_snapshot_id: snapshots.parentSnapshotId,
      source: snapshots.source,
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

// Helper: Generate ULID
function generateULID(): string {
  const timestamp = Date.now().toString(36).padStart(10, '0');
  const random = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 36).toString(36)
  ).join('');
  return (timestamp + random).toUpperCase();
}

// Helper: Mask secret value
function maskSecret(value: string): string {
  if (value.length <= 4) return '****';
  return '****' + value.slice(-4);
}
