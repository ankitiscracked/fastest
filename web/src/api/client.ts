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
  DeploymentSettings,
  DeploymentRecord,
  UpdateDeploymentSettingsRequest,
  BuildSuggestion,
  ProjectBrief,
  ProjectIntent,
  UpdateProjectBriefRequest,
} from '@fastest/shared';
import type {
  TimelineItem,
  DeploymentLogEntry,
  DeploymentSettings,
  DeploymentRecord,
  UpdateDeploymentSettingsRequest,
  BuildSuggestion,
  UpdateProjectBriefRequest,
} from '@fastest/shared';
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
  | { type: 'message_status'; messageId: string; status: Message['status'] }
  | { type: 'files_changed'; files: string[] }
  | { type: 'message_complete'; message: Message }
  | { type: 'message_update'; message: Message }
  | { type: 'opencode_event'; messageId: string; event: OpenCodeGlobalEvent }
  | { type: 'timeline_item'; item: TimelineItem }
  | { type: 'timeline_summary'; itemId: string; summary: string }
  | { type: 'project_info'; info: ProjectInfo }
  | { type: 'deployment_started'; deployment: Deployment }
  | { type: 'deployment_log'; deploymentId: string; entry: DeploymentLogEntry }
  | { type: 'deployment_complete'; deployment: Deployment }
  | { type: 'warning'; warning: string }
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

  async getProjectBrief(projectId: string) {
    return this.request<import('@fastest/shared').GetProjectBriefResponse>(
      'GET',
      `/projects/${projectId}/brief`
    );
  }

  async updateProjectBrief(projectId: string, payload: UpdateProjectBriefRequest) {
    return this.request<import('@fastest/shared').GetProjectBriefResponse>(
      'PATCH',
      `/projects/${projectId}/brief`,
      payload
    );
  }

  async listBuildSuggestions(projectId: string, status?: string) {
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    return this.request<import('@fastest/shared').ListBuildSuggestionsResponse>(
      'GET',
      `/projects/${projectId}/suggestions${query}`
    );
  }

  async generateBuildSuggestions(projectId: string) {
    return this.request<import('@fastest/shared').GenerateBuildSuggestionsResponse>(
      'POST',
      `/projects/${projectId}/suggestions/generate`
    );
  }

  async updateBuildSuggestion(projectId: string, suggestionId: string, status: BuildSuggestion['status']) {
    return this.request<{ suggestion: BuildSuggestion }>(
      'PATCH',
      `/projects/${projectId}/suggestions/${suggestionId}`,
      { status }
    );
  }

  async submitBuildSuggestionFeedback(projectId: string, suggestionId: string, helpful: boolean) {
    return this.request<{ suggestion: BuildSuggestion }>(
      'POST',
      `/projects/${projectId}/suggestions/${suggestionId}/feedback`,
      { helpful }
    );
  }

  // Project Docs
  async listProjectDocs(projectId: string) {
    return this.request<import('@fastest/shared').ListProjectDocsResponse>(
      'GET',
      `/projects/${projectId}/docs`
    );
  }

  async getDocContent(projectId: string, workspaceId: string, path: string) {
    return this.request<import('@fastest/shared').GetDocContentResponse>(
      'GET',
      `/projects/${projectId}/docs/content?workspace=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(path)}`
    );
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

  async createWorkspace(projectId: string, name: string, forkSnapshotId?: string) {
    return this.request<{ workspace: import('@fastest/shared').Workspace }>(
      'POST',
      `/projects/${projectId}/workspaces`,
      { name, fork_snapshot_id: forkSnapshotId }
    );
  }

  // Drift comparison (sync with main)
  async getDriftComparison(workspaceId: string) {
    return this.request<{
      drift: import('@fastest/shared').DriftReport | null;
      is_main_workspace: boolean;
      message?: string;
    }>('GET', `/workspaces/${workspaceId}/drift/compare`);
  }

  async analyzeDrift(workspaceId: string) {
    return this.request<{
      analysis: import('@fastest/shared').DriftAnalysis | null;
      error?: string;
    }>('POST', `/workspaces/${workspaceId}/drift/analyze`);
  }

  async setAsMainWorkspace(workspaceId: string) {
    return this.request<{ success: boolean; main_workspace_id: string }>(
      'POST',
      `/workspaces/${workspaceId}/set-as-main`
    );
  }

  // Sync operations
  async prepareSync(workspaceId: string) {
    return this.request<{ preview: import('@fastest/shared').SyncPreview }>(
      'POST',
      `/workspaces/${workspaceId}/sync/prepare`
    );
  }

  async executeSync(
    workspaceId: string,
    previewId: string,
    decisions: Record<string, string> = {},
    options?: { createSnapshotBefore?: boolean; createSnapshotAfter?: boolean }
  ) {
    return this.request<import('@fastest/shared').ExecuteSyncResponse>(
      'POST',
      `/workspaces/${workspaceId}/sync/execute`,
      {
        preview_id: previewId,
        decisions,
        create_snapshot_before: options?.createSnapshotBefore ?? true,
        create_snapshot_after: options?.createSnapshotAfter ?? true,
      }
    );
  }

  async undoSync(workspaceId: string, snapshotId: string) {
    return this.request<{ success: boolean; restored_snapshot_id: string }>(
      'POST',
      `/workspaces/${workspaceId}/sync/undo`,
      { snapshot_id: snapshotId }
    );
  }

  async getWorkspaceSnapshots(workspaceId: string, options?: { limit?: number }) {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    const query = params.toString() ? `?${params}` : '';

    return this.request<{
      snapshots: Array<{
        id: string;
        project_id: string;
        manifest_hash: string;
        parent_snapshot_id: string | null;
        source: string;
        summary: string | null;
        created_at: string;
        is_current: boolean;
      }>;
      current_snapshot_id: string | null;
    }>('GET', `/workspaces/${workspaceId}/snapshots${query}`);
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

  async moveConversationToWorkspace(conversationId: string, workspaceId: string) {
    return this.request<{ success: boolean }>(
      'PATCH',
      `/conversations/${conversationId}`,
      { workspace_id: workspaceId }
    );
  }

  /**
   * Create a snapshot from the conversation's current file state.
   * This captures any dirty files (modified but not yet in a snapshot).
   *
   * Options:
   * - generateSummary: Generate an LLM summary of changes
   */
  async createConversationSnapshot(
    conversationId: string,
    options?: { generateSummary?: boolean }
  ) {
    return this.request<{
      snapshot_id: string | null;
      manifest_hash: string | null;
      was_dirty: boolean;
      summary: string | null;
      file_changes: { added: number; modified: number; deleted: number } | null;
    }>('POST', `/conversations/${conversationId}/snapshot`, {
      generate_summary: options?.generateSummary ?? false,
    });
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
    return this.request<{ messageId: string }>(
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

  async deployWorkspace(workspaceId: string) {
    return this.request<{
      deploymentId: string;
      message: string;
      snapshot_id: string;
      conversation_id: string;
    }>(
      'POST',
      `/workspaces/${workspaceId}/deploy`
    );
  }

  async getDeploymentSettings(workspaceId: string) {
    return this.request<{ settings: DeploymentSettings }>(
      'GET',
      `/infrastructure/workspaces/${workspaceId}/deployment-settings`
    );
  }

  async updateDeploymentSettings(workspaceId: string, update: UpdateDeploymentSettingsRequest) {
    return this.request<{ settings: DeploymentSettings }>(
      'PUT',
      `/infrastructure/workspaces/${workspaceId}/deployment-settings`,
      update
    );
  }

  async getDeploymentHistory(workspaceId: string, limit = 30) {
    return this.request<{ deployments: DeploymentRecord[] }>(
      'GET',
      `/infrastructure/workspaces/${workspaceId}/deployments?limit=${limit}`
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

  // Action Items (cross-workspace insights)

  async getActionItems() {
    return this.request<{ items: import('@fastest/shared').ActionItem[] }>(
      'GET',
      '/action-items'
    );
  }

  async dismissActionItem(itemId: string) {
    return this.request<{ success: boolean }>(
      'POST',
      `/action-items/${itemId}/dismiss`
    );
  }

  /**
   * Connect to conversation WebSocket for streaming with automatic reconnection
   */
  connectStream(
    conversationId: string,
    onEvent: (event: StreamEvent) => void,
    options?: {
      maxReconnectAttempts?: number;
      onConnectionChange?: (connected: boolean) => void;
    }
  ): ReconnectingWebSocket {
    const token = this.getToken();
    const wsBase = getWsBase();
    const url = `${wsBase}/conversations/${conversationId}/stream?token=${token}`;

    return new ReconnectingWebSocket(url, onEvent, {
      maxReconnectAttempts: options?.maxReconnectAttempts ?? 5,
      onConnectionChange: options?.onConnectionChange,
    });
  }
}

/**
 * WebSocket wrapper with automatic reconnection and exponential backoff
 */
export class ReconnectingWebSocket {
  private ws: WebSocket | null = null;
  private url: string;
  private onEvent: (event: StreamEvent) => void;
  private reconnectAttempts = 0;
  private maxReconnectAttempts: number;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;
  private onConnectionChange?: (connected: boolean) => void;

  // Exponential backoff: 1s, 2s, 4s, 8s, 16s (capped)
  private readonly baseDelay = 1000;
  private readonly maxDelay = 16000;

  constructor(
    url: string,
    onEvent: (event: StreamEvent) => void,
    options: {
      maxReconnectAttempts?: number;
      onConnectionChange?: (connected: boolean) => void;
    } = {}
  ) {
    this.url = url;
    this.onEvent = onEvent;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
    this.onConnectionChange = options.onConnectionChange;
    this.connect();
  }

  private connect() {
    if (this.intentionallyClosed) return;

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        console.log('[WebSocket] Connected to stream');
        this.reconnectAttempts = 0; // Reset on successful connection
        this.onConnectionChange?.(true);
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as StreamEvent;
          console.log('[WebSocket] Received event:', data.type, data);
          this.onEvent(data);
        } catch (e) {
          console.error('Failed to parse stream event:', e);
        }
      };

      this.ws.onclose = (event) => {
        console.log('[WebSocket] Disconnected:', event.code, event.reason);
        this.onConnectionChange?.(false);

        // Don't reconnect if intentionally closed or normal closure
        if (this.intentionallyClosed || event.code === 1000) {
          return;
        }

        this.scheduleReconnect();
      };

      this.ws.onerror = (error) => {
        console.error('[WebSocket] Error:', error);
        // onclose will be called after onerror, which handles reconnection
      };
    } catch (error) {
      console.error('[WebSocket] Failed to create connection:', error);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.intentionallyClosed) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('[WebSocket] Max reconnection attempts reached');
      this.onEvent({ type: 'error', error: 'Connection lost. Please refresh the page.' });
      return;
    }

    // Exponential backoff with jitter
    const delay = Math.min(
      this.baseDelay * Math.pow(2, this.reconnectAttempts) + Math.random() * 1000,
      this.maxDelay
    );

    console.log(`[WebSocket] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})`);

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  /**
   * Get the current WebSocket ready state
   */
  get readyState(): number {
    return this.ws?.readyState ?? WebSocket.CLOSED;
  }

  /**
   * Send data through the WebSocket
   */
  send(data: string | ArrayBuffer | Blob) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      console.warn('[WebSocket] Cannot send - not connected');
    }
  }

  /**
   * Close the WebSocket connection permanently (no reconnection)
   */
  close() {
    this.intentionallyClosed = true;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      // Only close if not already closed/closing
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, 'Client closed');
      }
      this.ws = null;
    }
  }

  /**
   * Manually trigger a reconnection attempt
   */
  reconnect() {
    this.intentionallyClosed = false;
    this.reconnectAttempts = 0;

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.connect();
  }
}

export const api = new ApiClient();
