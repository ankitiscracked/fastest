import { Hono } from 'hono';
import type { Env } from '../index';
import type { Job, CreateJobRequest, JobStatus } from '@fastest/shared';
import type { DbJob } from '../types';
import { getAuthUser } from '../middleware/auth';
import { runJobInSandbox } from '../sandbox';

export const jobRoutes = new Hono<{ Bindings: Env }>();

// Get next pending job (for sandbox runner to pick up)
// NOTE: Must be before /:jobId routes to avoid matching "next" as a job ID
jobRoutes.get('/next', async (c) => {
  // TODO: Add service authentication for sandbox -> API calls
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const db = c.env.DB;

  // Get oldest pending job that belongs to this user's projects
  const job = await db.prepare(`
    SELECT j.*
    FROM jobs j
    JOIN projects p ON j.project_id = p.id
    WHERE j.status = 'pending' AND p.owner_user_id = ?
    ORDER BY j.created_at ASC
    LIMIT 1
  `).bind(user.id).first<DbJob>();

  if (!job) {
    return c.json({ job: null });
  }

  return c.json({
    job: {
      id: job.id,
      workspace_id: job.workspace_id,
      project_id: job.project_id,
      prompt: job.prompt,
      status: job.status as JobStatus,
      output_snapshot_id: job.output_snapshot_id,
      error: job.error,
      created_at: job.created_at,
      started_at: job.started_at,
      completed_at: job.completed_at,
    } as Job
  });
});

// Create a new job
jobRoutes.post('/', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const body = await c.req.json<CreateJobRequest>();
  const db = c.env.DB;

  if (!body.workspace_id) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'workspace_id is required' } }, 422);
  }

  if (!body.prompt || body.prompt.trim() === '') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'prompt is required' } }, 422);
  }

  // Get workspace and verify ownership through project
  const workspace = await db.prepare(`
    SELECT w.id, w.project_id, w.name, p.owner_user_id
    FROM workspaces w
    JOIN projects p ON w.project_id = p.id
    WHERE w.id = ?
  `).bind(body.workspace_id).first<{
    id: string;
    project_id: string;
    name: string;
    owner_user_id: string;
  }>();

  if (!workspace) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } }, 404);
  }

  if (workspace.owner_user_id !== user.id) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
  }

  const jobId = generateULID();
  const now = new Date().toISOString();

  await db.prepare(`
    INSERT INTO jobs (id, workspace_id, project_id, prompt, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).bind(jobId, workspace.id, workspace.project_id, body.prompt.trim(), now).run();

  // Insert activity event
  const eventId = generateULID();
  await db.prepare(`
    INSERT INTO activity_events (id, project_id, workspace_id, actor, type, message, created_at)
    VALUES (?, ?, ?, 'web', 'job.created', ?, ?)
  `).bind(eventId, workspace.project_id, workspace.id, `Job created: "${body.prompt.trim().slice(0, 50)}..."`, now).run();

  const job: Job = {
    id: jobId,
    workspace_id: workspace.id,
    project_id: workspace.project_id,
    prompt: body.prompt.trim(),
    status: 'pending',
    output_snapshot_id: null,
    error: null,
    created_at: now,
    started_at: null,
    completed_at: null,
  };

  return c.json({ job }, 201);
});

// Get job by ID
jobRoutes.get('/:jobId', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const jobId = c.req.param('jobId');
  const db = c.env.DB;

  // Get job and verify ownership through project
  const job = await db.prepare(`
    SELECT j.*, p.owner_user_id
    FROM jobs j
    JOIN projects p ON j.project_id = p.id
    WHERE j.id = ?
  `).bind(jobId).first<DbJob & { owner_user_id: string }>();

  if (!job) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Job not found' } }, 404);
  }

  if (job.owner_user_id !== user.id) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
  }

  return c.json({
    job: {
      id: job.id,
      workspace_id: job.workspace_id,
      project_id: job.project_id,
      prompt: job.prompt,
      status: job.status as JobStatus,
      output_snapshot_id: job.output_snapshot_id,
      error: job.error,
      created_at: job.created_at,
      started_at: job.started_at,
      completed_at: job.completed_at,
    } as Job
  });
});

// List jobs (optionally filtered by workspace or project)
jobRoutes.get('/', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const workspaceId = c.req.query('workspace_id');
  const projectId = c.req.query('project_id');
  const status = c.req.query('status');
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
  const db = c.env.DB;

  let query = `
    SELECT j.*
    FROM jobs j
    JOIN projects p ON j.project_id = p.id
    WHERE p.owner_user_id = ?
  `;
  const params: (string | number)[] = [user.id];

  if (workspaceId) {
    query += ' AND j.workspace_id = ?';
    params.push(workspaceId);
  }

  if (projectId) {
    query += ' AND j.project_id = ?';
    params.push(projectId);
  }

  if (status) {
    query += ' AND j.status = ?';
    params.push(status);
  }

  query += ' ORDER BY j.created_at DESC LIMIT ?';
  params.push(limit);

  const result = await db.prepare(query).bind(...params).all<DbJob>();

  const jobs: Job[] = (result.results || []).map((j) => ({
    id: j.id,
    workspace_id: j.workspace_id,
    project_id: j.project_id,
    prompt: j.prompt,
    status: j.status as JobStatus,
    output_snapshot_id: j.output_snapshot_id,
    error: j.error,
    created_at: j.created_at,
    started_at: j.started_at,
    completed_at: j.completed_at,
  }));

  return c.json({ jobs });
});

// Cancel a job
jobRoutes.post('/:jobId/cancel', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const jobId = c.req.param('jobId');
  const db = c.env.DB;

  // Get job and verify ownership
  const job = await db.prepare(`
    SELECT j.*, p.owner_user_id
    FROM jobs j
    JOIN projects p ON j.project_id = p.id
    WHERE j.id = ?
  `).bind(jobId).first<DbJob & { owner_user_id: string }>();

  if (!job) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Job not found' } }, 404);
  }

  if (job.owner_user_id !== user.id) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
  }

  // Can only cancel pending or running jobs
  if (job.status !== 'pending' && job.status !== 'running') {
    return c.json({
      error: {
        code: 'INVALID_STATE',
        message: `Cannot cancel job with status '${job.status}'`
      }
    }, 422);
  }

  const now = new Date().toISOString();

  await db.prepare(`
    UPDATE jobs SET status = 'cancelled', completed_at = ? WHERE id = ?
  `).bind(now, jobId).run();

  // Insert activity event
  const eventId = generateULID();
  await db.prepare(`
    INSERT INTO activity_events (id, project_id, workspace_id, actor, type, message, created_at)
    VALUES (?, ?, ?, 'web', 'job.cancelled', ?, ?)
  `).bind(eventId, job.project_id, job.workspace_id, `Job ${jobId.slice(0, 8)}... cancelled`, now).run();

  return c.json({
    job: {
      id: job.id,
      workspace_id: job.workspace_id,
      project_id: job.project_id,
      prompt: job.prompt,
      status: 'cancelled' as JobStatus,
      output_snapshot_id: job.output_snapshot_id,
      error: job.error,
      created_at: job.created_at,
      started_at: job.started_at,
      completed_at: now,
    } as Job
  });
});

// Internal: Update job status (called by sandbox runner)
// This would typically be authenticated with a service token, not user auth
jobRoutes.post('/:jobId/status', async (c) => {
  // TODO: Add service authentication for sandbox -> API calls
  // For now, require user auth
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const jobId = c.req.param('jobId');
  const body = await c.req.json<{
    status: JobStatus;
    output_snapshot_id?: string;
    error?: string;
  }>();
  const db = c.env.DB;

  // Validate status
  const validStatuses: JobStatus[] = ['pending', 'running', 'completed', 'failed', 'cancelled'];
  if (!validStatuses.includes(body.status)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid status' } }, 422);
  }

  // Get job and verify ownership
  const job = await db.prepare(`
    SELECT j.*, p.owner_user_id
    FROM jobs j
    JOIN projects p ON j.project_id = p.id
    WHERE j.id = ?
  `).bind(jobId).first<DbJob & { owner_user_id: string }>();

  if (!job) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Job not found' } }, 404);
  }

  if (job.owner_user_id !== user.id) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
  }

  const now = new Date().toISOString();
  const updates: string[] = ['status = ?'];
  const params: (string | null)[] = [body.status];

  // Set started_at when transitioning to running
  if (body.status === 'running' && !job.started_at) {
    updates.push('started_at = ?');
    params.push(now);
  }

  // Set completed_at when transitioning to terminal state
  if (['completed', 'failed', 'cancelled'].includes(body.status) && !job.completed_at) {
    updates.push('completed_at = ?');
    params.push(now);
  }

  // Set output_snapshot_id if provided
  if (body.output_snapshot_id) {
    updates.push('output_snapshot_id = ?');
    params.push(body.output_snapshot_id);
  }

  // Set error if provided
  if (body.error) {
    updates.push('error = ?');
    params.push(body.error);
  }

  params.push(jobId);

  await db.prepare(`
    UPDATE jobs SET ${updates.join(', ')} WHERE id = ?
  `).bind(...params).run();

  // Insert activity event for status changes
  const eventId = generateULID();
  const eventType = body.status === 'completed' ? 'job.completed' :
                    body.status === 'failed' ? 'job.failed' :
                    body.status === 'running' ? 'job.started' : 'job.updated';
  const message = body.status === 'completed' ? `Job ${jobId.slice(0, 8)}... completed` :
                  body.status === 'failed' ? `Job ${jobId.slice(0, 8)}... failed: ${body.error || 'Unknown error'}` :
                  body.status === 'running' ? `Job ${jobId.slice(0, 8)}... started` :
                  `Job ${jobId.slice(0, 8)}... status: ${body.status}`;

  await db.prepare(`
    INSERT INTO activity_events (id, project_id, workspace_id, actor, type, message, created_at)
    VALUES (?, ?, ?, 'system', ?, ?, ?)
  `).bind(eventId, job.project_id, job.workspace_id, eventType, message, now).run();

  // Fetch updated job
  const updatedJob = await db.prepare(`
    SELECT * FROM jobs WHERE id = ?
  `).bind(jobId).first<DbJob>();

  return c.json({
    job: {
      id: updatedJob!.id,
      workspace_id: updatedJob!.workspace_id,
      project_id: updatedJob!.project_id,
      prompt: updatedJob!.prompt,
      status: updatedJob!.status as JobStatus,
      output_snapshot_id: updatedJob!.output_snapshot_id,
      error: updatedJob!.error,
      created_at: updatedJob!.created_at,
      started_at: updatedJob!.started_at,
      completed_at: updatedJob!.completed_at,
    } as Job
  });
});

// Run a job in a sandbox
jobRoutes.post('/:jobId/run', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const jobId = c.req.param('jobId');
  const db = c.env.DB;

  // Get job and verify ownership
  const job = await db.prepare(`
    SELECT j.*, p.owner_user_id
    FROM jobs j
    JOIN projects p ON j.project_id = p.id
    WHERE j.id = ?
  `).bind(jobId).first<DbJob & { owner_user_id: string }>();

  if (!job) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Job not found' } }, 404);
  }

  if (job.owner_user_id !== user.id) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
  }

  // Can only run pending jobs
  if (job.status !== 'pending') {
    return c.json({
      error: {
        code: 'INVALID_STATE',
        message: `Cannot run job with status '${job.status}'`
      }
    }, 422);
  }

  // Get the API URL from the request
  // For local development, the container needs to use host.docker.internal instead of localhost
  let apiUrl = new URL(c.req.url).origin;
  if (c.env.ENVIRONMENT === 'development' && apiUrl.includes('localhost')) {
    apiUrl = apiUrl.replace('localhost', 'host.docker.internal');
  }

  // Get auth token from request
  const authHeader = c.req.header('Authorization');
  const apiToken = authHeader?.replace('Bearer ', '') || '';

  // Run job in sandbox
  const result = await runJobInSandbox(c.env, jobId, apiUrl, apiToken);

  if (!result.success) {
    return c.json({
      error: {
        code: 'EXECUTION_FAILED',
        message: result.error || 'Job execution failed',
      },
      job_id: jobId,
      duration_ms: result.duration_ms,
      stdout: result.stdout,
      stderr: result.stderr,
    }, 500);
  }

  // Fetch updated job
  const updatedJob = await db.prepare(`
    SELECT * FROM jobs WHERE id = ?
  `).bind(jobId).first<DbJob>();

  return c.json({
    job: {
      id: updatedJob!.id,
      workspace_id: updatedJob!.workspace_id,
      project_id: updatedJob!.project_id,
      prompt: updatedJob!.prompt,
      status: updatedJob!.status as JobStatus,
      output_snapshot_id: updatedJob!.output_snapshot_id,
      error: updatedJob!.error,
      created_at: updatedJob!.created_at,
      started_at: updatedJob!.started_at,
      completed_at: updatedJob!.completed_at,
    } as Job,
    duration_ms: result.duration_ms,
  });
});

// Helper: Generate ULID
function generateULID(): string {
  const timestamp = Date.now().toString(36).padStart(10, '0');
  const random = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 36).toString(36)
  ).join('');
  return (timestamp + random).toUpperCase();
}
