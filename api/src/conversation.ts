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
import { getSandbox, parseSSEStream, type Sandbox as CloudflareSandbox } from '@cloudflare/sandbox';
import { Sandbox as E2BSandbox } from 'e2b';
import type { Env } from './index';
import type { TimelineItem, FileChange, DeploymentLogEntry, DeploymentLog } from '@fastest/shared';

// Sandbox exec stream event types
type ExecEvent =
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'complete'; exitCode: number }
  | { type: 'error'; error: string };

type SandboxExecResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number;
};

type SandboxRunner = {
  exec: (command: string, opts?: { cwd?: string; env?: Record<string, string> }) => Promise<SandboxExecResult>;
  execStream?: (command: string, opts?: { env?: Record<string, string>; timeout?: number }) => Promise<ReadableStream>;
  runBackground?: (command: string, opts?: { cwd?: string; env?: Record<string, string> }) => Promise<void>;
  getHost?: (port: number) => string;
  type: 'cloudflare' | 'e2b';
};

// Message in the conversation
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

// Deployment info
export interface Deployment {
  id: string;
  url: string;
  status: 'deploying' | 'success' | 'failed';
  error?: string;
  createdAt: string;
  completedAt?: string;
}

// Project type detection
export interface ProjectInfo {
  type: 'wrangler' | 'unknown';
  name?: string;
  configFile?: string;
}

// State persisted in the DO
interface ConversationState {
  conversationId: string;
  workspaceId: string;
  projectId: string;
  messages: Message[];
  openCodeMessages?: Record<string, {
    info?: Record<string, unknown>;
    parts: Record<string, Record<string, unknown>>;
    partsOrder: string[];
  }>;
  openCodeMessageIdMap?: Record<string, string>;
  e2bSandboxId?: string;

  // Timeline of file changes
  timeline: TimelineItem[];

  // OpenCode session state (for resume)
  openCodeSessionId?: string;
  openCodePort?: number;

  // File state
  lastManifestHash?: string;

  // Deployment state
  projectInfo?: ProjectInfo;
  deployments: Deployment[];

  // Settings
  autoCommitOnClear: boolean;

  // Metadata
  createdAt: string;
  updatedAt: string;
}

// Events sent over WebSocket
type StreamEvent =
  | { type: 'message_start'; messageId: string }
  | { type: 'content_delta'; content: string }
  | { type: 'status'; status: Message['status'] }
  | { type: 'files_changed'; files: string[] }
  | { type: 'message_complete'; message: Message }
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
  private clients: Set<WebSocket> = new Set();
  private sandbox: CloudflareSandbox | null = null;
  private sandboxReady: boolean = false;
  private e2bSandbox: E2BSandbox | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
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
    const state = await this.ensureState();
    const openCodeMessages = state.openCodeMessages || {};
    const idMap = state.openCodeMessageIdMap || {};
    const mapped: Record<string, { info?: Record<string, unknown>; parts: Record<string, unknown>[] }> = {};

    for (const [openCodeMessageId, record] of Object.entries(openCodeMessages)) {
      const conversationMessageId = idMap[openCodeMessageId];
      if (!conversationMessageId) continue;
      const parts = record.partsOrder.length > 0
        ? record.partsOrder.map(id => record.parts[id]).filter(Boolean)
        : Object.values(record.parts);
      if (!mapped[conversationMessageId]) {
        mapped[conversationMessageId] = { info: record.info, parts: [] };
      }
      mapped[conversationMessageId].parts.push(...parts);
    }

    return mapped;
  }

  /**
   * Handle WebSocket connection for streaming
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade for streaming
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.ctx.acceptWebSocket(server);
      this.clients.add(server);
      console.log(`[WebSocket] Client connected. Total clients: ${this.clients.size}`);

      server.addEventListener('close', () => {
        this.clients.delete(server);
        console.log(`[WebSocket] Client disconnected. Total clients: ${this.clients.size}`);
      });

      server.addEventListener('error', (err) => {
        console.log(`[WebSocket] Client error:`, err);
        this.clients.delete(server);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

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
      const messages = await this.getOpenCodeMessagesByConversationMessageId();
      return Response.json({ messages });
    }

    if (url.pathname === '/message' && request.method === 'POST') {
      const { prompt, apiUrl, apiToken } = await request.json() as {
        prompt: string;
        apiUrl: string;
        apiToken: string;
      };
      const message = await this.sendMessage(prompt, apiUrl, apiToken);
      return Response.json({ message });
    }

    if (url.pathname === '/opencode-question/reply' && request.method === 'POST') {
      const { requestId, answers, apiUrl, apiToken } = await request.json() as {
        requestId: string;
        answers: string[][];
        apiUrl: string;
        apiToken: string;
      };
      await this.replyOpenCodeQuestion(requestId, answers, apiUrl, apiToken);
      return Response.json({ success: true });
    }

    if (url.pathname === '/opencode-question/reject' && request.method === 'POST') {
      const { requestId, apiUrl, apiToken } = await request.json() as {
        requestId: string;
        apiUrl: string;
        apiToken: string;
      };
      await this.rejectOpenCodeQuestion(requestId, apiUrl, apiToken);
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
      const projectInfo = await this.detectProjectType(apiUrl, apiToken);
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
      this.deploy(deploymentId, apiUrl, apiToken).catch(console.error);
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
    const data = JSON.stringify(event);
    console.log(`[Broadcast] Sending ${event.type} to ${this.clients.size} clients`);
    for (const client of this.clients) {
      try {
        client.send(data);
      } catch (err) {
        console.log(`[Broadcast] Error sending to client:`, err);
        this.clients.delete(client);
      }
    }
  }

  /**
   * Get or create a sandbox instance
   */
  private async getCloudflareSandbox(): Promise<CloudflareSandbox> {
    if (this.sandbox && this.sandboxReady) {
      return this.sandbox;
    }

    const state = await this.ensureState();

    // Use workspace ID as sandbox ID for persistence
    // normalizeId converts to lowercase to avoid hostname issues with preview URLs
    const sandbox = getSandbox(this.env.Sandbox, `workspace-${state.workspaceId}`, { normalizeId: true });
    if (!sandbox) {
      throw new Error('Failed to get sandbox instance');
    }
    this.sandbox = sandbox;
    this.sandboxReady = true;

    return this.sandbox;
  }

  private getSandboxProvider(): 'cloudflare' | 'e2b' {
    const provider = (this.env.SANDBOX_PROVIDER || '').toLowerCase();
    return provider === 'e2b' ? 'e2b' : 'cloudflare';
  }

  private async getE2BSandbox(): Promise<E2BSandbox> {
    const timeoutMs = 30 * 60 * 1000;
    const apiKey = (this.env.E2B_API_KEY || '').trim();
    const e2bOpts = apiKey ? { apiKey } : undefined;
    if (this.e2bSandbox) {
      try {
        if (await this.e2bSandbox.isRunning()) {
          try {
            await this.e2bSandbox.setTimeout(timeoutMs);
          } catch (err) {
            console.warn('[Sandbox][E2B] Failed to extend timeout', err);
          }
          return this.e2bSandbox;
        }
      } catch {
        // fall through to reconnect
      }
    }

    const state = await this.ensureState();
    if (state.e2bSandboxId) {
      try {
        const sandbox = await E2BSandbox.connect(state.e2bSandboxId, e2bOpts);
        try {
          await sandbox.setTimeout(timeoutMs);
        } catch (err) {
          console.warn('[Sandbox][E2B] Failed to extend timeout', err);
        }
        this.e2bSandbox = sandbox;
        return sandbox;
      } catch {
        state.e2bSandboxId = undefined;
        await this.ctx.storage.put('state', state);
        // fall through to create
      }
    }

    const templateId = (this.env.E2B_TEMPLATE_ID || '').trim();
    const sandbox = templateId
      ? await E2BSandbox.create(templateId, { ...e2bOpts, timeoutMs })
      : await E2BSandbox.create({ ...e2bOpts, timeoutMs });
    try {
      await sandbox.setTimeout(timeoutMs);
    } catch (err) {
      console.warn('[Sandbox][E2B] Failed to set timeout', err);
    }
    state.e2bSandboxId = sandbox.sandboxId;
    await this.ctx.storage.put('state', state);
    this.e2bSandbox = sandbox;
    return sandbox;
  }

  private async getSandboxRunner(): Promise<SandboxRunner> {
    if (this.getSandboxProvider() === 'e2b') {
      const sandbox = await this.getE2BSandbox();
      return {
        exec: async (command, opts) => {
          try {
            const result = await sandbox.commands.run(command, {
              cwd: opts?.cwd,
              envs: opts?.env,
            });
            if (result.exitCode !== 0) {
              console.error('[Sandbox][E2B] Command failed', {
                command,
                exitCode: result.exitCode,
                stdout: (result.stdout || '').slice(0, 2000),
                stderr: (result.stderr || '').slice(0, 2000),
              });
            }
            return {
              success: result.exitCode === 0,
              stdout: result.stdout || '',
              stderr: result.stderr || '',
              exitCode: result.exitCode,
            };
          } catch (err) {
            const exitCode = (err && typeof err === 'object' && 'exitCode' in err)
              ? (err as { exitCode?: number }).exitCode
              : undefined;
            const stdout = (err && typeof err === 'object' && 'stdout' in err)
              ? String((err as { stdout?: string }).stdout || '')
              : '';
            const stderr = (err && typeof err === 'object' && 'stderr' in err)
              ? String((err as { stderr?: string }).stderr || '')
              : '';
            console.error('[Sandbox][E2B] Command exception', {
              command,
              error: err instanceof Error ? err.message : String(err),
              exitCode,
              stdout: stdout.slice(0, 2000),
              stderr: stderr.slice(0, 2000),
            });
            throw err;
          }
        },
        runBackground: async (command, opts) => {
          try {
            await sandbox.commands.run(command, {
              cwd: opts?.cwd,
              envs: opts?.env,
              background: true,
            });
          } catch (err) {
            console.error('[Sandbox][E2B] Background command exception', {
              command,
              error: err instanceof Error ? err.message : String(err),
            });
            throw err;
          }
        },
        getHost: (port) => sandbox.getHost(port),
        type: 'e2b',
      };
    }

    const sandbox = await this.getCloudflareSandbox();
    return {
      exec: (command, opts) => sandbox.exec(command, opts),
      execStream: (command, opts) => sandbox.execStream(command, opts),
      type: 'cloudflare',
    };
  }

  /**
   * Send a message and stream the response
   */
  async sendMessage(prompt: string, apiUrl: string, apiToken: string): Promise<Message> {
    const state = await this.ensureState();

    // Create user message
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: prompt,
      status: 'completed',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };

    // Create assistant message (pending)
    const assistantMessage: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    // Add messages to state
    state.messages.push(userMessage, assistantMessage);
    state.updatedAt = new Date().toISOString();
    await this.ctx.storage.put('state', state);

    // Notify clients
    this.broadcast({ type: 'message_start', messageId: assistantMessage.id });
    this.broadcast({ type: 'status', status: 'running' });

    try {
      const handleOpenCodeEvent = (payload: { type?: string; properties?: Record<string, unknown> }) => {
        if (!payload?.type) return;
        if (!state.openCodeMessages) {
          state.openCodeMessages = {};
        }
        if (!state.openCodeMessageIdMap) {
          state.openCodeMessageIdMap = {};
        }

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
            state.openCodeMessageIdMap[id] = assistantMessage.id;
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
            state.openCodeMessageIdMap[messageId] = assistantMessage.id;
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
      const result = await this.runInSandboxWithStreaming(
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
      assistantMessage.filesChanged = result.fileChanges.map(f => f.path);

      if (result.manifestHash) {
        state.lastManifestHash = result.manifestHash;
      }

      // Create timeline item if files changed
      if (result.fileChanges.length > 0) {
        const timelineItem: TimelineItem = {
          id: crypto.randomUUID(),
          messageId: assistantMessage.id,
          timestamp: new Date().toISOString(),
          summary: null,
          summaryStatus: 'pending',
          files: result.fileChanges,
          manifestHash: result.manifestHash,
          previousManifestHash: result.previousManifestHash,
        };
        state.timeline.push(timelineItem);

        // Broadcast timeline item
        this.broadcast({ type: 'timeline_item', item: timelineItem });

        // Trigger async summary generation (fire and forget)
        this.generateTimelineSummary(timelineItem.id).catch(console.error);
      }

      await this.ctx.storage.put('state', state);

      if (result.fileChanges.length > 0) {
        this.broadcast({ type: 'files_changed', files: result.fileChanges.map(f => f.path) });
      }
      this.broadcast({ type: 'message_complete', message: assistantMessage });

    } catch (error) {
      assistantMessage.status = 'failed';
      assistantMessage.error = error instanceof Error ? error.message : String(error);
      assistantMessage.completedAt = new Date().toISOString();

      console.error('[Conversation] Assistant message failed', {
        conversationId: state.conversationId,
        messageId: assistantMessage.id,
        error: assistantMessage.error,
      });

      await this.ctx.storage.put('state', state);

      this.broadcast({ type: 'error', error: assistantMessage.error });
      this.broadcast({ type: 'message_complete', message: assistantMessage });
    }

    return assistantMessage;
  }

  /**
   * Run prompt in sandbox with streaming output via OpenCode HTTP API
   */
  private async runInSandboxWithStreaming(
    prompt: string,
    apiUrl: string,
    apiToken: string,
    assistantMessageId: string,
    onDelta: (delta: string) => void,
    onOpenCodeEvent: (payload: { type?: string; properties?: Record<string, unknown> }) => void
  ): Promise<{ output: string; fileChanges: FileChange[]; manifestHash: string; previousManifestHash?: string }> {
    const state = await this.ensureState();
    const sandbox = await this.getSandboxRunner();

    const workDir = this.getSandboxWorkDir(sandbox);

    try {
      // Check if we need to restore files
      if (state.lastManifestHash) {
        try {
          await this.restoreFiles(sandbox, apiUrl, apiToken, state.lastManifestHash, workDir);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes('Failed to download manifest')) {
            // Manifest missing (e.g. R2 reset) - reset workspace state and continue
            state.lastManifestHash = undefined;
            await this.ctx.storage.put('state', state);
            await sandbox.exec(`mkdir -p ${workDir}`);
          } else {
            throw err;
          }
        }
      } else if (state.messages.length === 2) {
        // First message - check for workspace base snapshot
        await this.initializeWorkspace(sandbox, apiUrl, apiToken, workDir);
      }

      let openCodeUrl = '';
      const openCodeDirectory = this.getOpenCodeDirectory(workDir);

      if (sandbox.type === 'e2b') {
        const port = await this.ensureOpenCodeServeE2B(sandbox, openCodeDirectory);
        const host = sandbox.getHost ? sandbox.getHost(port) : '';
        if (!host) {
          throw new Error('Failed to resolve OpenCode host for E2B sandbox');
        }
        openCodeUrl = host.startsWith('http') ? host : `https://${host}`;
        openCodeUrl = openCodeUrl.replace(/\/+$/, '');
      } else {
        // Use external OpenCode server if configured
        let configuredUrl = (this.env.OPENCODE_URL || '').trim();
        if (configuredUrl) {
          openCodeUrl = configuredUrl.replace(/\/+$/, '');
        } else {
          // Ensure OpenCode serve is running and get the port
          const port = await this.ensureOpenCodeServe(sandbox, workDir, apiUrl, apiToken);
          openCodeUrl = `http://localhost:${port}`;
        }
      }

      // Get or create OpenCode session
      const sessionId = await this.getOrCreateOpenCodeSession(openCodeUrl, openCodeDirectory);

      // Stream response via SSE
      const fullOutput = await this.streamFromOpenCode(
        sandbox,
        openCodeUrl,
        sessionId,
        prompt,
        assistantMessageId,
        onDelta,
        onOpenCodeEvent,
        openCodeDirectory,
        apiUrl,
        apiToken
      );

      // Collect files and create snapshot
      const { fileChanges, manifestHash, previousManifestHash } = await this.collectAndUploadFiles(
        sandbox, apiUrl, apiToken, workDir
      );

      return {
        output: fullOutput,
        fileChanges,
        manifestHash,
        previousManifestHash,
      };
    } catch (err) {
      console.error('[OpenCode] runInSandboxWithStreaming failed', {
        conversationId: state.conversationId,
        sandboxType: sandbox.type,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Get or create an OpenCode session for this conversation
   */
  private async getOrCreateOpenCodeSession(openCodeUrl: string, workDir?: string): Promise<string> {
    const state = await this.ensureState();

    // Reuse existing session if available
    if (state.openCodeSessionId) {
      try {
        // Verify session still exists
        const response = await fetch(`${openCodeUrl}/session/${state.openCodeSessionId}${this.getOpenCodeDirQuery(workDir)}`);
        if (response.ok) {
          return state.openCodeSessionId;
        }
      } catch {
        // Session doesn't exist, create a new one
      }
    }

    // Create new session
    const response = await fetch(`${openCodeUrl}/session${this.getOpenCodeDirQuery(workDir)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `conversation-${state.conversationId}` }),
    });

    if (!response.ok) {
      throw new Error('Failed to create OpenCode session');
    }

    const session = await response.json() as { id: string };
    state.openCodeSessionId = session.id;
    await this.ctx.storage.put('state', state);

    await this.replayOpenCodeContext(openCodeUrl, session.id, state, workDir);

    return session.id;
  }

  private async getOpenCodeUrl(apiUrl: string, apiToken: string, workDir?: string): Promise<string> {
    const sandbox = await this.getSandboxRunner();
    const effectiveWorkDir = workDir || this.getSandboxWorkDir(sandbox);
    const openCodeDirectory = this.getOpenCodeDirectory(effectiveWorkDir);

    if (sandbox.type === 'e2b') {
      const port = await this.ensureOpenCodeServeE2B(sandbox, openCodeDirectory);
      const host = sandbox.getHost ? sandbox.getHost(port) : '';
      if (!host) {
        throw new Error('Failed to resolve OpenCode host for E2B sandbox');
      }
      const url = host.startsWith('http') ? host : `https://${host}`;
      return url.replace(/\/+$/, '');
    }

    let openCodeUrl = (this.env.OPENCODE_URL || '').trim();
    if (openCodeUrl) {
      return openCodeUrl.replace(/\/+$/, '');
    }

    const port = await this.ensureOpenCodeServe(sandbox, effectiveWorkDir, apiUrl, apiToken);
    return `http://localhost:${port}`;
  }

  private getOpenCodeDirectory(workDir: string): string {
    const base = (this.env.OPENCODE_WORKDIR || '').trim();
    if (base) {
      return `${base.replace(/\/+$/, '')}/conversation-${this.ctx.id.toString()}`;
    }
    return workDir;
  }

  private getSandboxWorkDir(sandbox: SandboxRunner): string {
    return sandbox.type === 'e2b' ? '/home/user/workspace' : '/workspace';
  }


  private async replyOpenCodeQuestion(
    requestId: string,
    answers: string[][],
    apiUrl: string,
    apiToken: string
  ): Promise<void> {
    const sandbox = await this.getSandboxRunner();
    const workDir = this.getSandboxWorkDir(sandbox);
    const openCodeUrl = await this.getOpenCodeUrl(apiUrl, apiToken, workDir);
    const openCodeDirectory = this.getOpenCodeDirectory(workDir);
    const response = await fetch(`${openCodeUrl}/question/${requestId}/reply${this.getOpenCodeDirQuery(openCodeDirectory)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to reply to OpenCode question: ${response.status} ${text}`);
    }
  }

  private async rejectOpenCodeQuestion(
    requestId: string,
    apiUrl: string,
    apiToken: string
  ): Promise<void> {
    const sandbox = await this.getSandboxRunner();
    const workDir = this.getSandboxWorkDir(sandbox);
    const openCodeUrl = await this.getOpenCodeUrl(apiUrl, apiToken, workDir);
    const openCodeDirectory = this.getOpenCodeDirectory(workDir);
    const response = await fetch(`${openCodeUrl}/question/${requestId}/reject${this.getOpenCodeDirQuery(openCodeDirectory)}`, { method: 'POST' });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to reject OpenCode question: ${response.status} ${text}`);
    }
  }

  private async replayOpenCodeContext(
    openCodeUrl: string,
    sessionId: string,
    state: ConversationState,
    workDir?: string
  ): Promise<void> {
    if (!state.openCodeMessages || Object.keys(state.openCodeMessages).length === 0) {
      return;
    }

    const transcript = this.buildOpenCodeTranscript(state.openCodeMessages);
    if (!transcript) return;

    const provider = this.env.PROVIDER || 'anthropic';
    const model = this.getDefaultModel(provider);

    await fetch(`${openCodeUrl}/session/${sessionId}/message${this.getOpenCodeDirQuery(workDir)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parts: [{ type: 'text', text: transcript }],
        model: { providerID: provider, modelID: model },
        noReply: true,
        system: 'Conversation history (restored).',
      }),
    });
  }

  private getOpenCodeDirQuery(workDir?: string): string {
    if (!workDir) return '';
    return `?directory=${encodeURIComponent(workDir)}`;
  }

  private buildOpenCodeTranscript(
    messages: Record<string, { info?: Record<string, unknown>; parts: Record<string, Record<string, unknown>>; partsOrder: string[] }>
  ): string {
    const entries = Object.entries(messages)
      .map(([id, record]) => {
        const info = record.info || {};
        const time = (info as { time?: { created?: number } }).time?.created ?? 0;
        return { id, record, time };
      })
      .sort((a, b) => a.time - b.time);

    const lines: string[] = [];

    for (const entry of entries) {
      const info = entry.record.info || {};
      const role = (info as { role?: string }).role || 'user';
      const parts = entry.record.partsOrder.length > 0
        ? entry.record.partsOrder.map(id => entry.record.parts[id]).filter(Boolean)
        : Object.values(entry.record.parts);

      const partTexts = parts.map((part) => {
        const type = part.type as string | undefined;
        switch (type) {
          case 'text':
          case 'reasoning':
            return typeof part.text === 'string' ? part.text : '';
          case 'file':
            return `[file] ${(part.filename as string | undefined) || (part.url as string | undefined) || 'unknown'}`;
          case 'tool':
            return `[tool] ${(part.tool as string | undefined) || 'unknown'}`;
          case 'patch': {
            const files = Array.isArray(part.files) ? part.files.join(', ') : 'unknown';
            return `[patch] ${files}`;
          }
          case 'snapshot':
            return `[snapshot] ${(part.snapshot as string | undefined) || 'unknown'}`;
          default:
            return `[part] ${type || 'unknown'}`;
        }
      }).filter(Boolean);

      const content = partTexts.join('\n');
      if (content) {
        lines.push(`${role.toUpperCase()}: ${content}`);
      }
    }

    if (lines.length === 0) return '';
    return `Conversation history:\n${lines.join('\n\n')}`;
  }

  /**
   * Stream response from OpenCode using fetch with SSE
   */
  private async streamFromOpenCode(
    _sandbox: SandboxRunner,
    openCodeUrl: string,
    sessionId: string,
    prompt: string,
    assistantMessageId: string,
    onDelta: (delta: string) => void,
    onOpenCodeEvent: (payload: { type?: string; properties?: Record<string, unknown> }) => void,
    openCodeDirectory: string,
    apiUrl: string,
    apiToken: string
  ): Promise<string> {
    const provider = this.env.PROVIDER || 'anthropic';
    const model = this.getDefaultModel(provider);

    console.log(`[OpenCode] Starting stream for session ${sessionId}`);
    console.log(`[OpenCode] Provider: ${provider}, Model: ${model}`);
    console.log(`[OpenCode] URL: ${openCodeUrl}`);

    // Fetch user's API keys and set them in OpenCode
    const credentialsSet = await this.setOpenCodeCredentials(openCodeUrl, apiUrl, apiToken, provider);
    if (!credentialsSet) {
      const providerNames: Record<string, string> = {
        anthropic: 'Anthropic',
        openai: 'OpenAI',
        google: 'Google AI',
      };
      const providerName = providerNames[provider] || provider;
      throw new Error(
        `No API key configured for ${providerName}. Please add your ${providerName} API key in Settings → API Keys.`
      );
    }
    console.log(`[OpenCode] Credentials set`);

    let fullOutput = '';
    let messageComplete = false;
    const lastTextByPartId = new Map<string, string>();
    const assistantMessageIds = new Set<string>();

    // Subscribe to SSE events (use /global/event for wrapped payload format)
    console.log(`[OpenCode] Subscribing to event stream...`);
    let eventResponse: Response;
    try {
      eventResponse = await fetch(`${openCodeUrl}/global/event${this.getOpenCodeDirQuery(openCodeDirectory)}`, {
        headers: { Accept: 'text/event-stream' },
      });
    } catch (err) {
      console.error('[OpenCode] Event stream fetch failed', {
        url: `${openCodeUrl}/global/event${this.getOpenCodeDirQuery(openCodeDirectory)}`,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    console.log(`[OpenCode] Event stream response: ${eventResponse.status}`);
    if (!eventResponse.ok || !eventResponse.body) {
      throw new Error('Failed to connect to OpenCode event stream');
    }

    // Send prompt asynchronously (returns 204 immediately)
    console.log(`[OpenCode] Sending prompt async...`);
    let promptResponse: Response;
    try {
      promptResponse = await fetch(`${openCodeUrl}/session/${sessionId}/prompt_async${this.getOpenCodeDirQuery(openCodeDirectory)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parts: [{ type: 'text', text: prompt }],
          model: { providerID: provider, modelID: model },
        }),
      });
    } catch (err) {
      console.error('[OpenCode] Prompt fetch failed', {
        url: `${openCodeUrl}/session/${sessionId}/prompt_async${this.getOpenCodeDirQuery(openCodeDirectory)}`,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    console.log(`[OpenCode] Prompt response: ${promptResponse.status}`);
    if (!promptResponse.ok && promptResponse.status !== 204) {
      const errorText = await promptResponse.text();
      console.log(`[OpenCode] Prompt error: ${errorText}`);
      throw new Error(`Failed to send prompt: ${promptResponse.status}`);
    }

    // Process SSE stream
    console.log(`[OpenCode] Starting to read event stream...`);
    const reader = eventResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventCount = 0;

    try {
      while (!messageComplete) {
        const { done, value } = await reader.read();
        if (done) {
          console.log(`[OpenCode] Stream ended`);
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;

        // Process complete SSE events (separated by double newlines)
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const eventText of events) {
          const lines = eventText.split('\n');
          for (const line of lines) {
            if (line.startsWith('data:')) {
              try {
                const data = JSON.parse(line.slice(5).trim());
                eventCount++;

                // Events are wrapped in GlobalEvent with payload
                const payload = data.payload || data;

                if (eventCount <= 5 || payload.type?.includes('message')) {
                  console.log(`[OpenCode] Event #${eventCount}: ${payload.type}`);
                }

                if (payload?.type?.startsWith('message.') || payload?.type?.startsWith('question.')) {
                  this.broadcast({ type: 'opencode_event', messageId: assistantMessageId, event: data });
                  onOpenCodeEvent(payload);
                }

                switch (payload.type) {
                  case 'message.part.updated':
                    // Debug: log the full properties to understand the structure
                    console.log(`[OpenCode] message.part.updated properties:`, JSON.stringify(payload.properties));

                    // Try to extract delta - it might be in different places
                    let delta = payload.properties?.delta;

                    // If no delta, try to compute it from accumulated text
                    const part = payload.properties?.part;
                    if (!delta && part?.type === 'text') {
                      const nextText = typeof part.text === 'string'
                        ? part.text
                        : (typeof part.content === 'string' ? part.content : undefined);
                      if (nextText !== undefined) {
                        const partId = typeof part.id === 'string' ? part.id : 'default';
                        const prevText = lastTextByPartId.get(partId) || '';
                        if (nextText.startsWith(prevText)) {
                          delta = nextText.slice(prevText.length);
                        } else {
                          delta = nextText;
                        }
                        lastTextByPartId.set(partId, nextText);
                      }
                    }

                    const partMessageId = part?.messageID as string | undefined;
                    const isAssistantPart = partMessageId ? assistantMessageIds.has(partMessageId) : false;

                    if (part?.type === 'tool') {
                      const state = part?.state as { status?: string; output?: string; raw?: string } | undefined;
                      if (state?.status === 'completed' || state?.status === 'error') {
                        const output = (state?.output || state?.raw || '').toString();
                        if (output.includes('exit status') || state?.status === 'error') {
                          console.error('[OpenCode] Tool part error', {
                            tool: part?.tool,
                            status: state?.status,
                            output: output.slice(0, 2000),
                          });
                        }
                      }
                    }

                    if (delta && isAssistantPart) {
                      console.log(`[OpenCode] Broadcasting delta: ${delta.substring(0, 50)}...`);
                      fullOutput += delta;
                      onDelta(delta);
                    }
                    break;

                  case 'message.updated':
                    // Check for completion signals: finish status or time.completed present
                    const info = payload.properties?.info;
                    if (info?.role === 'assistant' && info?.id) {
                      assistantMessageIds.add(info.id);
                    }
                    const isComplete = info?.finish === 'stop' ||
                                       info?.finish === 'end_turn' ||
                                       (info?.time?.completed !== undefined);
                    console.log(`[OpenCode] Message updated, finish: ${info?.finish}, completed: ${info?.time?.completed}, isComplete: ${isComplete}`);
                    if (isComplete) {
                      messageComplete = true;
                    }
                    break;

                  case 'session.status':
                    if (payload.properties?.status?.type === 'idle') {
                      console.log(`[OpenCode] Session status idle - marking complete`);
                      messageComplete = true;
                    }
                    break;

                  case 'session.idle':
                    console.log(`[OpenCode] Session idle - marking complete`);
                    messageComplete = true;
                    break;

                  case 'session.error':
                    console.log(`[OpenCode] Session error: ${JSON.stringify(payload.properties)}`);
                    throw new Error(payload.properties?.error || 'OpenCode session error');
                }
              } catch (e) {
                // Skip malformed JSON unless it's our own error
                if (e instanceof Error && e.message.includes('session error')) {
                  throw e;
                }
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('[OpenCode] Stream error', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      console.log(`[OpenCode] Finished. Total events: ${eventCount}, Output length: ${fullOutput.length}`);
      reader.cancel();
    }

    return fullOutput;
  }

  /**
   * Set OpenCode credentials from user's stored API keys
   * Returns true if credentials were successfully set, false otherwise
   */
  private async setOpenCodeCredentials(
    openCodeUrl: string,
    apiUrl: string,
    apiToken: string,
    provider: string
  ): Promise<boolean> {
    // Map provider names to env var keys
    const providerKeyMap: Record<string, string> = {
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      google: 'GOOGLE_GENERATIVE_AI_API_KEY',
    };

    const envVarKey = providerKeyMap[provider];
    if (!envVarKey) {
      console.error(`[OpenCode] Unknown provider: ${provider}`);
      return false;
    }

    // Fetch user's API keys from database
    try {
      const response = await fetch(`${apiUrl}/v1/auth/api-keys/values`, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });

      if (!response.ok) {
        // Fall back to environment variable
        const envKey = this.env[envVarKey as keyof Env] as string | undefined;
        if (envKey) {
          await this.setOpenCodeProviderKey(openCodeUrl, provider, envKey);
          return true;
        }
        return false;
      }

      const data = await response.json() as { env_vars: Record<string, string> };
      const apiKey = data.env_vars?.[envVarKey];

      if (apiKey) {
        await this.setOpenCodeProviderKey(openCodeUrl, provider, apiKey);
        return true;
      } else {
        // Fall back to environment variable
        const envKey = this.env[envVarKey as keyof Env] as string | undefined;
        if (envKey) {
          await this.setOpenCodeProviderKey(openCodeUrl, provider, envKey);
          return true;
        }
        return false;
      }
    } catch (err) {
      console.error('Failed to fetch API keys:', err);
      // Fall back to environment variable
      const envKey = this.env[envVarKey as keyof Env] as string | undefined;
      if (envKey) {
        await this.setOpenCodeProviderKey(openCodeUrl, provider, envKey);
        return true;
      }
      return false;
    }
  }

  /**
   * Set a single provider's API key in OpenCode
   */
  private async setOpenCodeProviderKey(
    openCodeUrl: string,
    provider: string,
    apiKey: string
  ): Promise<void> {
    await fetch(`${openCodeUrl}/auth/${provider}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'api', key: apiKey }),
    });
  }

  /**
   * Ensure OpenCode serve is running, start if needed
   */
  private async ensureOpenCodeServe(
    sandbox: SandboxRunner,
    workDir: string,
    apiUrl: string,
    apiToken: string
  ): Promise<number> {
    const state = await this.ensureState();
    const port = state.openCodePort || 19000 + Math.floor(Math.random() * 1000);

    // Check if serve is already running
    try {
      const check = await sandbox.exec(`curl -s http://localhost:${port}/doc`);
      if (check.success) {
        return port;
      }
    } catch {
      // Not running, need to start
    }

    // Sanity check: ensure the OpenCode CLI has a serve subcommand
    const serveCheck = await sandbox.exec(`opencode serve --help >/dev/null 2>&1`);
    if (!serveCheck.success) {
      const help = await sandbox.exec(`opencode --help 2>/dev/null | head -40`);
      throw new Error(
        `OpenCode CLI missing 'serve' subcommand. opencode --help output:\n${help.stdout || help.stderr || ''}`
      );
    }

    // Fetch user's API keys from the API
    const envVars: Record<string, string> = {};
    try {
      const apiKeysResponse = await fetch(`${apiUrl}/v1/auth/api-keys/values`, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      if (apiKeysResponse.ok) {
        const data = await apiKeysResponse.json() as { env_vars: Record<string, string> };
        Object.assign(envVars, data.env_vars);
      }
    } catch (err) {
      console.error('Failed to fetch user API keys:', err);
    }

    // Fallback to environment bindings if no user keys found
    if (Object.keys(envVars).length === 0) {
      const provider = this.env.PROVIDER || 'anthropic';
      if (provider === 'anthropic' && this.env.ANTHROPIC_API_KEY) {
        envVars.ANTHROPIC_API_KEY = this.env.ANTHROPIC_API_KEY;
      } else if (provider === 'openai' && this.env.OPENAI_API_KEY) {
        envVars.OPENAI_API_KEY = this.env.OPENAI_API_KEY;
      } else if (provider === 'google' && this.env.GOOGLE_GENERATIVE_AI_API_KEY) {
        envVars.GOOGLE_GENERATIVE_AI_API_KEY = this.env.GOOGLE_GENERATIVE_AI_API_KEY;
      }
    }

    // Verify OpenCode binary exists and is executable
    const binaryCheck = await sandbox.exec(`which opencode && opencode --version 2>&1`);
    if (!binaryCheck.success) {
      const whichOut = await sandbox.exec(`which opencode 2>&1`);
      throw new Error(
        `OpenCode binary not found or not executable. which opencode output:\n${whichOut.stdout || whichOut.stderr || 'No output'}`
      );
    }

    // Start in background
    await sandbox.exec(
      `nohup opencode serve --port ${port} --hostname 127.0.0.1 > /tmp/opencode.log 2>&1 &`,
      { cwd: workDir, env: envVars }
    );

    // Wait for it to be ready
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const check = await sandbox.exec(`curl -s http://127.0.0.1:${port}/doc 2>&1 | head -1`);
        if (check.success && check.stdout && check.stdout.includes('<!DOCTYPE')) {
          // Save port to state
          state.openCodePort = port;
          await this.ctx.storage.put('state', state);
          return port;
        }
      } catch {
        // Not ready yet
      }
    }

    // Debug: Check if process is running
    const psCheck = await sandbox.exec(`ps aux | grep -i opencode | grep -v grep || true`);
    const logResult = await sandbox.exec(`tail -200 /tmp/opencode.log 2>/dev/null || true`);
    const logText = (logResult.stdout || logResult.stderr || '').trim();
    const psText = (psCheck.stdout || psCheck.stderr || '').trim();
    throw new Error(
      `OpenCode serve failed to start on port ${port}${logText ? `\n\nLogs:\n${logText}` : ''}${psText ? `\n\nProcesses:\n${psText}` : ''}`
    );
  }

  private async ensureOpenCodeServeE2B(
    sandbox: SandboxRunner,
    workDir: string
  ): Promise<number> {
    const port = 4096;

    try {
      const check = await sandbox.exec(`curl -s http://127.0.0.1:${port}/doc`);
      if (check.success && check.stdout.includes('"openapi"')) {
        return port;
      }
    } catch (err) {
      console.error('[OpenCode] Preflight check failed in E2B', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const which = await sandbox.exec('which opencode');
    if (!which.success) {
      const templateId = (this.env.E2B_TEMPLATE_ID || '').trim();
      if (templateId) {
        throw new Error('OpenCode not found in E2B template. Rebuild template with opencode installed.');
      }
      const install = await sandbox.exec('npm install -g opencode-ai');
      if (!install.success) {
        throw new Error(`OpenCode install failed in E2B sandbox: ${install.stderr || install.stdout}`);
      }
    }

    if (!sandbox.runBackground) {
      throw new Error('E2B sandbox runner does not support background commands');
    }

    await sandbox.exec(`mkdir -p "${workDir}"`);
    await sandbox.runBackground(
      `nohup opencode serve --port ${port} --hostname 0.0.0.0 > /tmp/opencode.log 2>&1 &`,
      { cwd: workDir }
    );

    // Wait for server to become ready
    for (let i = 0; i < 30; i++) {
      try {
        const ready = await sandbox.exec(`curl -s http://127.0.0.1:${port}/doc`);
        if (ready.success && ready.stdout.includes('"openapi"')) {
          return port;
        }
      } catch (err) {
        console.error('[OpenCode] Readiness check failed in E2B', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    try {
      const psCheck = await sandbox.exec(`ps aux | grep -i opencode | grep -v grep || true`);
      const logResult = await sandbox.exec(`tail -200 /tmp/opencode.log 2>/dev/null || true`);
      const logText = (logResult.stdout || logResult.stderr || '').trim();
      const psText = (psCheck.stdout || psCheck.stderr || '').trim();
      throw new Error(
        `OpenCode failed to start in E2B sandbox${logText ? `\n\nLogs:\n${logText}` : ''}${psText ? `\n\nProcesses:\n${psText}` : ''}`
      );
    } catch (err) {
      throw new Error('OpenCode failed to start in E2B sandbox');
    }
  }

  /**
   * Restore files from a manifest hash
   */
  private async restoreFiles(
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
    // Download manifest
    const manifestResponse = await fetch(`${apiUrl}/v1/blobs/manifests/${manifestHash}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });

    if (!manifestResponse.ok) {
      throw new Error('Failed to download manifest');
    }

    const manifest = await manifestResponse.json() as { files: Array<{ path: string; hash: string }> };

    // Ensure work directory exists
    await sandbox.exec(`mkdir -p ${workDir}`);

    // Download and restore each file
    for (const file of manifest.files) {
      const filePath = `${workDir}/${file.path}`;
      const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));

      await sandbox.exec(`mkdir -p ${dirPath}`);

      // Get presigned URL
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

      // Download to sandbox
      await sandbox.exec(`curl -s -H "Authorization: Bearer ${apiToken}" -o "${filePath}" "${url}"`);
    }
  }

  /**
   * Initialize workspace from base snapshot if available
   */
  private async initializeWorkspace(
    sandbox: SandboxRunner,
    apiUrl: string,
    apiToken: string,
    workDir: string
  ): Promise<void> {
    const state = await this.ensureState();

    // Get workspace details
    const wsResponse = await fetch(`${apiUrl}/v1/workspaces/${state.workspaceId}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });

    if (!wsResponse.ok) return;

    const { workspace } = await wsResponse.json() as { workspace: { base_snapshot_id?: string } };

    if (workspace.base_snapshot_id) {
      // Get snapshot
      const snapResponse = await fetch(`${apiUrl}/v1/snapshots/${workspace.base_snapshot_id}`, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });

      if (!snapResponse.ok) return;

      const { snapshot } = await snapResponse.json() as { snapshot: { manifest_hash: string } };

      // Restore files
      await this.restoreFiles(sandbox, apiUrl, apiToken, snapshot.manifest_hash, workDir);
      state.lastManifestHash = snapshot.manifest_hash;
      await this.ctx.storage.put('state', state);
    } else {
      // Just create empty workspace
      await sandbox.exec(`mkdir -p ${workDir}`);
    }
  }

  /**
   * Collect files and upload to blob storage
   * Returns file changes with proper diff against previous manifest
   */
  private async collectAndUploadFiles(
    sandbox: SandboxRunner,
    apiUrl: string,
    apiToken: string,
    workDir: string
  ): Promise<{ fileChanges: FileChange[]; manifestHash: string; previousManifestHash?: string }> {
    if (sandbox.type === 'e2b') {
      return this.collectAndUploadFilesE2B(apiUrl, apiToken, workDir);
    }

    const sandboxApiUrl = this.getSandboxApiUrl(apiUrl);
    const state = await this.ensureState();
    const previousManifestHash = state.lastManifestHash;

    // Get previous manifest for diffing
    let previousFiles: Map<string, string> = new Map(); // path -> hash
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

    // List all files
    const listResult = await sandbox.exec(`find ${workDir} -type f | head -1000`);
    if (!listResult.success) {
      return { fileChanges: [], manifestHash: '', previousManifestHash };
    }

    const filePaths = listResult.stdout.trim().split('\n').filter(Boolean);
    const files: Array<{ path: string; hash: string; size: number }> = [];
    const currentFiles: Map<string, string> = new Map(); // path -> hash

    for (const fullPath of filePaths) {
      const path = fullPath.replace(`${workDir}/`, '');

      // Get file hash
      const hashResult = await sandbox.exec(`sha256sum "${fullPath}" | cut -d' ' -f1`);
      if (!hashResult.success) continue;

      const hash = hashResult.stdout.trim();

      // Get file size
      const sizeResult = await sandbox.exec(`stat -c%s "${fullPath}"`);
      const size = parseInt(sizeResult.stdout.trim()) || 0;

      files.push({ path, hash, size });
      currentFiles.set(path, hash);
    }

    // Compute file changes
    const fileChanges: FileChange[] = [];

    // Check for added and modified files
    for (const [path, hash] of currentFiles) {
      const prevHash = previousFiles.get(path);
      if (!prevHash) {
        fileChanges.push({ path, change: 'added' });
      } else if (prevHash !== hash) {
        fileChanges.push({ path, change: 'modified' });
      }
    }

    // Check for deleted files
    for (const [path] of previousFiles) {
      if (!currentFiles.has(path)) {
        fileChanges.push({ path, change: 'deleted' });
      }
    }

    // Build manifest
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

    // Check which blobs need uploading
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

    // Upload missing blobs
    for (const file of files) {
      if (missing.includes(file.hash)) {
        const fullPath = `${workDir}/${file.path}`;

        // Get presigned URL
        const presignResponse = await fetch(`${apiUrl}/v1/blobs/presign-upload`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ hashes: [file.hash] }),
        });

        const { urls } = await presignResponse.json() as { urls: Record<string, string> };
        const url = urls[file.hash]?.startsWith('http') ? urls[file.hash] : `${sandboxApiUrl}${urls[file.hash]}`;

        // Upload from sandbox
        await sandbox.exec(`curl -s -X PUT -H "Authorization: Bearer ${apiToken}" --data-binary @"${fullPath}" "${url}"`);
      }
    }

    // Upload manifest
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
    const sandbox = await this.getE2BSandbox();
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
    const sandbox = await this.getE2BSandbox();
    const state = await this.ensureState();
    const previousManifestHash = state.lastManifestHash;

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

    const entries = await this.listE2BFiles(sandbox, workDir);
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

  private async listE2BFiles(sandbox: E2BSandbox, root: string): Promise<Array<{ path: string; size: number }>> {
    const files: Array<{ path: string; size: number }> = [];
    const queue: string[] = [root];

    while (queue.length > 0) {
      const dir = queue.shift();
      if (!dir) break;
      const entries = await sandbox.files.list(dir, { depth: 1 });
      for (const entry of entries) {
        if (!entry.path || entry.path === dir) continue;
        if (entry.type === 'dir') {
          queue.push(entry.path);
        } else if (entry.type === 'file') {
          files.push({ path: entry.path, size: entry.size });
        }
      }
    }

    return files;
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
      if (this.getSandboxProvider() === 'e2b' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
        console.warn('[Sandbox] E2B provider cannot reach localhost API URL. Use a public URL or tunnel.');
        return url.toString().replace(/\/$/, '');
      }
      if (this.getSandboxProvider() === 'cloudflare' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
        url.hostname = 'host.docker.internal';
        return url.toString().replace(/\/$/, '');
      }
    } catch {
      // Ignore and fall back to original
    }
    return apiUrl.replace(/\/$/, '');
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
   * Get default model for provider
   */
  private getDefaultModel(provider: string): string {
    switch (provider) {
      case 'google':
        return 'gemini-2.0-flash';
      case 'openai':
        return 'gpt-4o';
      case 'anthropic':
      default:
        return 'claude-sonnet-4-20250514';
    }
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

  /**
   * Detect project type by checking for wrangler config
   */
  private async detectProjectType(apiUrl: string, apiToken: string): Promise<ProjectInfo> {
    const state = await this.ensureState();
    const sandbox = await this.getSandboxRunner();
    const workDir = '/workspace';

    // Restore files if needed
    if (state.lastManifestHash) {
      await this.restoreFiles(sandbox, apiUrl, apiToken, state.lastManifestHash, workDir);
    }

    // Check for wrangler.toml or wrangler.jsonc
    const tomlCheck = await sandbox.exec(`test -f ${workDir}/wrangler.toml && echo "exists"`);
    const jsoncCheck = await sandbox.exec(`test -f ${workDir}/wrangler.jsonc && echo "exists"`);

    let projectInfo: ProjectInfo = { type: 'unknown' };

    if (tomlCheck.stdout.includes('exists')) {
      // Parse wrangler.toml for project name
      const catResult = await sandbox.exec(`cat ${workDir}/wrangler.toml`);
      const nameMatch = catResult.stdout.match(/name\s*=\s*["']([^"']+)["']/);
      projectInfo = {
        type: 'wrangler',
        name: nameMatch?.[1],
        configFile: 'wrangler.toml',
      };
    } else if (jsoncCheck.stdout.includes('exists')) {
      // Parse wrangler.jsonc for project name
      const catResult = await sandbox.exec(`cat ${workDir}/wrangler.jsonc`);
      try {
        // Remove comments for JSON parsing
        const jsonContent = catResult.stdout.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const config = JSON.parse(jsonContent);
        projectInfo = {
          type: 'wrangler',
          name: config.name,
          configFile: 'wrangler.jsonc',
        };
      } catch {
        projectInfo = {
          type: 'wrangler',
          configFile: 'wrangler.jsonc',
        };
      }
    }

    // Store and broadcast
    state.projectInfo = projectInfo;
    await this.ctx.storage.put('state', state);
    this.broadcast({ type: 'project_info', info: projectInfo });

    return projectInfo;
  }

  /**
   * Deploy the project to Cloudflare Workers
   */
  private async deploy(deploymentId: string, apiUrl: string, apiToken: string): Promise<void> {
    const state = await this.ensureState();
    const sandbox = await this.getSandboxRunner();
    const workDir = '/workspace';

    // Initialize deployment log
    const deploymentLog: DeploymentLog = {
      deploymentId,
      entries: [],
      startedAt: new Date().toISOString(),
    };

    // Helper to append and broadcast log entries
    const appendLog = async (step: DeploymentLogEntry['step'], stream: 'stdout' | 'stderr', content: string) => {
      const entry: DeploymentLogEntry = {
        timestamp: new Date().toISOString(),
        step,
        stream,
        content,
      };
      deploymentLog.entries.push(entry);
      this.broadcast({ type: 'deployment_log', deploymentId, entry });
    };

    // Create deployment record
    const deployment: Deployment = {
      id: deploymentId,
      url: '',
      status: 'deploying',
      createdAt: new Date().toISOString(),
    };
    state.deployments.push(deployment);
    await this.ctx.storage.put('state', state);
    this.broadcast({ type: 'deployment_started', deployment });

    try {
      // Restore files if needed
      if (state.lastManifestHash) {
        await this.restoreFiles(sandbox, apiUrl, apiToken, state.lastManifestHash, workDir);
      }

      // Detect project type if not already done
      if (!state.projectInfo) {
        await this.detectProjectType(apiUrl, apiToken);
      }

      if (state.projectInfo?.type !== 'wrangler') {
        throw new Error('Only Wrangler projects are supported for deployment');
      }

      // Fetch environment variables for this project
      const envVars = await this.fetchProjectEnvVars(apiUrl, apiToken, state.projectId);

      // Install dependencies if package.json exists
      const packageJsonCheck = await sandbox.exec(`test -f ${workDir}/package.json && echo "exists"`);
      if (packageJsonCheck.stdout.includes('exists')) {
        await appendLog('install', 'stdout', 'Installing dependencies...\n');
        await this.runCommandWithLogs(sandbox, `cd ${workDir} && npm install 2>&1`, 'install', appendLog, { timeout: 120000 });
      }

      // Run build if build script exists
      const packageJson = await sandbox.exec(`cat ${workDir}/package.json 2>/dev/null`);
      if (packageJson.success) {
        try {
          const pkg = JSON.parse(packageJson.stdout);
          if (pkg.scripts?.build) {
            await appendLog('build', 'stdout', 'Running build...\n');
            await this.runCommandWithLogs(sandbox, `cd ${workDir} && npm run build 2>&1`, 'build', appendLog, { timeout: 120000 });
          }
        } catch {
          // Ignore JSON parse errors
        }
      }

      // Generate unique project name for this user/project
      const projectName = `fastest-${state.projectId.slice(0, 8)}`;

      // Build --var flags for environment variables
      const varFlags = envVars
        .map(v => `--var ${v.key}:${this.shellEscape(v.value)}`)
        .join(' ');

      await appendLog('deploy', 'stdout', 'Deploying to Cloudflare Workers...\n');

      // Run wrangler deploy with streaming logs
      const deployOutput = await this.runCommandWithLogs(
        sandbox,
        `cd ${workDir} && npx wrangler deploy --name ${projectName} --compatibility-date 2024-01-01 ${varFlags} 2>&1`,
        'deploy',
        appendLog,
        {
          timeout: 120000,
          env: {
            CLOUDFLARE_API_TOKEN: this.env.CLOUDFLARE_DEPLOY_TOKEN || '',
            CLOUDFLARE_ACCOUNT_ID: this.env.CLOUDFLARE_ACCOUNT_ID || '',
          },
        }
      );

      // Parse the deployed URL from output
      const urlMatch = deployOutput.match(/https:\/\/[^\s)]+\.workers\.dev/);
      const deployedUrl = urlMatch?.[0] || `https://${projectName}.workers.dev`;

      // Update deployment record
      deployment.url = deployedUrl;
      deployment.status = 'success';
      deployment.completedAt = new Date().toISOString();

      // Save log
      deploymentLog.completedAt = new Date().toISOString();
      await this.ctx.storage.put(`deployment_log:${deploymentId}`, deploymentLog);
      await this.ctx.storage.put('state', state);

      await appendLog('deploy', 'stdout', `\nDeployed successfully to ${deployedUrl}\n`);
      this.broadcast({ type: 'deployment_complete', deployment });

    } catch (error) {
      // Update deployment with error
      deployment.status = 'failed';
      deployment.error = error instanceof Error ? error.message : String(error);
      deployment.completedAt = new Date().toISOString();

      // Save log even on failure
      deploymentLog.completedAt = new Date().toISOString();
      await this.ctx.storage.put(`deployment_log:${deploymentId}`, deploymentLog);
      await this.ctx.storage.put('state', state);

      await appendLog('deploy', 'stderr', `\nDeployment failed: ${deployment.error}\n`);
      this.broadcast({ type: 'deployment_complete', deployment });
    }
  }

  /**
   * Run a command with streaming logs
   */
  private async runCommandWithLogs(
    sandbox: SandboxRunner,
    command: string,
    step: DeploymentLogEntry['step'],
    appendLog: (step: DeploymentLogEntry['step'], stream: 'stdout' | 'stderr', content: string) => Promise<void>,
    options?: { env?: Record<string, string>; timeout?: number }
  ): Promise<string> {
    const summarize = (value?: string) => {
      if (!value) return '';
      const trimmed = value.trim();
      return trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}…` : trimmed;
    };
    if (sandbox.execStream) {
      const stream = await sandbox.execStream(command, options);
      let fullOutput = '';

      for await (const event of parseSSEStream(stream) as AsyncIterable<ExecEvent>) {
        switch (event.type) {
          case 'stdout':
            fullOutput += event.data;
            await appendLog(step, 'stdout', event.data);
            break;
          case 'stderr':
            await appendLog(step, 'stderr', event.data);
            break;
          case 'complete':
            if (event.exitCode !== 0) {
              console.error('[Sandbox] Command failed (stream)', {
                step,
                command,
                exitCode: event.exitCode,
                output: summarize(fullOutput),
              });
              throw new Error(`Command failed with exit code ${event.exitCode}`);
            }
            return fullOutput;
          case 'error':
            console.error('[Sandbox] Command stream error', { step, command, error: event.error });
            throw new Error(event.error);
        }
      }
      return fullOutput;
    }

    const result = await sandbox.exec(command, { env: options?.env });
    if (result.stdout) {
      await appendLog(step, 'stdout', result.stdout);
    }
    if (result.stderr) {
      await appendLog(step, 'stderr', result.stderr);
    }
    if (!result.success) {
      console.error('[Sandbox] Command failed', {
        step,
        command,
        exitCode: result.exitCode,
        stdout: summarize(result.stdout),
        stderr: summarize(result.stderr),
      });
      throw new Error(`Command failed${result.exitCode !== undefined ? ` with exit code ${result.exitCode}` : ''}`);
    }
    return result.stdout || '';
  }

  /**
   * Fetch project env vars from API
   */
  private async fetchProjectEnvVars(
    apiUrl: string,
    apiToken: string,
    projectId: string
  ): Promise<Array<{ key: string; value: string; is_secret: boolean }>> {
    try {
      const response = await fetch(`${apiUrl}/v1/projects/${projectId}/env-vars/values`, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });

      if (!response.ok) {
        console.warn('Failed to fetch env vars, proceeding without them');
        return [];
      }

      const data = await response.json() as { variables: Array<{ key: string; value: string; is_secret: boolean }> };
      return data.variables;
    } catch {
      console.warn('Error fetching env vars, proceeding without them');
      return [];
    }
  }

  /**
   * Escape value for shell
   */
  private shellEscape(value: string): string {
    // Use single quotes and escape any single quotes within
    return `'${value.replace(/'/g, "'\\''")}'`;
  }
}
