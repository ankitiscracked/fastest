import { Hono } from 'hono';
import type { Env } from '../index';
import type { Project, Workspace, Snapshot, CreateProjectRequest, CreateWorkspaceRequest } from '@fastest/shared';
import { getAuthUser } from '../middleware/auth';

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

  const db = c.env.DB;
  const projectId = generateULID();
  const now = new Date().toISOString();

  // Insert project
  await db.prepare(`
    INSERT INTO projects (id, owner_user_id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(projectId, user.id, body.name.trim(), now, now).run();

  // Insert activity event
  const eventId = generateULID();
  await db.prepare(`
    INSERT INTO activity_events (id, project_id, actor, type, message, created_at)
    VALUES (?, ?, 'web', 'project.created', ?, ?)
  `).bind(eventId, projectId, `Project "${body.name.trim()}" created`, now).run();

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

  const db = c.env.DB;

  const result = await db.prepare(`
    SELECT id, owner_user_id, name, created_at, updated_at, last_snapshot_id
    FROM projects
    WHERE owner_user_id = ?
    ORDER BY updated_at DESC
  `).bind(user.id).all<Project>();

  return c.json({ projects: result.results || [] });
});

// Get project by ID
projectRoutes.get('/:projectId', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const db = c.env.DB;

  // Fetch project
  const project = await db.prepare(`
    SELECT id, owner_user_id, name, created_at, updated_at, last_snapshot_id
    FROM projects
    WHERE id = ? AND owner_user_id = ?
  `).bind(projectId, user.id).first<Project>();

  if (!project) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  // Fetch workspaces
  const workspacesResult = await db.prepare(`
    SELECT id, project_id, name, machine_id, base_snapshot_id, local_path, last_seen_at, created_at
    FROM workspaces
    WHERE project_id = ?
    ORDER BY created_at DESC
  `).bind(projectId).all<Workspace>();

  // Fetch recent snapshots
  const snapshotsResult = await db.prepare(`
    SELECT id, project_id, manifest_hash, parent_snapshot_id, source, created_at
    FROM snapshots
    WHERE project_id = ?
    ORDER BY created_at DESC
    LIMIT 10
  `).bind(projectId).all<Snapshot>();

  // Fetch recent events
  const eventsResult = await db.prepare(`
    SELECT id, project_id, workspace_id, actor, type, snapshot_id, message, created_at
    FROM activity_events
    WHERE project_id = ?
    ORDER BY created_at DESC
    LIMIT 20
  `).bind(projectId).all();

  return c.json({
    project,
    workspaces: workspacesResult.results || [],
    snapshots: snapshotsResult.results || [],
    events: eventsResult.results || []
  });
});

// Get project status
projectRoutes.get('/:projectId/status', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const db = c.env.DB;

  const project = await db.prepare(`
    SELECT last_snapshot_id, updated_at
    FROM projects
    WHERE id = ? AND owner_user_id = ?
  `).bind(projectId, user.id).first<{ last_snapshot_id: string | null; updated_at: string }>();

  if (!project) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  // Get last activity
  const lastEvent = await db.prepare(`
    SELECT type, created_at
    FROM activity_events
    WHERE project_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(projectId).first<{ type: string; created_at: string }>();

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
  const db = c.env.DB;

  // Verify ownership
  const project = await db.prepare(`
    SELECT id FROM projects WHERE id = ? AND owner_user_id = ?
  `).bind(projectId, user.id).first();

  if (!project) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  const result = await db.prepare(`
    SELECT id, project_id, workspace_id, actor, type, snapshot_id, message, created_at
    FROM activity_events
    WHERE project_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(projectId, limit).all();

  return c.json({ events: result.results || [] });
});

// Create workspace for project
projectRoutes.post('/:projectId/workspaces', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const body = await c.req.json<CreateWorkspaceRequest>();
  const db = c.env.DB;

  // Verify ownership
  const project = await db.prepare(`
    SELECT id FROM projects WHERE id = ? AND owner_user_id = ?
  `).bind(projectId, user.id).first();

  if (!project) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  if (!body.name || body.name.trim() === '') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Workspace name is required' } }, 422);
  }

  const workspaceId = generateULID();
  const now = new Date().toISOString();

  await db.prepare(`
    INSERT INTO workspaces (id, project_id, name, machine_id, base_snapshot_id, local_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    workspaceId,
    projectId,
    body.name.trim(),
    body.machine_id || null,
    body.base_snapshot_id || null,
    body.local_path || null,
    now
  ).run();

  // Insert activity event
  const eventId = generateULID();
  await db.prepare(`
    INSERT INTO activity_events (id, project_id, workspace_id, actor, type, message, created_at)
    VALUES (?, ?, ?, 'cli', 'workspace.created', ?, ?)
  `).bind(eventId, projectId, workspaceId, `Workspace "${body.name.trim()}" created`, now).run();

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
  const db = c.env.DB;

  // Verify ownership
  const project = await db.prepare(`
    SELECT id FROM projects WHERE id = ? AND owner_user_id = ?
  `).bind(projectId, user.id).first();

  if (!project) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  // Get workspaces with their latest drift report
  const workspaces = await db.prepare(`
    SELECT
      w.id, w.project_id, w.name, w.machine_id, w.base_snapshot_id,
      w.local_path, w.last_seen_at, w.created_at,
      d.files_added, d.files_modified, d.files_deleted, d.bytes_changed, d.summary, d.reported_at
    FROM workspaces w
    LEFT JOIN (
      SELECT workspace_id, files_added, files_modified, files_deleted, bytes_changed, summary, reported_at,
             ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY reported_at DESC) as rn
      FROM drift_reports
    ) d ON w.id = d.workspace_id AND d.rn = 1
    WHERE w.project_id = ?
    ORDER BY w.created_at DESC
  `).bind(projectId).all();

  // Transform results to include drift as nested object
  const result = (workspaces.results || []).map((row: any) => ({
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    machine_id: row.machine_id,
    base_snapshot_id: row.base_snapshot_id,
    local_path: row.local_path,
    last_seen_at: row.last_seen_at,
    created_at: row.created_at,
    drift: row.reported_at ? {
      files_added: row.files_added,
      files_modified: row.files_modified,
      files_deleted: row.files_deleted,
      bytes_changed: row.bytes_changed,
      summary: row.summary,
      reported_at: row.reported_at
    } : null
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
  const db = c.env.DB;

  // Verify ownership
  const project = await db.prepare(`
    SELECT id FROM projects WHERE id = ? AND owner_user_id = ?
  `).bind(projectId, user.id).first();

  if (!project) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  if (!body.manifest_hash) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'manifest_hash is required' } }, 422);
  }

  // Check if snapshot with same manifest already exists
  const existing = await db.prepare(`
    SELECT id FROM snapshots WHERE project_id = ? AND manifest_hash = ?
  `).bind(projectId, body.manifest_hash).first<{ id: string }>();

  if (existing) {
    // Return existing snapshot (idempotent)
    const snapshot = await db.prepare(`
      SELECT id, project_id, manifest_hash, parent_snapshot_id, source, created_at
      FROM snapshots WHERE id = ?
    `).bind(existing.id).first<Snapshot>();
    return c.json({ snapshot, created: false });
  }

  const snapshotId = generateULID();
  const now = new Date().toISOString();
  const source = body.source || 'cli';

  await db.prepare(`
    INSERT INTO snapshots (id, project_id, manifest_hash, parent_snapshot_id, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(snapshotId, projectId, body.manifest_hash, body.parent_snapshot_id || null, source, now).run();

  // Update project's last_snapshot_id and updated_at
  await db.prepare(`
    UPDATE projects SET last_snapshot_id = ?, updated_at = ? WHERE id = ?
  `).bind(snapshotId, now, projectId).run();

  // Insert activity event
  const eventId = generateULID();
  await db.prepare(`
    INSERT INTO activity_events (id, project_id, actor, type, snapshot_id, message, created_at)
    VALUES (?, ?, ?, 'snapshot.pushed', ?, ?, ?)
  `).bind(eventId, projectId, source, snapshotId, `Snapshot ${snapshotId.slice(0, 8)}... pushed`, now).run();

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
  const db = c.env.DB;

  // Verify ownership
  const project = await db.prepare(`
    SELECT id FROM projects WHERE id = ? AND owner_user_id = ?
  `).bind(projectId, user.id).first();

  if (!project) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  const result = await db.prepare(`
    SELECT id, project_id, manifest_hash, parent_snapshot_id, source, created_at
    FROM snapshots
    WHERE project_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(projectId, limit).all<Snapshot>();

  return c.json({ snapshots: result.results || [] });
});

// Helper: Generate ULID
function generateULID(): string {
  const timestamp = Date.now().toString(36).padStart(10, '0');
  const random = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 36).toString(36)
  ).join('');
  return (timestamp + random).toUpperCase();
}
