const API_BASE = (import.meta.env.VITE_API_BASE || '/v1').replace(/\/+$/, '');

function getApiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

function getWsBase(): string {
  if (API_BASE.startsWith('https://')) {
    return `wss://${API_BASE.slice('https://'.length)}`;
  }
  if (API_BASE.startsWith('http://')) {
    return `ws://${API_BASE.slice('http://'.length)}`;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${API_BASE}`;
}

// Message types
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  filesChanged?: string[];
  error?: string;
  createdAt: string;
  completedAt?: string;
}

// Re-export Conversation types from shared
export type {
  Conversation,
  ConversationWithContext,
  TimelineItem,
  FileChange,
  ProjectEnvVar,
  SetEnvVarRequest,
  DeploymentLogEntry,
  DeploymentLog,
} from '@fastest/shared';
import type { TimelineItem, DeploymentLogEntry } from '@fastest/shared';
import type { OpenCodeGlobalEvent } from './opencode';

// Deployment types
export interface ProjectInfo {
  type: 'wrangler' | 'unknown';
  name?: string;
  configFile?: string;
}

export interface Deployment {
  id: string;
  url: string;
  status: 'deploying' | 'success' | 'failed';
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export type StreamEvent =
  | { type: 'message_start'; messageId: string }
  | { type: 'content_delta'; content: string }
  | { type: 'status'; status: Message['status'] }
  | { type: 'files_changed'; files: string[] }
  | { type: 'message_complete'; message: Message }
  | { type: 'opencode_event'; messageId: string; event: OpenCodeGlobalEvent }
  | { type: 'timeline_item'; item: TimelineItem }
  | { type: 'timeline_summary'; itemId: string; summary: string }
  | { type: 'project_info'; info: ProjectInfo }
  | { type: 'deployment_started'; deployment: Deployment }
  | { type: 'deployment_log'; deploymentId: string; entry: DeploymentLogEntry }
  | { type: 'deployment_complete'; deployment: Deployment }
  | { type: 'error'; error: string };

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

    const res = await fetch(getApiUrl(path), {
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
    return this.request<{ user: { id: string; email: string; name?: string; picture?: string } }>('GET', '/auth/me');
  }

  async googleAuth(credential: string) {
    return this.request<{
      access_token: string;
      token_type: string;
      expires_in: number;
      user: { id: string; email: string };
    }>('POST', '/auth/google', { credential });
  }

  // API Keys
  async listApiKeys() {
    return this.request<{ api_keys: import('@fastest/shared').UserApiKey[] }>('GET', '/auth/api-keys');
  }

  async setApiKey(provider: import('@fastest/shared').ApiKeyProvider, keyValue: string) {
    return this.request<{ success: boolean }>('POST', '/auth/api-keys', {
      provider,
      key_value: keyValue,
    });
  }

  async deleteApiKey(provider: import('@fastest/shared').ApiKeyProvider) {
    return this.request<{ success: boolean }>('DELETE', `/auth/api-keys/${provider}`);
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

  async createWorkspace(projectId: string, name: string, baseSnapshotId?: string) {
    return this.request<{ workspace: import('@fastest/shared').Workspace }>(
      'POST',
      `/projects/${projectId}/workspaces`,
      { name, base_snapshot_id: baseSnapshotId }
    );
  }

  // Conversations

  async createConversation(workspaceId: string, title?: string) {
    return this.request<{ conversation: import('@fastest/shared').Conversation }>(
      'POST',
      '/conversations',
      { workspace_id: workspaceId, title }
    );
  }

  async listConversations(options?: { limit?: number; offset?: number }) {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    const query = params.toString() ? `?${params}` : '';

    return this.request<{ conversations: import('@fastest/shared').ConversationWithContext[] }>(
      'GET',
      `/conversations${query}`
    );
  }

  async getConversation(conversationId: string) {
    return this.request<{ conversation: import('@fastest/shared').ConversationWithContext }>(
      'GET',
      `/conversations/${conversationId}`
    );
  }

  async updateConversationTitle(conversationId: string, title: string) {
    return this.request<{ success: boolean }>(
      'PATCH',
      `/conversations/${conversationId}`,
      { title }
    );
  }

  async getMessages(conversationId: string, options?: { limit?: number; before?: string }) {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.before) params.set('before', options.before);
    const query = params.toString() ? `?${params}` : '';

    return this.request<{ messages: Message[] }>(
      'GET',
      `/conversations/${conversationId}/messages${query}`
    );
  }

  async getOpenCodeMessages(conversationId: string) {
    return this.request<{ messages: Record<string, { info?: Record<string, unknown>; parts: import('./opencode').OpenCodePart[] }> }>(
      'GET',
      `/conversations/${conversationId}/opencode-messages`
    );
  }

  async replyOpenCodeQuestion(conversationId: string, requestId: string, answers: string[][]) {
    return this.request<{ success: boolean }>(
      'POST',
      `/conversations/${conversationId}/opencode-questions/${requestId}/reply`,
      { answers }
    );
  }

  async rejectOpenCodeQuestion(conversationId: string, requestId: string) {
    return this.request<{ success: boolean }>(
      'POST',
      `/conversations/${conversationId}/opencode-questions/${requestId}/reject`
    );
  }

  async sendMessage(conversationId: string, prompt: string) {
    return this.request<{ message: Message }>(
      'POST',
      `/conversations/${conversationId}/messages`,
      { prompt }
    );
  }

  async clearConversation(conversationId: string) {
    return this.request<{ success: boolean }>(
      'POST',
      `/conversations/${conversationId}/clear`
    );
  }

  async getTimeline(conversationId: string) {
    return this.request<{ timeline: TimelineItem[] }>(
      'GET',
      `/conversations/${conversationId}/timeline`
    );
  }

  // Deployment

  async getProjectInfo(conversationId: string) {
    return this.request<{ projectInfo: ProjectInfo }>(
      'GET',
      `/conversations/${conversationId}/project-info`
    );
  }

  async getDeployments(conversationId: string) {
    return this.request<{ deployments: Deployment[]; projectInfo: ProjectInfo | null }>(
      'GET',
      `/conversations/${conversationId}/deployments`
    );
  }

  async deploy(conversationId: string) {
    return this.request<{ deploymentId: string; message: string }>(
      'POST',
      `/conversations/${conversationId}/deploy`
    );
  }

  async getDeploymentLogs(conversationId: string, deploymentId: string) {
    return this.request<{ log: import('@fastest/shared').DeploymentLog }>(
      'GET',
      `/conversations/${conversationId}/deployments/${deploymentId}/logs`
    );
  }

  // Environment Variables

  async getEnvVars(projectId: string) {
    return this.request<{ variables: import('@fastest/shared').ProjectEnvVar[] }>(
      'GET',
      `/projects/${projectId}/env-vars`
    );
  }

  async setEnvVar(projectId: string, key: string, value: string, isSecret?: boolean) {
    return this.request<{ success: boolean }>(
      'POST',
      `/projects/${projectId}/env-vars`,
      { key, value, is_secret: isSecret }
    );
  }

  async setEnvVars(projectId: string, variables: import('@fastest/shared').SetEnvVarRequest[]) {
    return this.request<{ success: boolean; count: number }>(
      'PUT',
      `/projects/${projectId}/env-vars`,
      { variables }
    );
  }

  async deleteEnvVar(projectId: string, key: string) {
    return this.request<{ success: boolean }>(
      'DELETE',
      `/projects/${projectId}/env-vars/${key}`
    );
  }

  /**
   * Connect to conversation WebSocket for streaming
   */
  connectStream(conversationId: string, onEvent: (event: StreamEvent) => void): WebSocket {
    const token = this.getToken();
    const wsBase = getWsBase();

    // Include token in URL since WebSocket doesn't support custom headers easily
    const url = `${wsBase}/conversations/${conversationId}/stream?token=${token}`;

    const ws = new WebSocket(url);

    ws.onopen = () => {
      console.log('[WebSocket] Connected to stream');
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as StreamEvent;
        console.log('[WebSocket] Received event:', data.type, data);
        onEvent(data);
      } catch (e) {
        console.error('Failed to parse stream event:', e);
      }
    };

    ws.onclose = (event) => {
      console.log('[WebSocket] Disconnected:', event.code, event.reason);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      onEvent({ type: 'error', error: 'Connection error' });
    };

    return ws;
  }
}

export const api = new ApiClient();
