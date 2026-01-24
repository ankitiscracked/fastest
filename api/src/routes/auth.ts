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

  // Mask key values - show only last 4 characters (decrypt if encrypted)
  const maskedKeys: UserApiKey[] = [];
  for (const key of keys) {
    let suffix = '••••';
    try {
      const plain = await decryptApiKeyValue(c.env, key.keyValue);
      if (plain.length >= 4) {
        suffix = plain.slice(-4);
      }
    } catch {
      // Ignore decryption errors for list view
    }
    maskedKeys.push({
      id: key.id,
      user_id: key.userId,
      provider: key.provider as ApiKeyProvider,
      key_name: key.keyName,
      key_value: '•'.repeat(20) + suffix,
      created_at: key.createdAt,
      updated_at: key.updatedAt,
    });
  }

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
  let encryptedValue: string;
  try {
    encryptedValue = await encryptApiKeyValue(c.env, body.key_value);
  } catch (err) {
    return c.json({ error: { code: 'ENCRYPTION_FAILED', message: err instanceof Error ? err.message : 'Failed to encrypt key' } }, 500);
  }

  if (existing.length > 0) {
    // Update existing key
    await db
      .update(userApiKeys)
      .set({
        keyValue: encryptedValue,
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
      keyValue: encryptedValue,
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
    try {
      envVars[key.keyName] = await decryptApiKeyValue(c.env, key.keyValue);
    } catch (err) {
      return c.json({ error: { code: 'DECRYPTION_FAILED', message: err instanceof Error ? err.message : 'Failed to decrypt key' } }, 500);
    }
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

const API_KEY_PREFIX = 'enc:v1:';

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

async function getApiKeyCryptoKey(env: Env): Promise<CryptoKey> {
  if (!env.API_KEY_ENCRYPTION_KEY) {
    throw new Error('API key encryption is not configured');
  }
  const raw = base64ToBytes(env.API_KEY_ENCRYPTION_KEY);
  if (raw.length !== 32) {
    throw new Error('API key encryption key must be 32 bytes (base64-encoded)');
  }
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptApiKeyValue(env: Env, value: string): Promise<string> {
  const key = await getApiKeyCryptoKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(value);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded));
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);
  return API_KEY_PREFIX + bytesToBase64(combined);
}

async function decryptApiKeyValue(env: Env, stored: string): Promise<string> {
  if (!stored.startsWith(API_KEY_PREFIX)) {
    throw new Error('Stored API key is not encrypted');
  }
  const data = base64ToBytes(stored.slice(API_KEY_PREFIX.length));
  if (data.length <= 12) {
    throw new Error('Encrypted API key payload is invalid');
  }
  const iv = data.slice(0, 12);
  const ciphertext = data.slice(12);
  const key = await getApiKeyCryptoKey(env);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plain);
}
