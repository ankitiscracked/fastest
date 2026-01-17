const API_BASE = '/v1';

class ApiClient {
  private token: string | null = null;

  setToken(token: string | null) {
    this.token = token;
    if (token) {
      localStorage.setItem('fst_token', token);
    } else {
      localStorage.removeItem('fst_token');
    }
  }

  getToken(): string | null {
    if (!this.token) {
      this.token = localStorage.getItem('fst_token');
    }
    return this.token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    const token = this.getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: { message: 'Request failed' } }));
      throw new Error(error.error?.message || 'Request failed');
    }

    return res.json();
  }

  // Auth
  async startLogin(email: string) {
    return this.request<{ session_id: string }>('POST', '/auth/start', { email });
  }

  async completeLogin(sessionId: string, code: string) {
    return this.request<{ access_token: string; expires_in: number }>('POST', '/auth/complete', {
      session_id: sessionId,
      code,
    });
  }

  async getMe() {
    return this.request<{ user: { id: string; email: string } }>('GET', '/auth/me');
  }

  // Projects
  async createProject(name: string) {
    return this.request<{ project: import('@fastest/shared').Project }>('POST', '/projects', { name });
  }

  async listProjects() {
    return this.request<{ projects: import('@fastest/shared').Project[] }>('GET', '/projects');
  }

  async getProject(projectId: string) {
    return this.request<{
      project: import('@fastest/shared').Project;
      workspaces: import('@fastest/shared').Workspace[];
      snapshots: import('@fastest/shared').Snapshot[];
    }>('GET', `/projects/${projectId}`);
  }

  // Workspaces
  async getWorkspace(workspaceId: string) {
    return this.request<{
      workspace: import('@fastest/shared').Workspace;
      drift: import('@fastest/shared').DriftReport | null;
    }>('GET', `/workspaces/${workspaceId}`);
  }

  async listWorkspaces(projectId: string) {
    return this.request<{ workspaces: import('@fastest/shared').Workspace[] }>(
      'GET',
      `/projects/${projectId}/workspaces`
    );
  }

  // Jobs
  async createJob(workspaceId: string, prompt: string) {
    return this.request<{ job: import('@fastest/shared').Job }>('POST', '/jobs', {
      workspace_id: workspaceId,
      prompt,
    });
  }

  async getJob(jobId: string) {
    return this.request<{ job: import('@fastest/shared').Job }>('GET', `/jobs/${jobId}`);
  }

  async listJobs(workspaceId: string) {
    return this.request<{ jobs: import('@fastest/shared').Job[] }>(
      'GET',
      `/jobs?workspace_id=${workspaceId}`
    );
  }

  async runJob(jobId: string) {
    return this.request<{ job: import('@fastest/shared').Job; duration_ms: number }>(
      'POST',
      `/jobs/${jobId}/run`
    );
  }

  async cancelJob(jobId: string) {
    return this.request<{ job: import('@fastest/shared').Job }>('POST', `/jobs/${jobId}/cancel`);
  }
}

export const api = new ApiClient();
