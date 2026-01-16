import { Hono } from 'hono';
import type { Env } from '../index';
import type { Workspace, DriftReport, ReportDriftRequest } from '@fastest/shared';
import { getAuthUser } from '../middleware/auth';

export const workspaceRoutes = new Hono<{ Bindings: Env }>();

// Get workspace by ID
workspaceRoutes.get('/:workspaceId', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const workspaceId = c.req.param('workspaceId');
  const db = c.env.DB;

  // Fetch workspace with ownership check through project
  const workspace = await db.prepare(`
    SELECT w.id, w.project_id, w.name, w.machine_id, w.base_snapshot_id,
           w.local_path, w.last_seen_at, w.created_at
    FROM workspaces w
    JOIN projects p ON w.project_id = p.id
    WHERE w.id = ? AND p.owner_user_id = ?
  `).bind(workspaceId, user.id).first<Workspace>();

  if (!workspace) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } }, 404);
  }

  // Fetch latest drift report
  const drift = await db.prepare(`
    SELECT id, workspace_id, files_added, files_modified, files_deleted,
           bytes_changed, summary, reported_at
    FROM drift_reports
    WHERE workspace_id = ?
    ORDER BY reported_at DESC
    LIMIT 1
  `).bind(workspaceId).first<DriftReport>();

  return c.json({
    workspace,
    drift: drift || null
  });
});

// Update workspace heartbeat (last_seen_at)
workspaceRoutes.post('/:workspaceId/heartbeat', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const workspaceId = c.req.param('workspaceId');
  const db = c.env.DB;
  const now = new Date().toISOString();

  // Update with ownership check
  const result = await db.prepare(`
    UPDATE workspaces
    SET last_seen_at = ?
    WHERE id = ? AND project_id IN (
      SELECT id FROM projects WHERE owner_user_id = ?
    )
  `).bind(now, workspaceId, user.id).run();

  if (result.meta.changes === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } }, 404);
  }

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
  const db = c.env.DB;

  // Verify ownership through project
  const workspace = await db.prepare(`
    SELECT w.id, w.project_id
    FROM workspaces w
    JOIN projects p ON w.project_id = p.id
    WHERE w.id = ? AND p.owner_user_id = ?
  `).bind(workspaceId, user.id).first<{ id: string; project_id: string }>();

  if (!workspace) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } }, 404);
  }

  const driftId = generateULID();
  const now = new Date().toISOString();

  await db.prepare(`
    INSERT INTO drift_reports (id, workspace_id, files_added, files_modified, files_deleted, bytes_changed, summary, reported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    driftId,
    workspaceId,
    body.files_added || 0,
    body.files_modified || 0,
    body.files_deleted || 0,
    body.bytes_changed || 0,
    body.summary || null,
    now
  ).run();

  // Update workspace heartbeat
  await db.prepare(`
    UPDATE workspaces SET last_seen_at = ? WHERE id = ?
  `).bind(now, workspaceId).run();

  // Insert activity event if there's meaningful drift
  if ((body.files_added || 0) + (body.files_modified || 0) + (body.files_deleted || 0) > 0) {
    const eventId = generateULID();
    const message = `Drift: +${body.files_added || 0} ~${body.files_modified || 0} -${body.files_deleted || 0}`;
    await db.prepare(`
      INSERT INTO activity_events (id, project_id, workspace_id, actor, type, message, created_at)
      VALUES (?, ?, ?, 'cli', 'drift.reported', ?, ?)
    `).bind(eventId, workspace.project_id, workspaceId, message, now).run();
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
  const db = c.env.DB;

  // Verify ownership through project
  const workspace = await db.prepare(`
    SELECT w.id
    FROM workspaces w
    JOIN projects p ON w.project_id = p.id
    WHERE w.id = ? AND p.owner_user_id = ?
  `).bind(workspaceId, user.id).first();

  if (!workspace) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } }, 404);
  }

  const result = await db.prepare(`
    SELECT id, workspace_id, files_added, files_modified, files_deleted,
           bytes_changed, summary, reported_at
    FROM drift_reports
    WHERE workspace_id = ?
    ORDER BY reported_at DESC
    LIMIT ?
  `).bind(workspaceId, limit).all<DriftReport>();

  return c.json({
    drift_reports: result.results || [],
    latest: result.results?.[0] || null
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
