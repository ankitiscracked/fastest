/**
 * Workspace management - download and reconstruct workspace from R2
 */

import { mkdir, writeFile, readFile, readdir, stat, rm } from 'fs/promises';
import { join, dirname } from 'path';
import type { Manifest, FileEntry } from '@fastest/shared';
import { ApiClient } from './api';

export interface WorkspaceConfig {
  workDir: string;
  api: ApiClient;
}

export class Workspace {
  private workDir: string;
  private api: ApiClient;
  private baseManifest: Manifest | null = null;

  constructor(config: WorkspaceConfig) {
    this.workDir = config.workDir;
    this.api = config.api;
  }

  /**
   * Download and reconstruct workspace from a snapshot
   */
  async restore(snapshotId: string): Promise<void> {
    console.log(`Restoring workspace from snapshot ${snapshotId}...`);

    // Get snapshot details
    const snapshot = await this.api.getSnapshot(snapshotId);
    console.log(`  Manifest hash: ${snapshot.manifest_hash.slice(0, 16)}...`);

    // Download manifest
    const manifest = await this.api.downloadManifest(snapshot.manifest_hash);
    this.baseManifest = manifest;
    console.log(`  Files in manifest: ${manifest.files.length}`);

    // Ensure work directory exists and is clean
    await this.clean();
    await mkdir(this.workDir, { recursive: true });

    // Download all blobs and write files
    const totalFiles = manifest.files.length;
    let downloaded = 0;

    // Download in batches for better performance
    const batchSize = 10;
    for (let i = 0; i < manifest.files.length; i += batchSize) {
      const batch = manifest.files.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async (file) => {
          await this.downloadAndWriteFile(file);
          downloaded++;
          if (downloaded % 50 === 0 || downloaded === totalFiles) {
            console.log(`  Downloaded ${downloaded}/${totalFiles} files`);
          }
        })
      );
    }

    console.log(`Workspace restored to ${this.workDir}`);
  }

  /**
   * Download a single file and write it to disk
   */
  private async downloadAndWriteFile(file: FileEntry): Promise<void> {
    const filePath = join(this.workDir, file.path);
    const dirPath = dirname(filePath);

    // Ensure directory exists
    await mkdir(dirPath, { recursive: true });

    // Download blob
    const content = await this.api.downloadBlob(file.hash);

    // Write file
    await writeFile(filePath, Buffer.from(content), { mode: file.mode });
  }

  /**
   * Clean the work directory
   */
  async clean(): Promise<void> {
    try {
      await rm(this.workDir, { recursive: true, force: true });
    } catch {
      // Directory might not exist, that's fine
    }
  }

  /**
   * Get the base manifest (from restore)
   */
  getBaseManifest(): Manifest | null {
    return this.baseManifest;
  }

  /**
   * Get the work directory path
   */
  getWorkDir(): string {
    return this.workDir;
  }

  /**
   * Collect all files from the workspace
   */
  async collectFiles(): Promise<Array<{ path: string; content: Uint8Array; mode: number }>> {
    const files: Array<{ path: string; content: Uint8Array; mode: number }> = [];
    await this.walkDirectory(this.workDir, '', files);
    return files;
  }

  /**
   * Walk directory and collect files
   */
  private async walkDirectory(
    basePath: string,
    relativePath: string,
    files: Array<{ path: string; content: Uint8Array; mode: number }>
  ): Promise<void> {
    const currentPath = relativePath ? join(basePath, relativePath) : basePath;
    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryRelativePath = relativePath ? join(relativePath, entry.name) : entry.name;
      const entryFullPath = join(basePath, entryRelativePath);

      // Skip ignored patterns
      if (this.shouldIgnore(entryRelativePath, entry.isDirectory())) {
        continue;
      }

      if (entry.isDirectory()) {
        await this.walkDirectory(basePath, entryRelativePath, files);
      } else if (entry.isFile()) {
        const content = await readFile(entryFullPath);
        const stats = await stat(entryFullPath);
        files.push({
          path: entryRelativePath.replace(/\\/g, '/'),
          content: new Uint8Array(content),
          mode: stats.mode & 0o777,
        });
      }
    }
  }

  /**
   * Check if a path should be ignored
   */
  private shouldIgnore(path: string, isDir: boolean): boolean {
    const ignoredPatterns = [
      '.git',
      '.fst',
      'node_modules',
      '__pycache__',
      '.DS_Store',
      'Thumbs.db',
    ];

    const ignoredExtensions = [
      '.pyc', '.pyo', '.class', '.o', '.obj',
      '.exe', '.dll', '.so', '.dylib',
    ];

    const name = path.split('/').pop() || path;

    // Check directory patterns
    for (const pattern of ignoredPatterns) {
      if (name === pattern || path.includes(`/${pattern}/`) || path.startsWith(`${pattern}/`)) {
        return true;
      }
    }

    // Check extensions
    if (!isDir) {
      for (const ext of ignoredExtensions) {
        if (name.endsWith(ext)) {
          return true;
        }
      }
    }

    return false;
  }
}
