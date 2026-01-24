import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import type { Env } from '../index';
import type {
  Workspace,
  DriftReport,
  ReportDriftRequest,
  Manifest,
  DriftAnalysis,
  SyncPreview,
  AutoAction,
  ConflictDecision,
  DecisionOption,
  MergeRecord,
} from '@fastest/shared';
import { compareDrift, fromJSON, getFile, empty as emptyManifest } from '@fastest/shared';
import { getAuthUser } from '../middleware/auth';
import { createDb, workspaces, projects, driftReports, activityEvents, snapshots } from '../db';
import {
  createRollbackContext,
  executeRollback,
  uploadBlobWithRollback,
  validateManifestIntegrity,
  createOptimisticLockError,
  pMap,
} from '../sync_utils';

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
      merge_history: workspaces.mergeHistory,
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
    merge_history: row.merge_history ? JSON.parse(row.merge_history) : null,
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

// Compare workspace against another workspace (default: main workspace)
// Query params:
//   - source_workspace_id: optional, compare with this workspace instead of main
workspaceRoutes.get('/:workspaceId/drift/compare', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const workspaceId = c.req.param('workspaceId');
  const sourceWorkspaceId = c.req.query('source_workspace_id');
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

  // Determine which workspace to compare against
  const compareWithId = sourceWorkspaceId || workspace.main_workspace_id;

  // Check if comparing with self
  if (workspace.id === compareWithId) {
    return c.json({
      drift: null,
      is_main_workspace: !sourceWorkspaceId && workspace.id === workspace.main_workspace_id,
      message: sourceWorkspaceId ? 'Cannot compare workspace with itself' : 'This is the main workspace'
    });
  }

  // Check if we have a workspace to compare against
  if (!compareWithId) {
    return c.json({
      drift: null,
      is_main_workspace: false,
      message: 'No main workspace configured for this project'
    });
  }

  // Get source workspace's snapshot (verify it belongs to same project)
  const sourceWorkspaceResult = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      base_snapshot_id: workspaces.baseSnapshotId,
      project_id: workspaces.projectId,
    })
    .from(workspaces)
    .where(eq(workspaces.id, compareWithId))
    .limit(1);

  const sourceWorkspace = sourceWorkspaceResult[0];

  if (!sourceWorkspace) {
    return c.json({
      drift: null,
      is_main_workspace: false,
      message: sourceWorkspaceId ? 'Source workspace not found' : 'Main workspace not found'
    });
  }

  // Verify source workspace belongs to the same project
  if (sourceWorkspace.project_id !== workspace.project_id) {
    return c.json({ error: { code: 'INVALID_OPERATION', message: 'Cannot compare workspaces from different projects' } }, 400);
  }

  // Get snapshot manifest hashes
  const workspaceSnapshotId = workspace.base_snapshot_id;
  const sourceSnapshotId = sourceWorkspace.base_snapshot_id;

  if (!workspaceSnapshotId || !sourceSnapshotId) {
    return c.json({
      drift: null,
      is_main_workspace: false,
      message: 'One or both workspaces have no snapshot'
    });
  }

  // Get snapshot manifest hashes
  const [snapshotResults, sourceSnapshotResults] = await Promise.all([
    db.select({
      id: snapshots.id,
      manifest_hash: snapshots.manifestHash,
    })
      .from(snapshots)
      .where(eq(snapshots.id, workspaceSnapshotId)),
    db.select({
      id: snapshots.id,
      manifest_hash: snapshots.manifestHash,
    })
      .from(snapshots)
      .where(eq(snapshots.id, sourceSnapshotId)),
  ]);

  const workspaceSnapshot = snapshotResults[0];
  const sourceSnapshot = sourceSnapshotResults[0];

  if (!workspaceSnapshot || !sourceSnapshot) {
    return c.json({
      drift: null,
      is_main_workspace: false,
      message: 'Snapshot data not found'
    });
  }

  // Fetch manifests from R2
  const workspaceManifestKey = `${user.id}/manifests/${workspaceSnapshot.manifest_hash}.json`;
  const sourceManifestKey = `${user.id}/manifests/${sourceSnapshot.manifest_hash}.json`;

  const [workspaceManifestObj, sourceManifestObj] = await Promise.all([
    c.env.BLOBS.get(workspaceManifestKey),
    c.env.BLOBS.get(sourceManifestKey),
  ]);

  if (!workspaceManifestObj || !sourceManifestObj) {
    return c.json({
      drift: null,
      is_main_workspace: false,
      message: 'Manifest data not found in storage'
    });
  }

  const workspaceManifestText = await workspaceManifestObj.text();
  const sourceManifestText = await sourceManifestObj.text();

  let workspaceManifest: Manifest;
  let sourceManifest: Manifest;

  try {
    workspaceManifest = fromJSON(workspaceManifestText);
    sourceManifest = fromJSON(sourceManifestText);
  } catch {
    return c.json({
      drift: null,
      is_main_workspace: false,
      message: 'Failed to parse manifest data'
    });
  }

  // Compare the manifests (source is treated as "main" in the comparison)
  const comparison = compareDrift(workspaceManifest, sourceManifest);

  const driftId = generateULID();
  const now = new Date().toISOString();

  const driftReport: DriftReport = {
    id: driftId,
    workspace_id: workspaceId,
    main_workspace_id: sourceWorkspace.id, // The workspace we compared against
    compared_at: now,
    workspace_snapshot_id: workspaceSnapshotId,
    main_snapshot_id: sourceSnapshotId,
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

  // Save drift report to database for cross-workspace queries
  await db.insert(driftReports).values({
    id: driftId,
    workspaceId: workspaceId,
    filesAdded: comparison.main_only.length,
    filesModified: comparison.both_different.length,
    filesDeleted: 0,
    bytesChanged: 0,
    summary: null,
    reportedAt: now,
  }).onConflictDoUpdate({
    target: driftReports.id,
    set: {
      filesAdded: comparison.main_only.length,
      filesModified: comparison.both_different.length,
      reportedAt: now,
    },
  });

  return c.json({
    drift: driftReport,
    is_main_workspace: false,
    source_workspace: {
      id: sourceWorkspace.id,
      name: sourceWorkspace.name,
    },
  });
});

// Analyze drift with AI
workspaceRoutes.post('/:workspaceId/drift/analyze', async (c) => {
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
      analysis: null,
      error: 'This is the main workspace - nothing to analyze'
    });
  }

  // Check if main workspace is set
  if (!workspace.main_workspace_id) {
    return c.json({
      analysis: null,
      error: 'No main workspace configured for this project'
    });
  }

  // Get main workspace's snapshot
  const mainWorkspaceResult = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      base_snapshot_id: workspaces.baseSnapshotId,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspace.main_workspace_id))
    .limit(1);

  const mainWorkspace = mainWorkspaceResult[0];

  if (!mainWorkspace) {
    return c.json({
      analysis: null,
      error: 'Main workspace not found'
    });
  }

  // Get snapshot manifest hashes
  const workspaceSnapshotId = workspace.base_snapshot_id;
  const mainSnapshotId = mainWorkspace.base_snapshot_id;

  if (!workspaceSnapshotId || !mainSnapshotId) {
    return c.json({
      analysis: null,
      error: 'One or both workspaces have no snapshot'
    });
  }

  // Get snapshot manifest hashes
  const [snapshotResults, mainSnapshotResults] = await Promise.all([
    db.select({ manifest_hash: snapshots.manifestHash }).from(snapshots).where(eq(snapshots.id, workspaceSnapshotId)),
    db.select({ manifest_hash: snapshots.manifestHash }).from(snapshots).where(eq(snapshots.id, mainSnapshotId)),
  ]);

  const workspaceSnapshot = snapshotResults[0];
  const mainSnapshot = mainSnapshotResults[0];

  if (!workspaceSnapshot || !mainSnapshot) {
    return c.json({
      analysis: null,
      error: 'Snapshot data not found'
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
      analysis: null,
      error: 'Manifest data not found in storage'
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
      analysis: null,
      error: 'Failed to parse manifest data'
    });
  }

  // Compare the manifests
  const comparison = compareDrift(workspaceManifest, mainManifest);

  // If no drift, return a simple analysis
  if (comparison.main_only.length === 0 && comparison.both_different.length === 0) {
    const analysis: DriftAnalysis = {
      main_changes_summary: 'No new changes in main',
      workspace_changes_summary: comparison.workspace_only.length > 0
        ? `${comparison.workspace_only.length} files unique to your workspace`
        : 'No unique changes in your workspace',
      risk_level: 'low',
      risk_explanation: 'Your workspace is in sync with main',
      can_auto_sync: true,
      recommendation: 'No sync needed - your workspace is up to date with main',
      analyzed_at: new Date().toISOString(),
    };

    return c.json({ analysis });
  }

  // Build AI prompt
  const prompt = buildDriftAnalysisPrompt(
    workspace.name,
    mainWorkspace.name,
    comparison.main_only,
    comparison.workspace_only,
    comparison.both_different
  );

  try {
    // Call Workers AI
    const response = await (c.env.AI as Ai).run(
      '@cf/meta/llama-3.1-8b-instruct-fast' as Parameters<Ai['run']>[0],
      {
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
      }
    ) as { response?: string };

    const aiResponse = response.response?.trim() || '';

    // Parse AI response
    const analysis = parseAIAnalysisResponse(aiResponse, comparison);

    return c.json({ analysis });

  } catch (error) {
    console.error('Failed to generate drift analysis:', error);

    // Return a fallback analysis
    const analysis: DriftAnalysis = {
      main_changes_summary: `${comparison.main_only.length} new files in main`,
      workspace_changes_summary: `${comparison.workspace_only.length} files unique to workspace`,
      risk_level: comparison.both_different.length > 5 ? 'high' : comparison.both_different.length > 0 ? 'medium' : 'low',
      risk_explanation: comparison.both_different.length > 0
        ? `${comparison.both_different.length} files have been modified in both workspaces`
        : 'No overlapping changes detected',
      can_auto_sync: comparison.both_different.length === 0,
      recommendation: comparison.both_different.length === 0
        ? 'Safe to sync - no conflicting changes'
        : 'Review the modified files before syncing',
      analyzed_at: new Date().toISOString(),
    };

    return c.json({ analysis });
  }
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

// Prepare sync preview
workspaceRoutes.post('/:workspaceId/sync/prepare', async (c) => {
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
    return c.json({ error: { code: 'INVALID_OPERATION', message: 'Cannot sync main workspace with itself' } }, 400);
  }

  // Check if main workspace is set
  if (!workspace.main_workspace_id) {
    return c.json({ error: { code: 'NO_MAIN_WORKSPACE', message: 'No main workspace configured for this project' } }, 400);
  }

  // Get main workspace's snapshot
  const mainWorkspaceResult = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      base_snapshot_id: workspaces.baseSnapshotId,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspace.main_workspace_id))
    .limit(1);

  const mainWorkspace = mainWorkspaceResult[0];

  if (!mainWorkspace) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Main workspace not found' } }, 404);
  }

  // Get snapshot manifest hashes
  const workspaceSnapshotId = workspace.base_snapshot_id;
  const mainSnapshotId = mainWorkspace.base_snapshot_id;

  if (!workspaceSnapshotId || !mainSnapshotId) {
    return c.json({ error: { code: 'NO_SNAPSHOT', message: 'One or both workspaces have no snapshot' } }, 400);
  }

  // Get snapshot manifest hashes
  const [snapshotResults, mainSnapshotResults] = await Promise.all([
    db.select({ manifest_hash: snapshots.manifestHash }).from(snapshots).where(eq(snapshots.id, workspaceSnapshotId)),
    db.select({ manifest_hash: snapshots.manifestHash }).from(snapshots).where(eq(snapshots.id, mainSnapshotId)),
  ]);

  const workspaceSnapshot = snapshotResults[0];
  const mainSnapshot = mainSnapshotResults[0];

  if (!workspaceSnapshot || !mainSnapshot) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Snapshot data not found' } }, 404);
  }

  // Fetch manifests from R2
  const workspaceManifestKey = `${user.id}/manifests/${workspaceSnapshot.manifest_hash}.json`;
  const mainManifestKey = `${user.id}/manifests/${mainSnapshot.manifest_hash}.json`;

  const [workspaceManifestObj, mainManifestObj] = await Promise.all([
    c.env.BLOBS.get(workspaceManifestKey),
    c.env.BLOBS.get(mainManifestKey),
  ]);

  if (!workspaceManifestObj || !mainManifestObj) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Manifest data not found in storage' } }, 404);
  }

  const workspaceManifestText = await workspaceManifestObj.text();
  const mainManifestText = await mainManifestObj.text();

  let workspaceManifest: Manifest;
  let mainManifest: Manifest;

  try {
    workspaceManifest = fromJSON(workspaceManifestText);
    mainManifest = fromJSON(mainManifestText);
  } catch {
    return c.json({ error: { code: 'PARSE_ERROR', message: 'Failed to parse manifest data' } }, 500);
  }

  // Determine merge base for three-way merge
  const mergeBaseId = await getMergeBase(db, workspaceId, workspace.main_workspace_id);

  let baseManifest: Manifest;
  if (mergeBaseId) {
    const loadedBase = await loadManifestBySnapshotId(db, c.env.BLOBS, user.id, mergeBaseId);
    if (loadedBase) {
      baseManifest = loadedBase;
    } else {
      // Could not load base, fall back to empty manifest (two-way merge)
      baseManifest = emptyManifest();
    }
  } else {
    // No merge base found, fall back to empty manifest (two-way merge)
    baseManifest = emptyManifest();
  }

  // Compute three-way merge actions
  const mergeActions = computeThreeWayMerge(baseManifest, workspaceManifest, mainManifest);

  // If nothing to sync, return empty preview
  if (mergeActions.toApply.length === 0 && mergeActions.conflicts.length === 0) {
    const preview: SyncPreview = {
      id: generateULID(),
      workspace_id: workspaceId,
      drift_report_id: '',
      auto_actions: [],
      decisions_needed: [],
      files_to_update: 0,
      files_to_add: 0,
      files_unchanged: mergeActions.inSync.length,
      summary: 'Your workspace is already in sync with main.',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 minutes
    };

    return c.json({ preview });
  }

  // Build auto actions for files that only source changed (can apply directly)
  const autoActions: AutoAction[] = [];

  for (const action of mergeActions.toApply) {
    // Files where only source changed - can be applied without conflict
    autoActions.push({
      path: action.path,
      action: 'copy_from_main',
      description: `Add/update ${action.path} from main`,
    });
  }

  // Process conflict files with AI
  const decisionsNeeded: ConflictDecision[] = [];

  // For each conflicting file, analyze with AI
  for (const mergeAction of mergeActions.conflicts) {
    const path = mergeAction.path;
    const workspaceFile = getFile(workspaceManifest, path);
    const mainFile = getFile(mainManifest, path);

    if (!workspaceFile || !mainFile) {
      // Shouldn't happen, but handle gracefully
      autoActions.push({
        path,
        action: 'copy_from_main',
        description: `Update ${path} from main`,
      });
      continue;
    }

    // Fetch actual file contents from R2
    const workspaceBlobKey = `${user.id}/blobs/${workspaceFile.hash}`;
    const mainBlobKey = `${user.id}/blobs/${mainFile.hash}`;

    const [workspaceBlobObj, mainBlobObj] = await Promise.all([
      c.env.BLOBS.get(workspaceBlobKey),
      c.env.BLOBS.get(mainBlobKey),
    ]);

    if (!workspaceBlobObj || !mainBlobObj) {
      // Can't fetch contents, default to copy from main
      autoActions.push({
        path,
        action: 'copy_from_main',
        description: `Update ${path} from main (could not compare contents)`,
      });
      continue;
    }

    const workspaceContent = await workspaceBlobObj.text();
    const mainContent = await mainBlobObj.text();

    // Use AI to analyze the file differences
    try {
      const analysis = await analyzeFileDifference(
        c.env.AI as Ai,
        path,
        workspaceContent,
        mainContent
      );

      if (analysis.compatible && analysis.combined_content) {
        // AI successfully combined the files
        autoActions.push({
          path,
          action: 'ai_combined',
          description: analysis.description || `Combined changes in ${path}`,
          combined_content: analysis.combined_content,
        });
      } else {
        // Files have incompatible changes, need user decision
        decisionsNeeded.push({
          path,
          main_intent: analysis.main_intent || 'Changes from main',
          workspace_intent: analysis.workspace_intent || 'Your changes',
          conflict_reason: analysis.conflict_reason || 'Files have conflicting changes',
          options: analysis.options || [
            {
              id: 'use_main',
              label: 'Use main version',
              description: 'Replace your changes with main',
              resulting_content: mainContent,
            },
            {
              id: 'use_workspace',
              label: 'Keep your version',
              description: 'Keep your changes, ignore main',
              resulting_content: workspaceContent,
            },
          ],
          recommended_option_id: analysis.recommended_option || 'use_main',
        });
      }
    } catch (error) {
      console.error(`Failed to analyze ${path}:`, error);
      // Fallback: create a decision for the user
      decisionsNeeded.push({
        path,
        main_intent: 'Changes from main',
        workspace_intent: 'Your changes',
        conflict_reason: 'Could not automatically analyze - files differ',
        options: [
          {
            id: 'use_main',
            label: 'Use main version',
            description: 'Replace your changes with main',
            resulting_content: mainContent,
          },
          {
            id: 'use_workspace',
            label: 'Keep your version',
            description: 'Keep your changes, ignore main',
            resulting_content: workspaceContent,
          },
        ],
        recommended_option_id: 'use_main',
      });
    }
  }

  // Build summary
  const summaryParts: string[] = [];
  const copyCount = autoActions.filter(a => a.action === 'copy_from_main').length;
  const combineCount = autoActions.filter(a => a.action === 'ai_combined').length;

  if (copyCount > 0) {
    summaryParts.push(`${copyCount} file${copyCount !== 1 ? 's' : ''} to add from main`);
  }
  if (combineCount > 0) {
    summaryParts.push(`${combineCount} file${combineCount !== 1 ? 's' : ''} combined automatically`);
  }
  if (decisionsNeeded.length > 0) {
    summaryParts.push(`${decisionsNeeded.length} decision${decisionsNeeded.length !== 1 ? 's' : ''} needed`);
  }

  const summary = summaryParts.length > 0
    ? summaryParts.join('. ') + '.'
    : 'Ready to sync.';

  const previewId = generateULID();
  const preview: SyncPreview = {
    id: previewId,
    workspace_id: workspaceId,
    drift_report_id: '',
    auto_actions: autoActions,
    decisions_needed: decisionsNeeded,
    files_to_update: combineCount + decisionsNeeded.length,
    files_to_add: copyCount,
    files_unchanged: mergeActions.inSync.length,
    summary,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 minutes
  };

  // Store preview in KV for later execution
  await c.env.KV.put(
    `sync_preview:${previewId}`,
    JSON.stringify({
      preview,
      user_id: user.id,
      workspace_manifest_hash: workspaceSnapshot.manifest_hash,
      main_manifest_hash: mainSnapshot.manifest_hash,
      main_workspace_id: workspace.main_workspace_id,
      main_snapshot_id: mainSnapshotId,
      merge_base_id: mergeBaseId, // Track merge base for history
    }),
    { expirationTtl: 30 * 60 } // 30 minutes
  );

  return c.json({ preview });
});

// Execute sync
workspaceRoutes.post('/:workspaceId/sync/execute', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const workspaceId = c.req.param('workspaceId');
  const body = await c.req.json<{
    preview_id: string;
    decisions?: Record<string, string>;
    create_snapshot_before?: boolean;
    create_snapshot_after?: boolean;
  }>();

  const { preview_id, decisions = {}, create_snapshot_before = true, create_snapshot_after = true } = body;

  if (!preview_id) {
    return c.json({ error: { code: 'MISSING_PREVIEW_ID', message: 'preview_id is required' } }, 400);
  }

  // Retrieve preview from KV
  const previewData = await c.env.KV.get(`sync_preview:${preview_id}`);
  if (!previewData) {
    return c.json({ error: { code: 'PREVIEW_EXPIRED', message: 'Sync preview has expired. Please prepare sync again.' } }, 404);
  }

  const { preview, user_id, main_manifest_hash, main_workspace_id, main_snapshot_id, merge_base_id } = JSON.parse(previewData) as {
    preview: SyncPreview;
    user_id: string;
    workspace_manifest_hash: string;
    main_manifest_hash: string;
    main_workspace_id: string;
    main_snapshot_id: string;
    merge_base_id: string | null;
  };

  // Verify ownership
  if (user_id !== user.id) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'You do not own this sync preview' } }, 403);
  }

  // Verify workspace matches
  if (preview.workspace_id !== workspaceId) {
    return c.json({ error: { code: 'WORKSPACE_MISMATCH', message: 'Workspace ID does not match preview' } }, 400);
  }

  // Check if all required decisions are provided
  const missingDecisions = preview.decisions_needed
    .filter(d => !decisions[d.path])
    .map(d => d.path);

  if (missingDecisions.length > 0) {
    return c.json({
      error: {
        code: 'MISSING_DECISIONS',
        message: `Missing decisions for: ${missingDecisions.join(', ')}`,
        details: { missing: missingDecisions }
      }
    }, 400);
  }

  const db = createDb(c.env.DB);

  // Get workspace info including version for optimistic locking
  const workspaceResult = await db
    .select({
      id: workspaces.id,
      project_id: workspaces.projectId,
      base_snapshot_id: workspaces.baseSnapshotId,
      version: workspaces.version,
    })
    .from(workspaces)
    .innerJoin(projects, eq(workspaces.projectId, projects.id))
    .where(and(eq(workspaces.id, workspaceId), eq(projects.ownerUserId, user.id)))
    .limit(1);

  const workspace = workspaceResult[0];
  if (!workspace) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } }, 404);
  }

  // Store initial version for optimistic locking
  const initialVersion = workspace.version ?? 1;

  // Get current workspace manifest
  const currentSnapshotId = workspace.base_snapshot_id;
  if (!currentSnapshotId) {
    return c.json({ error: { code: 'NO_SNAPSHOT', message: 'Workspace has no snapshot' } }, 400);
  }

  const snapshotResult = await db
    .select({ manifest_hash: snapshots.manifestHash })
    .from(snapshots)
    .where(eq(snapshots.id, currentSnapshotId))
    .limit(1);

  const currentSnapshot = snapshotResult[0];
  if (!currentSnapshot) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Current snapshot not found' } }, 404);
  }

  // Load current manifest
  const manifestKey = `${user.id}/manifests/${currentSnapshot.manifest_hash}.json`;
  const manifestObj = await c.env.BLOBS.get(manifestKey);
  if (!manifestObj) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Manifest not found' } }, 404);
  }

  let workspaceManifest: Manifest;
  try {
    workspaceManifest = fromJSON(await manifestObj.text());
  } catch {
    return c.json({ error: { code: 'PARSE_ERROR', message: 'Failed to parse manifest' } }, 500);
  }

  // Load main manifest for copying files
  const mainManifestKey = `${user.id}/manifests/${main_manifest_hash}.json`;
  const mainManifestObj = await c.env.BLOBS.get(mainManifestKey);
  if (!mainManifestObj) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Main manifest not found' } }, 404);
  }

  let mainManifest: Manifest;
  try {
    mainManifest = fromJSON(await mainManifestObj.text());
  } catch {
    return c.json({ error: { code: 'PARSE_ERROR', message: 'Failed to parse main manifest' } }, 500);
  }

  // Create snapshot before (if requested)
  let snapshotBeforeId: string | undefined;
  if (create_snapshot_before) {
    snapshotBeforeId = generateULID();
    await db.insert(snapshots).values({
      id: snapshotBeforeId,
      projectId: workspace.project_id,
      workspaceId: workspaceId,
      manifestHash: currentSnapshot.manifest_hash,
      parentSnapshotId: currentSnapshotId,
      source: 'system',
      createdAt: new Date().toISOString(),
    });
  }

  // Create rollback context to track uploaded resources
  const rollbackContext = createRollbackContext();
  const errors: string[] = [];
  let filesUpdated = 0;
  let filesAdded = 0;

  // Build new manifest by cloning current (convert array to Map for easier manipulation)
  const newFiles = new Map<string, { hash: string; size: number; mode: number }>(
    workspaceManifest.files.map(f => [f.path, { hash: f.hash, size: f.size, mode: f.mode }])
  );

  try {
    // Process auto actions with rollback support
    for (const action of preview.auto_actions) {
      try {
        if (action.action === 'copy_from_main') {
          // Copy file from main manifest
          const mainFile = getFile(mainManifest, action.path);
          if (mainFile) {
            // Copy blob if not already present (it likely is since same user)
            const blobKey = `${user.id}/blobs/${mainFile.hash}`;
            const exists = await c.env.BLOBS.head(blobKey);
            if (!exists) {
              // This shouldn't happen for same user, but handle it
              const mainBlobKey = `${user.id}/blobs/${mainFile.hash}`;
              const mainBlob = await c.env.BLOBS.get(mainBlobKey);
              if (mainBlob) {
                await uploadBlobWithRollback(
                  c.env.BLOBS,
                  user.id,
                  mainFile.hash,
                  await mainBlob.arrayBuffer(),
                  rollbackContext
                );
              }
            }

            // Add to new manifest
            newFiles.set(action.path, mainFile);
            filesAdded++;
          } else {
            errors.push(`Could not find ${action.path} in main manifest`);
          }
        } else if (action.action === 'ai_combined' && action.combined_content) {
          // Write combined content as new blob
          const content = new TextEncoder().encode(action.combined_content);
          const hash = await computeSha256(content);

          await uploadBlobWithRollback(
            c.env.BLOBS,
            user.id,
            hash,
            content,
            rollbackContext
          );

          // Update manifest entry
          newFiles.set(action.path, {
            hash,
            size: content.length,
            mode: getFile(workspaceManifest, action.path)?.mode || 0o644,
          });
          filesUpdated++;
        }
      } catch (error) {
        console.error(`Failed to apply action for ${action.path}:`, error);
        errors.push(`Failed to sync ${action.path}`);
        // Trigger rollback on any error
        throw error;
      }
    }

    // Process user decisions with rollback support
    for (const decision of preview.decisions_needed) {
      const selectedOptionId = decisions[decision.path];
      const selectedOption = decision.options.find(o => o.id === selectedOptionId);

      if (!selectedOption) {
        errors.push(`Invalid decision for ${decision.path}`);
        throw new Error(`Invalid decision for ${decision.path}`);
      }

      try {
        // Write the selected content
        const content = new TextEncoder().encode(selectedOption.resulting_content);
        const hash = await computeSha256(content);

        await uploadBlobWithRollback(
          c.env.BLOBS,
          user.id,
          hash,
          content,
          rollbackContext
        );

        // Update manifest entry
        newFiles.set(decision.path, {
          hash,
          size: content.length,
          mode: getFile(workspaceManifest, decision.path)?.mode || 0o644,
        });
        filesUpdated++;
      } catch (error) {
        console.error(`Failed to apply decision for ${decision.path}:`, error);
        errors.push(`Failed to apply decision for ${decision.path}`);
        // Trigger rollback on any error
        throw error;
      }
    }
  } catch (error) {
    // Rollback all uploaded blobs on failure
    console.error('Sync failed, executing rollback:', error);
    const rollbackResult = await executeRollback(c.env.BLOBS, user.id, rollbackContext);
    if (rollbackResult.errors.length > 0) {
      console.error('Rollback errors:', rollbackResult.errors);
    }

    return c.json({
      error: {
        code: 'SYNC_FAILED',
        message: 'Sync failed and changes were rolled back',
        details: { errors, rollbackErrors: rollbackResult.errors }
      }
    }, 500);
  }

  // Create new manifest (convert Map back to array)
  const newManifest: Manifest = {
    version: workspaceManifest.version,
    files: Array.from(newFiles.entries()).map(([path, file]) => ({
      path,
      hash: file.hash,
      size: file.size,
      mode: file.mode,
    })),
  };

  // Validate manifest integrity - ensure all referenced blobs exist
  const validationResult = await validateManifestIntegrity(
    c.env.BLOBS,
    user.id,
    newManifest
  );

  if (!validationResult.valid) {
    console.error('Manifest validation failed:', validationResult);

    // Rollback uploaded blobs since manifest is invalid
    const rollbackResult = await executeRollback(c.env.BLOBS, user.id, rollbackContext);

    return c.json({
      error: {
        code: 'MANIFEST_INVALID',
        message: 'Manifest validation failed - some blobs are missing',
        details: {
          missingBlobs: validationResult.missingBlobs,
          validationErrors: validationResult.errors,
          rollbackErrors: rollbackResult.errors,
        }
      }
    }, 500);
  }

  // Compute manifest hash and save
  const { toJSON, hashManifest } = await import('@fastest/shared');
  const newManifestJson = toJSON(newManifest);
  const newManifestHash = await hashManifest(newManifest);

  await c.env.BLOBS.put(
    `${user.id}/manifests/${newManifestHash}.json`,
    newManifestJson
  );

  // Track manifest for potential rollback
  rollbackContext.createdManifests.push(newManifestHash);

  // Create new snapshot
  const newSnapshotId = generateULID();
  await db.insert(snapshots).values({
    id: newSnapshotId,
    projectId: workspace.project_id,
    workspaceId: workspaceId,
    manifestHash: newManifestHash,
    parentSnapshotId: currentSnapshotId,
    source: 'web',
    createdAt: new Date().toISOString(),
  });

  // Update workspace with OPTIMISTIC LOCKING
  // Only update if version matches what we read initially
  const updateResult = await db
    .update(workspaces)
    .set({
      baseSnapshotId: newSnapshotId,
      lastSeenAt: new Date().toISOString(),
      version: initialVersion + 1,
    })
    .where(
      and(
        eq(workspaces.id, workspaceId),
        eq(workspaces.version, initialVersion)
      )
    );

  // Check if optimistic lock succeeded (rowsAffected > 0)
  // D1 doesn't expose rowsAffected directly, so we verify by re-reading
  const verifyResult = await db
    .select({ version: workspaces.version, base_snapshot_id: workspaces.baseSnapshotId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  if (!verifyResult[0] || verifyResult[0].version !== initialVersion + 1 || verifyResult[0].base_snapshot_id !== newSnapshotId) {
    // Optimistic lock failed - concurrent modification detected
    console.error('Optimistic lock failed: workspace was modified concurrently');

    // Rollback - but note the snapshot record remains (orphaned but harmless)
    const rollbackResult = await executeRollback(c.env.BLOBS, user.id, rollbackContext);

    return c.json({
      error: {
        code: 'CONCURRENT_MODIFICATION',
        message: 'Another sync operation modified this workspace. Please try again.',
        details: {
          expectedVersion: initialVersion,
          rollbackErrors: rollbackResult.errors,
        }
      }
    }, 409); // 409 Conflict
  }

  // Update project's last snapshot
  await db
    .update(projects)
    .set({ lastSnapshotId: newSnapshotId })
    .where(eq(projects.id, workspace.project_id));

  // Update merge history to track this sync for future three-way merges
  if (main_workspace_id && main_snapshot_id) {
    try {
      // Get current workspace's merge history
      const currentMergeHistoryResult = await db
        .select({ merge_history: workspaces.mergeHistory })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);

      const currentMergeHistory = currentMergeHistoryResult[0]?.merge_history
        ? JSON.parse(currentMergeHistoryResult[0].merge_history)
        : {};

      // Get main workspace's merge history for transitive tracking
      const mainMergeHistoryResult = await db
        .select({ merge_history: workspaces.mergeHistory })
        .from(workspaces)
        .where(eq(workspaces.id, main_workspace_id))
        .limit(1);

      const mainMergeHistory = mainMergeHistoryResult[0]?.merge_history
        ? JSON.parse(mainMergeHistoryResult[0].merge_history)
        : {};

      // Record direct merge from main
      const now = new Date().toISOString();
      currentMergeHistory[main_workspace_id] = {
        last_merged_snapshot: main_snapshot_id,
        merged_at: now,
      };

      // Inherit main's merge history (transitive tracking)
      for (const [wsId, record] of Object.entries(mainMergeHistory)) {
        const typedRecord = record as { last_merged_snapshot: string; merged_at: string };
        if (!currentMergeHistory[wsId] || typedRecord.merged_at > currentMergeHistory[wsId].merged_at) {
          currentMergeHistory[wsId] = typedRecord;
        }
      }

      // Save updated merge history
      await db
        .update(workspaces)
        .set({ mergeHistory: JSON.stringify(currentMergeHistory) })
        .where(eq(workspaces.id, workspaceId));
    } catch (err) {
      console.error('Failed to update merge history:', err);
      // Non-fatal - sync still succeeded
    }
  }

  // Delete the preview from KV
  await c.env.KV.delete(`sync_preview:${preview_id}`);

  // Log activity
  const eventId = generateULID();
  await db.insert(activityEvents).values({
    id: eventId,
    projectId: workspace.project_id,
    workspaceId,
    actor: 'web',
    type: 'merge.completed',
    snapshotId: newSnapshotId,
    message: `Synced with main: +${filesAdded} files, ~${filesUpdated} updated`,
    createdAt: new Date().toISOString(),
  });

  return c.json({
    success: errors.length === 0,
    files_updated: filesUpdated,
    files_added: filesAdded,
    errors,
    snapshot_before_id: snapshotBeforeId,
    snapshot_after_id: create_snapshot_after ? newSnapshotId : undefined,
  });
});

// Undo last sync (restore to previous snapshot)
workspaceRoutes.post('/:workspaceId/sync/undo', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const workspaceId = c.req.param('workspaceId');
  const body = await c.req.json<{ snapshot_id: string }>();

  if (!body.snapshot_id) {
    return c.json({ error: { code: 'MISSING_SNAPSHOT_ID', message: 'snapshot_id is required' } }, 400);
  }

  const db = createDb(c.env.DB);

  // Get workspace info and verify ownership
  const workspaceResult = await db
    .select({
      id: workspaces.id,
      project_id: workspaces.projectId,
      base_snapshot_id: workspaces.baseSnapshotId,
    })
    .from(workspaces)
    .innerJoin(projects, eq(workspaces.projectId, projects.id))
    .where(and(eq(workspaces.id, workspaceId), eq(projects.ownerUserId, user.id)))
    .limit(1);

  const workspace = workspaceResult[0];
  if (!workspace) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } }, 404);
  }

  // Verify the target snapshot exists and belongs to this project
  const snapshotResult = await db
    .select({
      id: snapshots.id,
      project_id: snapshots.projectId,
      manifest_hash: snapshots.manifestHash,
    })
    .from(snapshots)
    .where(eq(snapshots.id, body.snapshot_id))
    .limit(1);

  const targetSnapshot = snapshotResult[0];
  if (!targetSnapshot) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Snapshot not found' } }, 404);
  }

  if (targetSnapshot.project_id !== workspace.project_id) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Snapshot does not belong to this project' } }, 403);
  }

  // Update workspace to point to the target snapshot
  await db
    .update(workspaces)
    .set({
      baseSnapshotId: body.snapshot_id,
      lastSeenAt: new Date().toISOString(),
    })
    .where(eq(workspaces.id, workspaceId));

  // Log activity
  const eventId = generateULID();
  await db.insert(activityEvents).values({
    id: eventId,
    projectId: workspace.project_id,
    workspaceId,
    actor: 'web',
    type: 'snapshot.pulled',
    snapshotId: body.snapshot_id,
    message: 'Reverted to previous snapshot (undo sync)',
    createdAt: new Date().toISOString(),
  });

  return c.json({
    success: true,
    restored_snapshot_id: body.snapshot_id,
  });
});

// ============================================================================
// Three-Way Merge Support Functions
// ============================================================================

/**
 * MergeAction represents what should happen to a single file during merge
 */
interface MergeAction {
  path: string;
  actionType: 'apply' | 'conflict' | 'in_sync' | 'skip';
  currentHash?: string;
  sourceHash?: string;
  baseHash?: string;
}

/**
 * MergeActions holds all computed merge actions from three-way comparison
 */
interface MergeActions {
  toApply: MergeAction[];   // Non-conflicting changes to apply from source
  conflicts: MergeAction[]; // Files with conflicting changes
  inSync: MergeAction[];    // Files already in sync
  skipped: MergeAction[];   // Files skipped (if cherry-pick filter used)
}

/**
 * Compute three-way merge actions given base, current, and source manifests.
 * This mirrors the CLI's computeMergeActions function.
 */
function computeThreeWayMerge(
  base: Manifest,
  current: Manifest,
  source: Manifest
): MergeActions {
  const result: MergeActions = {
    toApply: [],
    conflicts: [],
    inSync: [],
    skipped: [],
  };

  // Build lookup maps
  const baseFiles = new Map<string, string>();
  for (const f of base.files) {
    baseFiles.set(f.path, f.hash);
  }

  const currentFiles = new Map<string, string>();
  for (const f of current.files) {
    currentFiles.set(f.path, f.hash);
  }

  const sourceFiles = new Map<string, string>();
  for (const f of source.files) {
    sourceFiles.set(f.path, f.hash);
  }

  // Collect all unique paths
  const allPaths = new Set([
    ...baseFiles.keys(),
    ...currentFiles.keys(),
    ...sourceFiles.keys(),
  ]);

  for (const path of allPaths) {
    const inBase = baseFiles.has(path);
    const inCurrent = currentFiles.has(path);
    const inSource = sourceFiles.has(path);

    const baseHash = baseFiles.get(path);
    const currentHash = currentFiles.get(path);
    const sourceHash = sourceFiles.get(path);

    const action: MergeAction = {
      path,
      actionType: 'in_sync',
      baseHash,
      currentHash,
      sourceHash,
    };

    // Determine if each side changed from base
    const currentChanged = (!inBase && inCurrent) || (inBase && inCurrent && baseHash !== currentHash);
    const sourceChanged = (!inBase && inSource) || (inBase && inSource && baseHash !== sourceHash);
    const currentDeleted = inBase && !inCurrent;
    const sourceDeleted = inBase && !inSource;

    // Determine action based on three-way comparison
    if (!inSource && !sourceDeleted) {
      // File only exists in current or was deleted in source but we have it
      // Nothing to merge from source
      continue;
    }

    if (!inCurrent && inSource) {
      // File only in source (added in source) - apply
      action.actionType = 'apply';
      result.toApply.push(action);
    } else if (currentDeleted && inSource) {
      // We deleted, source has it - conflict
      action.actionType = 'conflict';
      result.conflicts.push(action);
    } else if (sourceDeleted && inCurrent) {
      // Source deleted, we have it - keep ours
      action.actionType = 'in_sync';
      result.inSync.push(action);
    } else if (inCurrent && inSource && currentHash === sourceHash) {
      // Same content - in sync
      action.actionType = 'in_sync';
      result.inSync.push(action);
    } else if (!currentChanged && sourceChanged) {
      // Only source changed - apply
      action.actionType = 'apply';
      result.toApply.push(action);
    } else if (currentChanged && !sourceChanged) {
      // Only current changed - keep ours (already have it)
      action.actionType = 'in_sync';
      result.inSync.push(action);
    } else if (currentChanged && sourceChanged) {
      // Both changed - conflict
      action.actionType = 'conflict';
      result.conflicts.push(action);
    } else {
      // No changes
      action.actionType = 'in_sync';
      result.inSync.push(action);
    }
  }

  return result;
}

/**
 * Determine the correct merge base (common ancestor) for three-way merge.
 * This mirrors the CLI's getMergeBase function with its 4-step fallback:
 *
 * 1. Check merge history - if we've merged from this source before
 * 2. Check if target was forked from source (via base_snapshot_id metadata)
 * 3. Check if source was forked from target
 * 4. Check if both are siblings (forked from same parent)
 * 5. Fallback to target's base_snapshot_id
 *
 * @returns The merge base snapshot ID, or null if none found
 */
async function getMergeBase(
  db: ReturnType<typeof createDb>,
  targetWorkspaceId: string,
  sourceWorkspaceId: string
): Promise<string | null> {
  // Get both workspaces with their merge history and base snapshot IDs
  const [targetResult, sourceResult] = await Promise.all([
    db.select({
      id: workspaces.id,
      base_snapshot_id: workspaces.baseSnapshotId,
      merge_history: workspaces.mergeHistory,
    })
      .from(workspaces)
      .where(eq(workspaces.id, targetWorkspaceId))
      .limit(1),
    db.select({
      id: workspaces.id,
      base_snapshot_id: workspaces.baseSnapshotId,
      merge_history: workspaces.mergeHistory,
    })
      .from(workspaces)
      .where(eq(workspaces.id, sourceWorkspaceId))
      .limit(1),
  ]);

  const target = targetResult[0];
  const source = sourceResult[0];

  if (!target || !source) {
    return null;
  }

  // Parse merge histories
  const targetMergeHistory: Record<string, MergeRecord> = target.merge_history
    ? JSON.parse(target.merge_history)
    : {};

  // 1. Check if we've merged from this source before
  if (targetMergeHistory[sourceWorkspaceId]) {
    return targetMergeHistory[sourceWorkspaceId].last_merged_snapshot;
  }

  // Helper to load snapshot metadata (workspace_id) from snapshot
  async function getSnapshotWorkspaceId(snapshotId: string): Promise<string | null> {
    const result = await db
      .select({ workspace_id: snapshots.workspaceId })
      .from(snapshots)
      .where(eq(snapshots.id, snapshotId))
      .limit(1);
    return result[0]?.workspace_id || null;
  }

  // 2. Check if target was forked from source
  if (target.base_snapshot_id) {
    const targetBaseWorkspaceId = await getSnapshotWorkspaceId(target.base_snapshot_id);
    if (targetBaseWorkspaceId === sourceWorkspaceId) {
      // Target was forked from source, use target's base as common ancestor
      return target.base_snapshot_id;
    }
  }

  // 3. Check if source was forked from target
  if (source.base_snapshot_id) {
    const sourceBaseWorkspaceId = await getSnapshotWorkspaceId(source.base_snapshot_id);
    if (sourceBaseWorkspaceId === targetWorkspaceId) {
      // Source was forked from target, use source's base as common ancestor
      return source.base_snapshot_id;
    }
  }

  // 4. Check if both are siblings (forked from same parent workspace)
  if (target.base_snapshot_id && source.base_snapshot_id) {
    const [targetBaseWsId, sourceBaseWsId] = await Promise.all([
      getSnapshotWorkspaceId(target.base_snapshot_id),
      getSnapshotWorkspaceId(source.base_snapshot_id),
    ]);

    if (targetBaseWsId && sourceBaseWsId && targetBaseWsId === sourceBaseWsId) {
      // Both forked from same workspace, use the earlier snapshot as common ancestor
      // We need to compare created_at timestamps
      const [targetSnapshotResult, sourceSnapshotResult] = await Promise.all([
        db.select({ created_at: snapshots.createdAt })
          .from(snapshots)
          .where(eq(snapshots.id, target.base_snapshot_id!))
          .limit(1),
        db.select({ created_at: snapshots.createdAt })
          .from(snapshots)
          .where(eq(snapshots.id, source.base_snapshot_id!))
          .limit(1),
      ]);

      if (targetSnapshotResult[0] && sourceSnapshotResult[0]) {
        if (targetSnapshotResult[0].created_at < sourceSnapshotResult[0].created_at) {
          return target.base_snapshot_id;
        }
        return source.base_snapshot_id;
      }
    }
  }

  // 5. Fallback to target's base_snapshot_id
  if (target.base_snapshot_id) {
    return target.base_snapshot_id;
  }

  return null;
}

/**
 * Load a manifest from R2 storage by snapshot ID
 */
async function loadManifestBySnapshotId(
  db: ReturnType<typeof createDb>,
  blobs: R2Bucket,
  userId: string,
  snapshotId: string
): Promise<Manifest | null> {
  const snapshotResult = await db
    .select({ manifest_hash: snapshots.manifestHash })
    .from(snapshots)
    .where(eq(snapshots.id, snapshotId))
    .limit(1);

  if (!snapshotResult[0]) {
    return null;
  }

  const manifestKey = `${userId}/manifests/${snapshotResult[0].manifest_hash}.json`;
  const manifestObj = await blobs.get(manifestKey);

  if (!manifestObj) {
    return null;
  }

  try {
    return fromJSON(await manifestObj.text());
  } catch {
    return null;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

// Helper: Compute SHA256 hash
async function computeSha256(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Helper: Generate ULID
function generateULID(): string {
  const timestamp = Date.now().toString(36).padStart(10, '0');
  const random = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 36).toString(36)
  ).join('');
  return (timestamp + random).toUpperCase();
}

// Helper: Build AI prompt for drift analysis
function buildDriftAnalysisPrompt(
  workspaceName: string,
  mainWorkspaceName: string,
  mainOnly: string[],
  workspaceOnly: string[],
  bothDifferent: string[]
): string {
  const mainOnlyList = mainOnly.length > 0
    ? mainOnly.slice(0, 20).join('\n') + (mainOnly.length > 20 ? `\n... and ${mainOnly.length - 20} more` : '')
    : 'None';

  const workspaceOnlyList = workspaceOnly.length > 0
    ? workspaceOnly.slice(0, 20).join('\n') + (workspaceOnly.length > 20 ? `\n... and ${workspaceOnly.length - 20} more` : '')
    : 'None';

  const bothDifferentList = bothDifferent.length > 0
    ? bothDifferent.slice(0, 20).join('\n') + (bothDifferent.length > 20 ? `\n... and ${bothDifferent.length - 20} more` : '')
    : 'None';

  return `You are analyzing the differences between two workspaces in a software project.

WORKSPACE: "${workspaceName}" (the workspace being analyzed)
MAIN: "${mainWorkspaceName}" (the source of truth)

## Files only in main (workspace is missing these):
${mainOnlyList}

## Files only in workspace (not in main):
${workspaceOnlyList}

## Files that differ between both:
${bothDifferentList}

## Task

Provide a concise analysis in this EXACT JSON format (no other text):

{
  "main_changes_summary": "1-2 sentence summary of what's new in main",
  "workspace_changes_summary": "1-2 sentence summary of workspace-specific changes",
  "risk_level": "low" or "medium" or "high",
  "risk_explanation": "1 sentence explaining the risk level",
  "can_auto_sync": true or false,
  "recommendation": "1 sentence recommendation for the user"
}

Guidelines:
- "low" risk: No overlapping changes, safe to sync automatically
- "medium" risk: Some overlapping files but likely compatible
- "high" risk: Many overlapping changes or critical files modified
- Focus on what the changes mean, not just file counts
- Be specific about what types of files changed (config, source code, tests, etc.)`;
}

// Helper: Parse AI response into DriftAnalysis
function parseAIAnalysisResponse(
  aiResponse: string,
  comparison: { main_only: string[]; workspace_only: string[]; both_different: string[] }
): DriftAnalysis {
  try {
    // Try to extract JSON from the response
    const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);

      return {
        main_changes_summary: parsed.main_changes_summary || `${comparison.main_only.length} new files in main`,
        workspace_changes_summary: parsed.workspace_changes_summary || `${comparison.workspace_only.length} files unique to workspace`,
        risk_level: ['low', 'medium', 'high'].includes(parsed.risk_level) ? parsed.risk_level : 'medium',
        risk_explanation: parsed.risk_explanation || 'Analysis could not determine specific risks',
        can_auto_sync: typeof parsed.can_auto_sync === 'boolean' ? parsed.can_auto_sync : comparison.both_different.length === 0,
        recommendation: parsed.recommendation || 'Review the changes before syncing',
        analyzed_at: new Date().toISOString(),
      };
    }
  } catch (e) {
    console.error('Failed to parse AI response:', e);
  }

  // Fallback if parsing fails
  return {
    main_changes_summary: `${comparison.main_only.length} new files in main`,
    workspace_changes_summary: `${comparison.workspace_only.length} files unique to workspace`,
    risk_level: comparison.both_different.length > 5 ? 'high' : comparison.both_different.length > 0 ? 'medium' : 'low',
    risk_explanation: comparison.both_different.length > 0
      ? `${comparison.both_different.length} files have been modified in both workspaces`
      : 'No overlapping changes detected',
    can_auto_sync: comparison.both_different.length === 0,
    recommendation: comparison.both_different.length === 0
      ? 'Safe to sync - no conflicting changes'
      : 'Review the modified files before syncing',
    analyzed_at: new Date().toISOString(),
  };
}

// Helper: Analyze file differences with AI
interface FileAnalysisResult {
  compatible: boolean;
  combined_content?: string;
  description?: string;
  main_intent?: string;
  workspace_intent?: string;
  conflict_reason?: string;
  options?: DecisionOption[];
  recommended_option?: string;
}

async function analyzeFileDifference(
  ai: Ai,
  path: string,
  workspaceContent: string,
  mainContent: string
): Promise<FileAnalysisResult> {
  // For very large files, skip AI and default to decision needed
  if (workspaceContent.length > 50000 || mainContent.length > 50000) {
    return {
      compatible: false,
      main_intent: 'Changes from main',
      workspace_intent: 'Your changes',
      conflict_reason: 'File too large for automatic analysis',
      options: [
        {
          id: 'use_main',
          label: 'Use main version',
          description: 'Replace with main version',
          resulting_content: mainContent,
        },
        {
          id: 'use_workspace',
          label: 'Keep your version',
          description: 'Keep your current version',
          resulting_content: workspaceContent,
        },
      ],
      recommended_option: 'use_main',
    };
  }

  // Truncate for AI prompt if needed
  const maxContentLength = 10000;
  const truncatedWorkspace = workspaceContent.length > maxContentLength
    ? workspaceContent.slice(0, maxContentLength) + '\n... (truncated)'
    : workspaceContent;
  const truncatedMain = mainContent.length > maxContentLength
    ? mainContent.slice(0, maxContentLength) + '\n... (truncated)'
    : mainContent;

  const prompt = buildFileSyncPrompt(path, truncatedWorkspace, truncatedMain);

  const response = await ai.run(
    '@cf/meta/llama-3.1-8b-instruct-fast' as Parameters<Ai['run']>[0],
    {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2000,
    }
  ) as { response?: string };

  const aiResponse = response.response?.trim() || '';

  return parseFileSyncResponse(aiResponse, workspaceContent, mainContent);
}

// Helper: Build prompt for file sync analysis
function buildFileSyncPrompt(
  path: string,
  workspaceContent: string,
  mainContent: string
): string {
  return `You are syncing two versions of a file. Your goal is to combine both sets of changes if possible.

FILE: ${path}

## Your workspace version:
\`\`\`
${workspaceContent}
\`\`\`

## Main version:
\`\`\`
${mainContent}
\`\`\`

## Task

Analyze both versions and respond with ONLY a JSON object (no other text):

If the changes are COMPATIBLE (can be combined):
{
  "compatible": true,
  "workspace_intent": "Brief description of what your version changed",
  "main_intent": "Brief description of what main changed",
  "combined_content": "The full combined file content that includes both changes",
  "description": "Brief description of how they were combined"
}

If the changes are INCOMPATIBLE (conflict):
{
  "compatible": false,
  "workspace_intent": "Brief description of what your version changed",
  "main_intent": "Brief description of what main changed",
  "conflict_reason": "Why these changes conflict"
}

Guidelines:
- Changes in DIFFERENT parts of the file are usually compatible
- Changes to the SAME lines/values are usually incompatible
- If imports were added by both, combine them
- If functions were added by both in different places, combine them
- If the same config value was changed to different values, that's a conflict
- Describe intents in plain English, not code
- For combined_content, output the COMPLETE file, not just the changed parts`;
}

// Helper: Parse AI response for file sync
function parseFileSyncResponse(
  aiResponse: string,
  workspaceContent: string,
  mainContent: string
): FileAnalysisResult {
  try {
    // Try to extract JSON from the response
    const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);

      if (parsed.compatible && parsed.combined_content) {
        return {
          compatible: true,
          combined_content: parsed.combined_content,
          description: parsed.description || 'Combined changes from both versions',
          main_intent: parsed.main_intent,
          workspace_intent: parsed.workspace_intent,
        };
      } else {
        return {
          compatible: false,
          main_intent: parsed.main_intent || 'Changes from main',
          workspace_intent: parsed.workspace_intent || 'Your changes',
          conflict_reason: parsed.conflict_reason || 'Files have conflicting changes',
          options: [
            {
              id: 'use_main',
              label: 'Use main version',
              description: parsed.main_intent || 'Use the version from main',
              resulting_content: mainContent,
            },
            {
              id: 'use_workspace',
              label: 'Keep your version',
              description: parsed.workspace_intent || 'Keep your current version',
              resulting_content: workspaceContent,
            },
          ],
          recommended_option: 'use_main',
        };
      }
    }
  } catch (e) {
    console.error('Failed to parse file sync AI response:', e);
  }

  // Fallback: return as incompatible
  return {
    compatible: false,
    main_intent: 'Changes from main',
    workspace_intent: 'Your changes',
    conflict_reason: 'Could not automatically analyze differences',
    options: [
      {
        id: 'use_main',
        label: 'Use main version',
        description: 'Replace with main version',
        resulting_content: mainContent,
      },
      {
        id: 'use_workspace',
        label: 'Keep your version',
        description: 'Keep your current version',
        resulting_content: workspaceContent,
      },
    ],
    recommended_option: 'use_main',
  };
}

// Get snapshots for a workspace (shows project snapshots)
workspaceRoutes.get('/:workspaceId/snapshots', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const workspaceId = c.req.param('workspaceId');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const db = createDb(c.env.DB);

  // Verify ownership and get project ID
  const workspaceResult = await db
    .select({
      id: workspaces.id,
      project_id: workspaces.projectId,
      base_snapshot_id: workspaces.baseSnapshotId,
    })
    .from(workspaces)
    .innerJoin(projects, eq(workspaces.projectId, projects.id))
    .where(and(eq(workspaces.id, workspaceId), eq(projects.ownerUserId, user.id)))
    .limit(1);

  const workspace = workspaceResult[0];
  if (!workspace) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } }, 404);
  }

  // Get all snapshots for this project
  const snapshotResults = await db
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
    .where(eq(snapshots.projectId, workspace.project_id))
    .orderBy(desc(snapshots.createdAt))
    .limit(limit);

  // Mark which snapshot is current for this workspace
  const snapshotsWithStatus = snapshotResults.map(s => ({
    ...s,
    is_current: s.id === workspace.base_snapshot_id,
  }));

  return c.json({
    snapshots: snapshotsWithStatus,
    current_snapshot_id: workspace.base_snapshot_id,
  });
});

/**
 * Deploy workspace from latest snapshot
 * POST /v1/workspaces/:workspaceId/deploy
 *
 * Deploys the workspace using its latest snapshot.
 * Requires at least one snapshot to exist for the workspace.
 */
workspaceRoutes.post('/:workspaceId/deploy', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const workspaceId = c.req.param('workspaceId');
  const db = createDb(c.env.DB);

  // Verify ownership and get workspace
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

  // Get the latest snapshot for this workspace
  const snapshotResult = await db
    .select({
      id: snapshots.id,
      manifest_hash: snapshots.manifestHash,
    })
    .from(snapshots)
    .where(eq(snapshots.workspaceId, workspaceId))
    .orderBy(desc(snapshots.createdAt))
    .limit(1);

  const latestSnapshot = snapshotResult[0];
  if (!latestSnapshot) {
    return c.json({
      error: {
        code: 'NO_SNAPSHOT',
        message: 'No snapshots found for this workspace. Save a snapshot before deploying.'
      }
    }, 400);
  }

  // Get or create a conversation for deployment
  // Use the most recent conversation for this workspace
  const conversationResult = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.workspaceId, workspaceId))
    .orderBy(desc(conversations.updatedAt))
    .limit(1);

  let conversationId: string;

  if (conversationResult[0]) {
    conversationId = conversationResult[0].id;
  } else {
    // Create a new conversation for deployment
    conversationId = generateULID();
    await db.insert(conversations).values({
      id: conversationId,
      workspaceId: workspaceId,
      title: 'Deployment',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  // Get the conversation DO and update its manifest to the snapshot's manifest
  const doId = c.env.ConversationSession.idFromName(conversationId);
  const stub = c.env.ConversationSession.get(doId);

  // First, set the manifest hash to the snapshot's manifest
  const setManifestResponse = await stub.fetch(new Request('http://do/set-manifest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifestHash: latestSnapshot.manifest_hash }),
  }));

  if (!setManifestResponse.ok) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to set deployment manifest' } }, 500);
  }

  // Get API URL and token for the sandbox to call back
  const apiUrl = new URL(c.req.url).origin;
  const apiToken = c.req.header('Authorization')?.replace('Bearer ', '') || '';

  // Trigger the deployment
  const response = await stub.fetch(new Request('http://do/deploy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiUrl, apiToken }),
  }));

  const data = await response.json();

  return c.json({
    ...data,
    snapshot_id: latestSnapshot.id,
    conversation_id: conversationId,
  });
});
