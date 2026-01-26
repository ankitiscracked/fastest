import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import type { Env } from '../index';
import { createDb, providerCredentials, infrastructureResources, projects } from '../db';
import { getAuthUser } from '../middleware/auth';
import type {
  InfraProvider,
  ResourceType,
  SetProviderCredentialRequest,
  DeployProjectRequest,
  InfrastructureResource,
} from '@fastest/shared';
import {
  getProvider,
  getDefaultProviderNameForType,
  validateProviderCredentials,
  ProviderError,
} from '../providers';
import type { ProviderCredentials } from '../providers';
import { detectRequirements, suggestResources } from '../detection';

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

  const requirements = await detectRequirements(files);
  const suggestions = suggestResources(requirements);

  return c.json({
    requirements,
    suggested_resources: suggestions,
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
  const provisionedResources: InfrastructureResource[] = [];

  try {
    // 1. Get files from manifest
    const files = new Map<string, string>();
    // TODO: Fetch files from R2 using manifest_hash

    // 2. Detect requirements
    const requirements = await detectRequirements(files);
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

    const credsByProvider = new Map(
      allCreds.map((c) => [
        c.provider,
        {
          provider: c.provider as InfraProvider,
          apiToken: c.apiToken,
          metadata: c.metadata ? JSON.parse(c.metadata) : {},
        },
      ])
    );

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

      // Get credentials for this provider
      const creds = credsByProvider.get(suggestion.provider);
      if (!creds) {
        console.warn(`No credentials for provider ${suggestion.provider}, skipping ${suggestion.type}`);
        continue;
      }

      // Provision the resource
      const provider = getProvider(suggestion.provider);
      const resourceId = generateId();

      // Create resource record first (pending)
      await db.insert(infrastructureResources).values({
        id: resourceId,
        projectId,
        type: suggestion.type,
        provider: suggestion.provider,
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
        }, creds);

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
            provider: suggestion.provider,
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
      const creds = credsByProvider.get(computeSuggestion.provider);
      if (creds) {
        const provider = getProvider(computeSuggestion.provider);

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
          creds
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
              provider: computeSuggestion.provider,
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
