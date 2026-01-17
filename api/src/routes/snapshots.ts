import { Hono } from 'hono';
import type { Env } from '../index';
import type { Snapshot } from '@fastest/shared';
import { getAuthUser } from '../middleware/auth';

export const snapshotRoutes = new Hono<{ Bindings: Env }>();

// Get snapshot by ID
snapshotRoutes.get('/:snapshotId', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const snapshotId = c.req.param('snapshotId');
  const db = c.env.DB;

  // Get snapshot and verify ownership through project
  const snapshot = await db.prepare(`
    SELECT s.id, s.project_id, s.manifest_hash, s.parent_snapshot_id, s.source, s.created_at,
           p.owner_user_id
    FROM snapshots s
    JOIN projects p ON s.project_id = p.id
    WHERE s.id = ?
  `).bind(snapshotId).first<Snapshot & { owner_user_id: string }>();

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
      parent_snapshot_id: snapshot.parent_snapshot_id,
      source: snapshot.source,
      created_at: snapshot.created_at,
    }
  });
});
