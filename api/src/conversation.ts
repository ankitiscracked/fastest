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
import { getSandbox, parseSSEStream, type Sandbox } from '@cloudflare/sandbox';
import type { Env } from './index';
import type { TimelineItem, FileChange, DeploymentLogEntry, DeploymentLog } from '@fastest/shared';

// Sandbox exec stream event types
type ExecEvent =
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'complete'; exitCode: number }
  | { type: 'error'; error: string };

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
  private sandbox: Sandbox | null = null;
  private sandboxReady: boolean = false;

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

    if (url.pathname === '/message' && request.method === 'POST') {
      const { prompt, apiUrl, apiToken } = await request.json() as {
        prompt: string;
        apiUrl: string;
        apiToken: string;
      };
      const message = await this.sendMessage(prompt, apiUrl, apiToken);
      return Response.json({ message });
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
  private async getSandbox(): Promise<Sandbox> {
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
      // Run in sandbox with streaming
      const result = await this.runInSandboxWithStreaming(
        prompt,
        apiUrl,
        apiToken,
        (delta) => {
          // Broadcast each delta as it arrives
          this.broadcast({ type: 'content_delta', content: delta });
        }
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
    onDelta: (delta: string) => void
  ): Promise<{ output: string; fileChanges: FileChange[]; manifestHash: string; previousManifestHash?: string }> {
    const state = await this.ensureState();
    const sandbox = await this.getSandbox();

    const workDir = '/workspace';

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

    // Use external OpenCode server if configured (useful when sandbox CLI is unavailable)
    let openCodeUrl = (this.env.OPENCODE_URL || '').trim();
    if (openCodeUrl) {
      openCodeUrl = openCodeUrl.replace(/\/+$/, '');
    } else {
      // Ensure OpenCode serve is running and get the port
      const port = await this.ensureOpenCodeServe(sandbox, workDir, apiUrl, apiToken);
      openCodeUrl = `http://localhost:${port}`;
    }

    // Get or create OpenCode session
    const sessionId = await this.getOrCreateOpenCodeSession(openCodeUrl);

    // Stream response via SSE
    const fullOutput = await this.streamFromOpenCode(
      sandbox,
      openCodeUrl,
      sessionId,
      prompt,
      onDelta,
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
  }

  /**
   * Get or create an OpenCode session for this conversation
   */
  private async getOrCreateOpenCodeSession(openCodeUrl: string): Promise<string> {
    const state = await this.ensureState();

    // Reuse existing session if available
    if (state.openCodeSessionId) {
      try {
        // Verify session still exists
        const response = await fetch(`${openCodeUrl}/session/${state.openCodeSessionId}`);
        if (response.ok) {
          return state.openCodeSessionId;
        }
      } catch {
        // Session doesn't exist, create a new one
      }
    }

    // Create new session
    const response = await fetch(`${openCodeUrl}/session`, {
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

    return session.id;
  }

  /**
   * Stream response from OpenCode using fetch with SSE
   */
  private async streamFromOpenCode(
    _sandbox: Sandbox,
    openCodeUrl: string,
    sessionId: string,
    prompt: string,
    onDelta: (delta: string) => void,
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

    // Subscribe to SSE events (use /global/event for wrapped payload format)
    console.log(`[OpenCode] Subscribing to event stream...`);
    const eventResponse = await fetch(`${openCodeUrl}/global/event`, {
      headers: { Accept: 'text/event-stream' },
    });

    console.log(`[OpenCode] Event stream response: ${eventResponse.status}`);
    if (!eventResponse.ok || !eventResponse.body) {
      throw new Error('Failed to connect to OpenCode event stream');
    }

    // Send prompt asynchronously (returns 204 immediately)
    console.log(`[OpenCode] Sending prompt async...`);
    const promptResponse = await fetch(`${openCodeUrl}/session/${sessionId}/prompt_async`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parts: [{ type: 'text', text: prompt }],
        model: { providerID: provider, modelID: model },
      }),
    });

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

                    if (delta) {
                      console.log(`[OpenCode] Broadcasting delta: ${delta.substring(0, 50)}...`);
                      fullOutput += delta;
                      onDelta(delta);
                    }
                    break;

                  case 'message.updated':
                    // Check for completion signals: finish status or time.completed present
                    const info = payload.properties?.info;
                    const isComplete = info?.finish === 'stop' ||
                                       info?.finish === 'end_turn' ||
                                       (info?.time?.completed !== undefined);
                    console.log(`[OpenCode] Message updated, finish: ${info?.finish}, completed: ${info?.time?.completed}, isComplete: ${isComplete}`);
                    if (isComplete) {
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
    sandbox: Sandbox,
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

  /**
   * Restore files from a manifest hash
   */
  private async restoreFiles(
    sandbox: Sandbox,
    apiUrl: string,
    apiToken: string,
    manifestHash: string,
    workDir: string
  ): Promise<void> {
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
    sandbox: Sandbox,
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
    sandbox: Sandbox,
    apiUrl: string,
    apiToken: string,
    workDir: string
  ): Promise<{ fileChanges: FileChange[]; manifestHash: string; previousManifestHash?: string }> {
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
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
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
    const sandbox = await this.getSandbox();
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
    const sandbox = await this.getSandbox();
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
    sandbox: Sandbox,
    command: string,
    step: DeploymentLogEntry['step'],
    appendLog: (step: DeploymentLogEntry['step'], stream: 'stdout' | 'stderr', content: string) => Promise<void>,
    options?: { env?: Record<string, string>; timeout?: number }
  ): Promise<string> {
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
            throw new Error(`Command failed with exit code ${event.exitCode}`);
          }
          return fullOutput;
        case 'error':
          throw new Error(event.error);
      }
    }
    return fullOutput;
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
