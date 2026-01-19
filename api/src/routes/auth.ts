import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import type { Env } from '../index';
import { createDb, users, sessions, userApiKeys } from '../db';
import { hashToken, getAuthUser } from '../middleware/auth';
import type { ApiKeyProvider, UserApiKey } from '@fastest/shared';
import { API_KEY_PROVIDERS } from '@fastest/shared';

export const authRoutes = new Hono<{ Bindings: Env }>();

// Google OAuth - verify ID token and create session
authRoutes.post('/google', async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json<{ credential: string }>();

  if (!body.credential) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'credential is required' } }, 422);
  }

  try {
    // Verify the Google ID token
    const googleUser = await verifyGoogleToken(body.credential, c.env.GOOGLE_CLIENT_ID);

    if (!googleUser || !googleUser.email) {
      return c.json({ error: { code: 'INVALID_TOKEN', message: 'Invalid Google token' } }, 401);
    }

    // Find or create user
    const existingUsers = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, googleUser.email.toLowerCase()))
      .limit(1);

    let user = existingUsers[0];

    if (!user) {
      // Create new user
      const userId = generateULID();
      await db.insert(users).values({
        id: userId,
        email: googleUser.email.toLowerCase(),
        name: googleUser.name || null,
        picture: googleUser.picture || null,
      });
      user = { id: userId, email: googleUser.email.toLowerCase() };
    }

    // Generate access token and create session
    const accessToken = generateSecureToken(32);
    const tokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

    const sessionId = generateULID();
    await db.insert(sessions).values({
      id: sessionId,
      userId: user.id,
      tokenHash: hashToken(accessToken),
      expiresAt: tokenExpiresAt,
    });

    return c.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 30 * 24 * 60 * 60,
      user: {
        id: user.id,
        email: user.email,
      },
    });
  } catch (error) {
    console.error('Google auth error:', error);
    return c.json({ error: { code: 'AUTH_ERROR', message: 'Authentication failed' } }, 401);
  }
});

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
  const db = createDb(c.env.DB);
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid authorization header' } }, 401);
  }

  const token = authHeader.slice(7);
  const tokenHash = hashToken(token);

  // Look up session with user info
  const result = await db
    .select({
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
      email: users.email,
      name: users.name,
      picture: users.picture,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);

  const session = result[0];

  if (!session) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token' } }, 401);
  }

  if (new Date(session.expiresAt) < new Date()) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Token expired' } }, 401);
  }

  return c.json({
    user: {
      id: session.userId,
      email: session.email,
      name: session.name,
      picture: session.picture,
    }
  });
});

// API Key Management Routes

/**
 * GET /auth/api-keys
 * List all API keys for the current user (values masked)
 */
authRoutes.get('/api-keys', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const db = createDb(c.env.DB);

  const keys = await db
    .select()
    .from(userApiKeys)
    .where(eq(userApiKeys.userId, user.id));

  // Mask key values - show only last 4 characters
  const maskedKeys: UserApiKey[] = keys.map(key => ({
    id: key.id,
    user_id: key.userId,
    provider: key.provider as ApiKeyProvider,
    key_name: key.keyName,
    key_value: '•'.repeat(20) + key.keyValue.slice(-4),
    created_at: key.createdAt,
    updated_at: key.updatedAt,
  }));

  return c.json({ api_keys: maskedKeys });
});

/**
 * POST /auth/api-keys
 * Set an API key for a provider (creates or updates)
 */
authRoutes.post('/api-keys', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const db = createDb(c.env.DB);
  const body = await c.req.json<{ provider: ApiKeyProvider; key_value: string }>();

  if (!body.provider || !body.key_value) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'provider and key_value are required' } }, 422);
  }

  const providerConfig = API_KEY_PROVIDERS[body.provider];
  if (!providerConfig) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid provider' } }, 422);
  }

  // Check if key already exists
  const existing = await db
    .select({ id: userApiKeys.id })
    .from(userApiKeys)
    .where(and(
      eq(userApiKeys.userId, user.id),
      eq(userApiKeys.provider, body.provider)
    ))
    .limit(1);

  const now = new Date().toISOString();

  if (existing.length > 0) {
    // Update existing key
    await db
      .update(userApiKeys)
      .set({
        keyValue: body.key_value,
        updatedAt: now,
      })
      .where(eq(userApiKeys.id, existing[0].id));
  } else {
    // Insert new key
    await db.insert(userApiKeys).values({
      id: generateULID(),
      userId: user.id,
      provider: body.provider,
      keyName: providerConfig.keyName,
      keyValue: body.key_value,
      createdAt: now,
      updatedAt: now,
    });
  }

  return c.json({ success: true });
});

/**
 * DELETE /auth/api-keys/:provider
 * Delete an API key for a provider
 */
authRoutes.delete('/api-keys/:provider', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const db = createDb(c.env.DB);
  const provider = c.req.param('provider') as ApiKeyProvider;

  if (!API_KEY_PROVIDERS[provider]) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid provider' } }, 422);
  }

  await db
    .delete(userApiKeys)
    .where(and(
      eq(userApiKeys.userId, user.id),
      eq(userApiKeys.provider, provider)
    ));

  return c.json({ success: true });
});

/**
 * GET /auth/api-keys/values (internal endpoint for OpenCode)
 * Get unmasked API key values for the current user
 * Used by the sandbox to pass env vars to OpenCode
 */
authRoutes.get('/api-keys/values', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const db = createDb(c.env.DB);

  const keys = await db
    .select({
      keyName: userApiKeys.keyName,
      keyValue: userApiKeys.keyValue,
    })
    .from(userApiKeys)
    .where(eq(userApiKeys.userId, user.id));

  // Return as a map of env var name -> value
  const envVars: Record<string, string> = {};
  for (const key of keys) {
    envVars[key.keyName] = key.keyValue;
  }

  return c.json({ env_vars: envVars });
});

// Helper functions

interface GoogleUser {
  email: string;
  name?: string;
  picture?: string;
  email_verified?: boolean;
}

async function verifyGoogleToken(credential: string, clientId?: string): Promise<GoogleUser | null> {
  // Verify the token with Google's tokeninfo endpoint
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);

  if (!response.ok) {
    return null;
  }

  const payload = await response.json() as {
    aud: string;
    email: string;
    email_verified: string;
    name?: string;
    picture?: string;
  };

  // Verify the audience matches our client ID (if provided)
  if (clientId && payload.aud !== clientId) {
    console.error('Token audience mismatch:', payload.aud, 'vs', clientId);
    return null;
  }

  // Verify email is verified
  if (payload.email_verified !== 'true') {
    return null;
  }

  return {
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
    email_verified: true,
  };
}

function generateULID(): string {
  const timestamp = Date.now().toString(36).padStart(10, '0');
  const random = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 36).toString(36)
  ).join('');
  return (timestamp + random).toUpperCase();
}

function generateSecureToken(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => chars[byte % chars.length]).join('');
}
