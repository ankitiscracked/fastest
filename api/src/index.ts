import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { authRoutes } from './routes/auth';
import { oauthRoutes } from './routes/oauth';
import { projectRoutes } from './routes/projects';
import { snapshotRoutes } from './routes/snapshots';
import { workspaceRoutes } from './routes/workspaces';
import { blobRoutes } from './routes/blobs';
import { conversationRoutes } from './routes/conversations';

// Re-export Sandbox class for Durable Object binding (only when containers are enabled)
export { Sandbox } from '@cloudflare/sandbox';
import type { Sandbox } from '@cloudflare/sandbox';

// Re-export ConversationSession for Durable Object binding
export { ConversationSession } from './conversation';
import type { ConversationSession } from './conversation';

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  ENVIRONMENT: string;
  // Sandbox container bindings
  Sandbox: DurableObjectNamespace<Sandbox>;
  // Conversation session bindings
  ConversationSession: DurableObjectNamespace<ConversationSession>;
  // Workers AI for timeline summaries
  AI: Ai;
  // API keys for LLM providers
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GOOGLE_GENERATIVE_AI_API_KEY?: string;
  PROVIDER?: string;
  // External OpenCode server URL override (used if sandbox CLI is unavailable)
  OPENCODE_URL?: string;
  // Optional directory to isolate OpenCode tool effects (host OpenCode)
  OPENCODE_WORKDIR?: string;
  // Sandbox provider (cloudflare | e2b)
  SANDBOX_PROVIDER?: string;
  // E2B template id (optional)
  E2B_TEMPLATE_ID?: string;
  // E2B API key
  E2B_API_KEY?: string;
  // Google OAuth
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // Cloudflare deploy credentials (our account)
  CLOUDFLARE_DEPLOY_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
}

const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', logger());
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API v1 routes
const v1 = new Hono<{ Bindings: Env }>();

v1.route('/auth', authRoutes);
v1.route('/oauth', oauthRoutes);
v1.route('/projects', projectRoutes);
v1.route('/snapshots', snapshotRoutes);
v1.route('/workspaces', workspaceRoutes);
v1.route('/blobs', blobRoutes);
v1.route('/conversations', conversationRoutes);

app.route('/v1', v1);

// 404 handler
app.notFound((c) => {
  return c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Error:', err);
  return c.json({
    error: {
      code: 'INTERNAL_ERROR',
      message: err.message || 'Internal server error'
    }
  }, 500);
});

export default app;
