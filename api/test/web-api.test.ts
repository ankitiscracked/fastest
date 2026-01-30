import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../src/index.vitest';
import { hashToken } from '../src/middleware/auth';
import schemaSql from '../src/db/schema.sql?raw';

const ctx = {
  waitUntil(promise: Promise<unknown>) {
    return promise;
  },
  passThroughOnException() {},
} as ExecutionContext;

async function applySchema() {
  const cleaned = schemaSql
    .split('\n')
    .map((line) => line.replace(/--.*$/, '').trim())
    .filter(Boolean)
    .join('\n');

  const statements = cleaned
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
}

async function clearTables() {
  const statements = [
    'DELETE FROM sessions',
    'DELETE FROM conversations',
    'DELETE FROM workspaces',
    'DELETE FROM projects',
    'DELETE FROM users',
  ];
  for (const sql of statements) {
    await env.DB.prepare(sql).run();
  }
}

async function seedUserSession(userId: string, email: string, token: string) {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  await env.DB.prepare(
    'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)'
  ).bind(userId, email, now).run();

  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(crypto.randomUUID(), userId, hashToken(token), expiresAt, now)
    .run();
}

async function seedUser(userId: string, email: string) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)'
  ).bind(userId, email, now).run();
}

async function seedProject(projectId: string, ownerUserId: string, name: string) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(projectId, ownerUserId, name, now, now)
    .run();
}

async function seedWorkspace(workspaceId: string, projectId: string, name: string) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO workspaces (id, project_id, name, created_at) VALUES (?, ?, ?, ?)'
  )
    .bind(workspaceId, projectId, name, now)
    .run();
}

async function seedConversation(conversationId: string, workspaceId: string, title: string) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO conversations (id, workspace_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(conversationId, workspaceId, title, now, now)
    .run();
}

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe('web api: primary paths', () => {
  beforeAll(async () => {
    await applySchema();
  });

  beforeEach(async () => {
    await clearTables();
  });

  it('GET /v1/projects returns only projects owned by the user', async () => {
    const token = 'token-user-1';
    await seedUserSession('user-1', 'user1@example.com', token);
    await seedProject('project-1', 'user-1', 'User Project');
    await seedUser('user-2', 'user2@example.com');
    await seedProject('project-2', 'user-2', 'Other Project');

    const res = await worker.fetch(
      new Request('http://localhost/v1/projects', {
        headers: authHeader(token),
      }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ projects: Array<{ id: string }> }>();
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0].id).toBe('project-1');
  });

  it('GET /v1/projects requires authentication', async () => {
    const res = await worker.fetch(
      new Request('http://localhost/v1/projects'),
      env,
      ctx
    );

    expect(res.status).toBe(401);
  });

  it('GET /v1/conversations returns only conversations in user-owned projects', async () => {
    const token = 'token-user-1';
    await seedUserSession('user-1', 'user1@example.com', token);

    await seedProject('project-1', 'user-1', 'User Project');
    await seedWorkspace('workspace-1', 'project-1', 'User Workspace');
    await seedConversation('conversation-1', 'workspace-1', 'User Conversation');

    await seedUser('user-2', 'user2@example.com');
    await seedProject('project-2', 'user-2', 'Other Project');
    await seedWorkspace('workspace-2', 'project-2', 'Other Workspace');
    await seedConversation('conversation-2', 'workspace-2', 'Other Conversation');

    const res = await worker.fetch(
      new Request('http://localhost/v1/conversations', {
        headers: authHeader(token),
      }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ conversations: Array<{ id: string }> }>();
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0].id).toBe('conversation-1');
  });
});
