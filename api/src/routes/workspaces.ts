import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import type { Env } from '../index';
import type { Workspace, DriftReport, ReportDriftRequest, Manifest } from '@fastest/shared';
import { compareDrift, fromJSON } from '@fastest/shared';
import { getAuthUser } from '../middleware/auth';
import { createDb, workspaces, projects, driftReports, activityEvents, snapshots } from '../db';

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

  // Return a backward-compatible DriftReport (legacy CLI reporting)
  const driftReport: DriftReport = {
    id: driftId,
    workspace_id: workspaceId,
    main_workspace_id: '', // Not available for legacy reports
    compared_at: now,
    workspace_snapshot_id: null,
    main_snapshot_id: null,
    main_only: [],
    workspace_only: [],
    both_same: [],
    both_different: [],
    total_drift_files: (body.files_added || 0) + (body.files_modified || 0),
    has_overlaps: (body.files_modified || 0) > 0,
    files_added: body.files_added || 0,
    files_modified: body.files_modified || 0,
    files_deleted: body.files_deleted || 0,
    bytes_changed: body.bytes_changed || 0,
    summary: body.summary || null,
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

// Compare workspace against main (for sync with main)
workspaceRoutes.get('/:workspaceId/drift/compare', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const workspaceId = c.req.param('workspaceId');
  const db = createDb(c.env.DB);

  // Fetch workspace with project info
  const workspaceResult = await db
    .select({
      id: workspaces.id,
      project_id: workspaces.projectId,
      name: workspaces.name,
      base_snapshot_id: workspaces.baseSnapshotId,
      main_workspace_id: projects.mainWorkspaceId,
      owner_user_id: projects.ownerUserId,
    })
    .from(workspaces)
    .innerJoin(projects, eq(workspaces.projectId, projects.id))
    .where(and(eq(workspaces.id, workspaceId), eq(projects.ownerUserId, user.id)))
    .limit(1);

  const workspace = workspaceResult[0];

  if (!workspace) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } }, 404);
  }

  // Check if this is the main workspace
  if (workspace.id === workspace.main_workspace_id) {
    return c.json({
      drift: null,
      is_main_workspace: true,
      message: 'This is the main workspace'
    });
  }

  // Check if main workspace is set
  if (!workspace.main_workspace_id) {
    return c.json({
      drift: null,
      is_main_workspace: false,
      message: 'No main workspace configured for this project'
    });
  }

  // Get main workspace's snapshot
  const mainWorkspaceResult = await db
    .select({
      id: workspaces.id,
      base_snapshot_id: workspaces.baseSnapshotId,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspace.main_workspace_id))
    .limit(1);

  const mainWorkspace = mainWorkspaceResult[0];

  if (!mainWorkspace) {
    return c.json({
      drift: null,
      is_main_workspace: false,
      message: 'Main workspace not found'
    });
  }

  // Get snapshot manifest hashes
  const workspaceSnapshotId = workspace.base_snapshot_id;
  const mainSnapshotId = mainWorkspace.base_snapshot_id;

  if (!workspaceSnapshotId || !mainSnapshotId) {
    return c.json({
      drift: null,
      is_main_workspace: false,
      message: 'One or both workspaces have no snapshot'
    });
  }

  // Get snapshot manifest hashes
  const snapshotResults = await db
    .select({
      id: snapshots.id,
      manifest_hash: snapshots.manifestHash,
    })
    .from(snapshots)
    .where(eq(snapshots.id, workspaceSnapshotId));

  const mainSnapshotResults = await db
    .select({
      id: snapshots.id,
      manifest_hash: snapshots.manifestHash,
    })
    .from(snapshots)
    .where(eq(snapshots.id, mainSnapshotId));

  const workspaceSnapshot = snapshotResults[0];
  const mainSnapshot = mainSnapshotResults[0];

  if (!workspaceSnapshot || !mainSnapshot) {
    return c.json({
      drift: null,
      is_main_workspace: false,
      message: 'Snapshot data not found'
    });
  }

  // Fetch manifests from R2
  const workspaceManifestKey = `${user.id}/manifests/${workspaceSnapshot.manifest_hash}.json`;
  const mainManifestKey = `${user.id}/manifests/${mainSnapshot.manifest_hash}.json`;

  const [workspaceManifestObj, mainManifestObj] = await Promise.all([
    c.env.BLOBS.get(workspaceManifestKey),
    c.env.BLOBS.get(mainManifestKey),
  ]);

  if (!workspaceManifestObj || !mainManifestObj) {
    return c.json({
      drift: null,
      is_main_workspace: false,
      message: 'Manifest data not found in storage'
    });
  }

  const workspaceManifestText = await workspaceManifestObj.text();
  const mainManifestText = await mainManifestObj.text();

  let workspaceManifest: Manifest;
  let mainManifest: Manifest;

  try {
    workspaceManifest = fromJSON(workspaceManifestText);
    mainManifest = fromJSON(mainManifestText);
  } catch {
    return c.json({
      drift: null,
      is_main_workspace: false,
      message: 'Failed to parse manifest data'
    });
  }

  // Compare the manifests
  const comparison = compareDrift(workspaceManifest, mainManifest);

  const driftReport: DriftReport = {
    id: generateULID(),
    workspace_id: workspaceId,
    main_workspace_id: workspace.main_workspace_id,
    compared_at: new Date().toISOString(),
    workspace_snapshot_id: workspaceSnapshotId,
    main_snapshot_id: mainSnapshotId,
    main_only: comparison.main_only,
    workspace_only: comparison.workspace_only,
    both_same: comparison.both_same,
    both_different: comparison.both_different,
    total_drift_files: comparison.main_only.length + comparison.both_different.length,
    has_overlaps: comparison.both_different.length > 0,
    // Legacy fields
    files_added: comparison.main_only.length,
    files_modified: comparison.both_different.length,
    files_deleted: 0, // Not applicable for sync comparison
    bytes_changed: 0,
    summary: null,
  };

  return c.json({
    drift: driftReport,
    is_main_workspace: false,
  });
});

// Set main workspace for a project
workspaceRoutes.post('/:workspaceId/set-as-main', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const workspaceId = c.req.param('workspaceId');
  const db = createDb(c.env.DB);

  // Fetch workspace with project info
  const workspaceResult = await db
    .select({
      id: workspaces.id,
      project_id: workspaces.projectId,
      owner_user_id: projects.ownerUserId,
    })
    .from(workspaces)
    .innerJoin(projects, eq(workspaces.projectId, projects.id))
    .where(and(eq(workspaces.id, workspaceId), eq(projects.ownerUserId, user.id)))
    .limit(1);

  const workspace = workspaceResult[0];

  if (!workspace) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } }, 404);
  }

  // Update project to set this workspace as main
  await db
    .update(projects)
    .set({ mainWorkspaceId: workspaceId })
    .where(eq(projects.id, workspace.project_id));

  return c.json({ success: true, main_workspace_id: workspaceId });
});

// Helper: Generate ULID
function generateULID(): string {
  const timestamp = Date.now().toString(36).padStart(10, '0');
  const random = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 36).toString(36)
  ).join('');
  return (timestamp + random).toUpperCase();
}
