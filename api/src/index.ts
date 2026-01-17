import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { authRoutes } from './routes/auth';
import { oauthRoutes } from './routes/oauth';
import { projectRoutes } from './routes/projects';
import { snapshotRoutes } from './routes/snapshots';
import { workspaceRoutes } from './routes/workspaces';
import { blobRoutes } from './routes/blobs';
import { jobRoutes } from './routes/jobs';

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  ENVIRONMENT: string;
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
v1.route('/jobs', jobRoutes);

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
