import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import type { Env } from '../index';
import type { Workspace, DriftReport, ReportDriftRequest } from '@fastest/shared';
import { getAuthUser } from '../middleware/auth';
import { createDb, workspaces, projects, driftReports, activityEvents } from '../db';

export const workspaceRoutes = new Hono<{ Bindings: Env }>();

// Get workspace by ID
workspaceRoutes.get('/:workspaceId', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const workspaceId = c.req.param('workspaceId');
  const db = createDb(c.env.DB);

  // Fetch workspace with ownership check through project
  const workspaceResult = await db
    .select({
      id: workspaces.id,
      project_id: workspaces.projectId,
      name: workspaces.name,
      machine_id: workspaces.machineId,
      base_snapshot_id: workspaces.baseSnapshotId,
      local_path: workspaces.localPath,
      last_seen_at: workspaces.lastSeenAt,
      created_at: workspaces.createdAt,
      owner_user_id: projects.ownerUserId,
    })
    .from(workspaces)
    .innerJoin(projects, eq(workspaces.projectId, projects.id))
    .where(and(eq(workspaces.id, workspaceId), eq(projects.ownerUserId, user.id)))
    .limit(1);

  const row = workspaceResult[0];

  if (!row) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } }, 404);
  }

  const workspace: Workspace = {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    machine_id: row.machine_id,
    base_snapshot_id: row.base_snapshot_id,
    local_path: row.local_path,
    last_seen_at: row.last_seen_at,
    created_at: row.created_at,
  };

  // Fetch latest drift report
  const driftResult = await db
    .select({
      id: driftReports.id,
      workspace_id: driftReports.workspaceId,
      files_added: driftReports.filesAdded,
      files_modified: driftReports.filesModified,
      files_deleted: driftReports.filesDeleted,
      bytes_changed: driftReports.bytesChanged,
      summary: driftReports.summary,
      reported_at: driftReports.reportedAt,
    })
    .from(driftReports)
    .where(eq(driftReports.workspaceId, workspaceId))
    .orderBy(desc(driftReports.reportedAt))
    .limit(1);

  const drift = driftResult[0] || null;

  return c.json({
    workspace,
    drift
  });
});

// Update workspace heartbeat (last_seen_at)
workspaceRoutes.post('/:workspaceId/heartbeat', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const workspaceId = c.req.param('workspaceId');
  const db = createDb(c.env.DB);
  const now = new Date().toISOString();

  // First verify ownership
  const workspaceResult = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .innerJoin(projects, eq(workspaces.projectId, projects.id))
    .where(and(eq(workspaces.id, workspaceId), eq(projects.ownerUserId, user.id)))
    .limit(1);

  if (!workspaceResult[0]) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } }, 404);
  }

  // Update heartbeat
  await db
    .update(workspaces)
    .set({ lastSeenAt: now })
    .where(eq(workspaces.id, workspaceId));

  return c.json({ success: true, last_seen_at: now });
});

// Report drift for a workspace
workspaceRoutes.post('/:workspaceId/drift', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const workspaceId = c.req.param('workspaceId');
  const body = await c.req.json<ReportDriftRequest>();
  const db = createDb(c.env.DB);

  // Verify ownership through project
  const workspaceResult = await db
    .select({
      id: workspaces.id,
      project_id: workspaces.projectId,
    })
    .from(workspaces)
    .innerJoin(projects, eq(workspaces.projectId, projects.id))
    .where(and(eq(workspaces.id, workspaceId), eq(projects.ownerUserId, user.id)))
    .limit(1);

  const workspace = workspaceResult[0];

  if (!workspace) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } }, 404);
  }

  const driftId = generateULID();
  const now = new Date().toISOString();

  await db.insert(driftReports).values({
    id: driftId,
    workspaceId,
    filesAdded: body.files_added || 0,
    filesModified: body.files_modified || 0,
    filesDeleted: body.files_deleted || 0,
    bytesChanged: body.bytes_changed || 0,
    summary: body.summary || null,
    reportedAt: now,
  });

  // Update workspace heartbeat
  await db
    .update(workspaces)
    .set({ lastSeenAt: now })
    .where(eq(workspaces.id, workspaceId));

  // Insert activity event if there's meaningful drift
  if ((body.files_added || 0) + (body.files_modified || 0) + (body.files_deleted || 0) > 0) {
    const eventId = generateULID();
    const message = `Drift: +${body.files_added || 0} ~${body.files_modified || 0} -${body.files_deleted || 0}`;
    await db.insert(activityEvents).values({
      id: eventId,
      projectId: workspace.project_id,
      workspaceId,
      actor: 'cli',
      type: 'drift.reported',
      message,
      createdAt: now,
    });
  }

  const driftReport: DriftReport = {
    id: driftId,
    workspace_id: workspaceId,
    files_added: body.files_added || 0,
    files_modified: body.files_modified || 0,
    files_deleted: body.files_deleted || 0,
    bytes_changed: body.bytes_changed || 0,
    summary: body.summary || null,
    reported_at: now
  };

  return c.json({ drift_report: driftReport }, 201);
});

// Get drift history for a workspace
workspaceRoutes.get('/:workspaceId/drift', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const workspaceId = c.req.param('workspaceId');
  const limit = Math.min(parseInt(c.req.query('limit') || '10'), 100);
  const db = createDb(c.env.DB);

  // Verify ownership through project
  const workspaceResult = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .innerJoin(projects, eq(workspaces.projectId, projects.id))
    .where(and(eq(workspaces.id, workspaceId), eq(projects.ownerUserId, user.id)))
    .limit(1);

  if (!workspaceResult[0]) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } }, 404);
  }

  const result = await db
    .select({
      id: driftReports.id,
      workspace_id: driftReports.workspaceId,
      files_added: driftReports.filesAdded,
      files_modified: driftReports.filesModified,
      files_deleted: driftReports.filesDeleted,
      bytes_changed: driftReports.bytesChanged,
      summary: driftReports.summary,
      reported_at: driftReports.reportedAt,
    })
    .from(driftReports)
    .where(eq(driftReports.workspaceId, workspaceId))
    .orderBy(desc(driftReports.reportedAt))
    .limit(limit);

  return c.json({
    drift_reports: result,
    latest: result[0] || null
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
