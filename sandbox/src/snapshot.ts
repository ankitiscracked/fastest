/**
 * Snapshot creation - generate manifest and upload to R2
 */

import type { Manifest, FileContent } from '@fastest/shared';
import {
  generateFromFiles,
  hashManifest,
  diff,
} from '@fastest/shared';
import { ApiClient } from './api';
import { Workspace } from './workspace';

export interface SnapshotResult {
  snapshotId: string;
  manifestHash: string;
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
  blobsUploaded: number;
}

/**
 * Create a snapshot from the current workspace state
 */
export async function createSnapshot(
  workspace: Workspace,
  api: ApiClient,
  projectId: string,
  parentSnapshotId?: string
): Promise<SnapshotResult> {
  console.log('Creating snapshot...');

  // Collect all files from workspace
  const files = await workspace.collectFiles();
  console.log(`  Collected ${files.length} files`);

  // Convert to FileContent format for manifest generation
  const fileContents: FileContent[] = files.map((f) => ({
    path: f.path,
    content: f.content,
    mode: f.mode,
  }));

  // Generate manifest
  const manifest = await generateFromFiles(fileContents);
  const manifestHash = await hashManifest(manifest);
  console.log(`  Manifest hash: ${manifestHash.slice(0, 16)}...`);

  // Compare with base manifest to find changes
  const baseManifest = workspace.getBaseManifest();
  let filesAdded = 0;
  let filesModified = 0;
  let filesDeleted = 0;

  if (baseManifest) {
    const changes = diff(baseManifest, manifest);
    filesAdded = changes.added.length;
    filesModified = changes.modified.length;
    filesDeleted = changes.deleted.length;
    console.log(`  Changes: +${filesAdded} ~${filesModified} -${filesDeleted}`);
  } else {
    filesAdded = manifest.files.length;
    console.log(`  New workspace: ${filesAdded} files`);
  }

  // Find blobs that need to be uploaded
  const allHashes = manifest.files.map((f) => f.hash);
  const uniqueHashes = [...new Set(allHashes)];

  // Check which blobs already exist
  const { missing } = await api.checkBlobsExist(uniqueHashes);
  console.log(`  Blobs to upload: ${missing.length}/${uniqueHashes.length}`);

  // Create a map of hash -> content for uploading
  const hashToContent = new Map<string, Uint8Array>();
  for (const file of files) {
    const hash = manifest.files.find((f) => f.path === file.path)?.hash;
    if (hash && missing.includes(hash) && !hashToContent.has(hash)) {
      hashToContent.set(hash, file.content);
    }
  }

  // Upload missing blobs
  let uploaded = 0;
  for (const [hash, content] of hashToContent) {
    await api.uploadBlob(hash, content.buffer as ArrayBuffer);
    uploaded++;
    if (uploaded % 20 === 0 || uploaded === hashToContent.size) {
      console.log(`  Uploaded ${uploaded}/${hashToContent.size} blobs`);
    }
  }

  // Upload manifest
  await api.uploadManifest(manifestHash, manifest);
  console.log(`  Manifest uploaded`);

  // Create snapshot record
  const snapshot = await api.createSnapshot(projectId, manifestHash, parentSnapshotId);
  console.log(`  Snapshot created: ${snapshot.id}`);

  return {
    snapshotId: snapshot.id,
    manifestHash,
    filesAdded,
    filesModified,
    filesDeleted,
    blobsUploaded: uploaded,
  };
}
