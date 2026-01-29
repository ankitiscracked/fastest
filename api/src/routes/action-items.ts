import { Hono } from 'hono';
import { eq, and, desc, ne, isNotNull, sql } from 'drizzle-orm';
import type { Env } from '../index';
import type { ActionItem, ActionItemRun } from '@fastest/shared';
import { getAuthUser } from '../middleware/auth';
import { createDb, workspaces, projects, driftReports, actionItems, actionItemRuns, deployments, conversations } from '../db';

export const actionItemRoutes = new Hono<{ Bindings: Env }>();

// Get all action items across workspaces for the current user
// Reads from drift_reports table (populated by drift/compare endpoint)
actionItemRoutes.get('/', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const db = createDb(c.env.DB);
  const items: ActionItem[] = [];

  // Query recent drift reports with workspace and project info
  // Only get the latest drift report per workspace (using subquery)
  const driftResults = await db
    .select({
      drift_id: driftReports.id,
      workspace_id: driftReports.workspaceId,
      files_added: driftReports.filesAdded,
      files_modified: driftReports.filesModified,
      reported_at: driftReports.reportedAt,
      workspace_name: workspaces.name,
      project_id: workspaces.projectId,
      project_name: projects.name,
      main_workspace_id: projects.mainWorkspaceId,
    })
    .from(driftReports)
    .innerJoin(workspaces, eq(driftReports.workspaceId, workspaces.id))
    .innerJoin(projects, eq(workspaces.projectId, projects.id))
    .where(
      and(
        eq(projects.ownerUserId, user.id),
        isNotNull(projects.mainWorkspaceId),
        // Only show drift for non-main workspaces
        sql`${driftReports.workspaceId} != ${projects.mainWorkspaceId}`
      )
    )
    .orderBy(desc(driftReports.reportedAt));

  // Deduplicate to keep only latest report per workspace
  const seenWorkspaces = new Set<string>();

  for (const row of driftResults) {
    if (seenWorkspaces.has(row.workspace_id)) continue;
    seenWorkspaces.add(row.workspace_id);

    const filesAdded = row.files_added ?? 0;
    const filesModified = row.files_modified ?? 0;
    const totalDrift = filesAdded + filesModified;

    // Skip if no drift
    if (totalDrift === 0) continue;

    // Determine severity
    let severity: ActionItem['severity'] = 'info';
    if (filesModified > 0) {
      severity = 'warning'; // Has conflicts
    }
    if (filesModified > 5) {
      severity = 'critical'; // Many conflicts
    }

    items.push({
      id: `drift-${row.workspace_id}`,
      type: 'drift',
      severity,
      workspace_id: row.workspace_id,
      workspace_name: row.workspace_name,
      project_id: row.project_id,
      project_name: row.project_name,
      title: `${totalDrift} file${totalDrift !== 1 ? 's' : ''} behind main`,
      description: filesModified > 0
        ? `${filesAdded} new in main, ${filesModified} with conflicts`
        : `${filesAdded} new files in main`,
      icon: 'sync',
      action_label: 'Sync',
      action_type: 'sync',
      action_data: {
        workspace_id: row.workspace_id,
        drift_count: totalDrift,
        main_only: filesAdded,
        conflicts: filesModified,
      },
      created_at: row.reported_at,
    });
  }

  // Query pending action items (code fixes / improvements)
  const actionItemResults = await db
    .select({
      id: actionItems.id,
      workspace_id: actionItems.workspaceId,
      type: actionItems.type,
      severity: actionItems.severity,
      title: actionItems.title,
      description: actionItems.description,
      affected_files: actionItems.affectedFiles,
      suggested_prompt: actionItems.suggestedPrompt,
      metadata: actionItems.metadata,
      created_at: actionItems.createdAt,
      workspace_name: workspaces.name,
      project_id: workspaces.projectId,
      project_name: projects.name,
    })
    .from(actionItems)
    .innerJoin(workspaces, eq(actionItems.workspaceId, workspaces.id))
    .innerJoin(projects, eq(workspaces.projectId, projects.id))
    .where(
      and(
        eq(projects.ownerUserId, user.id),
        eq(actionItems.status, 'pending')
      )
    )
    .orderBy(desc(actionItems.createdAt))
    .limit(20); // Limit to avoid overwhelming the UI

  // Map action item type to icons
  const iconMapping: Record<string, string> = {
    security: 'shield',
    test_coverage: 'check',
    refactoring: 'lightbulb',
    build_failure: 'alert',
  };

  for (const row of actionItemResults) {
    const actionType = (row.type as ActionItem['type']) || 'refactoring';
    const icon = iconMapping[actionType] || 'lightbulb';
    const actionLabel = actionType === 'test_coverage'
      ? 'Add'
      : actionType === 'security'
        ? 'Fix'
        : actionType === 'build_failure'
          ? 'Analyze'
          : 'Refactor';

    items.push({
      id: row.id,
      type: actionType,
      severity: (row.severity as ActionItem['severity']) || 'info',
      workspace_id: row.workspace_id,
      workspace_name: row.workspace_name,
      project_id: row.project_id,
      project_name: row.project_name,
      title: row.title,
      description: row.description || undefined,
      icon,
      action_label: actionLabel,
      action_type: 'prompt',
      action_data: {
        suggested_prompt: row.suggested_prompt,
        affected_files: row.affected_files ? JSON.parse(row.affected_files) : [],
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      },
      created_at: row.created_at,
    });
  }

  // Query recent failed deployments per workspace
  const deploymentResults = await db
    .select({
      deployment_id: deployments.id,
      workspace_id: deployments.workspaceId,
      project_id: deployments.projectId,
      status: deployments.status,
      error: deployments.error,
      started_at: deployments.startedAt,
      completed_at: deployments.completedAt,
      workspace_name: workspaces.name,
      project_name: projects.name,
    })
    .from(deployments)
    .innerJoin(workspaces, eq(deployments.workspaceId, workspaces.id))
    .innerJoin(projects, eq(workspaces.projectId, projects.id))
    .where(
      and(
        eq(projects.ownerUserId, user.id),
        eq(deployments.status, 'failed')
      )
    )
    .orderBy(desc(deployments.startedAt))
    .limit(20);

  // Deduplicate to keep only latest failed deployment per workspace
  const seenDeploymentWorkspaces = new Set<string>();

  for (const row of deploymentResults) {
    if (!row.workspace_id) continue;
    if (seenDeploymentWorkspaces.has(row.workspace_id)) continue;
    seenDeploymentWorkspaces.add(row.workspace_id);

    items.push({
      id: `deploy-${row.deployment_id}`,
      type: 'build_failure',
      severity: 'warning',
      workspace_id: row.workspace_id,
      workspace_name: row.workspace_name,
      project_id: row.project_id,
      project_name: row.project_name,
      title: 'Latest deployment failed',
      description: row.error || 'Deployment failed. Review logs for details.',
      icon: 'alert',
      action_label: 'Analyze',
      action_type: 'prompt',
      action_data: {
        deployment_id: row.deployment_id,
        started_at: row.started_at,
        completed_at: row.completed_at,
      },
      created_at: row.started_at,
    });
  }

  // Sort by severity (critical first), then by drift count
  items.sort((a, b) => {
    const severityOrder = { critical: 0, warning: 1, info: 2 };
    const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
    if (severityDiff !== 0) return severityDiff;

    // Then by drift count (higher first)
    const aCount = (a.action_data?.drift_count as number) || 0;
    const bCount = (b.action_data?.drift_count as number) || 0;
    return bCount - aCount;
  });

  return c.json({ items });
});

// Dismiss an action item
actionItemRoutes.post('/:itemId/dismiss', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const itemId = c.req.param('itemId');
  const db = createDb(c.env.DB);

  // Check if it's a drift/build item (starts with "drift-" / "deploy-") or an action item
  if (itemId.startsWith('drift-') || itemId.startsWith('deploy-')) {
    // Drift/build items don't have persistent dismiss state yet
    // Could add a dismissed_* table in the future
    return c.json({ success: true });
  }

  // Mark action item as dismissed
  await db
    .update(actionItems)
    .set({ status: 'dismissed' })
    .where(eq(actionItems.id, itemId));

  return c.json({ success: true });
});

// Create a new action item run (background patch generation)
actionItemRoutes.post('/:itemId/runs', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const itemId = c.req.param('itemId');
  const db = createDb(c.env.DB);

  let item = await db
    .select({
      id: actionItems.id,
      workspace_id: actionItems.workspaceId,
      project_id: actionItems.projectId,
      type: actionItems.type,
      status: actionItems.status,
    })
    .from(actionItems)
    .innerJoin(projects, eq(actionItems.projectId, projects.id))
    .where(and(eq(actionItems.id, itemId), eq(projects.ownerUserId, user.id)))
    .limit(1)
    .then((rows) => rows[0]);

  // If this is a build failure item, create a persistent action_item entry on demand
  if (!item && itemId.startsWith('deploy-')) {
    const deploymentId = itemId.replace('deploy-', '');
    const [deployment] = await db
      .select({
        id: deployments.id,
        workspace_id: deployments.workspaceId,
        project_id: deployments.projectId,
        error: deployments.error,
        started_at: deployments.startedAt,
        workspace_name: workspaces.name,
        project_name: projects.name,
      })
      .from(deployments)
      .innerJoin(workspaces, eq(deployments.workspaceId, workspaces.id))
      .innerJoin(projects, eq(deployments.projectId, projects.id))
      .where(and(eq(deployments.id, deploymentId), eq(projects.ownerUserId, user.id)))
      .limit(1);

    if (!deployment) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Deployment not found' } }, 404);
    }

    const now = new Date().toISOString();
    const actionItemId = crypto.randomUUID();
    await db.insert(actionItems).values({
      id: actionItemId,
      workspaceId: deployment.workspace_id,
      projectId: deployment.project_id,
      type: 'build_failure',
      severity: 'warning',
      title: 'Analyze build failure',
      description: deployment.error || 'Deployment failed. Analyze logs for root cause.',
      metadata: JSON.stringify({
        deployment_id: deployment.id,
        started_at: deployment.started_at,
      }),
      status: 'pending',
      source: 'analysis',
      createdAt: now,
      updatedAt: now,
    });

    item = {
      id: actionItemId,
      workspace_id: deployment.workspace_id,
      project_id: deployment.project_id,
      type: 'build_failure',
      status: 'pending',
    };
  }

  if (!item) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Action item not found' } }, 404);
  }

  if (item.status === 'dismissed' || item.status === 'applied') {
    return c.json({ error: { code: 'INVALID_STATE', message: 'Action item is not runnable' } }, 400);
  }

  const [conversation] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.workspaceId, item.workspace_id))
    .orderBy(desc(conversations.updatedAt))
    .limit(1);

  if (!conversation) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'No conversation found for workspace' } }, 404);
  }

  const runId = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.insert(actionItemRuns).values({
    id: runId,
    actionItemId: item.id,
    workspaceId: item.workspace_id,
    projectId: item.project_id,
    status: 'queued',
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: now,
    updatedAt: now,
  });

  // Kick off async run in the conversation DO
  const doId = c.env.ConversationSession.idFromName(conversation.id);
  const stub = c.env.ConversationSession.get(doId);
  const baseUrl = new URL(c.req.url);
  const apiUrl = `${baseUrl.origin}/v1`;
  stub.fetch(new Request('http://do/action-item-runs/start', {
    method: 'POST',
    body: JSON.stringify({
      runId,
      actionItemId: item.id,
      conversationId: conversation.id,
      workspaceId: item.workspace_id,
      projectId: item.project_id,
      apiUrl,
      apiToken: c.req.header('Authorization')?.replace('Bearer ', '') || '',
    }),
  })).catch((err) => {
    console.error('[ActionItems] Failed to start run:', err);
  });

  const run: ActionItemRun = {
    id: runId,
    action_item_id: item.id,
    workspace_id: item.workspace_id,
    project_id: item.project_id,
    status: 'queued',
    attempt_count: 0,
    max_attempts: 3,
    created_at: now,
    updated_at: now,
  };

  return c.json({ run });
});

// List runs for an action item
actionItemRoutes.get('/:itemId/runs', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const itemId = c.req.param('itemId');
  const db = createDb(c.env.DB);

  const rows = await db
    .select({
      id: actionItemRuns.id,
      action_item_id: actionItemRuns.actionItemId,
      workspace_id: actionItemRuns.workspaceId,
      project_id: actionItemRuns.projectId,
      status: actionItemRuns.status,
      attempt_count: actionItemRuns.attemptCount,
      max_attempts: actionItemRuns.maxAttempts,
      base_manifest_hash: actionItemRuns.baseManifestHash,
      summary: actionItemRuns.summary,
      report: actionItemRuns.report,
      patch: actionItemRuns.patch,
      checks: actionItemRuns.checks,
      error: actionItemRuns.error,
      started_at: actionItemRuns.startedAt,
      completed_at: actionItemRuns.completedAt,
      created_at: actionItemRuns.createdAt,
      updated_at: actionItemRuns.updatedAt,
    })
    .from(actionItemRuns)
    .innerJoin(actionItems, eq(actionItemRuns.actionItemId, actionItems.id))
    .innerJoin(projects, eq(actionItems.projectId, projects.id))
    .where(and(eq(actionItemRuns.actionItemId, itemId), eq(projects.ownerUserId, user.id)))
    .orderBy(desc(actionItemRuns.createdAt))
    .limit(20);

  const runs: ActionItemRun[] = rows.map((row) => ({
    id: row.id,
    action_item_id: row.action_item_id,
    workspace_id: row.workspace_id,
    project_id: row.project_id,
    status: row.status as ActionItemRun['status'],
    attempt_count: row.attempt_count,
    max_attempts: row.max_attempts,
    base_manifest_hash: row.base_manifest_hash || undefined,
    summary: row.summary || undefined,
    report: row.report || undefined,
    patch: row.patch || undefined,
    checks: row.checks ? JSON.parse(row.checks) : undefined,
    error: row.error || undefined,
    started_at: row.started_at || undefined,
    completed_at: row.completed_at || undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));

  return c.json({ runs });
});

// Get a single run
actionItemRoutes.get('/runs/:runId', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const runId = c.req.param('runId');
  const db = createDb(c.env.DB);

  const [row] = await db
    .select({
      id: actionItemRuns.id,
      action_item_id: actionItemRuns.actionItemId,
      workspace_id: actionItemRuns.workspaceId,
      project_id: actionItemRuns.projectId,
      status: actionItemRuns.status,
      attempt_count: actionItemRuns.attemptCount,
      max_attempts: actionItemRuns.maxAttempts,
      base_manifest_hash: actionItemRuns.baseManifestHash,
      summary: actionItemRuns.summary,
      report: actionItemRuns.report,
      patch: actionItemRuns.patch,
      checks: actionItemRuns.checks,
      error: actionItemRuns.error,
      started_at: actionItemRuns.startedAt,
      completed_at: actionItemRuns.completedAt,
      created_at: actionItemRuns.createdAt,
      updated_at: actionItemRuns.updatedAt,
    })
    .from(actionItemRuns)
    .innerJoin(actionItems, eq(actionItemRuns.actionItemId, actionItems.id))
    .innerJoin(projects, eq(actionItems.projectId, projects.id))
    .where(and(eq(actionItemRuns.id, runId), eq(projects.ownerUserId, user.id)))
    .limit(1);

  if (!row) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Run not found' } }, 404);
  }

  const run: ActionItemRun = {
    id: row.id,
    action_item_id: row.action_item_id,
    workspace_id: row.workspace_id,
    project_id: row.project_id,
    status: row.status as ActionItemRun['status'],
    attempt_count: row.attempt_count,
    max_attempts: row.max_attempts,
    base_manifest_hash: row.base_manifest_hash || undefined,
    summary: row.summary || undefined,
    report: row.report || undefined,
    patch: row.patch || undefined,
    checks: row.checks ? JSON.parse(row.checks) : undefined,
    error: row.error || undefined,
    started_at: row.started_at || undefined,
    completed_at: row.completed_at || undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };

  return c.json({ run });
});

// Apply a ready run (write changes back to workspace)
actionItemRoutes.post('/runs/:runId/apply', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const runId = c.req.param('runId');
  const db = createDb(c.env.DB);

  const [runRow] = await db
    .select({
      id: actionItemRuns.id,
      action_item_id: actionItemRuns.actionItemId,
      workspace_id: actionItemRuns.workspaceId,
      project_id: actionItemRuns.projectId,
      status: actionItemRuns.status,
    })
    .from(actionItemRuns)
    .innerJoin(actionItems, eq(actionItemRuns.actionItemId, actionItems.id))
    .innerJoin(projects, eq(actionItems.projectId, projects.id))
    .where(and(eq(actionItemRuns.id, runId), eq(projects.ownerUserId, user.id)))
    .limit(1);

  if (!runRow) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Run not found' } }, 404);
  }

  if (runRow.status !== 'ready') {
    return c.json({ error: { code: 'INVALID_STATE', message: 'Run is not ready to apply' } }, 400);
  }

  const [conversation] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.workspaceId, runRow.workspace_id))
    .orderBy(desc(conversations.updatedAt))
    .limit(1);

  if (!conversation) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'No conversation found for workspace' } }, 404);
  }

  const doId = c.env.ConversationSession.idFromName(conversation.id);
  const stub = c.env.ConversationSession.get(doId);
  const baseUrl = new URL(c.req.url);
  const apiUrl = `${baseUrl.origin}/v1`;
  await stub.fetch(new Request('http://do/action-item-runs/apply', {
    method: 'POST',
    body: JSON.stringify({
      runId,
      conversationId: conversation.id,
      workspaceId: runRow.workspace_id,
      projectId: runRow.project_id,
      apiUrl,
      apiToken: c.req.header('Authorization')?.replace('Bearer ', '') || '',
    }),
  }));

  return c.json({ success: true });
});
