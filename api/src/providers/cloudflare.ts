import type { ResourceType } from '@fastest/shared';
import type {
  ResourceProvider,
  ProviderCredentials,
  ProvisionConfig,
  ProvisionResult,
  DeployResult,
  ResourceInfo,
} from './types';
import { ProviderError } from './types';

/**
 * Cloudflare provider implementation
 * Supports: compute:edge (Workers), storage:blob (R2)
 *
 * Note: This provider is designed to work with wrangler CLI for deployments.
 * For edge workers, the actual deployment happens via sandbox execution.
 */
export class CloudflareProvider implements ResourceProvider {
  readonly name = 'cloudflare' as const;
  readonly supportedTypes: ResourceType[] = [
    'compute:edge',
    'storage:blob',
  ];

  private readonly apiBase = 'https://api.cloudflare.com/client/v4';

  private async api<T>(
    path: string,
    method: string,
    creds: ProviderCredentials,
    body?: unknown
  ): Promise<T> {
    const response = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creds.apiToken}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new ProviderError(
        'cloudflare',
        'API_ERROR',
        `Cloudflare API returned ${response.status}: ${text}`
      );
    }

    const result = (await response.json()) as {
      success: boolean;
      errors?: Array<{ code: number; message: string }>;
      result?: T;
    };

    if (!result.success) {
      const errorMsg = result.errors?.[0]?.message || 'Unknown error';
      throw new ProviderError('cloudflare', 'API_ERROR', errorMsg);
    }

    return result.result as T;
  }

  async validateCredentials(creds: ProviderCredentials): Promise<boolean> {
    try {
      await this.api<{ id: string }>('/user/tokens/verify', 'GET', creds);
      return true;
    } catch {
      return false;
    }
  }

  async provision(
    type: ResourceType,
    config: ProvisionConfig,
    creds: ProviderCredentials
  ): Promise<ProvisionResult> {
    if (type === 'compute:edge') {
      return this.provisionWorker(config, creds);
    } else if (type === 'storage:blob') {
      return this.provisionR2Bucket(config, creds);
    }

    throw new ProviderError('cloudflare', 'UNSUPPORTED_TYPE', `Unsupported resource type: ${type}`);
  }

  private async provisionWorker(
    config: ProvisionConfig,
    creds: ProviderCredentials
  ): Promise<ProvisionResult> {
    // Workers are created on first deploy, so we just return a placeholder
    // The actual worker name will be based on project ID
    const workerName = `fastest-${config.projectId.slice(0, 8)}`;

    return {
      success: true,
      resourceId: workerName,
    };
  }

  private async provisionR2Bucket(
    config: ProvisionConfig,
    creds: ProviderCredentials
  ): Promise<ProvisionResult> {
    const accountId = creds.metadata?.accountId;
    if (!accountId) {
      throw new ProviderError(
        'cloudflare',
        'MISSING_ACCOUNT_ID',
        'Account ID is required for R2 bucket creation'
      );
    }

    const bucketName = `fastest-${config.projectId.slice(0, 8)}-${config.name}`.toLowerCase();

    try {
      await this.api(
        `/accounts/${accountId}/r2/buckets`,
        'POST',
        creds,
        { name: bucketName }
      );

      return {
        success: true,
        resourceId: bucketName,
        connectionInfo: {
          url: `https://${accountId}.r2.cloudflarestorage.com/${bucketName}`,
        },
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        'cloudflare',
        'PROVISION_FAILED',
        `Failed to create R2 bucket: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async deploy(
    resourceId: string | null,
    files: Map<string, Uint8Array>,
    config: ProvisionConfig,
    creds: ProviderCredentials
  ): Promise<DeployResult> {
    // Cloudflare Workers deployment is handled via wrangler CLI in the sandbox
    // This method provides the configuration needed for that deployment
    const workerName = resourceId || `fastest-${config.projectId.slice(0, 8)}`;
    const accountId = creds.metadata?.accountId;

    if (!accountId) {
      return {
        success: false,
        error: 'Account ID is required for Cloudflare deployment',
      };
    }

    // For actual deployment, we need to use wrangler in the sandbox
    // This method returns the expected URL
    return {
      success: true,
      deploymentId: workerName,
      url: `https://${workerName}.${accountId}.workers.dev`,
    };
  }

  /**
   * Deploy a worker using Cloudflare API directly
   * This is used when we have the bundled worker code
   */
  async deployWorkerScript(
    workerName: string,
    scriptContent: string,
    creds: ProviderCredentials,
    envVars?: Record<string, string>
  ): Promise<DeployResult> {
    const accountId = creds.metadata?.accountId;
    if (!accountId) {
      return {
        success: false,
        error: 'Account ID is required',
      };
    }

    try {
      // Create FormData for script upload
      const metadata = {
        main_module: 'worker.js',
        bindings: envVars
          ? Object.entries(envVars).map(([name, text]) => ({
              type: 'plain_text',
              name,
              text,
            }))
          : [],
      };

      // Upload the worker script
      const formData = new FormData();
      formData.append('metadata', JSON.stringify(metadata));
      formData.append(
        'worker.js',
        new Blob([scriptContent], { type: 'application/javascript+module' }),
        'worker.js'
      );

      const response = await fetch(
        `${this.apiBase}/accounts/${accountId}/workers/scripts/${workerName}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${creds.apiToken}`,
          },
          body: formData,
        }
      );

      if (!response.ok) {
        const text = await response.text();
        return {
          success: false,
          error: `Failed to deploy worker: ${text}`,
        };
      }

      // Enable the worker on workers.dev subdomain
      await this.api(
        `/accounts/${accountId}/workers/scripts/${workerName}/subdomain`,
        'POST',
        creds,
        { enabled: true }
      );

      return {
        success: true,
        deploymentId: workerName,
        url: `https://${workerName}.${accountId}.workers.dev`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getStatus(resourceId: string, creds: ProviderCredentials): Promise<ResourceInfo> {
    const accountId = creds.metadata?.accountId;
    if (!accountId) {
      return {
        resourceId,
        status: 'error',
        error: 'Account ID is required',
      };
    }

    try {
      const result = await this.api<{ id: string; etag: string }>(
        `/accounts/${accountId}/workers/scripts/${resourceId}`,
        'GET',
        creds
      );

      return {
        resourceId,
        status: 'ready',
        url: `https://${resourceId}.${accountId}.workers.dev`,
      };
    } catch {
      return {
        resourceId,
        status: 'pending',
      };
    }
  }

  async destroy(resourceId: string, creds: ProviderCredentials): Promise<void> {
    const accountId = creds.metadata?.accountId;
    if (!accountId) {
      throw new ProviderError(
        'cloudflare',
        'MISSING_ACCOUNT_ID',
        'Account ID is required'
      );
    }

    await this.api(
      `/accounts/${accountId}/workers/scripts/${resourceId}`,
      'DELETE',
      creds
    );
  }
}
