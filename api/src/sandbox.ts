/**
 * Sandbox execution - runs OpenCode in a Cloudflare Sandbox container
 */

import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import type { Env } from './index';

interface RunJobResult {
  success: boolean;
  job_id: string;
  output_snapshot_id?: string;
  error?: string;
  duration_ms?: number;
  stdout?: string;
  stderr?: string;
}

/**
 * Generate the runner script that executes inside the sandbox
 */
function generateRunnerScript(config: {
  jobId: string;
  apiUrl: string;
  apiToken: string;
  anthropicKey?: string;
  openaiKey?: string;
  googleKey?: string;
  provider?: string;
}): string {
  return `
/**
 * Sandbox Runner - executes inside the Cloudflare Sandbox container
 */

const API_URL = ${JSON.stringify(config.apiUrl)};
const API_TOKEN = ${JSON.stringify(config.apiToken)};
const JOB_ID = ${JSON.stringify(config.jobId)};
const ANTHROPIC_API_KEY = ${JSON.stringify(config.anthropicKey || '')};
const OPENAI_API_KEY = ${JSON.stringify(config.openaiKey || '')};
const GOOGLE_GENERATIVE_AI_API_KEY = ${JSON.stringify(config.googleKey || '')};
const PROVIDER = ${JSON.stringify(config.provider || 'anthropic')};

async function apiRequest(method, path, body) {
  const response = await fetch(API_URL + path, {
    method,
    headers: {
      'Authorization': 'Bearer ' + API_TOKEN,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error('API error ' + response.status + ': ' + error);
  }

  return response.json();
}

async function downloadBlob(hash) {
  const { urls } = await apiRequest('POST', '/v1/blobs/presign-download', { hashes: [hash] });
  const relativeUrl = urls[hash];
  if (!relativeUrl) throw new Error('No download URL for blob: ' + hash);

  // Make URL absolute by prepending API_URL
  const url = relativeUrl.startsWith('http') ? relativeUrl : API_URL + relativeUrl;
  const response = await fetch(url, {
    headers: {
      'Authorization': 'Bearer ' + API_TOKEN,
    },
  });
  if (!response.ok) throw new Error('Failed to download blob: ' + hash);

  return new Uint8Array(await response.arrayBuffer());
}

async function sha256(data) {
  const buffer = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function getDefaultModel(provider) {
  switch (provider) {
    case 'google':
      return 'gemini-2.0-flash';
    case 'openai':
      return 'gpt-4o';
    case 'anthropic':
    default:
      return 'claude-sonnet-4-20250514';
  }
}

async function waitForServe(port, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch('http://localhost:' + port + '/doc');
      if (response.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

async function uploadBlob(hash, content) {
  const { urls } = await apiRequest('POST', '/v1/blobs/presign-upload', { hashes: [hash] });
  const url = urls[hash];

  const response = await fetch(url, {
    method: 'PUT',
    body: content,
  });

  if (!response.ok) throw new Error('Failed to upload blob: ' + hash);
}

async function main() {
  console.log('='.repeat(60));
  console.log('Sandbox Runner');
  console.log('Job ID:', JOB_ID);
  console.log('='.repeat(60));

  // Mark job as running
  console.log('\\nMarking job as running...');
  await apiRequest('POST', '/v1/jobs/' + JOB_ID + '/status', { status: 'running' });

  // Get job details
  console.log('Fetching job details...');
  const { job } = await apiRequest('GET', '/v1/jobs/' + JOB_ID);
  console.log('Prompt:', job.prompt.slice(0, 100) + (job.prompt.length > 100 ? '...' : ''));

  // Get workspace details
  console.log('Fetching workspace...');
  const { workspace } = await apiRequest('GET', '/v1/workspaces/' + job.workspace_id);

  const workDir = '/workspace';
  await Bun.spawn(['mkdir', '-p', workDir]).exited;

  if (workspace.base_snapshot_id) {
    // Get snapshot manifest
    console.log('Fetching snapshot...');
    const { snapshot } = await apiRequest('GET', '/v1/snapshots/' + workspace.base_snapshot_id);

    // Download manifest
    console.log('Downloading manifest...');
    const manifestData = await downloadBlob(snapshot.manifest_hash);
    const manifest = JSON.parse(new TextDecoder().decode(manifestData));
    console.log('Files in manifest:', manifest.files.length);

    // Restore files
    console.log('Restoring workspace files...');

    for (const file of manifest.files) {
      const filePath = workDir + '/' + file.path;
      const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));

      await Bun.spawn(['mkdir', '-p', dirPath]).exited;
      const content = await downloadBlob(file.hash);
      await Bun.write(filePath, content);
    }
    console.log('Restored', manifest.files.length, 'files');
  } else {
    console.log('No base snapshot - starting with empty workspace');
  }

  // Run OpenCode using serve + attach approach
  console.log('\\nRunning OpenCode...');

  // Determine which API key to use based on provider
  const env = { ...process.env };
  if (PROVIDER === 'openai') {
    env.OPENAI_API_KEY = OPENAI_API_KEY;
  } else if (PROVIDER === 'google') {
    env.GOOGLE_GENERATIVE_AI_API_KEY = GOOGLE_GENERATIVE_AI_API_KEY;
  } else {
    env.ANTHROPIC_API_KEY = ANTHROPIC_API_KEY;
  }

  // Start opencode serve
  const port = 19000 + Math.floor(Math.random() * 1000);
  console.log('Starting opencode serve on port', port, '...');

  const serve = Bun.spawn(['opencode', 'serve', '--port', String(port)], {
    cwd: workDir,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Wait for serve to be ready
  const serveReady = await waitForServe(port);
  if (!serveReady) {
    serve.kill();
    throw new Error('OpenCode serve failed to start');
  }
  console.log('Serve ready');

  // Send warmup message to prime the model
  console.log('Warming up model...');
  try {
    const warmupSession = await fetch('http://localhost:' + port + '/session?directory=' + workDir, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (warmupSession.ok) {
      const session = await warmupSession.json();
      await fetch('http://localhost:' + port + '/session/' + session.id + '/message?directory=' + workDir, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: { providerID: PROVIDER, modelID: getDefaultModel(PROVIDER) },
          parts: [{ type: 'text', text: 'say hi' }],
        }),
      });
    }
  } catch (e) {
    // Warmup failed, continue anyway
  }

  // Run the actual prompt
  console.log('Running prompt...');
  const model = getDefaultModel(PROVIDER);
  const opencode = Bun.spawn([
    'opencode', 'run', job.prompt,
    '--model', PROVIDER + '/' + model,
    '--attach', 'http://localhost:' + port,
    '--format', 'json',
  ], {
    cwd: workDir,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'pipe',
  });

  // Close stdin to prevent TTY issues
  opencode.stdin.end();

  const stdout = await new Response(opencode.stdout).text();
  const stderr = await new Response(opencode.stderr).text();
  const exitCode = await opencode.exited;

  // Kill the serve process
  serve.kill();

  console.log('OpenCode exit code:', exitCode);
  if (stderr) console.log('OpenCode stderr:', stderr);

  if (exitCode !== 0) {
    throw new Error('OpenCode failed: ' + stderr);
  }

  // Collect modified files
  console.log('\\nCollecting modified files...');
  const glob = new Bun.Glob('**/*');
  const files = [];

  for await (const path of glob.scan({ cwd: workDir, dot: false })) {
    const fullPath = workDir + '/' + path;
    const stat = await Bun.file(fullPath).stat();

    if (stat && !stat.isDirectory()) {
      const content = await Bun.file(fullPath).arrayBuffer();
      const hash = await sha256(new Uint8Array(content));
      files.push({
        path,
        hash,
        size: content.byteLength,
        mode: 420, // 0o644
        content: new Uint8Array(content),
      });
    }
  }
  console.log('Collected', files.length, 'files');

  // Build manifest
  const newManifest = {
    version: '1',
    files: files.map(f => ({
      path: f.path,
      hash: f.hash,
      size: f.size,
      mode: f.mode,
    })).sort((a, b) => a.path.localeCompare(b.path)),
  };

  const manifestJson = JSON.stringify(newManifest, null, '  ');
  const manifestHash = await sha256(manifestJson);
  console.log('Manifest hash:', manifestHash.slice(0, 16) + '...');

  // Check which blobs need uploading
  const allHashes = [...new Set(files.map(f => f.hash))];
  const { missing } = await apiRequest('POST', '/v1/blobs/exists', { hashes: allHashes });
  console.log('Blobs to upload:', missing.length, '/', allHashes.length);

  // Upload missing blobs
  for (const file of files) {
    if (missing.includes(file.hash)) {
      await uploadBlob(file.hash, file.content);
    }
  }

  // Upload manifest
  console.log('Uploading manifest...');
  const manifestResponse = await fetch(API_URL + '/v1/blobs/manifests/' + manifestHash, {
    method: 'PUT',
    headers: {
      'Authorization': 'Bearer ' + API_TOKEN,
      'Content-Type': 'application/json',
    },
    body: manifestJson,
  });

  if (!manifestResponse.ok) {
    throw new Error('Failed to upload manifest: ' + await manifestResponse.text());
  }

  // Create snapshot
  console.log('Creating snapshot...');
  const { snapshot: newSnapshot } = await apiRequest('POST', '/v1/projects/' + workspace.project_id + '/snapshots', {
    manifest_hash: manifestHash,
    parent_snapshot_id: workspace.base_snapshot_id,
    source: 'web',
  });

  console.log('Output snapshot:', newSnapshot.id);

  // Mark job as completed
  console.log('\\nMarking job as completed...');
  await apiRequest('POST', '/v1/jobs/' + JOB_ID + '/status', {
    status: 'completed',
    output_snapshot_id: newSnapshot.id,
  });

  console.log('\\n' + '='.repeat(60));
  console.log('Job completed successfully!');
  console.log('='.repeat(60));
}

main().catch(async (error) => {
  console.error('Job failed:', error.message);

  try {
    await apiRequest('POST', '/v1/jobs/' + JOB_ID + '/status', {
      status: 'failed',
      error: error.message,
    });
  } catch (e) {
    console.error('Failed to update job status:', e);
  }

  process.exit(1);
});
`;
}

/**
 * Run a job inside a Cloudflare Sandbox container
 */
export async function runJobInSandbox(
  env: Env,
  jobId: string,
  apiUrl: string,
  apiToken: string
): Promise<RunJobResult> {
  const startTime = Date.now();

  try {
    // Get sandbox instance - use job ID as sandbox ID so each job gets its own sandbox
    const sandbox = getSandbox(env.Sandbox, `job-${jobId}`);

    // Generate and write the runner script
    const runnerScript = generateRunnerScript({
      jobId,
      apiUrl,
      apiToken,
      anthropicKey: env.ANTHROPIC_API_KEY,
      openaiKey: env.OPENAI_API_KEY,
      googleKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
      provider: env.PROVIDER,
    });

    await sandbox.writeFile('/tmp/runner.ts', runnerScript);

    // Execute the runner script
    const result = await sandbox.exec('bun run /tmp/runner.ts');

    const duration = Date.now() - startTime;

    if (!result.success) {
      return {
        success: false,
        job_id: jobId,
        error: `Sandbox exited with code ${result.exitCode}`,
        stdout: result.stdout,
        stderr: result.stderr,
        duration_ms: duration,
      };
    }

    // Parse output to get snapshot ID
    const snapshotMatch = result.stdout.match(/Output snapshot: (\S+)/);
    const outputSnapshotId = snapshotMatch?.[1];

    return {
      success: true,
      job_id: jobId,
      output_snapshot_id: outputSnapshotId,
      stdout: result.stdout,
      stderr: result.stderr,
      duration_ms: duration,
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    return {
      success: false,
      job_id: jobId,
      error: error instanceof Error ? error.message : String(error),
      duration_ms: duration,
    };
  }
}
