import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import type { Env } from '../index';
import { createDb, providerCredentials, infrastructureResources, projects, workspaces, deploymentSettings, deployments } from '../db';
import { getAuthUser } from '../middleware/auth';
import type {
  InfraProvider,
  ResourceType,
  SetProviderCredentialRequest,
  DeployProjectRequest,
  InfrastructureResource,
  DeploymentSettings,
  UpdateDeploymentSettingsRequest,
  DeploymentRecord,
  UpdateDeploymentStatusRequest,
} from '@fastest/shared';
import {
  getProvider,
  validateProviderCredentials,
} from '../providers';
import type { ProviderCredentials } from '../providers';
import { detectRequirementsWithFallback, suggestResources } from '../detection';
import { selectProviderForType } from '../providers/selection';

export const infrastructureRoutes = new Hono<{ Bindings: Env }>();

// Helper to generate IDs
function generateId(): string {
  return `res_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// Helper to encrypt connection info
async function encryptConnectionInfo(
  env: Env,
  info: Record<string, unknown>
): Promise<string> {
  // For now, just JSON stringify. In production, use proper encryption like userApiKeys
  // TODO: Use same encryption as API keys
  return JSON.stringify(info);
}

// Helper to decrypt connection info
async function decryptConnectionInfo(
  env: Env,
  encrypted: string
): Promise<Record<string, unknown>> {
  // TODO: Use same decryption as API keys
  return JSON.parse(encrypted);
}

// Helper to verify project ownership
async function verifyProjectOwnership(
  db: ReturnType<typeof createDb>,
  projectId: string,
  userId: string
): Promise<boolean> {
  const result = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, userId)))
    .limit(1);
  return result.length > 0;
}

async function getWorkspaceProjectId(
  db: ReturnType<typeof createDb>,
  workspaceId: string,
  userId: string
): Promise<string | null> {
  const result = await db
    .select({ projectId: workspaces.projectId })
    .from(workspaces)
    .innerJoin(projects, eq(workspaces.projectId, projects.id))
    .where(and(eq(workspaces.id, workspaceId), eq(projects.ownerUserId, userId)))
    .limit(1);

  return result.length > 0 ? result[0].projectId : null;
}

// ============================================================================
// Provider Credentials
// ============================================================================

/**
 * GET /infrastructure/credentials
 * List all provider credentials for the current user
 */
infrastructureRoutes.get('/credentials', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const db = createDb(c.env.DB);

  const creds = await db
    .select({
      id: providerCredentials.id,
      provider: providerCredentials.provider,
      metadata: providerCredentials.metadata,
      createdAt: providerCredentials.createdAt,
      updatedAt: providerCredentials.updatedAt,
    })
    .from(providerCredentials)
    .where(eq(providerCredentials.userId, user.id));

  return c.json({
    credentials: creds.map((cred) => ({
      id: cred.id,
      user_id: user.id,
      provider: cred.provider as InfraProvider,
      metadata: cred.metadata,
      created_at: cred.createdAt,
      updated_at: cred.updatedAt,
    })),
  });
});

/**
 * POST /infrastructure/credentials
 * Add or update a provider credential
 */
infrastructureRoutes.post('/credentials', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const body = await c.req.json<SetProviderCredentialRequest>();

  if (!body.provider || !body.api_token) {
    return c.json({
      error: { code: 'VALIDATION_ERROR', message: 'provider and api_token are required' },
    }, 422);
  }

  // Validate credentials with the provider
  const providerCreds: ProviderCredentials = {
    provider: body.provider,
    apiToken: body.api_token,
    metadata: body.metadata,
  };

  try {
    const isValid = await validateProviderCredentials(body.provider, providerCreds);
    if (!isValid) {
      return c.json({
        error: { code: 'INVALID_CREDENTIALS', message: 'Provider rejected the credentials' },
      }, 400);
    }
  } catch (error) {
    return c.json({
      error: {
        code: 'VALIDATION_FAILED',
        message: error instanceof Error ? error.message : 'Failed to validate credentials',
      },
    }, 400);
  }

  const db = createDb(c.env.DB);

  // Check if credential already exists
  const existing = await db
    .select({ id: providerCredentials.id })
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.userId, user.id),
        eq(providerCredentials.provider, body.provider)
      )
    )
    .limit(1);

  const now = new Date().toISOString();

  if (existing.length > 0) {
    // Update existing
    await db
      .update(providerCredentials)
      .set({
        apiToken: body.api_token,
        metadata: body.metadata ? JSON.stringify(body.metadata) : null,
        updatedAt: now,
      })
      .where(eq(providerCredentials.id, existing[0].id));

    return c.json({ success: true, id: existing[0].id });
  } else {
    // Create new
    const id = generateId();
    await db.insert(providerCredentials).values({
      id,
      userId: user.id,
      provider: body.provider,
      apiToken: body.api_token,
      metadata: body.metadata ? JSON.stringify(body.metadata) : null,
      createdAt: now,
      updatedAt: now,
    });

    return c.json({ success: true, id }, 201);
  }
});

/**
 * DELETE /infrastructure/credentials/:provider
 * Remove a provider credential
 */
infrastructureRoutes.delete('/credentials/:provider', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const provider = c.req.param('provider') as InfraProvider;
  const db = createDb(c.env.DB);

  await db
    .delete(providerCredentials)
    .where(
      and(
        eq(providerCredentials.userId, user.id),
        eq(providerCredentials.provider, provider)
      )
    );

  return c.json({ success: true });
});

// ============================================================================
// Resources
// ============================================================================

/**
 * GET /infrastructure/workspaces/:workspaceId/deployment-settings
 * Get deployment settings for a workspace
 */
infrastructureRoutes.get('/workspaces/:workspaceId/deployment-settings', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const workspaceId = c.req.param('workspaceId');
  const db = createDb(c.env.DB);

  const projectId = await getWorkspaceProjectId(db, workspaceId, user.id);
  if (!projectId) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } }, 404);
  }

  const existing = await db
    .select()
    .from(deploymentSettings)
    .where(eq(deploymentSettings.workspaceId, workspaceId))
    .limit(1);

  const now = new Date().toISOString();
  const settings: DeploymentSettings = existing.length > 0
    ? {
      workspace_id: existing[0].workspaceId,
      auto_deploy: existing[0].autoDeploy === 1,
      runtime_override: (existing[0].runtimeOverride as DeploymentSettings['runtime_override']) ?? null,
      build_command: existing[0].buildCommand ?? null,
      start_command: existing[0].startCommand ?? null,
      created_at: existing[0].createdAt,
      updated_at: existing[0].updatedAt,
    }
    : {
      workspace_id: workspaceId,
      auto_deploy: false,
      runtime_override: null,
      build_command: null,
      start_command: null,
      created_at: now,
      updated_at: now,
    };

  return c.json({ settings });
});

/**
 * PUT /infrastructure/workspaces/:workspaceId/deployment-settings
 * Update deployment settings for a workspace
 */
infrastructureRoutes.put('/workspaces/:workspaceId/deployment-settings', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const workspaceId = c.req.param('workspaceId');
  const db = createDb(c.env.DB);

  const projectId = await getWorkspaceProjectId(db, workspaceId, user.id);
  if (!projectId) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } }, 404);
  }

  const body = await c.req.json<UpdateDeploymentSettingsRequest>();
  const now = new Date().toISOString();

  const existing = await db
    .select()
    .from(deploymentSettings)
    .where(eq(deploymentSettings.workspaceId, workspaceId))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(deploymentSettings)
      .set({
        autoDeploy: body.auto_deploy !== undefined ? (body.auto_deploy ? 1 : 0) : existing[0].autoDeploy,
        runtimeOverride: body.runtime_override ?? existing[0].runtimeOverride,
        buildCommand: body.build_command ?? existing[0].buildCommand,
        startCommand: body.start_command ?? existing[0].startCommand,
        updatedAt: now,
      })
      .where(eq(deploymentSettings.workspaceId, workspaceId));
  } else {
    await db.insert(deploymentSettings).values({
      workspaceId,
      autoDeploy: body.auto_deploy ? 1 : 0,
      runtimeOverride: body.runtime_override ?? null,
      buildCommand: body.build_command ?? null,
      startCommand: body.start_command ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }

  const settings: DeploymentSettings = {
    workspace_id: workspaceId,
    auto_deploy: body.auto_deploy ?? (existing[0]?.autoDeploy === 1) ?? false,
    runtime_override: body.runtime_override ?? existing[0]?.runtimeOverride ?? null,
    build_command: body.build_command ?? existing[0]?.buildCommand ?? null,
    start_command: body.start_command ?? existing[0]?.startCommand ?? null,
    created_at: existing[0]?.createdAt ?? now,
    updated_at: now,
  };

  return c.json({ settings });
});

/**
 * GET /infrastructure/workspaces/:workspaceId/deployments
 * List deployments for a workspace
 */
infrastructureRoutes.get('/workspaces/:workspaceId/deployments', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const workspaceId = c.req.param('workspaceId');
  const db = createDb(c.env.DB);

  const projectId = await getWorkspaceProjectId(db, workspaceId, user.id);
  if (!projectId) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } }, 404);
  }

  const limitParam = c.req.query('limit');
  const limit = Math.min(100, Math.max(1, Number(limitParam || 30)));

  const rows = await db
    .select()
    .from(deployments)
    .where(eq(deployments.workspaceId, workspaceId))
    .orderBy(desc(deployments.startedAt))
    .limit(limit);

  const results: DeploymentRecord[] = rows.map((row) => ({
    id: row.id,
    workspace_id: row.workspaceId,
    project_id: row.projectId,
    snapshot_id: row.snapshotId,
    status: row.status as DeploymentRecord['status'],
    trigger: row.trigger as DeploymentRecord['trigger'],
    url: row.url,
    error: row.error,
    started_at: row.startedAt,
    completed_at: row.completedAt,
  }));

  return c.json({ deployments: results });
});

/**
 * POST /infrastructure/deployments/:deploymentId/status
 * Update deployment status (internal callback)
 */
infrastructureRoutes.post('/deployments/:deploymentId/status', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const deploymentId = c.req.param('deploymentId');
  const body = await c.req.json<UpdateDeploymentStatusRequest>();
  const db = createDb(c.env.DB);

  const result = await db
    .select({ id: deployments.id })
    .from(deployments)
    .innerJoin(projects, eq(deployments.projectId, projects.id))
    .where(and(eq(deployments.id, deploymentId), eq(projects.ownerUserId, user.id)))
    .limit(1);

  if (result.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Deployment not found' } }, 404);
  }

  const completedAt = body.completed_at || (body.status !== 'deploying' ? new Date().toISOString() : null);

  await db
    .update(deployments)
    .set({
      status: body.status,
      url: body.url ?? null,
      error: body.error ?? null,
      completedAt,
    })
    .where(eq(deployments.id, deploymentId));

  return c.json({ success: true });
});

/**
 * GET /infrastructure/projects/:projectId/resources
 * List all infrastructure resources for a project
 */
infrastructureRoutes.get('/projects/:projectId/resources', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DB);

  // Verify ownership
  if (!(await verifyProjectOwnership(db, projectId, user.id))) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  const resources = await db
    .select()
    .from(infrastructureResources)
    .where(eq(infrastructureResources.projectId, projectId));

  // Mask connection info
  const maskedResources: InfrastructureResource[] = resources.map((r) => ({
    id: r.id,
    project_id: r.projectId,
    type: r.type as ResourceType,
    provider: r.provider as InfraProvider,
    provider_resource_id: r.providerResourceId,
    name: r.name,
    connection_info: r.connectionInfo ? '••••••••' : null,
    status: r.status as InfrastructureResource['status'],
    error: r.error,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  }));

  return c.json({ resources: maskedResources });
});

/**
 * GET /infrastructure/projects/:projectId/resources/:resourceId
 * Get a specific resource
 */
infrastructureRoutes.get('/projects/:projectId/resources/:resourceId', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const resourceId = c.req.param('resourceId');
  const db = createDb(c.env.DB);

  // Verify ownership
  if (!(await verifyProjectOwnership(db, projectId, user.id))) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  const resources = await db
    .select()
    .from(infrastructureResources)
    .where(
      and(
        eq(infrastructureResources.id, resourceId),
        eq(infrastructureResources.projectId, projectId)
      )
    )
    .limit(1);

  if (resources.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Resource not found' } }, 404);
  }

  const r = resources[0];

  return c.json({
    resource: {
      id: r.id,
      project_id: r.projectId,
      type: r.type as ResourceType,
      provider: r.provider as InfraProvider,
      provider_resource_id: r.providerResourceId,
      name: r.name,
      connection_info: r.connectionInfo ? '••••••••' : null,
      status: r.status,
      error: r.error,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    },
  });
});

/**
 * DELETE /infrastructure/projects/:projectId/resources/:resourceId
 * Delete a resource
 */
infrastructureRoutes.delete('/projects/:projectId/resources/:resourceId', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const resourceId = c.req.param('resourceId');
  const db = createDb(c.env.DB);

  // Verify ownership
  if (!(await verifyProjectOwnership(db, projectId, user.id))) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  // Get the resource
  const resources = await db
    .select()
    .from(infrastructureResources)
    .where(
      and(
        eq(infrastructureResources.id, resourceId),
        eq(infrastructureResources.projectId, projectId)
      )
    )
    .limit(1);

  if (resources.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Resource not found' } }, 404);
  }

  const resource = resources[0];

  // Get provider credentials
  const creds = await db
    .select()
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.userId, user.id),
        eq(providerCredentials.provider, resource.provider)
      )
    )
    .limit(1);

  if (creds.length > 0 && resource.providerResourceId) {
    // Try to destroy the resource in the provider
    try {
      const provider = getProvider(resource.provider as InfraProvider);
      const metadata = creds[0].metadata ? JSON.parse(creds[0].metadata) : {};
      await provider.destroy(resource.providerResourceId, {
        provider: resource.provider as InfraProvider,
        apiToken: creds[0].apiToken,
        metadata,
      });
    } catch (error) {
      console.error('Failed to destroy resource in provider:', error);
      // Continue with deletion anyway
    }
  }

  // Mark as deleted (or actually delete)
  await db
    .update(infrastructureResources)
    .set({ status: 'deleted', updatedAt: new Date().toISOString() })
    .where(eq(infrastructureResources.id, resourceId));

  return c.json({ success: true });
});

// ============================================================================
// Detection & Deployment
// ============================================================================

/**
 * GET /infrastructure/projects/:projectId/detect
 * Detect requirements from project files
 */
infrastructureRoutes.get('/projects/:projectId/detect', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const manifestHash = c.req.query('manifest_hash');
  const db = createDb(c.env.DB);

  // Verify ownership
  if (!(await verifyProjectOwnership(db, projectId, user.id))) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  // Get files from manifest
  // TODO: Implement getFilesFromManifest
  const files = new Map<string, string>();

  if (manifestHash) {
    // Fetch manifest and files from R2
    // This is a simplified version - actual implementation would fetch from R2
  }

  const detection = await detectRequirementsWithFallback(files, c.env);
  const suggestions = suggestResources(detection.requirements);

  return c.json({
    requirements: detection.requirements,
    suggested_resources: suggestions,
    detection: detection.metadata,
  });
});

/**
 * POST /infrastructure/projects/:projectId/deploy
 * Deploy the project (detect requirements, provision resources, deploy)
 */
infrastructureRoutes.post('/projects/:projectId/deploy', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const projectId = c.req.param('projectId');
  const body = await c.req.json<DeployProjectRequest>();
  const db = createDb(c.env.DB);

  // Verify ownership
  if (!(await verifyProjectOwnership(db, projectId, user.id))) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  const deploymentId = generateId();
  const now = new Date().toISOString();
  const workspaceId = body.workspace_id || null;
  const trigger = body.source || 'manual';
  const provisionedResources: InfrastructureResource[] = [];

  if (workspaceId) {
    const workspaceProjectId = await getWorkspaceProjectId(db, workspaceId, user.id);
    if (!workspaceProjectId || workspaceProjectId !== projectId) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } }, 404);
    }
  }

  await db.insert(deployments).values({
    id: deploymentId,
    workspaceId,
    projectId,
    snapshotId: null,
    status: 'deploying',
    trigger,
    url: null,
    error: null,
    startedAt: now,
    completedAt: null,
  });

  try {
    // 1. Get files from manifest
    const files = new Map<string, string>();
    // TODO: Fetch files from R2 using manifest_hash

    // 2. Detect requirements
    const detection = await detectRequirementsWithFallback(files, c.env);
    const requirements = detection.requirements;
    const suggestions = suggestResources(requirements);

    // 3. Get existing resources
    const existingResources = await db
      .select()
      .from(infrastructureResources)
      .where(
        and(
          eq(infrastructureResources.projectId, projectId),
          eq(infrastructureResources.status, 'ready')
        )
      );

    // 4. Get provider credentials
    const allCreds = await db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.userId, user.id));

    const userCredsByProvider = new Map(
      allCreds.map((c) => [
        c.provider,
        {
          provider: c.provider as InfraProvider,
          apiToken: c.apiToken,
          metadata: c.metadata ? JSON.parse(c.metadata) : {},
        },
      ])
    );

    const managedCredsByProvider = new Map<InfraProvider, ProviderCredentials>();
    if (c.env.CLOUDFLARE_DEPLOY_TOKEN && c.env.CLOUDFLARE_ACCOUNT_ID) {
      managedCredsByProvider.set('cloudflare', {
        provider: 'cloudflare',
        apiToken: c.env.CLOUDFLARE_DEPLOY_TOKEN,
        metadata: { accountId: c.env.CLOUDFLARE_ACCOUNT_ID },
      });
    }
    if (c.env.RAILWAY_DEPLOY_TOKEN) {
      managedCredsByProvider.set('railway', {
        provider: 'railway',
        apiToken: c.env.RAILWAY_DEPLOY_TOKEN,
        metadata: c.env.RAILWAY_PROJECT_ID ? { projectId: c.env.RAILWAY_PROJECT_ID } : {},
      });
    }

    // 5. Provision missing resources
    for (const suggestion of suggestions) {
      // Skip compute for now (handled separately)
      if (suggestion.type === 'compute' || suggestion.type === 'compute:edge') {
        continue;
      }

      // Check if already exists
      const existing = existingResources.find(
        (r) => r.type === suggestion.type && r.status === 'ready'
      );
      if (existing) {
        continue;
      }

      const selection = selectProviderForType(
        suggestion.type,
        suggestion.provider_candidates,
        userCredsByProvider,
        managedCredsByProvider
      );
      if (!selection) {
        console.warn(`No credentials available for ${suggestion.type}, skipping`);
        continue;
      }

      // Provision the resource
      const provider = getProvider(selection.provider);
      const resourceId = generateId();

      // Create resource record first (pending)
      await db.insert(infrastructureResources).values({
        id: resourceId,
        projectId,
        type: suggestion.type,
        provider: selection.provider,
        name: suggestion.name,
        status: 'provisioning',
        createdAt: now,
        updatedAt: now,
      });

      try {
        const result = await provider.provision(suggestion.type, {
          name: suggestion.name,
          projectId,
          envVarName: suggestion.envVar,
        }, selection.creds);

        if (result.success) {
          // Update resource with provider ID and connection info
          await db
            .update(infrastructureResources)
            .set({
              providerResourceId: result.resourceId,
              connectionInfo: result.connectionInfo
                ? await encryptConnectionInfo(c.env, result.connectionInfo)
                : null,
              status: 'ready',
              updatedAt: new Date().toISOString(),
            })
            .where(eq(infrastructureResources.id, resourceId));

          provisionedResources.push({
            id: resourceId,
            project_id: projectId,
            type: suggestion.type,
            provider: selection.provider,
            provider_resource_id: result.resourceId,
            name: suggestion.name,
            connection_info: null,
            status: 'ready',
            error: null,
            created_at: now,
            updated_at: now,
          });

          // TODO: Add connection URL to project env vars
        } else {
          await db
            .update(infrastructureResources)
            .set({
              status: 'error',
              error: result.error || 'Unknown error',
              updatedAt: new Date().toISOString(),
            })
            .where(eq(infrastructureResources.id, resourceId));
        }
      } catch (error) {
        await db
          .update(infrastructureResources)
          .set({
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(infrastructureResources.id, resourceId));
      }
    }

    // 6. Deploy compute resource
    // Find the compute suggestion
    const computeSuggestion = suggestions.find(
      (s) => s.type === 'compute' || s.type === 'compute:edge'
    );

    let deployUrl: string | null = null;

    if (computeSuggestion) {
        const computeSelection = selectProviderForType(
          computeSuggestion.type,
          computeSuggestion.provider_candidates,
          userCredsByProvider,
          managedCredsByProvider
        );
        if (computeSelection) {
          const provider = getProvider(computeSelection.provider);

        // Check for existing compute resource
        const existingCompute = existingResources.find(
          (r) => r.type === computeSuggestion.type
        );

        // Convert files to Uint8Array map (Workers-compatible)
        const encoder = new TextEncoder();
        const fileBuffers = new Map<string, Uint8Array>();
        for (const [path, content] of files) {
          fileBuffers.set(path, encoder.encode(content));
        }

        // TODO: Collect env vars from provisioned resources
        const envVars: Record<string, string> = {};

          const deployResult = await provider.deploy(
            existingCompute?.providerResourceId || null,
            fileBuffers,
            {
              name: `fastest-${projectId.slice(0, 8)}`,
              projectId,
              envVars,
              buildCommand: requirements.buildCommand || undefined,
              startCommand: requirements.startCommand || undefined,
            },
            computeSelection.creds
          );

        if (deployResult.success) {
          deployUrl = deployResult.url || null;

          // Update or create compute resource record
          if (existingCompute) {
            await db
              .update(infrastructureResources)
              .set({ updatedAt: new Date().toISOString() })
              .where(eq(infrastructureResources.id, existingCompute.id));
          } else {
            const computeResourceId = generateId();
            await db.insert(infrastructureResources).values({
              id: computeResourceId,
              projectId,
              type: computeSuggestion.type,
              provider: computeSelection.provider,
              providerResourceId: deployResult.deploymentId || null,
              name: 'app',
              status: 'ready',
              createdAt: now,
              updatedAt: now,
            });
          }
        }
      }
    }

    // 7. Get all resources for response
    const allResources = await db
      .select()
      .from(infrastructureResources)
      .where(eq(infrastructureResources.projectId, projectId));

    const responseResources: InfrastructureResource[] = allResources.map((r) => ({
      id: r.id,
      project_id: r.projectId,
      type: r.type as ResourceType,
      provider: r.provider as InfraProvider,
      provider_resource_id: r.providerResourceId,
      name: r.name,
      connection_info: null,
      status: r.status as InfrastructureResource['status'],
      error: r.error,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    }));

    await db
      .update(deployments)
      .set({
        status: 'success',
        url: deployUrl,
        error: null,
        completedAt: new Date().toISOString(),
      })
      .where(eq(deployments.id, deploymentId));

    return c.json({
      success: true,
      deployment_id: deploymentId,
      url: deployUrl,
      resources: responseResources,
      provisioned_resources: provisionedResources,
      error: null,
    });
  } catch (error) {
    console.error('Deployment failed:', error);
    await db
      .update(deployments)
      .set({
        status: 'failed',
        url: null,
        error: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString(),
      })
      .where(eq(deployments.id, deploymentId));
    return c.json({
      success: false,
      deployment_id: deploymentId,
      url: null,
      resources: [],
      provisioned_resources: [],
      error: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});
