import { Hono } from 'hono';
import type { Env } from '../index';

export const oauthRoutes = new Hono<{ Bindings: Env }>();

// Constants for device flow
const DEVICE_CODE_EXPIRY_SECONDS = 900; // 15 minutes
const POLL_INTERVAL_SECONDS = 5;
const USER_CODE_LENGTH = 8; // ABCD-1234 format

/**
 * POST /oauth/device
 *
 * Start the device authorization flow (RFC 8628)
 * CLI calls this to get a device_code and user_code
 */
oauthRoutes.post('/device', async (c) => {
  const db = c.env.DB;

  const id = generateULID();
  const deviceCode = generateSecureToken(32);
  const userCode = generateUserCode();
  const expiresAt = new Date(Date.now() + DEVICE_CODE_EXPIRY_SECONDS * 1000).toISOString();

  // Store in database
  await db.prepare(`
    INSERT INTO device_codes (id, device_code, user_code, status, expires_at)
    VALUES (?, ?, ?, 'pending', ?)
  `).bind(id, deviceCode, userCode, expiresAt).run();

  // Return per RFC 8628
  return c.json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${getBaseUrl(c)}/device`,
    verification_uri_complete: `${getBaseUrl(c)}/device?code=${userCode}`,
    expires_in: DEVICE_CODE_EXPIRY_SECONDS,
    interval: POLL_INTERVAL_SECONDS,
  });
});

/**
 * POST /oauth/token
 *
 * Poll for token (CLI calls this repeatedly until authorized)
 * Per RFC 8628, returns specific error codes while pending
 */
oauthRoutes.post('/token', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<{
    grant_type: string;
    device_code: string;
  }>();

  // Validate grant type
  if (body.grant_type !== 'urn:ietf:params:oauth:grant-type:device_code') {
    return c.json({
      error: 'unsupported_grant_type',
      error_description: 'Only device_code grant type is supported'
    }, 400);
  }

  if (!body.device_code) {
    return c.json({
      error: 'invalid_request',
      error_description: 'device_code is required'
    }, 400);
  }

  // Look up device code
  const record = await db.prepare(`
    SELECT id, device_code, user_code, user_id, status, expires_at
    FROM device_codes
    WHERE device_code = ?
  `).bind(body.device_code).first<{
    id: string;
    device_code: string;
    user_code: string;
    user_id: string | null;
    status: string;
    expires_at: string;
  }>();

  if (!record) {
    return c.json({
      error: 'invalid_grant',
      error_description: 'Invalid device code'
    }, 400);
  }

  // Check expiration
  if (new Date(record.expires_at) < new Date()) {
    return c.json({
      error: 'expired_token',
      error_description: 'Device code has expired'
    }, 400);
  }

  // Check status
  switch (record.status) {
    case 'pending':
      // User hasn't authorized yet - tell CLI to keep polling
      return c.json({
        error: 'authorization_pending',
        error_description: 'User has not yet authorized'
      }, 400);

    case 'denied':
      return c.json({
        error: 'access_denied',
        error_description: 'User denied the authorization request'
      }, 400);

    case 'authorized':
      if (!record.user_id) {
        return c.json({
          error: 'server_error',
          error_description: 'Authorization incomplete'
        }, 500);
      }

      // Generate access token
      const accessToken = generateSecureToken(32);
      const tokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

      // Create session
      const sessionId = generateULID();
      await db.prepare(`
        INSERT INTO sessions (id, user_id, token_hash, expires_at)
        VALUES (?, ?, ?, ?)
      `).bind(sessionId, record.user_id, hashToken(accessToken), tokenExpiresAt).run();

      // Mark device code as used (delete it)
      await db.prepare(`DELETE FROM device_codes WHERE id = ?`).bind(record.id).run();

      // Get user info
      const user = await db.prepare(`
        SELECT id, email FROM users WHERE id = ?
      `).bind(record.user_id).first<{ id: string; email: string }>();

      return c.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 30 * 24 * 60 * 60, // 30 days in seconds
        user: user,
      });

    default:
      return c.json({
        error: 'server_error',
        error_description: 'Unknown status'
      }, 500);
  }
});

/**
 * POST /oauth/device/authorize
 *
 * Called from web UI when user enters code and authenticates via Google
 * This authorizes the device code for a specific user
 */
oauthRoutes.post('/device/authorize', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<{
    user_code: string;
    credential: string;
  }>();

  if (!body.user_code || !body.credential) {
    return c.json({
      error: { code: 'VALIDATION_ERROR', message: 'user_code and credential are required' }
    }, 422);
  }

  // Verify Google credential
  const googleUser = await verifyGoogleToken(body.credential, c.env.GOOGLE_CLIENT_ID);
  if (!googleUser || !googleUser.email) {
    return c.json({
      error: { code: 'INVALID_CREDENTIAL', message: 'Invalid Google credential' }
    }, 401);
  }

  // Normalize user code (remove dashes, uppercase)
  const normalizedCode = body.user_code.replace(/-/g, '').toUpperCase();

  // Find the device code
  const record = await db.prepare(`
    SELECT id, status, expires_at
    FROM device_codes
    WHERE REPLACE(UPPER(user_code), '-', '') = ?
  `).bind(normalizedCode).first<{
    id: string;
    status: string;
    expires_at: string;
  }>();

  if (!record) {
    return c.json({
      error: { code: 'INVALID_CODE', message: 'Invalid or expired code' }
    }, 400);
  }

  if (new Date(record.expires_at) < new Date()) {
    return c.json({
      error: { code: 'EXPIRED_CODE', message: 'Code has expired' }
    }, 400);
  }

  if (record.status !== 'pending') {
    return c.json({
      error: { code: 'ALREADY_USED', message: 'Code has already been used' }
    }, 400);
  }

  // Find or create user
  let user = await db.prepare(`
    SELECT id, email FROM users WHERE email = ?
  `).bind(googleUser.email.toLowerCase()).first<{ id: string; email: string }>();

  if (!user) {
    // Create new user
    const userId = generateULID();
    await db.prepare(`
      INSERT INTO users (id, email, name, picture) VALUES (?, ?, ?, ?)
    `).bind(userId, googleUser.email.toLowerCase(), googleUser.name || null, googleUser.picture || null).run();
    user = { id: userId, email: googleUser.email.toLowerCase() };
  }

  // Authorize the device code
  await db.prepare(`
    UPDATE device_codes
    SET status = 'authorized', user_id = ?
    WHERE id = ?
  `).bind(user.id, record.id).run();

  return c.json({
    success: true,
    message: 'Device authorized. You can close this window and return to the CLI.'
  });
});

/**
 * POST /oauth/device/deny
 *
 * Called from web UI if user denies the authorization
 */
oauthRoutes.post('/device/deny', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<{ user_code: string }>();

  if (!body.user_code) {
    return c.json({
      error: { code: 'VALIDATION_ERROR', message: 'user_code is required' }
    }, 422);
  }

  const normalizedCode = body.user_code.replace(/-/g, '').toUpperCase();

  await db.prepare(`
    UPDATE device_codes
    SET status = 'denied'
    WHERE REPLACE(UPPER(user_code), '-', '') = ? AND status = 'pending'
  `).bind(normalizedCode).run();

  return c.json({ success: true });
});

// Helper functions

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

function generateUserCode(): string {
  // Generate format: ABCD-1234
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // Excluding I, O to avoid confusion
  const digits = '0123456789';

  const letterPart = Array.from({ length: 4 }, () =>
    letters[Math.floor(Math.random() * letters.length)]
  ).join('');

  const digitPart = Array.from({ length: 4 }, () =>
    digits[Math.floor(Math.random() * digits.length)]
  ).join('');

  return `${letterPart}-${digitPart}`;
}

function hashToken(token: string): string {
  // Simple hash for token storage
  // In production, use a proper crypto hash
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    const char = token.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `hash_${Math.abs(hash).toString(16)}`;
}

function getBaseUrl(c: { req: { url: string } }): string {
  const url = new URL(c.req.url);
  // In production, this should be your actual domain
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    return `http://localhost:3000`; // Web UI port in dev
  }
  return `${url.protocol}//${url.hostname}`;
}

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
