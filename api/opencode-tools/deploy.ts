/**
 * OpenCode Deploy Tool
 *
 * This tool is used by the OpenCode agent to deploy projects.
 * It calls the Fastest API to detect requirements, provision resources,
 * and deploy the application.
 *
 * Environment variables required:
 * - FASTEST_API_URL: The base URL of the Fastest API
 * - FASTEST_API_TOKEN: Authentication token
 * - FASTEST_PROJECT_ID: The current project ID
 */

import { tool } from '@opencode-ai/plugin';

export default tool({
  description: `Deploy the current project to production. This tool automatically:
- Detects what your code needs (databases, caches, etc.)
- Provisions any required infrastructure
- Deploys your application
- Returns the live URL

Use this when the user wants to deploy, ship, or make their app live.`,

  args: {
    message: tool.schema
      .string()
      .optional()
      .describe('Optional deployment note or message'),
  },

  async execute(args, ctx) {
    const apiUrl = process.env.FASTEST_API_URL;
    const apiToken = process.env.FASTEST_API_TOKEN;
    const projectId = process.env.FASTEST_PROJECT_ID;

    // Validate required environment variables
    if (!apiUrl) {
      return 'Error: FASTEST_API_URL environment variable is not set. Cannot deploy.';
    }
    if (!apiToken) {
      return 'Error: FASTEST_API_TOKEN environment variable is not set. Cannot deploy.';
    }
    if (!projectId) {
      return 'Error: FASTEST_PROJECT_ID environment variable is not set. Cannot deploy.';
    }

    try {
      // Step 1: Get current manifest hash (represents current files)
      const manifestResponse = await fetch(
        `${apiUrl}/v1/projects/${projectId}/current-manifest`,
        {
          headers: {
            Authorization: `Bearer ${apiToken}`,
          },
        }
      );

      if (!manifestResponse.ok) {
        const errorText = await manifestResponse.text();
        return `Error: Failed to get current manifest: ${errorText}`;
      }

      const { manifestHash } = (await manifestResponse.json()) as { manifestHash: string };

      // Step 2: Trigger deployment
      const deployResponse = await fetch(
        `${apiUrl}/v1/infrastructure/projects/${projectId}/deploy`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiToken}`,
          },
          body: JSON.stringify({
            manifest_hash: manifestHash,
            message: args.message,
          }),
        }
      );

      if (!deployResponse.ok) {
        const errorText = await deployResponse.text();
        return `Deployment failed: ${errorText}`;
      }

      const result = (await deployResponse.json()) as {
        success: boolean;
        deployment_id: string;
        url: string | null;
        resources: Array<{
          id: string;
          type: string;
          provider: string;
          name: string;
          status: string;
        }>;
        provisioned_resources: Array<{
          id: string;
          type: string;
          provider: string;
          name: string;
        }>;
        error: string | null;
      };

      if (!result.success) {
        return `Deployment failed: ${result.error || 'Unknown error'}`;
      }

      // Build success message
      let response = `Deployment successful!`;

      if (result.url) {
        response += `\n\nYour app is live at: ${result.url}`;
      }

      if (result.provisioned_resources && result.provisioned_resources.length > 0) {
        response += `\n\nNewly provisioned resources:`;
        for (const resource of result.provisioned_resources) {
          response += `\n  - ${resource.type} (${resource.name}) on ${resource.provider}`;
        }
      }

      if (result.resources && result.resources.length > 0) {
        const readyResources = result.resources.filter((r) => r.status === 'ready');
        if (readyResources.length > 0) {
          response += `\n\nActive resources:`;
          for (const resource of readyResources) {
            response += `\n  - ${resource.type}: ${resource.name} (${resource.provider})`;
          }
        }
      }

      response += `\n\nDeployment ID: ${result.deployment_id}`;

      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Deployment error: ${message}`;
    }
  },
});
