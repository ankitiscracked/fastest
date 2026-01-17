/**
 * Fastest Sandbox Runner
 *
 * This is the main entry point for running agent jobs in CloudFlare Sandboxes.
 *
 * Usage:
 *   JOB_ID=xxx API_URL=https://api.example.com API_TOKEN=xxx bun run src/index.ts
 *
 * Or to poll for next job:
 *   API_URL=https://api.example.com API_TOKEN=xxx bun run src/index.ts
 */

import { ApiClient } from './api';
import { Workspace } from './workspace';
import { runOpenCode, isOpenCodeInstalled } from './agent';
import { createSnapshot } from './snapshot';
import type { Job } from '@fastest/shared';

// Configuration from environment
const config = {
  apiUrl: process.env.API_URL || 'http://localhost:8788',
  apiToken: process.env.API_TOKEN || '',
  jobId: process.env.JOB_ID,
  workDir: process.env.WORK_DIR || '/tmp/workspace',
  anthropicKey: process.env.ANTHROPIC_API_KEY,
  openaiKey: process.env.OPENAI_API_KEY,
  googleKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  provider: process.env.PROVIDER || 'anthropic',
  maxSteps: parseInt(process.env.MAX_STEPS || '50'),
};

async function main() {
  console.log('='.repeat(60));
  console.log('Fastest Sandbox Runner');
  console.log('='.repeat(60));

  // Validate configuration
  if (!config.apiToken) {
    console.error('Error: API_TOKEN is required');
    process.exit(1);
  }

  // Check if OpenCode is installed
  const openCodeInstalled = await isOpenCodeInstalled();
  if (!openCodeInstalled) {
    console.error('Error: OpenCode is not installed. Install it with: npm install -g opencode');
    process.exit(1);
  }
  console.log('OpenCode: installed');

  // Create API client
  const api = new ApiClient({
    baseUrl: config.apiUrl,
    token: config.apiToken,
  });

  // Get job to run
  let job: Job | null = null;

  if (config.jobId) {
    // Run specific job
    console.log(`Fetching job ${config.jobId}...`);
    job = await api.getJob(config.jobId);
  } else {
    // Poll for next pending job
    console.log('Polling for next pending job...');
    job = await api.getNextJob();
  }

  if (!job) {
    console.log('No pending jobs found');
    process.exit(0);
  }

  console.log(`\nJob: ${job.id}`);
  console.log(`  Workspace: ${job.workspace_id}`);
  console.log(`  Prompt: ${job.prompt.slice(0, 100)}${job.prompt.length > 100 ? '...' : ''}`);

  // Run the job
  await runJob(api, job);
}

async function runJob(api: ApiClient, job: Job) {
  const startTime = Date.now();

  try {
    // Mark job as running
    console.log('\nMarking job as running...');
    await api.updateJobStatus(job.id, 'running');

    // Get workspace details
    console.log('Fetching workspace details...');
    const workspace = await api.getWorkspace(job.workspace_id);

    if (!workspace.base_snapshot_id) {
      throw new Error('Workspace has no base snapshot');
    }

    // Create workspace manager
    const ws = new Workspace({
      workDir: config.workDir,
      api,
    });

    // Download and restore workspace
    console.log('\nRestoring workspace...');
    await ws.restore(workspace.base_snapshot_id);

    // Determine API key based on provider
    let apiKey: string | undefined;
    if (config.provider === 'openai') {
      apiKey = config.openaiKey;
    } else if (config.provider === 'google') {
      apiKey = config.googleKey;
    } else {
      apiKey = config.anthropicKey;
    }

    if (!apiKey) {
      throw new Error(`No API key provided for provider: ${config.provider}`);
    }

    // Run OpenCode
    console.log('\nRunning OpenCode...');
    const result = await runOpenCode(job.prompt, {
      workDir: config.workDir,
      apiKey,
      provider: config.provider,
      maxSteps: config.maxSteps,
    });

    if (!result.success) {
      throw new Error(result.error || 'Agent execution failed');
    }

    console.log('OpenCode completed successfully');

    // Create snapshot from modified workspace
    console.log('\nCreating output snapshot...');
    const snapshotResult = await createSnapshot(
      ws,
      api,
      workspace.project_id,
      workspace.base_snapshot_id
    );

    // Mark job as completed
    console.log('\nMarking job as completed...');
    await api.updateJobStatus(job.id, 'completed', {
      outputSnapshotId: snapshotResult.snapshotId,
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n' + '='.repeat(60));
    console.log('Job completed successfully!');
    console.log(`  Duration: ${duration}s`);
    console.log(`  Output snapshot: ${snapshotResult.snapshotId}`);
    console.log(`  Changes: +${snapshotResult.filesAdded} ~${snapshotResult.filesModified} -${snapshotResult.filesDeleted}`);
    console.log(`  Blobs uploaded: ${snapshotResult.blobsUploaded}`);
    console.log('='.repeat(60));

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`\nJob failed: ${errorMessage}`);

    // Mark job as failed
    try {
      await api.updateJobStatus(job.id, 'failed', { error: errorMessage });
    } catch (updateError) {
      console.error('Failed to update job status:', updateError);
    }

    process.exit(1);
  }
}

// Run main
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
