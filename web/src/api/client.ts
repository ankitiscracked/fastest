const API_BASE = '/v1';

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
export type { Conversation, ConversationWithContext, TimelineItem, FileChange } from '@fastest/shared';
import type { TimelineItem } from '@fastest/shared';

export type StreamEvent =
  | { type: 'message_start'; messageId: string }
  | { type: 'content_delta'; content: string }
  | { type: 'status'; status: Message['status'] }
  | { type: 'files_changed'; files: string[] }
  | { type: 'message_complete'; message: Message }
  | { type: 'timeline_item'; item: TimelineItem }
  | { type: 'timeline_summary'; itemId: string; summary: string }
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

  /**
   * Connect to conversation WebSocket for streaming
   */
  connectStream(conversationId: string, onEvent: (event: StreamEvent) => void): WebSocket {
    const token = this.getToken();
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;

    // Include token in URL since WebSocket doesn't support custom headers easily
    const url = `${protocol}//${host}${API_BASE}/conversations/${conversationId}/stream?token=${token}`;

    const ws = new WebSocket(url);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as StreamEvent;
        onEvent(data);
      } catch (e) {
        console.error('Failed to parse stream event:', e);
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      onEvent({ type: 'error', error: 'Connection error' });
    };

    return ws;
  }
}

export const api = new ApiClient();
