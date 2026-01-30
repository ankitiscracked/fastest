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
import { actionItemRoutes } from './routes/action-items';
import { infrastructureRoutes } from './routes/infrastructure';
import { runBackgroundJobs } from './background-jobs';

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  ENVIRONMENT: string;
  // Conversation session bindings (unused in tests)
  ConversationSession: DurableObjectNamespace;
  // Workers AI for timeline summaries (unused in tests)
  AI: Ai;
  // API keys for LLM providers
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GOOGLE_GENERATIVE_AI_API_KEY?: string;
  MAX_FILES_PER_MANIFEST?: string;
  PROVIDER?: string;
  // External OpenCode server URL override (used if sandbox CLI is unavailable)
  OPENCODE_URL?: string;
  // Optional directory to isolate OpenCode tool effects (host OpenCode)
  OPENCODE_WORKDIR?: string;
  // Optional directory for OpenCode custom tools
  OPENCODE_TOOLS_DIR?: string;
  // Sandbox provider (cloudflare | e2b)
  SANDBOX_PROVIDER?: string;
  // E2B template id (optional)
  E2B_TEMPLATE_ID?: string;
  // E2B API key
  E2B_API_KEY?: string;
  // Google OAuth
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // User API key encryption (base64-encoded 32 bytes)
  API_KEY_ENCRYPTION_KEY?: string;
  // Cloudflare deploy credentials (our account)
  CLOUDFLARE_DEPLOY_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  // Railway deploy credentials (our account)
  RAILWAY_DEPLOY_TOKEN?: string;
  RAILWAY_PROJECT_ID?: string;
}

const app = new Hono<{ Bindings: Env }>();

app.use('*', logger());
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const v1 = new Hono<{ Bindings: Env }>();

v1.route('/auth', authRoutes);
v1.route('/oauth', oauthRoutes);
v1.route('/projects', projectRoutes);
v1.route('/snapshots', snapshotRoutes);
v1.route('/workspaces', workspaceRoutes);
v1.route('/blobs', blobRoutes);
v1.route('/conversations', conversationRoutes);
v1.route('/action-items', actionItemRoutes);
v1.route('/infrastructure', infrastructureRoutes);

app.route('/v1', v1);

app.notFound((c) => {
  return c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404);
});

app.onError((err, c) => {
  console.error('Error:', err);
  return c.json({
    error: {
      code: 'INTERNAL_ERROR',
      message: err.message || 'Internal server error'
    }
  }, 500);
});

export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runBackgroundJobs(env));
  },
};
