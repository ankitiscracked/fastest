/**
 * API client for communicating with the Fastest API from the sandbox
 */

import type { Job, Manifest } from '@fastest/shared';

export interface ApiConfig {
  baseUrl: string;
  token: string;
}

export class ApiClient {
  private baseUrl: string;
  private token: string;

  constructor(config: ApiConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.token = config.token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.token}`,
    };

    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
      throw new Error(`API error: ${error.error?.message || response.statusText}`);
    }

    return response.json();
  }

  /**
   * Get the next pending job
   */
  async getNextJob(): Promise<Job | null> {
    const result = await this.request<{ job: Job | null }>('GET', '/v1/jobs/next');
    return result.job;
  }

  /**
   * Get a specific job by ID
   */
  async getJob(jobId: string): Promise<Job> {
    const result = await this.request<{ job: Job }>('GET', `/v1/jobs/${jobId}`);
    return result.job;
  }

  /**
   * Update job status
   */
  async updateJobStatus(
    jobId: string,
    status: 'running' | 'completed' | 'failed',
    options?: { outputSnapshotId?: string; error?: string }
  ): Promise<Job> {
    const result = await this.request<{ job: Job }>('POST', `/v1/jobs/${jobId}/status`, {
      status,
      output_snapshot_id: options?.outputSnapshotId,
      error: options?.error,
    });
    return result.job;
  }

  /**
   * Get workspace details
   */
  async getWorkspace(workspaceId: string): Promise<{
    id: string;
    project_id: string;
    name: string;
    base_snapshot_id: string | null;
  }> {
    const result = await this.request<{ workspace: any }>('GET', `/v1/workspaces/${workspaceId}`);
    return result.workspace;
  }

  /**
   * Get snapshot details
   */
  async getSnapshot(snapshotId: string): Promise<{
    id: string;
    project_id: string;
    manifest_hash: string;
    parent_snapshot_id: string | null;
  }> {
    const result = await this.request<{ snapshot: any }>('GET', `/v1/snapshots/${snapshotId}`);
    return result.snapshot;
  }

  /**
   * Download manifest from R2
   */
  async downloadManifest(manifestHash: string): Promise<Manifest> {
    const url = `${this.baseUrl}/v1/blobs/manifests/${manifestHash}`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${this.token}` },
    });

    if (!response.ok) {
      throw new Error(`Failed to download manifest: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Download blob from R2
   */
  async downloadBlob(hash: string): Promise<ArrayBuffer> {
    const url = `${this.baseUrl}/v1/blobs/download/${hash}`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${this.token}` },
    });

    if (!response.ok) {
      throw new Error(`Failed to download blob ${hash}: ${response.statusText}`);
    }

    return response.arrayBuffer();
  }

  /**
   * Check which blobs already exist
   */
  async checkBlobsExist(hashes: string[]): Promise<{ missing: string[]; existing: string[] }> {
    const result = await this.request<{ missing: string[]; existing: string[] }>(
      'POST',
      '/v1/blobs/exists',
      { hashes }
    );
    return result;
  }

  /**
   * Upload blob to R2
   */
  async uploadBlob(hash: string, content: ArrayBuffer): Promise<void> {
    const url = `${this.baseUrl}/v1/blobs/upload/${hash}`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: content,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
      throw new Error(`Failed to upload blob: ${error.error?.message || response.statusText}`);
    }
  }

  /**
   * Upload manifest to R2
   */
  async uploadManifest(hash: string, manifest: Manifest): Promise<void> {
    const url = `${this.baseUrl}/v1/blobs/manifests/${hash}`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(manifest, null, '  '),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
      throw new Error(`Failed to upload manifest: ${error.error?.message || response.statusText}`);
    }
  }

  /**
   * Create a new snapshot
   */
  async createSnapshot(
    projectId: string,
    manifestHash: string,
    parentSnapshotId?: string
  ): Promise<{ id: string }> {
    const result = await this.request<{ snapshot: { id: string } }>(
      'POST',
      `/v1/projects/${projectId}/snapshots`,
      {
        manifest_hash: manifestHash,
        parent_snapshot_id: parentSnapshotId,
        source: 'agent',
      }
    );
    return result.snapshot;
  }
}
