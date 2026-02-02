/**
 * Conversation API routes
 *
 * Conversations are chat sessions that belong to a workspace.
 * Multiple conversations can exist per workspace.
 */

import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import type { Env } from '../index';
import { authMiddleware, getAuthUser } from '../middleware/auth';
import { createDb, conversations, workspaces, projects, snapshots, deployments } from '../db';
import type { Conversation, ConversationWithContext } from '@fastest/shared';

// Helper: Generate ULID
function generateULID(): string {
  const timestamp = Date.now().toString(36).padStart(10, '0');
  const random = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 36).toString(36)
  ).join('');
  return (timestamp + random).toUpperCase();
}

function generateSnapshotID(): string {
  return `snap-${generateULID()}`;
}

export const conversationRoutes = new Hono<{ Bindings: Env }>();

// All routes require authentication
conversationRoutes.use('*', authMiddleware);

/**
 * Get Durable Object ID for a conversation
 */
function getConversationDOId(env: Env, conversationId: string): DurableObjectId {
  return env.ConversationSession.idFromName(`conversation:${conversationId}`);
}

/**
 * Create a new conversation
 * POST /v1/conversations
 */
conversationRoutes.post('/', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const { workspace_id, title } = await c.req.json<{ workspace_id: string; title?: string }>();

  if (!workspace_id) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'workspace_id is required' } }, 400);
  }

  const db = createDb(c.env.DB);

  // Verify workspace exists and user has access
  const workspaceResult = await db
    .select({
      id: workspaces.id,
      project_id: workspaces.projectId,
      owner_user_id: projects.ownerUserId,
      current_manifest_hash: workspaces.currentManifestHash,
    })
    .from(workspaces)
    .innerJoin(projects, eq(workspaces.projectId, projects.id))
    .where(eq(workspaces.id, workspace_id))
    .limit(1);
  const workspace = workspaceResult[0];

  if (!workspace) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } }, 404);
  }

  if (workspace.owner_user_id !== user.id) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
  }

  // Create conversation in database
  const conversationId = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.insert(conversations).values({
    id: conversationId,
    workspaceId: workspace_id,
    title: title || null,
    createdAt: now,
    updatedAt: now,
  });

  let initialManifestHash: string | undefined = workspace.current_manifest_hash || undefined;
  if (!initialManifestHash) {
    const snapshotResult = await db
      .select({ manifest_hash: snapshots.manifestHash })
      .from(snapshots)
      .where(eq(snapshots.workspaceId, workspace_id))
      .orderBy(desc(snapshots.createdAt))
      .limit(1);
    initialManifestHash = snapshotResult[0]?.manifest_hash;
  }

  if (initialManifestHash && !workspace.current_manifest_hash) {
    await db
      .update(workspaces)
      .set({ currentManifestHash: initialManifestHash })
      .where(eq(workspaces.id, workspace_id));
  }

  // Initialize the Durable Object
  const doId = getConversationDOId(c.env, conversationId);
  const stub = c.env.ConversationSession.get(doId);

  await stub.fetch(new Request('http://do/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId,
      workspaceId: workspace_id,
      projectId: workspace.project_id,
      initialManifestHash,
    }),
  }));

  const conversation: Conversation = {
    id: conversationId,
    workspace_id,
    title: title || null,
    created_at: now,
    updated_at: now,
  };

  return c.json({ conversation });
});

/**
 * List conversations for the current user
 * GET /v1/conversations
 */
conversationRoutes.get('/', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const limit = parseInt(c.req.query('limit') || '20');
  const offset = parseInt(c.req.query('offset') || '0');

  const db = c.env.DB;

  const results = await db
    .prepare(`
      SELECT
        c.id,
        c.workspace_id,
        c.title,
        c.created_at,
        c.updated_at,
        w.name as workspace_name,
        p.id as project_id,
        p.name as project_name
      FROM conversations c
      JOIN workspaces w ON c.workspace_id = w.id
      JOIN projects p ON w.project_id = p.id
      WHERE p.owner_user_id = ?
      ORDER BY c.updated_at DESC
      LIMIT ? OFFSET ?
    `)
    .bind(user.id, limit, offset)
    .all<ConversationWithContext>();

  return c.json({ conversations: results.results || [] });
});

/**
 * Get a single conversation
 * GET /v1/conversations/:conversationId
 */
conversationRoutes.get('/:conversationId', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const { conversationId } = c.req.param();
  const db = c.env.DB;

  const conversation = await db
    .prepare(`
      SELECT
        c.id,
        c.workspace_id,
        c.title,
        c.created_at,
        c.updated_at,
        w.name as workspace_name,
        p.id as project_id,
        p.name as project_name
      FROM conversations c
      JOIN workspaces w ON c.workspace_id = w.id
      JOIN projects p ON w.project_id = p.id
      WHERE c.id = ? AND p.owner_user_id = ?
    `)
    .bind(conversationId, user.id)
    .first<ConversationWithContext>();

  if (!conversation) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } }, 404);
  }

  return c.json({ conversation });
});

/**
 * Update conversation (title or workspace)
 * PATCH /v1/conversations/:conversationId
 */
conversationRoutes.patch('/:conversationId', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const { conversationId } = c.req.param();
  const body = await c.req.json<{ title?: string; workspace_id?: string }>();

  const db = c.env.DB;

  // Verify ownership of conversation
  const existing = await db
    .prepare(`
      SELECT c.id, c.workspace_id, w.project_id
      FROM conversations c
      JOIN workspaces w ON c.workspace_id = w.id
      JOIN projects p ON w.project_id = p.id
      WHERE c.id = ? AND p.owner_user_id = ?
    `)
    .bind(conversationId, user.id)
    .first<{ id: string; workspace_id: string; project_id: string }>();

  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } }, 404);
  }

  const now = new Date().toISOString();

  // If moving to a new workspace, verify it's in the same project and user owns it
  if (body.workspace_id && body.workspace_id !== existing.workspace_id) {
    const targetWorkspace = await db
      .prepare(`
        SELECT w.id, w.project_id
        FROM workspaces w
        JOIN projects p ON w.project_id = p.id
        WHERE w.id = ? AND p.owner_user_id = ?
      `)
      .bind(body.workspace_id, user.id)
      .first<{ id: string; project_id: string }>();

    if (!targetWorkspace) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Target workspace not found' } }, 404);
    }

    if (targetWorkspace.project_id !== existing.project_id) {
      return c.json({ error: { code: 'INVALID_INPUT', message: 'Cannot move conversation to a workspace in a different project' } }, 400);
    }

    await db
      .prepare('UPDATE conversations SET workspace_id = ?, updated_at = ? WHERE id = ?')
      .bind(body.workspace_id, now, conversationId)
      .run();
  }

  // Update title if provided
  if (body.title !== undefined) {
    await db
      .prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
      .bind(body.title, now, conversationId)
      .run();
  }

  return c.json({ success: true });
});

/**
 * Get messages for a conversation
 * GET /v1/conversations/:conversationId/messages
 */
conversationRoutes.get('/:conversationId/messages', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const { conversationId } = c.req.param();
  const limit = c.req.query('limit');
  const before = c.req.query('before');

  const db = c.env.DB;

  // Verify ownership
  const existing = await db
    .prepare(`
      SELECT c.id
      FROM conversations c
      JOIN workspaces w ON c.workspace_id = w.id
      JOIN projects p ON w.project_id = p.id
      WHERE c.id = ? AND p.owner_user_id = ?
    `)
    .bind(conversationId, user.id)
    .first();

  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } }, 404);
  }

  const doId = getConversationDOId(c.env, conversationId);
  const stub = c.env.ConversationSession.get(doId);

  const url = new URL('http://do/messages');
  if (limit) url.searchParams.set('limit', limit);
  if (before) url.searchParams.set('before', before);

  const response = await stub.fetch(new Request(url));
  const data = await response.json();

  return c.json(data);
});

// Get persisted OpenCode message parts (mapped to conversation message IDs)
conversationRoutes.get('/:conversationId/opencode-messages', async (c) => {
  const { conversationId } = c.req.param();
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const db = createDb(c.env.DB);
  const result = await db
    .select({ id: conversations.id })
    .from(conversations)
    .innerJoin(workspaces, eq(conversations.workspaceId, workspaces.id))
    .innerJoin(projects, eq(workspaces.projectId, projects.id))
    .where(and(
      eq(conversations.id, conversationId),
      eq(projects.ownerUserId, user.id)
    ))
    .limit(1);

  if (result.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } }, 404);
  }

  const doId = getConversationDOId(c.env, conversationId);
  const stub = c.env.ConversationSession.get(doId);

  const response = await stub.fetch(new Request('http://do/opencode-messages'));
  const data = await response.json();

  if (!response.ok) {
    return c.json(data, response.status as 404);
  }

  return c.json(data);
});

/**
 * Send a message to the conversation
 * POST /v1/conversations/:conversationId/messages
 */
conversationRoutes.post('/:conversationId/messages', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const { conversationId } = c.req.param();
  const { prompt } = await c.req.json<{ prompt: string }>();

  if (!prompt?.trim()) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'Prompt is required' } }, 400);
  }

  const db = c.env.DB;

  // Verify ownership and get workspace info
  const conversation = await db
    .prepare(`
      SELECT c.id, c.workspace_id, c.title, w.project_id
      FROM conversations c
      JOIN workspaces w ON c.workspace_id = w.id
      JOIN projects p ON w.project_id = p.id
      WHERE c.id = ? AND p.owner_user_id = ?
    `)
    .bind(conversationId, user.id)
    .first<{ id: string; workspace_id: string; title: string | null; project_id: string }>();

  if (!conversation) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } }, 404);
  }

  // Auto-generate title from first message if not set
  if (!conversation.title) {
    const title = prompt.slice(0, 100) + (prompt.length > 100 ? '...' : '');
    await db
      .prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
      .bind(title, new Date().toISOString(), conversationId)
      .run();
  } else {
    // Update the updated_at timestamp
    await db
      .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), conversationId)
      .run();
  }

  const doId = getConversationDOId(c.env, conversationId);
  const stub = c.env.ConversationSession.get(doId);

  // Get API URL and token for the sandbox to call back
  const apiUrl = new URL(c.req.url).origin;
  const apiToken = c.req.header('Authorization')?.replace('Bearer ', '') || '';

  const response = await stub.fetch(new Request('http://do/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, apiUrl, apiToken }),
  }));

  const data = await response.json();
  return c.json(data);
});

/**
 * Reply to an OpenCode question request
 * POST /v1/conversations/:conversationId/opencode-questions/:requestId/reply
 */
conversationRoutes.post('/:conversationId/opencode-questions/:requestId/reply', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const { conversationId, requestId } = c.req.param();
  const { answers } = await c.req.json<{ answers: string[][] }>();

  const db = createDb(c.env.DB);
  const result = await db
    .select({ id: conversations.id })
    .from(conversations)
    .innerJoin(workspaces, eq(conversations.workspaceId, workspaces.id))
    .innerJoin(projects, eq(workspaces.projectId, projects.id))
    .where(and(
      eq(conversations.id, conversationId),
      eq(projects.ownerUserId, user.id)
    ))
    .limit(1);

  if (result.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } }, 404);
  }

  const doId = getConversationDOId(c.env, conversationId);
  const stub = c.env.ConversationSession.get(doId);

  const apiUrl = new URL(c.req.url).origin;
  const apiToken = c.req.header('Authorization')?.replace('Bearer ', '') || '';

  const response = await stub.fetch(new Request('http://do/opencode-question/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, answers, apiUrl, apiToken }),
  }));

  const data = await response.json();
  if (!response.ok) {
    return c.json(data, response.status as 400);
  }

  return c.json({ success: true });
});

/**
 * Reject an OpenCode question request
 * POST /v1/conversations/:conversationId/opencode-questions/:requestId/reject
 */
conversationRoutes.post('/:conversationId/opencode-questions/:requestId/reject', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const { conversationId, requestId } = c.req.param();

  const db = createDb(c.env.DB);
  const result = await db
    .select({ id: conversations.id })
    .from(conversations)
    .innerJoin(workspaces, eq(conversations.workspaceId, workspaces.id))
    .innerJoin(projects, eq(workspaces.projectId, projects.id))
    .where(and(
      eq(conversations.id, conversationId),
      eq(projects.ownerUserId, user.id)
    ))
    .limit(1);

  if (result.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } }, 404);
  }

  const doId = getConversationDOId(c.env, conversationId);
  const stub = c.env.ConversationSession.get(doId);

  const apiUrl = new URL(c.req.url).origin;
  const apiToken = c.req.header('Authorization')?.replace('Bearer ', '') || '';

  const response = await stub.fetch(new Request('http://do/opencode-question/reject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, apiUrl, apiToken }),
  }));

  const data = await response.json();
  if (!response.ok) {
    return c.json(data, response.status as 400);
  }

  return c.json({ success: true });
});

/**
 * Clear conversation messages
 * POST /v1/conversations/:conversationId/clear
 */
conversationRoutes.post('/:conversationId/clear', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const { conversationId } = c.req.param();
  const db = c.env.DB;

  // Verify ownership
  const existing = await db
    .prepare(`
      SELECT c.id
      FROM conversations c
      JOIN workspaces w ON c.workspace_id = w.id
      JOIN projects p ON w.project_id = p.id
      WHERE c.id = ? AND p.owner_user_id = ?
    `)
    .bind(conversationId, user.id)
    .first();

  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } }, 404);
  }

  const doId = getConversationDOId(c.env, conversationId);
  const stub = c.env.ConversationSession.get(doId);

  const response = await stub.fetch(new Request('http://do/clear', { method: 'POST' }));
  const data = await response.json();

  return c.json(data);
});

/**
 * Get timeline for a conversation
 * GET /v1/conversations/:conversationId/timeline
 */
conversationRoutes.get('/:conversationId/timeline', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const { conversationId } = c.req.param();
  const db = c.env.DB;

  // Verify ownership
  const existing = await db
    .prepare(`
      SELECT c.id
      FROM conversations c
      JOIN workspaces w ON c.workspace_id = w.id
      JOIN projects p ON w.project_id = p.id
      WHERE c.id = ? AND p.owner_user_id = ?
    `)
    .bind(conversationId, user.id)
    .first();

  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } }, 404);
  }

  const doId = getConversationDOId(c.env, conversationId);
  const stub = c.env.ConversationSession.get(doId);

  const response = await stub.fetch(new Request('http://do/timeline'));
  const data = await response.json();

  return c.json(data);
});

/**
 * Get project info for a conversation
 * GET /v1/conversations/:conversationId/project-info
 */
conversationRoutes.get('/:conversationId/project-info', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const { conversationId } = c.req.param();
  const db = c.env.DB;

  // Verify ownership
  const existing = await db
    .prepare(`
      SELECT c.id
      FROM conversations c
      JOIN workspaces w ON c.workspace_id = w.id
      JOIN projects p ON w.project_id = p.id
      WHERE c.id = ? AND p.owner_user_id = ?
    `)
    .bind(conversationId, user.id)
    .first();

  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } }, 404);
  }

  const doId = getConversationDOId(c.env, conversationId);
  const stub = c.env.ConversationSession.get(doId);

  // Get API URL and token for the sandbox
  const apiUrl = new URL(c.req.url).origin;
  const apiToken = c.req.header('Authorization')?.replace('Bearer ', '') || '';

  const url = new URL('http://do/project-info');
  url.searchParams.set('apiUrl', apiUrl);
  url.searchParams.set('apiToken', apiToken);

  const response = await stub.fetch(new Request(url));
  const data = await response.json();

  return c.json(data);
});

/**
 * Get deployments for a conversation
 * GET /v1/conversations/:conversationId/deployments
 */
conversationRoutes.get('/:conversationId/deployments', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const { conversationId } = c.req.param();
  const db = c.env.DB;

  // Verify ownership
  const existing = await db
    .prepare(`
      SELECT c.id
      FROM conversations c
      JOIN workspaces w ON c.workspace_id = w.id
      JOIN projects p ON w.project_id = p.id
      WHERE c.id = ? AND p.owner_user_id = ?
    `)
    .bind(conversationId, user.id)
    .first();

  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } }, 404);
  }

  const doId = getConversationDOId(c.env, conversationId);
  const stub = c.env.ConversationSession.get(doId);

  const response = await stub.fetch(new Request('http://do/deployments'));
  const data = await response.json();

  return c.json(data);
});

/**
 * Deploy the project
 * POST /v1/conversations/:conversationId/deploy
 */
conversationRoutes.post('/:conversationId/deploy', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const { conversationId } = c.req.param();
  const db = createDb(c.env.DB);

  const existing = await db
    .select({
      id: conversations.id,
      workspaceId: conversations.workspaceId,
      projectId: workspaces.projectId,
    })
    .from(conversations)
    .innerJoin(workspaces, eq(conversations.workspaceId, workspaces.id))
    .innerJoin(projects, eq(workspaces.projectId, projects.id))
    .where(and(eq(conversations.id, conversationId), eq(projects.ownerUserId, user.id)))
    .limit(1);

  if (!existing[0]) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } }, 404);
  }

  const deploymentId = generateULID();
  const now = new Date().toISOString();

  await db.insert(deployments).values({
    id: deploymentId,
    workspaceId: existing[0].workspaceId,
    projectId: existing[0].projectId,
    snapshotId: null,
    status: 'deploying',
    trigger: 'chat',
    url: null,
    error: null,
    startedAt: now,
    completedAt: null,
  });

  const doId = getConversationDOId(c.env, conversationId);
  const stub = c.env.ConversationSession.get(doId);

  // Get API URL and token for the sandbox to call back
  const apiUrl = new URL(c.req.url).origin;
  const apiToken = c.req.header('Authorization')?.replace('Bearer ', '') || '';

  const response = await stub.fetch(new Request('http://do/deploy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiUrl, apiToken, deploymentId }),
  }));

  const data = await response.json();
  return c.json(data);
});

/**
 * Get deployment logs
 * GET /v1/conversations/:conversationId/deployments/:deploymentId/logs
 */
conversationRoutes.get('/:conversationId/deployments/:deploymentId/logs', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const { conversationId, deploymentId } = c.req.param();
  const db = c.env.DB;

  // Verify ownership
  const existing = await db
    .prepare(`
      SELECT c.id
      FROM conversations c
      JOIN workspaces w ON c.workspace_id = w.id
      JOIN projects p ON w.project_id = p.id
      WHERE c.id = ? AND p.owner_user_id = ?
    `)
    .bind(conversationId, user.id)
    .first();

  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } }, 404);
  }

  const doId = getConversationDOId(c.env, conversationId);
  const stub = c.env.ConversationSession.get(doId);

  const response = await stub.fetch(new Request(`http://do/deployments/${deploymentId}/logs`));
  const data = await response.json();

  if (!response.ok) {
    return c.json(data, response.status as 404);
  }

  return c.json(data);
});

/**
 * WebSocket endpoint for streaming
 * GET /v1/conversations/:conversationId/stream
 * Auth is handled via token query param since WebSocket can't send custom headers
 */
conversationRoutes.get('/:conversationId/stream', async (c) => {
  const { conversationId } = c.req.param();

  // Check for WebSocket upgrade
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.json({ error: { code: 'UPGRADE_REQUIRED', message: 'WebSocket upgrade required' } }, 426);
  }

  // Auth is handled by the middleware (which now checks query param token)
  // Verify user has access to this conversation
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  // Verify conversation exists and user has access
  const db = createDb(c.env.DB);
  const result = await db
    .select({ id: conversations.id })
    .from(conversations)
    .innerJoin(workspaces, eq(conversations.workspaceId, workspaces.id))
    .innerJoin(projects, eq(workspaces.projectId, projects.id))
    .where(and(
      eq(conversations.id, conversationId),
      eq(projects.ownerUserId, user.id)
    ))
    .limit(1);

  if (result.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } }, 404);
  }

  const doId = getConversationDOId(c.env, conversationId);
  const stub = c.env.ConversationSession.get(doId);

  // Forward the WebSocket upgrade to the DO
  return stub.fetch(c.req.raw);
});

/**
 * Create a snapshot from the conversation's current file state
 * POST /v1/conversations/:conversationId/snapshot
 *
 * Options:
 * - generate_summary: boolean - Generate an LLM summary of changes
 *
 * Used for:
 * - Branching: capture dirty files before creating new workspace
 * - Save snapshot: explicitly checkpoint work with a summary
 *
 * Note: This does NOT update the workspace's current_snapshot_id or fork_snapshot_id.
 * fork_snapshot_id represents the origin snapshot the workspace was created from.
 */
conversationRoutes.post('/:conversationId/snapshot', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const { conversationId } = c.req.param();
  const body = await c.req.json<{
    generate_summary?: boolean;
  }>().catch(() => ({} as { generate_summary?: boolean }));

  const generate_summary = body.generate_summary ?? false;
  const db = createDb(c.env.DB);

  // Verify ownership and get workspace/project info
  const result = await db
    .select({
      id: conversations.id,
      workspace_id: conversations.workspaceId,
      project_id: workspaces.projectId,
      fork_snapshot_id: workspaces.forkSnapshotId,
      current_snapshot_id: workspaces.currentSnapshotId,
    })
    .from(conversations)
    .innerJoin(workspaces, eq(conversations.workspaceId, workspaces.id))
    .innerJoin(projects, eq(workspaces.projectId, projects.id))
    .where(and(
      eq(conversations.id, conversationId),
      eq(projects.ownerUserId, user.id)
    ))
    .limit(1);

  if (result.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } }, 404);
  }

  const conversation = result[0];

  // Get the conversation's current manifest hash and recent messages from the Durable Object
  const doId = getConversationDOId(c.env, conversationId);
  const stub = c.env.ConversationSession.get(doId);

  const stateResponse = await stub.fetch(new Request('http://do/state'));
  if (!stateResponse.ok) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get conversation state' } }, 500);
  }

  const { state } = await stateResponse.json() as {
    state: {
      lastManifestHash?: string;
      messages?: Array<{ role: string; content: string }>;
    };
  };
  const currentManifestHash = state?.lastManifestHash;

  if (!currentManifestHash) {
    // No files have been modified yet, just return the existing snapshot
    return c.json({
      snapshot_id: conversation.fork_snapshot_id,
      manifest_hash: null,
      was_dirty: false,
      summary: null,
    });
  }

  // Check if the manifest is different from the workspace's current snapshot
  let existingManifestHash: string | null = null;
  if (conversation.fork_snapshot_id) {
    const snapshotResult = await db
      .select({ manifest_hash: snapshots.manifestHash })
      .from(snapshots)
      .where(eq(snapshots.id, conversation.fork_snapshot_id))
      .limit(1);
    existingManifestHash = snapshotResult[0]?.manifest_hash ?? null;
  }

  // If the manifest hasn't changed, return the existing snapshot
  if (currentManifestHash === existingManifestHash) {
    return c.json({
      snapshot_id: conversation.fork_snapshot_id,
      manifest_hash: currentManifestHash,
      was_dirty: false,
      summary: null,
    });
  }

  // Calculate file changes for summary generation
  let fileChanges: { added: string[]; modified: string[]; deleted: string[] } = {
    added: [],
    modified: [],
    deleted: [],
  };
  let summary: string | null = null;

  if (generate_summary) {
    // Fetch current and previous manifests to compute diff
    const currentManifestKey = `${user.id}/manifests/${currentManifestHash}.json`;
    const currentManifestObj = await c.env.BLOBS.get(currentManifestKey);

    let currentFiles: Map<string, string> = new Map();
    let previousFiles: Map<string, string> = new Map();

    if (currentManifestObj) {
      try {
        const manifest = JSON.parse(await currentManifestObj.text()) as {
          files: Array<{ path: string; hash: string }>;
        };
        for (const f of manifest.files) {
          currentFiles.set(f.path, f.hash);
        }
      } catch {
        // Ignore parse errors
      }
    }

    if (existingManifestHash) {
      const prevManifestKey = `${user.id}/manifests/${existingManifestHash}.json`;
      const prevManifestObj = await c.env.BLOBS.get(prevManifestKey);
      if (prevManifestObj) {
        try {
          const manifest = JSON.parse(await prevManifestObj.text()) as {
            files: Array<{ path: string; hash: string }>;
          };
          for (const f of manifest.files) {
            previousFiles.set(f.path, f.hash);
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    // Compute file changes
    for (const [path, hash] of currentFiles) {
      const prevHash = previousFiles.get(path);
      if (!prevHash) {
        fileChanges.added.push(path);
      } else if (prevHash !== hash) {
        fileChanges.modified.push(path);
      }
    }
    for (const path of previousFiles.keys()) {
      if (!currentFiles.has(path)) {
        fileChanges.deleted.push(path);
      }
    }

    // Get recent conversation messages for context
    const recentMessages = (state.messages || [])
      .slice(-6)
      .map(m => `${m.role}: ${m.content.slice(0, 200)}${m.content.length > 200 ? '...' : ''}`)
      .join('\n');

    // Generate summary using AI
    const totalChanges = fileChanges.added.length + fileChanges.modified.length + fileChanges.deleted.length;
    if (totalChanges > 0) {
      const prompt = `You are summarizing changes made to a codebase. Based on the file changes and conversation context, write a brief 1-2 sentence summary of what was accomplished. Use past tense and be specific.

File changes:
${fileChanges.added.length > 0 ? `Added: ${fileChanges.added.slice(0, 10).join(', ')}${fileChanges.added.length > 10 ? ` (+${fileChanges.added.length - 10} more)` : ''}` : ''}
${fileChanges.modified.length > 0 ? `Modified: ${fileChanges.modified.slice(0, 10).join(', ')}${fileChanges.modified.length > 10 ? ` (+${fileChanges.modified.length - 10} more)` : ''}` : ''}
${fileChanges.deleted.length > 0 ? `Deleted: ${fileChanges.deleted.slice(0, 10).join(', ')}${fileChanges.deleted.length > 10 ? ` (+${fileChanges.deleted.length - 10} more)` : ''}` : ''}

Recent conversation:
${recentMessages || 'No conversation context available.'}

Write a brief summary (1-2 sentences):`;

      try {
        const response = await (c.env.AI as Ai).run(
          '@cf/meta/llama-3.1-8b-instruct-fast' as Parameters<Ai['run']>[0],
          {
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 100,
          }
        ) as { response?: string };

        summary = response.response?.trim() || null;
      } catch (err) {
        console.error('Failed to generate snapshot summary:', err);
        // Fallback to a simple summary
        summary = `${totalChanges} file${totalChanges !== 1 ? 's' : ''} changed: ${fileChanges.added.length} added, ${fileChanges.modified.length} modified, ${fileChanges.deleted.length} deleted`;
      }
    }
  }

  // Create a new snapshot with the current manifest
  const snapshotId = generateSnapshotID();
  const now = new Date().toISOString();

  await db.insert(snapshots).values({
    id: snapshotId,
    projectId: conversation.project_id,
    workspaceId: conversation.workspace_id,
    manifestHash: currentManifestHash,
    parentSnapshotIds: JSON.stringify(conversation.fork_snapshot_id ? [conversation.fork_snapshot_id] : []),
    source: 'web',
    summary,
    createdAt: now,
  });

  // Trigger Atlas re-index in background
  const apiUrl = new URL(c.req.url).origin;
  const apiToken = c.req.header('Authorization')?.replace('Bearer ', '') || '';
  if (apiToken) {
    c.executionCtx.waitUntil(
      fetch(`${apiUrl}/v1/projects/${conversation.project_id}/atlas/index`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify({}),
      })
    );
  }

  return c.json({
    snapshot_id: snapshotId,
    manifest_hash: currentManifestHash,
    was_dirty: true,
    summary,
    file_changes: generate_summary ? {
      added: fileChanges.added.length,
      modified: fileChanges.modified.length,
      deleted: fileChanges.deleted.length,
    } : null,
  });
});
