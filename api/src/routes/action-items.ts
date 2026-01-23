import { Hono } from 'hono';
import { eq, and, desc, ne, isNotNull, sql } from 'drizzle-orm';
import type { Env } from '../index';
import type { ActionItem } from '@fastest/shared';
import { getAuthUser } from '../middleware/auth';
import { createDb, workspaces, projects, driftReports, refactoringSuggestions } from '../db';

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

  // Query pending refactoring suggestions
  const refactoringResults = await db
    .select({
      id: refactoringSuggestions.id,
      workspace_id: refactoringSuggestions.workspaceId,
      type: refactoringSuggestions.type,
      severity: refactoringSuggestions.severity,
      title: refactoringSuggestions.title,
      description: refactoringSuggestions.description,
      affected_files: refactoringSuggestions.affectedFiles,
      suggested_prompt: refactoringSuggestions.suggestedPrompt,
      created_at: refactoringSuggestions.createdAt,
      workspace_name: workspaces.name,
      project_id: workspaces.projectId,
      project_name: projects.name,
    })
    .from(refactoringSuggestions)
    .innerJoin(workspaces, eq(refactoringSuggestions.workspaceId, workspaces.id))
    .innerJoin(projects, eq(workspaces.projectId, projects.id))
    .where(
      and(
        eq(projects.ownerUserId, user.id),
        eq(refactoringSuggestions.status, 'pending')
      )
    )
    .orderBy(desc(refactoringSuggestions.createdAt))
    .limit(20); // Limit to avoid overwhelming the UI

  // Map refactoring type to action item type
  const typeMapping: Record<string, ActionItem['type']> = {
    security: 'security',
    duplication: 'refactoring',
    performance: 'refactoring',
    naming: 'refactoring',
    structure: 'refactoring',
  };

  // Map refactoring type to icons
  const iconMapping: Record<string, string> = {
    security: 'shield',
    duplication: 'copy',
    performance: 'zap',
    naming: 'tag',
    structure: 'layers',
  };

  for (const row of refactoringResults) {
    const actionType = typeMapping[row.type] || 'refactoring';
    const icon = iconMapping[row.type] || 'lightbulb';

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
      action_label: 'Fix',
      action_type: 'prompt',
      action_data: {
        suggested_prompt: row.suggested_prompt,
        affected_files: row.affected_files ? JSON.parse(row.affected_files) : [],
        suggestion_type: row.type,
      },
      created_at: row.created_at,
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

  // Check if it's a drift item (starts with "drift-") or a refactoring suggestion
  if (itemId.startsWith('drift-')) {
    // Drift items don't have persistent dismiss state yet
    // Could add a dismissed_drift_reports table in the future
    return c.json({ success: true });
  }

  // Mark refactoring suggestion as dismissed
  await db
    .update(refactoringSuggestions)
    .set({ status: 'dismissed' })
    .where(eq(refactoringSuggestions.id, itemId));

  return c.json({ success: true });
});
