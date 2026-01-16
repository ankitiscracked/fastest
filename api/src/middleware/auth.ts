import type { Context } from 'hono';
import type { Env } from '../index';

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

  const db = c.env.DB;

  // Look up session by token hash
  const tokenHash = hashToken(token);

  const session = await db.prepare(`
    SELECT s.user_id, s.expires_at, u.email
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token_hash = ?
  `).bind(tokenHash).first<{
    user_id: string;
    expires_at: string;
    email: string;
  }>();

  if (!session) {
    return null;
  }

  // Check if session is expired
  if (new Date(session.expires_at) < new Date()) {
    return null;
  }

  return {
    id: session.user_id,
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
function hashToken(token: string): string {
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    const char = token.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `hash_${Math.abs(hash).toString(16)}`;
}
