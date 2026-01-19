/**
 * Conversation API routes
 *
 * Conversations are chat sessions that belong to a workspace.
 * Multiple conversations can exist per workspace.
 */

import { Hono } from 'hono';
import type { Env } from '../index';
import { authMiddleware, getAuthUser } from '../middleware/auth';
import type { Conversation, ConversationWithContext } from '@fastest/shared';

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

  const db = c.env.DB;

  // Verify workspace exists and user has access
  const workspace = await db
    .prepare(`
      SELECT w.*, p.owner_user_id
      FROM workspaces w
      JOIN projects p ON w.project_id = p.id
      WHERE w.id = ?
    `)
    .bind(workspace_id)
    .first<{ id: string; project_id: string; owner_user_id: string }>();

  if (!workspace) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } }, 404);
  }

  if (workspace.owner_user_id !== user.id) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
  }

  // Create conversation in database
  const conversationId = crypto.randomUUID();
  const now = new Date().toISOString();

  await db
    .prepare(`
      INSERT INTO conversations (id, workspace_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .bind(conversationId, workspace_id, title || null, now, now)
    .run();

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
 * Update conversation title
 * PATCH /v1/conversations/:conversationId
 */
conversationRoutes.patch('/:conversationId', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const { conversationId } = c.req.param();
  const { title } = await c.req.json<{ title: string }>();

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

  const now = new Date().toISOString();
  await db
    .prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
    .bind(title, now, conversationId)
    .run();

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
 * WebSocket endpoint for streaming
 * GET /v1/conversations/:conversationId/stream
 */
conversationRoutes.get('/:conversationId/stream', async (c) => {
  const { conversationId } = c.req.param();

  // Check for WebSocket upgrade
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.json({ error: { code: 'UPGRADE_REQUIRED', message: 'WebSocket upgrade required' } }, 426);
  }

  // Note: WebSocket auth is handled via token query param
  // The token is validated by the DO or we could validate here

  const doId = getConversationDOId(c.env, conversationId);
  const stub = c.env.ConversationSession.get(doId);

  // Forward the WebSocket upgrade to the DO
  return stub.fetch(c.req.raw);
});
