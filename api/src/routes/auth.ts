import { Hono } from 'hono';
import type { Env } from '../index';

export const authRoutes = new Hono<{ Bindings: Env }>();

// Start login flow (send magic link / code)
authRoutes.post('/start', async (c) => {
  const body = await c.req.json<{ email: string }>();

  if (!body.email) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Email is required' } }, 422);
  }

  // TODO: Implement magic link flow
  // For now, return a placeholder session_id
  return c.json({
    session_id: 'placeholder-session',
    message: 'Check your email for the login code'
  });
});

// Complete login (exchange code for token)
authRoutes.post('/complete', async (c) => {
  const body = await c.req.json<{ session_id: string; code: string }>();

  if (!body.session_id || !body.code) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'session_id and code are required' } }, 422);
  }

  // TODO: Implement code verification
  // For now, return a placeholder token
  return c.json({
    access_token: 'placeholder-token',
    expires_in: 86400
  });
});

// Get current user
authRoutes.get('/me', async (c) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid authorization header' } }, 401);
  }

  // TODO: Verify token and fetch user
  // For now, return a placeholder user
  return c.json({
    user: {
      id: 'placeholder-user-id',
      email: 'user@example.com',
      created_at: new Date().toISOString()
    }
  });
});
