import { INFRA_PROVIDERS } from '@fastest/shared';
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

const RAILWAY_API = 'https://backboard.railway.app/graphql/v2';

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

/**
 * Railway provider implementation
 * Supports: compute, database:postgres, database:redis
 */
export class RailwayProvider implements ResourceProvider {
  readonly name = 'railway' as const;
  readonly supportedTypes: ResourceType[] = INFRA_PROVIDERS.railway.supportedTypes;

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    creds: ProviderCredentials
  ): Promise<T> {
    const response = await fetch(RAILWAY_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creds.apiToken}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new ProviderError(
        'railway',
        'API_ERROR',
        `Railway API returned ${response.status}: ${await response.text()}`
      );
    }

    const result = (await response.json()) as GraphQLResponse<T>;

    if (result.errors && result.errors.length > 0) {
      throw new ProviderError(
        'railway',
        'GRAPHQL_ERROR',
        result.errors[0].message,
        { errors: result.errors }
      );
    }

    if (!result.data) {
      throw new ProviderError('railway', 'NO_DATA', 'No data returned from Railway API');
    }

    return result.data;
  }

  async validateCredentials(creds: ProviderCredentials): Promise<boolean> {
    try {
      const query = `query { me { id email } }`;
      await this.graphql<{ me: { id: string; email: string } }>(query, {}, creds);
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
    // First, ensure we have a Railway project
    const projectId = await this.ensureProject(config, creds);

    if (type === 'compute') {
      return this.provisionService(projectId, config, creds);
    } else if (type === 'database:postgres') {
      return this.provisionPostgres(projectId, config, creds);
    } else if (type === 'database:redis') {
      return this.provisionRedis(projectId, config, creds);
    }

    throw new ProviderError('railway', 'UNSUPPORTED_TYPE', `Unsupported resource type: ${type}`);
  }

  private async ensureProject(
    config: ProvisionConfig,
    creds: ProviderCredentials
  ): Promise<string> {
    // Check if we already have a project ID in metadata
    if (creds.metadata?.projectId) {
      return creds.metadata.projectId;
    }

    // Create a new project
    const query = `
      mutation CreateProject($name: String!) {
        projectCreate(input: { name: $name }) {
          id
          name
        }
      }
    `;

    const result = await this.graphql<{
      projectCreate: { id: string; name: string };
    }>(query, { name: `fastest-${config.projectId.slice(0, 8)}` }, creds);

    return result.projectCreate.id;
  }

  private async provisionService(
    railwayProjectId: string,
    config: ProvisionConfig,
    creds: ProviderCredentials
  ): Promise<ProvisionResult> {
    // Create an empty service (code will be deployed later)
    const query = `
      mutation CreateService($projectId: String!, $name: String!) {
        serviceCreate(input: { projectId: $projectId, name: $name }) {
          id
          name
        }
      }
    `;

    const result = await this.graphql<{
      serviceCreate: { id: string; name: string };
    }>(query, { projectId: railwayProjectId, name: config.name }, creds);

    return {
      success: true,
      resourceId: result.serviceCreate.id,
    };
  }

  private async provisionPostgres(
    railwayProjectId: string,
    config: ProvisionConfig,
    creds: ProviderCredentials
  ): Promise<ProvisionResult> {
    // Create PostgreSQL database using Railway's template
    const query = `
      mutation CreatePostgres($projectId: String!, $name: String!) {
        templateDeploy(input: {
          projectId: $projectId
          services: [{
            name: $name
            source: { image: "postgres:15" }
            variables: {
              POSTGRES_USER: "postgres"
              POSTGRES_DB: "railway"
            }
            volumes: [{
              mountPath: "/var/lib/postgresql/data"
              name: "pgdata"
            }]
          }]
        }) {
          projectId
          services {
            id
            name
          }
        }
      }
    `;

    try {
      const result = await this.graphql<{
        templateDeploy: {
          projectId: string;
          services: Array<{ id: string; name: string }>;
        };
      }>(query, { projectId: railwayProjectId, name: config.name || 'postgres' }, creds);

      const service = result.templateDeploy.services[0];
      if (!service) {
        throw new ProviderError('railway', 'NO_SERVICE', 'No service created');
      }

      // Wait for the database to be ready and get connection info
      const connectionInfo = await this.waitForDatabaseReady(service.id, creds);

      return {
        success: true,
        resourceId: service.id,
        connectionInfo,
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        'railway',
        'PROVISION_FAILED',
        `Failed to provision PostgreSQL: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async provisionRedis(
    railwayProjectId: string,
    config: ProvisionConfig,
    creds: ProviderCredentials
  ): Promise<ProvisionResult> {
    // Create Redis using Railway's template
    const query = `
      mutation CreateRedis($projectId: String!, $name: String!) {
        templateDeploy(input: {
          projectId: $projectId
          services: [{
            name: $name
            source: { image: "redis:7" }
            volumes: [{
              mountPath: "/data"
              name: "redis-data"
            }]
          }]
        }) {
          projectId
          services {
            id
            name
          }
        }
      }
    `;

    try {
      const result = await this.graphql<{
        templateDeploy: {
          projectId: string;
          services: Array<{ id: string; name: string }>;
        };
      }>(query, { projectId: railwayProjectId, name: config.name || 'redis' }, creds);

      const service = result.templateDeploy.services[0];
      if (!service) {
        throw new ProviderError('railway', 'NO_SERVICE', 'No service created');
      }

      // Wait for Redis to be ready
      const connectionInfo = await this.waitForDatabaseReady(service.id, creds);

      return {
        success: true,
        resourceId: service.id,
        connectionInfo,
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        'railway',
        'PROVISION_FAILED',
        `Failed to provision Redis: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async waitForDatabaseReady(
    serviceId: string,
    creds: ProviderCredentials,
    maxAttempts = 30
  ): Promise<ProvisionResult['connectionInfo']> {
    const query = `
      query GetServiceVariables($serviceId: String!) {
        service(id: $serviceId) {
          id
          serviceInstances(first: 1) {
            edges {
              node {
                id
                status
              }
            }
          }
        }
        variables(serviceId: $serviceId) {
          id
          name
          value
        }
      }
    `;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await this.graphql<{
          service: {
            id: string;
            serviceInstances: {
              edges: Array<{ node: { id: string; status: string } }>;
            };
          };
          variables: Array<{ id: string; name: string; value: string }>;
        }>(query, { serviceId }, creds);

        const instance = result.service.serviceInstances.edges[0]?.node;
        if (instance?.status === 'ACTIVE' || instance?.status === 'RUNNING') {
          // Extract connection info from variables
          const vars = Object.fromEntries(
            result.variables.map((v) => [v.name, v.value])
          );

          return {
            url: vars.DATABASE_URL || vars.REDIS_URL,
            host: vars.PGHOST || vars.REDIS_HOST,
            port: parseInt(vars.PGPORT || vars.REDIS_PORT || '0', 10) || undefined,
            username: vars.PGUSER || vars.POSTGRES_USER,
            password: vars.PGPASSWORD || vars.POSTGRES_PASSWORD,
            database: vars.PGDATABASE || vars.POSTGRES_DB,
          };
        }
      } catch {
        // Ignore errors during polling
      }

      // Wait 2 seconds before next attempt
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new ProviderError(
      'railway',
      'TIMEOUT',
      'Database did not become ready within timeout'
    );
  }

  async deploy(
    resourceId: string | null,
    files: Map<string, Uint8Array>,
    config: ProvisionConfig,
    creds: ProviderCredentials
  ): Promise<DeployResult> {
    try {
      // Get or create project
      const projectId = await this.ensureProject(config, creds);

      // Get or create service
      let serviceId = resourceId;
      if (!serviceId) {
        const provision = await this.provisionService(projectId, config, creds);
        serviceId = provision.resourceId;
      }

      // Set environment variables
      if (config.envVars && Object.keys(config.envVars).length > 0) {
        await this.setServiceVariables(serviceId, config.envVars, creds);
      }

      // Create deployment using Railway's up endpoint
      // Note: Railway's deployment API requires uploading a tarball or connecting to a repo
      // For simplicity, we'll use their CLI-like approach
      const deploymentId = await this.createDeployment(serviceId, files, config, creds);

      // Get the deployment URL
      const url = await this.getServiceUrl(serviceId, creds);

      return {
        success: true,
        deploymentId,
        url,
      };
    } catch (error) {
      if (error instanceof ProviderError) {
        return {
          success: false,
          error: error.message,
        };
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async setServiceVariables(
    serviceId: string,
    variables: Record<string, string>,
    creds: ProviderCredentials
  ): Promise<void> {
    const query = `
      mutation SetVariables($serviceId: String!, $variables: ServiceVariablesInput!) {
        variableCollectionUpsert(input: {
          serviceId: $serviceId
          variables: $variables
        })
      }
    `;

    await this.graphql(query, { serviceId, variables }, creds);
  }

  private async createDeployment(
    serviceId: string,
    files: Map<string, Uint8Array>,
    config: ProvisionConfig,
    creds: ProviderCredentials
  ): Promise<string> {
    // Railway expects code via GitHub or their CLI upload
    // For now, we'll use their source upload approach

    // First, get the service to find its source
    const getQuery = `
      query GetService($serviceId: String!) {
        service(id: $serviceId) {
          id
          projectId
        }
      }
    `;

    const serviceInfo = await this.graphql<{
      service: { id: string; projectId: string };
    }>(getQuery, { serviceId }, creds);

    // Create a deployment trigger
    // Note: Full implementation would upload files as a tarball
    // This is a simplified version
    const deployQuery = `
      mutation TriggerDeploy($serviceId: String!) {
        deploymentTriggerCreate(input: { serviceId: $serviceId }) {
          id
          status
        }
      }
    `;

    const result = await this.graphql<{
      deploymentTriggerCreate: { id: string; status: string };
    }>(deployQuery, { serviceId }, creds);

    return result.deploymentTriggerCreate.id;
  }

  private async getServiceUrl(serviceId: string, creds: ProviderCredentials): Promise<string> {
    const query = `
      query GetServiceDomain($serviceId: String!) {
        service(id: $serviceId) {
          id
          serviceDomains {
            domain
          }
        }
      }
    `;

    const result = await this.graphql<{
      service: { id: string; serviceDomains: Array<{ domain: string }> };
    }>(query, { serviceId }, creds);

    const domain = result.service.serviceDomains[0]?.domain;
    return domain ? `https://${domain}` : '';
  }

  async getStatus(resourceId: string, creds: ProviderCredentials): Promise<ResourceInfo> {
    const query = `
      query GetServiceStatus($serviceId: String!) {
        service(id: $serviceId) {
          id
          serviceInstances(first: 1) {
            edges {
              node {
                id
                status
              }
            }
          }
          serviceDomains {
            domain
          }
        }
      }
    `;

    const result = await this.graphql<{
      service: {
        id: string;
        serviceInstances: {
          edges: Array<{ node: { id: string; status: string } }>;
        };
        serviceDomains: Array<{ domain: string }>;
      };
    }>(query, { serviceId: resourceId }, creds);

    const instance = result.service.serviceInstances.edges[0]?.node;
    const domain = result.service.serviceDomains[0]?.domain;

    let status: ResourceInfo['status'] = 'pending';
    if (instance?.status === 'ACTIVE' || instance?.status === 'RUNNING') {
      status = 'ready';
    } else if (instance?.status === 'BUILDING' || instance?.status === 'DEPLOYING') {
      status = 'provisioning';
    } else if (instance?.status === 'FAILED' || instance?.status === 'CRASHED') {
      status = 'error';
    }

    return {
      resourceId,
      status,
      url: domain ? `https://${domain}` : undefined,
    };
  }

  async destroy(resourceId: string, creds: ProviderCredentials): Promise<void> {
    const query = `
      mutation DeleteService($serviceId: String!) {
        serviceDelete(id: $serviceId)
      }
    `;

    await this.graphql(query, { serviceId: resourceId }, creds);
  }
}
