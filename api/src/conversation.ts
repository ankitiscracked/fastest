/**
 * ConversationSession Durable Object
 *
 * Manages a persistent conversation tied to a workspace.
 * Handles:
 * - Message storage and history
 * - Long-running sandbox connection
 * - WebSocket streaming to clients
 * - Session resume after sandbox death
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';
import type { TimelineItem, FileChange, DeploymentLogEntry, DeploymentLog } from '@fastest/shared';
import type { ConversationState, Message, Deployment, ProjectInfo } from './conversation_types';
import { ConversationFiles } from './conversation_files';
import { ConversationDeployments } from './conversation_deploy';
import { ConversationOpenCode } from './conversation_opencode';
import { ConversationWebSocket } from './conversation_ws';
import { ConversationSandbox } from './conversation_sandbox';

 

// Events sent over WebSocket
type StreamEvent =
  | { type: 'message_start'; messageId: string }
  | { type: 'content_delta'; content: string }
  | { type: 'message_status'; messageId: string; status: Message['status'] }
  | { type: 'files_changed'; files: string[] }
  | { type: 'message_complete'; message: Message }
  | { type: 'message_update'; message: Message }
  | { type: 'opencode_event'; messageId: string; event: unknown }
  | { type: 'timeline_item'; item: TimelineItem }
  | { type: 'timeline_summary'; itemId: string; summary: string }
  | { type: 'project_info'; info: ProjectInfo }
  | { type: 'deployment_started'; deployment: Deployment }
  | { type: 'deployment_log'; deploymentId: string; entry: DeploymentLogEntry }
  | { type: 'deployment_complete'; deployment: Deployment }
  | { type: 'error'; error: string };

export class ConversationSession extends DurableObject<Env> {
  private state: ConversationState | null = null;
  private ws: ConversationWebSocket;
  private sandbox: ConversationSandbox;
  private files: ConversationFiles;
  private deployments: ConversationDeployments;
  private openCode: ConversationOpenCode;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sandbox = new ConversationSandbox({
      env: this.env,
      ensureState: () => this.ensureState(),
      persistState: (state) => this.ctx.storage.put('state', state),
    });
    this.files = new ConversationFiles({
      env: this.env,
      ensureState: () => this.ensureState(),
      sandbox: this.sandbox,
      persistState: (state) => this.ctx.storage.put('state', state),
    });
    this.ws = new ConversationWebSocket(this.ctx);
    this.deployments = new ConversationDeployments({
      env: this.env,
      ctx: this.ctx,
      ensureState: () => this.ensureState(),
      sandbox: this.sandbox,
      files: this.files,
      broadcast: (event) => this.broadcast(event),
    });
    this.openCode = new ConversationOpenCode({
      env: this.env,
      ctx: this.ctx,
      ensureState: () => this.ensureState(),
      sandbox: this.sandbox,
      files: this.files,
      broadcast: (event) => this.broadcast(event),
    });
  }

  /**
   * Initialize or load conversation state
   */
  private async ensureState(): Promise<ConversationState> {
    if (this.state) return this.state;

    const stored = await this.ctx.storage.get<ConversationState>('state');
    if (stored) {
      this.state = stored;
      return this.state;
    }

    // New conversation - will be initialized on first message
    throw new Error('Conversation not initialized. Call init() first.');
  }

  /**
   * Initialize a new conversation
   */
  async init(conversationId: string, workspaceId: string, projectId: string): Promise<ConversationState> {
    const existing = await this.ctx.storage.get<ConversationState>('state');
    if (existing) {
      this.state = existing;
      return existing;
    }

    const now = new Date().toISOString();
    this.state = {
      conversationId,
      workspaceId,
      projectId,
      messages: [],
      openCodeMessages: {},
      openCodeMessageIdMap: {},
      timeline: [],
      deployments: [],
      autoCommitOnClear: false,
      createdAt: now,
      updatedAt: now,
    };

    await this.ctx.storage.put('state', this.state);
    return this.state;
  }

  /**
   * Get conversation state
   */
  async getState(): Promise<ConversationState> {
    return this.ensureState();
  }

  /**
   * Get messages with optional pagination
   */
  async getMessages(limit?: number, before?: string): Promise<Message[]> {
    const state = await this.ensureState();
    let messages = [...state.messages];

    if (before) {
      const idx = messages.findIndex(m => m.id === before);
      if (idx > 0) {
        messages = messages.slice(0, idx);
      }
    }

    if (limit) {
      messages = messages.slice(-limit);
    }

    return messages;
  }

  async getOpenCodeMessagesByConversationMessageId(): Promise<Record<string, { info?: Record<string, unknown>; parts: Record<string, unknown>[] }>> {
    return this.openCode.getOpenCodeMessagesByConversationMessageId();
  }

  /**
   * Handle WebSocket connection for streaming
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade for streaming
    const wsResponse = this.ws.handleUpgrade(request);
    if (wsResponse) return wsResponse;

    // REST endpoints
    if (url.pathname === '/init' && request.method === 'POST') {
      const { conversationId, workspaceId, projectId } = await request.json() as {
        conversationId: string;
        workspaceId: string;
        projectId: string;
      };
      const state = await this.init(conversationId, workspaceId, projectId);
      return Response.json({ state });
    }

    if (url.pathname === '/state' && request.method === 'GET') {
      const state = await this.getState();
      return Response.json({ state });
    }

    if (url.pathname === '/messages' && request.method === 'GET') {
      const limit = url.searchParams.get('limit');
      const before = url.searchParams.get('before');
      const messages = await this.getMessages(
        limit ? parseInt(limit) : undefined,
        before || undefined
      );
      return Response.json({ messages });
    }

    if (url.pathname === '/opencode-messages' && request.method === 'GET') {
      const messages = await this.openCode.getOpenCodeMessagesByConversationMessageId();
      return Response.json({ messages });
    }

    if (url.pathname === '/message' && request.method === 'POST') {
      const { prompt, apiUrl, apiToken } = await request.json() as {
        prompt: string;
        apiUrl: string;
        apiToken: string;
      };
      const message = await this.sendMessage(prompt, apiUrl, apiToken);
      return Response.json({ messageId: message.id });
    }

    if (url.pathname === '/opencode-question/reply' && request.method === 'POST') {
      const { requestId, answers, apiUrl, apiToken } = await request.json() as {
        requestId: string;
        answers: string[][];
        apiUrl: string;
        apiToken: string;
      };
      await this.openCode.replyOpenCodeQuestion(requestId, answers, apiUrl, apiToken);
      return Response.json({ success: true });
    }

    if (url.pathname === '/opencode-question/reject' && request.method === 'POST') {
      const { requestId, apiUrl, apiToken } = await request.json() as {
        requestId: string;
        apiUrl: string;
        apiToken: string;
      };
      await this.openCode.rejectOpenCodeQuestion(requestId, apiUrl, apiToken);
      return Response.json({ success: true });
    }

    if (url.pathname === '/clear' && request.method === 'POST') {
      await this.clearConversation();
      return Response.json({ success: true });
    }

    if (url.pathname === '/timeline' && request.method === 'GET') {
      const state = await this.ensureState();
      return Response.json({ timeline: state.timeline });
    }

    if (url.pathname === '/timeline/generate-summary' && request.method === 'POST') {
      const { itemId } = await request.json() as { itemId: string };
      // This triggers async summary generation - does not wait
      this.generateTimelineSummary(itemId).catch(console.error);
      return Response.json({ success: true, message: 'Summary generation started' });
    }

    if (url.pathname === '/project-info' && request.method === 'GET') {
      const { apiUrl, apiToken } = Object.fromEntries(url.searchParams) as { apiUrl: string; apiToken: string };
      const projectInfo = await this.deployments.detectProjectType(apiUrl, apiToken);
      return Response.json({ projectInfo });
    }

    if (url.pathname === '/deployments' && request.method === 'GET') {
      const state = await this.ensureState();
      return Response.json({
        deployments: state.deployments,
        projectInfo: state.projectInfo,
      });
    }

    if (url.pathname === '/deploy' && request.method === 'POST') {
      const { apiUrl, apiToken } = await request.json() as { apiUrl: string; apiToken: string };
      // Trigger async deployment - returns immediately
      const deploymentId = crypto.randomUUID();
      this.deployments.deploy(deploymentId, apiUrl, apiToken).catch(console.error);
      return Response.json({ deploymentId, message: 'Deployment started' });
    }

    // Get deployment logs: /deployments/:deploymentId/logs
    const logsMatch = url.pathname.match(/^\/deployments\/([^/]+)\/logs$/);
    if (logsMatch && request.method === 'GET') {
      const deploymentId = logsMatch[1];
      const log = await this.ctx.storage.get<DeploymentLog>(`deployment_log:${deploymentId}`);
      if (!log) {
        return Response.json({ error: { code: 'NOT_FOUND', message: 'Deployment log not found' } }, { status: 404 });
      }
      return Response.json({ log });
    }

    return new Response('Not found', { status: 404 });
  }

  /**
   * Broadcast event to all connected WebSocket clients
   */
  private broadcast(event: StreamEvent) {
    this.ws.broadcast(event);
  }

  /**
   * Send a message and stream the response
   */
  async sendMessage(prompt: string, apiUrl: string, apiToken: string): Promise<Message> {
    const state = await this.ensureState();
    state.activeAssistantMessageId = undefined;

    // Create user message
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: prompt,
      status: 'completed',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };

    // Create assistant message (running)
    const assistantMessage: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      status: 'running',
      createdAt: new Date().toISOString(),
    };

    // Add messages to state
    state.messages.push(userMessage, assistantMessage);
    state.updatedAt = new Date().toISOString();
    state.activeAssistantMessageId = assistantMessage.id;
    await this.ctx.storage.put('state', state);

    // Notify clients
    this.broadcast({ type: 'message_start', messageId: assistantMessage.id });
    this.broadcast({ type: 'message_status', messageId: assistantMessage.id, status: 'running' });

    // Run the heavy work async so the request can return quickly.
    this.ctx.waitUntil(this.runMessage(prompt, apiUrl, apiToken, assistantMessage.id));

    return assistantMessage;
  }

  /**
   * Long-running message processing (sandbox + OpenCode + uploads).
   */
  private async runMessage(
    prompt: string,
    apiUrl: string,
    apiToken: string,
    assistantMessageId: string
  ): Promise<void> {
    const state = await this.ensureState();
    const assistantMessage = state.messages.find(m => m.id === assistantMessageId);
    if (!assistantMessage) {
      console.error('[Conversation] Assistant message not found', {
        conversationId: state.conversationId,
        messageId: assistantMessageId,
      });
      return;
    }

    try {
      const handleOpenCodeEvent = (payload: { type?: string; properties?: Record<string, unknown> }) => {
        if (!payload?.type) return;
        if (!state.openCodeMessages) {
          state.openCodeMessages = {};
        }
        if (!state.openCodeMessageIdMap) {
          state.openCodeMessageIdMap = {};
        }

        const activeAssistantId = state.activeAssistantMessageId || assistantMessage.id;

        if (payload.type === 'message.updated') {
          const info = (payload.properties as { info?: Record<string, unknown> } | undefined)?.info;
          const id = info?.id as string | undefined;
          if (!id) return;
          if (!state.openCodeMessages[id]) {
            state.openCodeMessages[id] = { parts: {}, partsOrder: [] };
          }
          state.openCodeMessages[id].info = info;
          const role = info?.role as string | undefined;
          if (role && role !== 'user') {
            state.openCodeMessageIdMap[id] = activeAssistantId;
          }
          return;
        }

        if (payload.type === 'message.part.updated') {
          const part = (payload.properties as { part?: Record<string, unknown>; delta?: string } | undefined)?.part;
          if (!part) return;
          const messageId = part.messageID as string | undefined;
          if (!messageId) return;
          if (!state.openCodeMessages[messageId]) {
            state.openCodeMessages[messageId] = { parts: {}, partsOrder: [] };
          }
          if (!state.openCodeMessageIdMap[messageId]) {
            state.openCodeMessageIdMap[messageId] = activeAssistantId;
          }
          const record = state.openCodeMessages[messageId];
          const partId = (part.id as string | undefined) || `${part.type || 'part'}-${messageId}`;
          const prevPart = record.parts[partId] || {};
          const nextPart = { ...prevPart, ...part } as Record<string, unknown>;
          if (part.type === 'text') {
            const delta = (payload.properties as { delta?: string } | undefined)?.delta;
            if (delta && typeof nextPart.text !== 'string') {
              nextPart.text = `${(prevPart.text as string | undefined) || ''}${delta}`;
            }
          }
          record.parts[partId] = nextPart;
          if (!record.partsOrder.includes(partId)) {
            record.partsOrder.push(partId);
          }
        }
      };

      // Run in sandbox with streaming
      const result = await this.openCode.runInSandboxWithStreaming(
        prompt,
        apiUrl,
        apiToken,
        assistantMessage.id,
        (delta) => {
          // Broadcast each delta as it arrives
          this.broadcast({ type: 'content_delta', content: delta });
        },
        handleOpenCodeEvent
      );

      // Update assistant message with full content
      assistantMessage.content = result.output;
      assistantMessage.status = 'completed';
      assistantMessage.completedAt = new Date().toISOString();
      await this.ctx.storage.put('state', state);
      this.broadcast({ type: 'message_status', messageId: assistantMessage.id, status: 'completed' });
      this.broadcast({ type: 'message_complete', message: assistantMessage });

      if (state.activeAssistantMessageId === assistantMessage.id) {
        state.activeAssistantMessageId = undefined;
      }

      const { fileChanges, manifestHash, previousManifestHash } = await this.files.collectAndUploadFiles(
        result.sandbox,
        apiUrl,
        apiToken,
        result.workDir
      );

      assistantMessage.filesChanged = fileChanges.map(f => f.path);
      if (manifestHash) {
        state.lastManifestHash = manifestHash;
      }

      if (fileChanges.length > 0) {
        const timelineItem: TimelineItem = {
          id: crypto.randomUUID(),
          messageId: assistantMessage.id,
          timestamp: new Date().toISOString(),
          summary: null,
          summaryStatus: 'pending',
          files: fileChanges,
          manifestHash,
          previousManifestHash,
        };
        state.timeline.push(timelineItem);
        this.broadcast({ type: 'timeline_item', item: timelineItem });
        this.generateTimelineSummary(timelineItem.id).catch(console.error);
      }

      await this.ctx.storage.put('state', state);

      if (fileChanges.length > 0) {
        this.broadcast({ type: 'files_changed', files: fileChanges.map(f => f.path) });
        this.broadcast({ type: 'message_update', message: assistantMessage });
      }

    } catch (error) {
      assistantMessage.status = 'failed';
      assistantMessage.error = error instanceof Error ? error.message : String(error);
      assistantMessage.completedAt = new Date().toISOString();

      console.error('[Conversation] Assistant message failed', {
        conversationId: state.conversationId,
        messageId: assistantMessage.id,
        error: assistantMessage.error,
      });

      if (state.activeAssistantMessageId === assistantMessage.id) {
        state.activeAssistantMessageId = undefined;
      }
      await this.ctx.storage.put('state', state);

      this.broadcast({ type: 'error', error: assistantMessage.error });
      this.broadcast({ type: 'message_status', messageId: assistantMessage.id, status: 'failed' });
      this.broadcast({ type: 'message_complete', message: assistantMessage });
    }
  }

  /**
   * Clear conversation (visual reset)
   */
  async clearConversation(): Promise<void> {
    const state = await this.ensureState();

    // Optionally create a commit before clearing
    // (would need to be implemented with proper snapshot creation)

    // Clear messages but keep session state
    state.messages = [];
    state.openCodeMessages = {};
    state.openCodeMessageIdMap = {};
    state.updatedAt = new Date().toISOString();

    await this.ctx.storage.put('state', state);
  }

  /**
   * Generate a narrative summary for a timeline item using Workers AI
   * This runs async and broadcasts the result when complete
   */
  private async generateTimelineSummary(itemId: string): Promise<void> {
    const state = await this.ensureState();
    const item = state.timeline.find(t => t.id === itemId);
    if (!item) return;

    // Update status to generating
    item.summaryStatus = 'generating';
    await this.ctx.storage.put('state', state);

    try {
      // Build prompt from file changes
      const added = item.files.filter(f => f.change === 'added').map(f => f.path);
      const modified = item.files.filter(f => f.change === 'modified').map(f => f.path);
      const deleted = item.files.filter(f => f.change === 'deleted').map(f => f.path);

      // Find the corresponding message to get context
      const message = state.messages.find(m => m.id === item.messageId);
      const userPrompt = state.messages.find(
        (m, i) => m.role === 'user' && state.messages[i + 1]?.id === item.messageId
      );

      const prompt = `You are summarizing code changes for a developer. Generate a concise 1-2 sentence narrative summary of what was accomplished.

User's request: "${userPrompt?.content || 'Unknown'}"

Files changed:
${added.length > 0 ? `Added: ${added.join(', ')}` : ''}
${modified.length > 0 ? `Modified: ${modified.join(', ')}` : ''}
${deleted.length > 0 ? `Deleted: ${deleted.join(', ')}` : ''}

Write a brief summary focusing on what was accomplished, not listing files. Use past tense. Be specific but concise.`;

      // Call Workers AI (using type assertion for newer model)
      const response = await (this.env.AI as Ai).run(
        '@cf/meta/llama-3.1-8b-instruct-fast' as Parameters<Ai['run']>[0],
        {
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 100,
        }
      ) as { response?: string };

      const summary = response.response?.trim() || 'Updated project files';

      // Update timeline item
      item.summary = summary;
      item.summaryStatus = 'completed';
      await this.ctx.storage.put('state', state);

      // Broadcast the update
      this.broadcast({ type: 'timeline_summary', itemId, summary });

    } catch (error) {
      console.error('Failed to generate timeline summary:', error);
      item.summaryStatus = 'failed';
      item.summary = this.generateFallbackSummary(item.files);
      await this.ctx.storage.put('state', state);

      // Still broadcast the fallback
      this.broadcast({ type: 'timeline_summary', itemId, summary: item.summary });
    }
  }

  /**
   * Generate a simple fallback summary when AI fails
   */
  private generateFallbackSummary(files: FileChange[]): string {
    const added = files.filter(f => f.change === 'added').length;
    const modified = files.filter(f => f.change === 'modified').length;
    const deleted = files.filter(f => f.change === 'deleted').length;

    const parts: string[] = [];
    if (added > 0) parts.push(`added ${added} file${added > 1 ? 's' : ''}`);
    if (modified > 0) parts.push(`modified ${modified} file${modified > 1 ? 's' : ''}`);
    if (deleted > 0) parts.push(`deleted ${deleted} file${deleted > 1 ? 's' : ''}`);

    return parts.length > 0 ? `Changed files: ${parts.join(', ')}` : 'Updated project files';
  }

}
