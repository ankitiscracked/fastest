import type { ResourceType, ResourceStatus, InfraProvider, DetectedRequirements } from '@fastest/shared';

/**
 * Credentials for authenticating with a provider
 */
export interface ProviderCredentials {
  provider: InfraProvider;
  apiToken: string;
  metadata?: {
    accountId?: string;
    teamId?: string;
    projectId?: string;  // Provider's project ID, not ours
    [key: string]: string | undefined;
  };
}

/**
 * Configuration for provisioning a resource
 */
export interface ProvisionConfig {
  /** User-friendly name for the resource */
  name: string;
  /** Our internal project ID */
  projectId: string;
  /** Environment variables to set (for compute resources) */
  envVars?: Record<string, string>;
  /** Runtime for compute resources */
  runtime?: 'node' | 'python' | 'go';
  /** Build command for compute resources */
  buildCommand?: string;
  /** Start command for compute resources */
  startCommand?: string;
  /** Environment variable name for connection info (for databases) */
  envVarName?: string;
}

/**
 * Result of provisioning a resource
 */
export interface ProvisionResult {
  success: boolean;
  /** Provider's resource ID */
  resourceId: string;
  /** Connection info for databases/caches */
  connectionInfo?: {
    url?: string;
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    database?: string;
  };
  error?: string;
}

/**
 * Result of deploying code
 */
export interface DeployResult {
  success: boolean;
  /** Provider's deployment ID */
  deploymentId?: string;
  /** Public URL of the deployed app */
  url?: string;
  error?: string;
  logs?: string[];
}

/**
 * Resource status from provider
 */
export interface ResourceInfo {
  resourceId: string;
  status: ResourceStatus;
  url?: string;
  connectionInfo?: ProvisionResult['connectionInfo'];
  error?: string;
}

/**
 * Interface that all infrastructure providers must implement
 */
export interface ResourceProvider {
  /** Provider identifier */
  readonly name: InfraProvider;

  /** Resource types this provider supports */
  readonly supportedTypes: ResourceType[];

  /**
   * Validate that credentials are valid
   */
  validateCredentials(creds: ProviderCredentials): Promise<boolean>;

  /**
   * Provision a new resource (database, cache, compute, etc.)
   */
  provision(
    type: ResourceType,
    config: ProvisionConfig,
    creds: ProviderCredentials
  ): Promise<ProvisionResult>;

  /**
   * Deploy code to a compute resource
   * @param resourceId - Provider's resource ID (or null to create new)
   * @param files - Map of file paths to contents (as Uint8Array for Workers compatibility)
   * @param config - Deployment configuration
   * @param creds - Provider credentials
   */
  deploy(
    resourceId: string | null,
    files: Map<string, Uint8Array>,
    config: ProvisionConfig,
    creds: ProviderCredentials
  ): Promise<DeployResult>;

  /**
   * Get current status of a resource
   */
  getStatus(resourceId: string, creds: ProviderCredentials): Promise<ResourceInfo>;

  /**
   * Destroy a resource
   */
  destroy(resourceId: string, creds: ProviderCredentials): Promise<void>;
}

/**
 * Error thrown by providers
 */
export class ProviderError extends Error {
  constructor(
    public readonly provider: InfraProvider,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderError';
  }
}
