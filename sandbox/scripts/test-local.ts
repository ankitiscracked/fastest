/**
 * Local test script for sandbox runner
 *
 * This script:
 * 1. Seeds the database with test user/project/workspace
 * 2. Creates test files and uploads them as blobs
 * 3. Creates a manifest and snapshot
 * 4. Creates a test job
 * 5. Runs the sandbox runner
 *
 * Usage:
 *   cd sandbox && bun run scripts/test-local.ts
 */

import { $ } from 'bun';

const API_URL = 'http://localhost:8788';
const API_TOKEN = 'test123';

// Test files to create
const TEST_FILES = [
  {
    path: 'src/index.ts',
    content: `// Main entry point
export function main() {
  console.log("Hello, world!");
}

main();
`,
  },
  {
    path: 'src/utils.ts',
    content: `// Utility functions
export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`,
  },
  {
    path: 'package.json',
    content: JSON.stringify({
      name: 'test-project',
      version: '1.0.0',
      main: 'src/index.ts',
    }, null, 2),
  },
  {
    path: 'README.md',
    content: `# Test Project

This is a test project for the sandbox runner.
`,
  },
];

async function sha256(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const buffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function apiRequest(method: string, path: string, body?: unknown) {
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error ${response.status}: ${error}`);
  }

  return response.json();
}

async function uploadBlob(hash: string, content: string) {
  const response = await fetch(`${API_URL}/v1/blobs/upload/${hash}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/octet-stream',
    },
    body: content,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Upload error: ${error}`);
  }

  return response.json();
}

async function uploadManifest(hash: string, manifest: unknown) {
  const response = await fetch(`${API_URL}/v1/blobs/manifests/${hash}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(manifest, null, '  '),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Manifest upload error: ${error}`);
  }

  return response.json();
}

async function main() {
  console.log('='.repeat(60));
  console.log('Sandbox Runner Local Test');
  console.log('='.repeat(60));

  // Check if API is running
  console.log('\n1. Checking API...');
  try {
    const health = await fetch(`${API_URL}/health`);
    if (!health.ok) throw new Error('API not responding');
    console.log('   API is running');
  } catch (error) {
    console.error('   API is not running! Start it with: cd api && bun run dev');
    process.exit(1);
  }

  // Seed database
  console.log('\n2. Seeding database...');
  try {
    await $`cd ../api && bunx wrangler d1 execute fastest-db --local --command "
      INSERT OR IGNORE INTO users (id, email) VALUES ('test-user', 'test@example.com');
      INSERT OR IGNORE INTO sessions (id, user_id, token_hash, expires_at) VALUES ('test-session', 'test-user', 'hash_54c9a7a0', '2030-01-01');
      INSERT OR IGNORE INTO projects (id, owner_user_id, name) VALUES ('test-project', 'test-user', 'Test Project');
      INSERT OR IGNORE INTO workspaces (id, project_id, name) VALUES ('test-workspace', 'test-project', 'main');
    "`.quiet();
    console.log('   Database seeded');
  } catch (error) {
    console.log('   Database already seeded (or error - continuing anyway)');
  }

  // Upload test files as blobs
  console.log('\n3. Uploading test files...');
  const manifestFiles = [];

  for (const file of TEST_FILES) {
    const hash = await sha256(file.content);
    console.log(`   ${file.path} -> ${hash.slice(0, 16)}...`);

    try {
      await uploadBlob(hash, file.content);
    } catch (error) {
      // Blob might already exist
    }

    manifestFiles.push({
      path: file.path,
      hash,
      size: file.content.length,
      mode: 420, // 0o644
    });
  }

  // Create manifest
  console.log('\n4. Creating manifest...');
  const manifest = {
    version: '1',
    files: manifestFiles.sort((a, b) => a.path.localeCompare(b.path)),
  };

  const manifestJson = JSON.stringify(manifest, null, '  ');
  const manifestHash = await sha256(manifestJson);
  console.log(`   Manifest hash: ${manifestHash.slice(0, 16)}...`);

  try {
    await uploadManifest(manifestHash, manifest);
    console.log('   Manifest uploaded');
  } catch (error) {
    console.log('   Manifest might already exist');
  }

  // Create snapshot
  console.log('\n5. Creating snapshot...');
  let snapshotId: string;
  try {
    const result = await apiRequest('POST', '/v1/projects/test-project/snapshots', {
      manifest_hash: manifestHash,
      source: 'cli',
    });
    snapshotId = result.snapshot.id;
    console.log(`   Snapshot created: ${snapshotId}`);
  } catch (error) {
    // Snapshot might already exist, get the latest
    const result = await apiRequest('GET', '/v1/projects/test-project/snapshots?limit=1');
    snapshotId = result.snapshots[0]?.id;
    if (!snapshotId) {
      throw new Error('Failed to create or find snapshot');
    }
    console.log(`   Using existing snapshot: ${snapshotId}`);
  }

  // Update workspace with base snapshot
  console.log('\n6. Updating workspace with base snapshot...');
  try {
    await $`cd ../api && bunx wrangler d1 execute fastest-db --local --command "
      UPDATE workspaces SET base_snapshot_id = '${snapshotId}' WHERE id = 'test-workspace';
    "`.quiet();
    console.log('   Workspace updated');
  } catch (error) {
    console.error('   Failed to update workspace:', error);
  }

  // Create a test job
  console.log('\n7. Creating test job...');
  const jobResult = await apiRequest('POST', '/v1/jobs', {
    workspace_id: 'test-workspace',
    prompt: 'Add a subtract function to src/utils.ts that subtracts two numbers',
  });
  const jobId = jobResult.job.id;
  console.log(`   Job created: ${jobId}`);

  // Print instructions
  console.log('\n' + '='.repeat(60));
  console.log('Test setup complete!');
  console.log('='.repeat(60));
  console.log('\nTo run the sandbox runner:');
  console.log('\n  # Make sure OpenCode is installed:');
  console.log('  npm install -g opencode');
  console.log('\n  # Run the sandbox runner:');
  console.log(`  cd sandbox && JOB_ID=${jobId} API_URL=${API_URL} API_TOKEN=${API_TOKEN} \\`);
  console.log('    ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY bun run src/index.ts');
  console.log('\n  # Or poll for next job:');
  console.log(`  cd sandbox && API_URL=${API_URL} API_TOKEN=${API_TOKEN} \\`);
  console.log('    ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY bun run src/index.ts');
  console.log('\n' + '='.repeat(60));
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
