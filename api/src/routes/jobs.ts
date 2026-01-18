import { Hono } from 'hono';
import { eq, and, asc, desc } from 'drizzle-orm';
import type { Env } from '../index';
import type { Job, CreateJobRequest, JobStatus } from '@fastest/shared';
import { getAuthUser } from '../middleware/auth';
import { runJobInSandbox } from '../sandbox';
import { createDb, jobs, workspaces, projects, activityEvents } from '../db';

export const jobRoutes = new Hono<{ Bindings: Env }>();

// Get next pending job (for sandbox runner to pick up)
// NOTE: Must be before /:jobId routes to avoid matching "next" as a job ID
jobRoutes.get('/next', async (c) => {
  // TODO: Add service authentication for sandbox -> API calls
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const db = createDb(c.env.DB);

  // Get oldest pending job that belongs to this user's projects
  const result = await db
    .select({
      id: jobs.id,
      workspace_id: jobs.workspaceId,
      project_id: jobs.projectId,
      prompt: jobs.prompt,
      status: jobs.status,
      output_snapshot_id: jobs.outputSnapshotId,
      error: jobs.error,
      created_at: jobs.createdAt,
      started_at: jobs.startedAt,
      completed_at: jobs.completedAt,
    })
    .from(jobs)
    .innerJoin(projects, eq(jobs.projectId, projects.id))
    .where(and(eq(jobs.status, 'pending'), eq(projects.ownerUserId, user.id)))
    .orderBy(asc(jobs.createdAt))
    .limit(1);

  const job = result[0];

  if (!job) {
    return c.json({ job: null });
  }

  return c.json({
    job: {
      ...job,
      status: job.status as JobStatus,
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
  const db = createDb(c.env.DB);

  if (!body.workspace_id) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'workspace_id is required' } }, 422);
  }

  if (!body.prompt || body.prompt.trim() === '') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'prompt is required' } }, 422);
  }

  // Get workspace and verify ownership through project
  const workspaceResult = await db
    .select({
      id: workspaces.id,
      project_id: workspaces.projectId,
      name: workspaces.name,
      owner_user_id: projects.ownerUserId,
    })
    .from(workspaces)
    .innerJoin(projects, eq(workspaces.projectId, projects.id))
    .where(eq(workspaces.id, body.workspace_id))
    .limit(1);

  const workspace = workspaceResult[0];

  if (!workspace) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } }, 404);
  }

  if (workspace.owner_user_id !== user.id) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
  }

  const jobId = generateULID();
  const now = new Date().toISOString();

  await db.insert(jobs).values({
    id: jobId,
    workspaceId: workspace.id,
    projectId: workspace.project_id,
    prompt: body.prompt.trim(),
    status: 'pending',
    createdAt: now,
  });

  // Insert activity event
  const eventId = generateULID();
  await db.insert(activityEvents).values({
    id: eventId,
    projectId: workspace.project_id,
    workspaceId: workspace.id,
    actor: 'web',
    type: 'job.created',
    message: `Job created: "${body.prompt.trim().slice(0, 50)}..."`,
    createdAt: now,
  });

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
  const db = createDb(c.env.DB);

  // Get job and verify ownership through project
  const result = await db
    .select({
      id: jobs.id,
      workspace_id: jobs.workspaceId,
      project_id: jobs.projectId,
      prompt: jobs.prompt,
      status: jobs.status,
      output_snapshot_id: jobs.outputSnapshotId,
      error: jobs.error,
      created_at: jobs.createdAt,
      started_at: jobs.startedAt,
      completed_at: jobs.completedAt,
      owner_user_id: projects.ownerUserId,
    })
    .from(jobs)
    .innerJoin(projects, eq(jobs.projectId, projects.id))
    .where(eq(jobs.id, jobId))
    .limit(1);

  const job = result[0];

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
  const db = createDb(c.env.DB);

  // Build conditions
  let conditions = [eq(projects.ownerUserId, user.id)];

  if (workspaceId) {
    conditions.push(eq(jobs.workspaceId, workspaceId));
  }

  if (projectId) {
    conditions.push(eq(jobs.projectId, projectId));
  }

  if (status) {
    conditions.push(eq(jobs.status, status));
  }

  const result = await db
    .select({
      id: jobs.id,
      workspace_id: jobs.workspaceId,
      project_id: jobs.projectId,
      prompt: jobs.prompt,
      status: jobs.status,
      output_snapshot_id: jobs.outputSnapshotId,
      error: jobs.error,
      created_at: jobs.createdAt,
      started_at: jobs.startedAt,
      completed_at: jobs.completedAt,
    })
    .from(jobs)
    .innerJoin(projects, eq(jobs.projectId, projects.id))
    .where(and(...conditions))
    .orderBy(desc(jobs.createdAt))
    .limit(limit);

  const jobsList: Job[] = result.map((j) => ({
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

  return c.json({ jobs: jobsList });
});

// Cancel a job
jobRoutes.post('/:jobId/cancel', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const jobId = c.req.param('jobId');
  const db = createDb(c.env.DB);

  // Get job and verify ownership
  const result = await db
    .select({
      id: jobs.id,
      workspace_id: jobs.workspaceId,
      project_id: jobs.projectId,
      prompt: jobs.prompt,
      status: jobs.status,
      output_snapshot_id: jobs.outputSnapshotId,
      error: jobs.error,
      created_at: jobs.createdAt,
      started_at: jobs.startedAt,
      completed_at: jobs.completedAt,
      owner_user_id: projects.ownerUserId,
    })
    .from(jobs)
    .innerJoin(projects, eq(jobs.projectId, projects.id))
    .where(eq(jobs.id, jobId))
    .limit(1);

  const job = result[0];

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

  await db
    .update(jobs)
    .set({ status: 'cancelled', completedAt: now })
    .where(eq(jobs.id, jobId));

  // Insert activity event
  const eventId = generateULID();
  await db.insert(activityEvents).values({
    id: eventId,
    projectId: job.project_id,
    workspaceId: job.workspace_id,
    actor: 'web',
    type: 'job.cancelled',
    message: `Job ${jobId.slice(0, 8)}... cancelled`,
    createdAt: now,
  });

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
  const db = createDb(c.env.DB);

  // Validate status
  const validStatuses: JobStatus[] = ['pending', 'running', 'completed', 'failed', 'cancelled'];
  if (!validStatuses.includes(body.status)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid status' } }, 422);
  }

  // Get job and verify ownership
  const result = await db
    .select({
      id: jobs.id,
      workspace_id: jobs.workspaceId,
      project_id: jobs.projectId,
      prompt: jobs.prompt,
      status: jobs.status,
      output_snapshot_id: jobs.outputSnapshotId,
      error: jobs.error,
      created_at: jobs.createdAt,
      started_at: jobs.startedAt,
      completed_at: jobs.completedAt,
      owner_user_id: projects.ownerUserId,
    })
    .from(jobs)
    .innerJoin(projects, eq(jobs.projectId, projects.id))
    .where(eq(jobs.id, jobId))
    .limit(1);

  const job = result[0];

  if (!job) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Job not found' } }, 404);
  }

  if (job.owner_user_id !== user.id) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
  }

  const now = new Date().toISOString();
  const updates: Record<string, string | null> = { status: body.status };

  // Set started_at when transitioning to running
  if (body.status === 'running' && !job.started_at) {
    updates.startedAt = now;
  }

  // Set completed_at when transitioning to terminal state
  if (['completed', 'failed', 'cancelled'].includes(body.status) && !job.completed_at) {
    updates.completedAt = now;
  }

  // Set output_snapshot_id if provided
  if (body.output_snapshot_id) {
    updates.outputSnapshotId = body.output_snapshot_id;
  }

  // Set error if provided
  if (body.error) {
    updates.error = body.error;
  }

  await db
    .update(jobs)
    .set(updates)
    .where(eq(jobs.id, jobId));

  // Insert activity event for status changes
  const eventId = generateULID();
  const eventType = body.status === 'completed' ? 'job.completed' :
                    body.status === 'failed' ? 'job.failed' :
                    body.status === 'running' ? 'job.started' : 'job.updated';
  const message = body.status === 'completed' ? `Job ${jobId.slice(0, 8)}... completed` :
                  body.status === 'failed' ? `Job ${jobId.slice(0, 8)}... failed: ${body.error || 'Unknown error'}` :
                  body.status === 'running' ? `Job ${jobId.slice(0, 8)}... started` :
                  `Job ${jobId.slice(0, 8)}... status: ${body.status}`;

  await db.insert(activityEvents).values({
    id: eventId,
    projectId: job.project_id,
    workspaceId: job.workspace_id,
    actor: 'system',
    type: eventType,
    message,
    createdAt: now,
  });

  // Fetch updated job
  const updatedResult = await db
    .select({
      id: jobs.id,
      workspace_id: jobs.workspaceId,
      project_id: jobs.projectId,
      prompt: jobs.prompt,
      status: jobs.status,
      output_snapshot_id: jobs.outputSnapshotId,
      error: jobs.error,
      created_at: jobs.createdAt,
      started_at: jobs.startedAt,
      completed_at: jobs.completedAt,
    })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);

  const updatedJob = updatedResult[0]!;

  return c.json({
    job: {
      id: updatedJob.id,
      workspace_id: updatedJob.workspace_id,
      project_id: updatedJob.project_id,
      prompt: updatedJob.prompt,
      status: updatedJob.status as JobStatus,
      output_snapshot_id: updatedJob.output_snapshot_id,
      error: updatedJob.error,
      created_at: updatedJob.created_at,
      started_at: updatedJob.started_at,
      completed_at: updatedJob.completed_at,
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
  const db = createDb(c.env.DB);

  // Get job and verify ownership
  const result = await db
    .select({
      id: jobs.id,
      workspace_id: jobs.workspaceId,
      project_id: jobs.projectId,
      prompt: jobs.prompt,
      status: jobs.status,
      output_snapshot_id: jobs.outputSnapshotId,
      error: jobs.error,
      created_at: jobs.createdAt,
      started_at: jobs.startedAt,
      completed_at: jobs.completedAt,
      owner_user_id: projects.ownerUserId,
    })
    .from(jobs)
    .innerJoin(projects, eq(jobs.projectId, projects.id))
    .where(eq(jobs.id, jobId))
    .limit(1);

  const job = result[0];

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
  const sandboxResult = await runJobInSandbox(c.env, jobId, apiUrl, apiToken);

  if (!sandboxResult.success) {
    return c.json({
      error: {
        code: 'EXECUTION_FAILED',
        message: sandboxResult.error || 'Job execution failed',
      },
      job_id: jobId,
      duration_ms: sandboxResult.duration_ms,
      stdout: sandboxResult.stdout,
      stderr: sandboxResult.stderr,
    }, 500);
  }

  // Fetch updated job
  const updatedResult = await db
    .select({
      id: jobs.id,
      workspace_id: jobs.workspaceId,
      project_id: jobs.projectId,
      prompt: jobs.prompt,
      status: jobs.status,
      output_snapshot_id: jobs.outputSnapshotId,
      error: jobs.error,
      created_at: jobs.createdAt,
      started_at: jobs.startedAt,
      completed_at: jobs.completedAt,
    })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);

  const updatedJob = updatedResult[0]!;

  return c.json({
    job: {
      id: updatedJob.id,
      workspace_id: updatedJob.workspace_id,
      project_id: updatedJob.project_id,
      prompt: updatedJob.prompt,
      status: updatedJob.status as JobStatus,
      output_snapshot_id: updatedJob.output_snapshot_id,
      error: updatedJob.error,
      created_at: updatedJob.created_at,
      started_at: updatedJob.started_at,
      completed_at: updatedJob.completed_at,
    } as Job,
    duration_ms: sandboxResult.duration_ms,
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
