import type { Context, Next } from 'hono';
import { createMiddleware } from 'hono/factory';
import { eq, and, gt } from 'drizzle-orm';
import type { Env } from '../index';
import { createDb, sessions, users } from '../db';

interface AuthUser {
  id: string;
  email: string;
}

/**
 * Get the authenticated user from the request
 * Returns null if not authenticated
 */
export async function getAuthUser(c: Context<{ Bindings: Env }>): Promise<AuthUser | null> {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice(7); // Remove "Bearer " prefix

  if (!token) {
    return null;
  }

  const db = createDb(c.env.DB);
  const tokenHash = hashToken(token);

  const result = await db
    .select({
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
      email: users.email,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);

  const session = result[0];

  if (!session) {
    return null;
  }

  // Check if session is expired
  if (new Date(session.expiresAt) < new Date()) {
    return null;
  }

  return {
    id: session.userId,
    email: session.email
  };
}

/**
 * Require authentication - throws if not authenticated
 */
export async function requireAuth(c: Context<{ Bindings: Env }>): Promise<AuthUser> {
  const user = await getAuthUser(c);

  if (!user) {
    throw new Error('Authentication required');
  }

  return user;
}

/**
 * Simple hash function for token storage
 * In production, use a proper crypto hash
 */
export function hashToken(token: string): string {
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    const char = token.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `hash_${Math.abs(hash).toString(16)}`;
}

/**
 * Auth middleware - rejects requests without valid authentication
 */
export const authMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const user = await getAuthUser(c);

  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  await next();
});
