import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Env } from '../index';
import type { Snapshot } from '@fastest/shared';
import { getAuthUser } from '../middleware/auth';
import { createDb, snapshots, projects } from '../db';

export const snapshotRoutes = new Hono<{ Bindings: Env }>();

// Get snapshot by ID
snapshotRoutes.get('/:snapshotId', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const snapshotId = c.req.param('snapshotId');
  const db = createDb(c.env.DB);

  // Get snapshot and verify ownership through project
  const result = await db
    .select({
      id: snapshots.id,
      project_id: snapshots.projectId,
      manifest_hash: snapshots.manifestHash,
      parent_snapshot_ids: snapshots.parentSnapshotIds,
      source: snapshots.source,
      created_at: snapshots.createdAt,
      owner_user_id: projects.ownerUserId,
    })
    .from(snapshots)
    .innerJoin(projects, eq(snapshots.projectId, projects.id))
    .where(eq(snapshots.id, snapshotId))
    .limit(1);

  const snapshot = result[0];

  if (!snapshot) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Snapshot not found' } }, 404);
  }

  if (snapshot.owner_user_id !== user.id) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
  }

  return c.json({
    snapshot: {
      id: snapshot.id,
      project_id: snapshot.project_id,
      manifest_hash: snapshot.manifest_hash,
      parent_snapshot_ids: JSON.parse(snapshot.parent_snapshot_ids || '[]'),
      source: snapshot.source,
      created_at: snapshot.created_at,
    }
  });
});
