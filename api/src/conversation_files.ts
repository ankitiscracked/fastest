import ignore from 'ignore';
import type { FileChange } from '@fastest/shared';
import type { E2BSandbox } from 'e2b';
import type { Env } from './index';
import type { ConversationState, SandboxRunner } from './conversation_types';
import type { ConversationSandbox } from './conversation_sandbox';
import {
  fetchWithRetry,
  pMap,
  createUploadStats,
  type UploadStats,
  type SkippedFile,
} from './sync_utils';

type EnsureState = () => Promise<ConversationState>;
type PersistState = (state: ConversationState) => Promise<void>;

export class ConversationFiles {
  private env: Env;
  private ensureState: EnsureState;
  private sandbox: ConversationSandbox;
  private persistState: PersistState;

  constructor(deps: {
    env: Env;
    ensureState: EnsureState;
    sandbox: ConversationSandbox;
    persistState: PersistState;
  }) {
    this.env = deps.env;
    this.ensureState = deps.ensureState;
    this.sandbox = deps.sandbox;
    this.persistState = deps.persistState;
  }

  /**
   * Restore files from a manifest hash
   */
  async restoreFiles(
    sandbox: SandboxRunner,
    apiUrl: string,
    apiToken: string,
    manifestHash: string,
    workDir: string
  ): Promise<void> {
    if (sandbox.type === 'e2b') {
      await this.restoreFilesE2B(apiUrl, apiToken, manifestHash, workDir);
      return;
    }

    const sandboxApiUrl = this.getSandboxApiUrl(apiUrl);
    const manifestResponse = await fetch(`${apiUrl}/v1/blobs/manifests/${manifestHash}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });

    if (!manifestResponse.ok) {
      throw new Error('Failed to download manifest');
    }

    const manifest = await manifestResponse.json() as { files: Array<{ path: string; hash: string }> };

    await sandbox.exec(`mkdir -p ${workDir}`);

    for (const file of manifest.files) {
      const filePath = `${workDir}/${file.path}`;
      const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));

      await sandbox.exec(`mkdir -p ${dirPath}`);

      const presignResponse = await fetch(`${apiUrl}/v1/blobs/presign-download`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ hashes: [file.hash] }),
      });

      const { urls } = await presignResponse.json() as { urls: Record<string, string> };
      const url = urls[file.hash]?.startsWith('http') ? urls[file.hash] : `${sandboxApiUrl}${urls[file.hash]}`;

      await sandbox.exec(`curl -s -H "Authorization: Bearer ${apiToken}" -o "${filePath}" "${url}"`);
    }
  }

  /**
   * Initialize workspace from base snapshot if available
   */
  async initializeWorkspace(
    sandbox: SandboxRunner,
    apiUrl: string,
    apiToken: string,
    workDir: string
  ): Promise<void> {
    const state = await this.ensureState();

    const wsResponse = await fetch(`${apiUrl}/v1/workspaces/${state.workspaceId}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });

    if (!wsResponse.ok) return;

    const { workspace } = await wsResponse.json() as { workspace: { base_snapshot_id?: string; current_manifest_hash?: string } };

    if (workspace.current_manifest_hash) {
      await this.restoreFiles(sandbox, apiUrl, apiToken, workspace.current_manifest_hash, workDir);
      state.lastManifestHash = workspace.current_manifest_hash;
      await this.persistState(state);
      return;
    }

    if (workspace.base_snapshot_id) {
      const snapResponse = await fetch(`${apiUrl}/v1/snapshots/${workspace.base_snapshot_id}`, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });

      if (!snapResponse.ok) return;

      const { snapshot } = await snapResponse.json() as { snapshot: { manifest_hash: string } };

      await this.restoreFiles(sandbox, apiUrl, apiToken, snapshot.manifest_hash, workDir);
      state.lastManifestHash = snapshot.manifest_hash;
      await this.persistState(state);
    } else {
      await sandbox.exec(`mkdir -p ${workDir}`);
    }
  }

  /**
   * Collect files and upload to blob storage
   * Returns file changes with proper diff against previous manifest
   *
   * Improvements:
   * - Retry logic with exponential backoff for network operations
   * - Parallel blob uploads with concurrency limit
   * - Tracks and returns skipped files for visibility
   */
  async collectAndUploadFiles(
    sandbox: SandboxRunner,
    apiUrl: string,
    apiToken: string,
    workDir: string
  ): Promise<{
    fileChanges: FileChange[];
    manifestHash: string;
    previousManifestHash?: string;
    uploadStats?: UploadStats;
  }> {
    if (sandbox.type === 'e2b') {
      return this.collectAndUploadFilesE2B(apiUrl, apiToken, workDir);
    }

    const ignoreMatcher = await this.getIgnoreMatcher({ sandbox, workDir, type: 'cloudflare' });
    const sandboxApiUrl = this.getSandboxApiUrl(apiUrl);
    const state = await this.ensureState();
    const previousManifestHash = state.lastManifestHash;

    // Initialize upload stats for tracking
    const uploadStats = createUploadStats();

    let previousFiles: Map<string, string> = new Map();
    if (previousManifestHash) {
      try {
        // Use retry logic for fetching previous manifest
        const manifestResponse = await fetchWithRetry(
          `${apiUrl}/v1/blobs/manifests/${previousManifestHash}`,
          { headers: { Authorization: `Bearer ${apiToken}` } },
          { maxRetries: 3 }
        );
        if (manifestResponse.ok) {
          const prevManifest = await manifestResponse.json() as { files: Array<{ path: string; hash: string }> };
          for (const f of prevManifest.files) {
            previousFiles.set(f.path, f.hash);
          }
        }
      } catch (error) {
        // Log but continue - treat as no previous state
        console.warn('Failed to fetch previous manifest after retries:', error);
      }
    }

    const listResult = await sandbox.exec(`find ${workDir} -type f`);
    if (!listResult.success) {
      return { fileChanges: [], manifestHash: '', previousManifestHash };
    }

    const filePaths = listResult.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((fullPath) => {
        const relPath = fullPath.replace(`${workDir}/`, '');
        return ignoreMatcher.shouldInclude(relPath, false);
      });
    const maxFilesEnv = (this.env.MAX_FILES_PER_MANIFEST || '').trim();
    const maxFiles = Number.isFinite(Number(maxFilesEnv)) ? Number(maxFilesEnv) : 0;
    if (maxFiles > 0 && filePaths.length > maxFiles) {
      throw new Error(`Workspace has ${filePaths.length} files; max allowed is ${maxFiles}. Reduce files or increase MAX_FILES_PER_MANIFEST.`);
    }
    const files: Array<{ path: string; hash: string; size: number }> = [];
    const currentFiles: Map<string, string> = new Map();
    uploadStats.totalFiles = filePaths.length;

    for (const fullPath of filePaths) {
      const path = fullPath.replace(`${workDir}/`, '');

      const hashResult = await sandbox.exec(`sha256sum "${fullPath}" | cut -d' ' -f1`);
      if (!hashResult.success) {
        // Track skipped files instead of silently ignoring
        uploadStats.skippedFiles.push({
          path,
          reason: `Hash computation failed: ${hashResult.stderr || 'unknown error'}`,
        });
        continue;
      }

      const hash = hashResult.stdout.trim();

      const sizeResult = await sandbox.exec(`stat -c%s "${fullPath}"`);
      const size = parseInt(sizeResult.stdout.trim()) || 0;

      files.push({ path, hash, size });
      currentFiles.set(path, hash);
    }

    const fileChanges: FileChange[] = [];

    for (const [path, hash] of currentFiles) {
      const prevHash = previousFiles.get(path);
      if (!prevHash) {
        fileChanges.push({ path, change: 'added' });
      } else if (prevHash !== hash) {
        fileChanges.push({ path, change: 'modified' });
      }
    }

    for (const [path] of previousFiles) {
      if (!currentFiles.has(path)) {
        fileChanges.push({ path, change: 'deleted' });
      }
    }

    const manifest = {
      version: '1',
      files: files.map(f => ({
        path: f.path,
        hash: f.hash,
        size: f.size,
        mode: 420,
      })).sort((a, b) => a.path.localeCompare(b.path)),
    };

    const manifestJson = JSON.stringify(manifest, null, '  ');
    const manifestHash = await this.computeSHA256(manifestJson);

    const allHashes = [...new Set(files.map(f => f.hash))];

    // Check which blobs exist with retry
    const existsResponse = await fetchWithRetry(
      `${apiUrl}/v1/blobs/exists`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ hashes: allHashes }),
      },
      { maxRetries: 3 }
    );

    const { missing, existing } = await existsResponse.json() as { missing: string[]; existing?: string[] };
    uploadStats.existingFiles = existing?.length || (allHashes.length - missing.length);

    // Get files that need to be uploaded
    const filesToUpload = files.filter(f => missing.includes(f.hash));

    // Upload blobs in parallel with concurrency limit
    await pMap(
      filesToUpload,
      async (file) => {
        const fullPath = `${workDir}/${file.path}`;

        try {
          // Get presigned URL with retry
          const presignResponse = await fetchWithRetry(
            `${apiUrl}/v1/blobs/presign-upload`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${apiToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ hashes: [file.hash] }),
            },
            { maxRetries: 2 }
          );

          const { urls } = await presignResponse.json() as { urls: Record<string, string> };
          const url = urls[file.hash]?.startsWith('http') ? urls[file.hash] : `${sandboxApiUrl}${urls[file.hash]}`;

          // Upload with retry
          const uploadResult = await sandbox.exec(
            `curl -s -w "%{http_code}" -X PUT -H "Authorization: Bearer ${apiToken}" --data-binary @"${fullPath}" "${url}"`
          );

          if (!uploadResult.success) {
            throw new Error(`Upload failed: ${uploadResult.stderr || 'curl error'}`);
          }

          // Check HTTP status code (last 3 characters of output)
          const output = uploadResult.stdout.trim();
          const httpCode = output.slice(-3);
          if (!httpCode.startsWith('2')) {
            throw new Error(`Upload returned HTTP ${httpCode}`);
          }

          uploadStats.uploadedFiles++;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          uploadStats.failedFiles.push({
            path: file.path,
            hash: file.hash,
            error: errorMessage,
          });
          console.error(`Failed to upload ${file.path}:`, error);
          // Continue with other files instead of failing entirely
        }
      },
      { concurrency: 5, stopOnError: false }
    );

    // Log upload stats
    if (uploadStats.skippedFiles.length > 0 || uploadStats.failedFiles.length > 0) {
      console.warn('File upload issues:', {
        skipped: uploadStats.skippedFiles.length,
        failed: uploadStats.failedFiles.length,
        skippedFiles: uploadStats.skippedFiles.slice(0, 5), // Log first 5
        failedFiles: uploadStats.failedFiles.slice(0, 5),
      });
    }

    // Upload manifest with retry
    await fetchWithRetry(
      `${apiUrl}/v1/blobs/manifests/${manifestHash}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: manifestJson,
      },
      { maxRetries: 3 }
    );

    return { fileChanges, manifestHash, previousManifestHash, uploadStats };
  }

  private resolveApiUrl(apiUrl: string, pathOrUrl: string): string {
    if (pathOrUrl.startsWith('http')) return pathOrUrl;
    const base = apiUrl.endsWith('/') ? apiUrl.slice(0, -1) : apiUrl;
    const suffix = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
    return `${base}${suffix}`;
  }

  private async restoreFilesE2B(
    apiUrl: string,
    apiToken: string,
    manifestHash: string,
    workDir: string
  ): Promise<void> {
    const sandbox = await this.sandbox.getE2BSandbox();
    const manifestResponse = await fetch(`${apiUrl}/v1/blobs/manifests/${manifestHash}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });

    if (!manifestResponse.ok) {
      throw new Error('Failed to download manifest');
    }

    const manifest = await manifestResponse.json() as { files: Array<{ path: string; hash: string }> };
    await sandbox.files.makeDir(workDir);

    for (const file of manifest.files) {
      const filePath = `${workDir}/${file.path}`;
      const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));
      await sandbox.files.makeDir(dirPath);

      const presignResponse = await fetch(`${apiUrl}/v1/blobs/presign-download`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ hashes: [file.hash] }),
      });

      const { urls } = await presignResponse.json() as { urls: Record<string, string> };
      const url = this.resolveApiUrl(apiUrl, urls[file.hash]);
      const blobResponse = await fetch(url, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      if (!blobResponse.ok) {
        throw new Error(`Failed to download blob ${file.hash}`);
      }
      const bytes = new Uint8Array(await blobResponse.arrayBuffer());
      await sandbox.files.write(filePath, bytes);
    }
  }

  private async collectAndUploadFilesE2B(
    apiUrl: string,
    apiToken: string,
    workDir: string
  ): Promise<{ fileChanges: FileChange[]; manifestHash: string; previousManifestHash?: string }> {
    const sandbox = await this.sandbox.getE2BSandbox();
    const state = await this.ensureState();
    const previousManifestHash = state.lastManifestHash;
    const ignoreMatcher = await this.getIgnoreMatcher({ sandbox, workDir, type: 'e2b' });

    let previousFiles: Map<string, string> = new Map();
    if (previousManifestHash) {
      try {
        const manifestResponse = await fetch(`${apiUrl}/v1/blobs/manifests/${previousManifestHash}`, {
          headers: { Authorization: `Bearer ${apiToken}` },
        });
        if (manifestResponse.ok) {
          const prevManifest = await manifestResponse.json() as { files: Array<{ path: string; hash: string }> };
          for (const f of prevManifest.files) {
            previousFiles.set(f.path, f.hash);
          }
        }
      } catch {
        // Ignore - treat as no previous state
      }
    }

    const entries = await this.listE2BFiles(sandbox, workDir, ignoreMatcher);
    const files: Array<{ path: string; hash: string; size: number }> = [];
    const currentFiles: Map<string, string> = new Map();

    for (const entry of entries) {
      const relPath = entry.path.replace(`${workDir}/`, '');
      const bytes = await sandbox.files.read(entry.path, { format: 'bytes' });
      const hash = await this.computeSHA256Bytes(bytes);
      const size = typeof entry.size === 'number' ? entry.size : bytes.length;
      files.push({ path: relPath, hash, size });
      currentFiles.set(relPath, hash);
    }

    const fileChanges: FileChange[] = [];
    for (const [path, hash] of currentFiles) {
      const prevHash = previousFiles.get(path);
      if (!prevHash) {
        fileChanges.push({ path, change: 'added' });
      } else if (prevHash !== hash) {
        fileChanges.push({ path, change: 'modified' });
      }
    }
    for (const [path] of previousFiles) {
      if (!currentFiles.has(path)) {
        fileChanges.push({ path, change: 'deleted' });
      }
    }

    const manifest = {
      version: '1',
      files: files.map(f => ({
        path: f.path,
        hash: f.hash,
        size: f.size,
        mode: 420,
      })).sort((a, b) => a.path.localeCompare(b.path)),
    };

    const manifestJson = JSON.stringify(manifest, null, '  ');
    const manifestHash = await this.computeSHA256(manifestJson);

    const allHashes = [...new Set(files.map(f => f.hash))];
    const existsResponse = await fetch(`${apiUrl}/v1/blobs/exists`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ hashes: allHashes }),
    });

    const { missing } = await existsResponse.json() as { missing: string[] };

    for (const file of files) {
      if (missing.includes(file.hash)) {
        const fullPath = `${workDir}/${file.path}`;
        const presignResponse = await fetch(`${apiUrl}/v1/blobs/presign-upload`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ hashes: [file.hash] }),
        });

        const { urls } = await presignResponse.json() as { urls: Record<string, string> };
        const url = this.resolveApiUrl(apiUrl, urls[file.hash]);
        const bytes = await sandbox.files.read(fullPath, { format: 'bytes' });
        await fetch(url, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${apiToken}` },
          body: bytes,
        });
      }
    }

    await fetch(`${apiUrl}/v1/blobs/manifests/${manifestHash}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: manifestJson,
    });

    return { fileChanges, manifestHash, previousManifestHash };
  }

  private async listE2BFiles(
    sandbox: E2BSandbox,
    root: string,
    ignoreMatcher: { shouldInclude: (path: string, isDir: boolean) => boolean }
  ): Promise<Array<{ path: string; size: number }>> {
    const files: Array<{ path: string; size: number }> = [];
    const queue: string[] = [root];

    while (queue.length > 0) {
      const dir = queue.shift();
      if (!dir) break;
      const entries = await sandbox.files.list(dir, { depth: 1 });
      for (const entry of entries) {
        if (!entry.path || entry.path === dir) continue;
        const relPath = entry.path.replace(`${root}/`, '');
        if (!ignoreMatcher.shouldInclude(relPath, entry.type === 'dir')) {
          continue;
        }
        if (entry.type === 'dir') {
          queue.push(entry.path);
        } else if (entry.type === 'file') {
          files.push({ path: entry.path, size: entry.size });
        }
      }
    }

    return files;
  }

  private async getIgnoreMatcher(args: {
    sandbox: SandboxRunner | E2BSandbox;
    workDir: string;
    type: 'cloudflare' | 'e2b';
  }): Promise<{ shouldInclude: (path: string, isDir: boolean) => boolean }> {
    const defaults = [
      '.git',
      '.git/**',
      'node_modules',
      'node_modules/**',
      '.DS_Store',
      'dist',
      'dist/**',
      'build',
      'build/**',
      '.next',
      '.next/**',
      '.turbo',
      '.turbo/**',
      '.cache',
      '.cache/**',
    ];

    const ig = ignore().add(defaults);
    const workDir = args.workDir.replace(/\/+$/, '');

    const addIgnoreFile = async (path: string) => {
      try {
        if (args.type === 'e2b') {
          const sandbox = args.sandbox as E2BSandbox;
          const content = await sandbox.files.read(path, { format: 'text' });
          if (content) ig.add(content);
        } else {
          const sandbox = args.sandbox as SandboxRunner;
          const result = await sandbox.exec(`cat "${path}" 2>/dev/null || true`);
          if (result.stdout) ig.add(result.stdout);
        }
      } catch {
        // Ignore missing files
      }
    };

    await addIgnoreFile(`${workDir}/.gitignore`);
    await addIgnoreFile(`${workDir}/.git/info/exclude`);

    return {
      shouldInclude: (relPath: string, isDir: boolean) => {
        if (!relPath) return false;
        const normalized = relPath.replace(/^\/+/, '');
        const checkPath = isDir && !normalized.endsWith('/') ? `${normalized}/` : normalized;
        return !ig.ignores(checkPath);
      },
    };
  }

  private async computeSHA256Bytes(data: Uint8Array): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  private async computeSHA256(text: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  private getSandboxApiUrl(apiUrl: string): string {
    try {
      const url = new URL(apiUrl);
      if (this.sandbox.getSandboxProvider() === 'e2b' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
        console.warn('[Sandbox] E2B provider cannot reach localhost API URL. Use a public URL or tunnel.');
        return url.toString().replace(/\/$/, '');
      }
      if (this.sandbox.getSandboxProvider() === 'cloudflare' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
        url.hostname = 'host.docker.internal';
        return url.toString().replace(/\/$/, '');
      }
    } catch {
      // Ignore and fall back to original
    }
    return apiUrl.replace(/\/$/, '');
  }
}
