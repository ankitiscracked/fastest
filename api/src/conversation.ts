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

// State persisted in the DO
interface ConversationState {
  conversationId: string;
  workspaceId: string;
  projectId: string;
  messages: Message[];

  // OpenCode session state (for resume)
  openCodeSessionId?: string;
  openCodePort?: number;

  // File state
  lastManifestHash?: string;

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

      server.addEventListener('close', () => {
        this.clients.delete(server);
      });

      server.addEventListener('error', () => {
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

    return new Response('Not found', { status: 404 });
  }

  /**
   * Broadcast event to all connected WebSocket clients
   */
  private broadcast(event: StreamEvent) {
    const data = JSON.stringify(event);
    for (const client of this.clients) {
      try {
        client.send(data);
      } catch {
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
    const sandbox = getSandbox(this.env.Sandbox, `workspace-${state.workspaceId}`);
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
      assistantMessage.filesChanged = result.filesChanged;

      if (result.manifestHash) {
        state.lastManifestHash = result.manifestHash;
      }

      await this.ctx.storage.put('state', state);

      if (result.filesChanged?.length) {
        this.broadcast({ type: 'files_changed', files: result.filesChanged });
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
  ): Promise<{ output: string; filesChanged?: string[]; manifestHash?: string }> {
    const state = await this.ensureState();
    const sandbox = await this.getSandbox();

    const workDir = '/workspace';

    // Check if we need to restore files
    if (state.lastManifestHash) {
      await this.restoreFiles(sandbox, apiUrl, apiToken, state.lastManifestHash, workDir);
    } else if (state.messages.length === 2) {
      // First message - check for workspace base snapshot
      await this.initializeWorkspace(sandbox, apiUrl, apiToken, workDir);
    }

    // Ensure OpenCode serve is running and get the port
    const port = await this.ensureOpenCodeServe(sandbox, workDir);
    const openCodeUrl = `http://localhost:${port}`;

    // Get or create OpenCode session
    const sessionId = await this.getOrCreateOpenCodeSession(sandbox, openCodeUrl);

    // Stream response via SSE
    const fullOutput = await this.streamFromOpenCode(
      sandbox,
      openCodeUrl,
      sessionId,
      prompt,
      onDelta
    );

    // Collect files and create snapshot
    const { filesChanged, manifestHash } = await this.collectAndUploadFiles(
      sandbox, apiUrl, apiToken, workDir
    );

    return {
      output: fullOutput,
      filesChanged,
      manifestHash,
    };
  }

  /**
   * Get or create an OpenCode session for this conversation
   */
  private async getOrCreateOpenCodeSession(sandbox: Sandbox, openCodeUrl: string): Promise<string> {
    const state = await this.ensureState();

    // Reuse existing session if available
    if (state.openCodeSessionId) {
      // Verify session still exists
      const checkResult = await sandbox.exec(
        `curl -s -o /dev/null -w "%{http_code}" "${openCodeUrl}/session/${state.openCodeSessionId}"`
      );
      if (checkResult.stdout.trim() === '200') {
        return state.openCodeSessionId;
      }
    }

    // Create new session
    const createResult = await sandbox.exec(
      `curl -s -X POST "${openCodeUrl}/session" -H "Content-Type: application/json" -d '{"title":"conversation-${state.conversationId}"}'`
    );

    if (!createResult.success) {
      throw new Error('Failed to create OpenCode session');
    }

    const session = JSON.parse(createResult.stdout) as { id: string };
    state.openCodeSessionId = session.id;
    await this.ctx.storage.put('state', state);

    return session.id;
  }

  /**
   * Stream response from OpenCode serve via SSE using execStream
   */
  private async streamFromOpenCode(
    sandbox: Sandbox,
    openCodeUrl: string,
    sessionId: string,
    prompt: string,
    onDelta: (delta: string) => void
  ): Promise<string> {
    const provider = this.env.PROVIDER || 'anthropic';
    const model = this.getDefaultModel(provider);

    // Send prompt first (this returns the response synchronously via SSE)
    const escapedPrompt = JSON.stringify(prompt);

    // Use execStream to get real-time output from curl SSE listener
    const stream = await sandbox.execStream(
      `curl -s -N "${openCodeUrl}/session/${sessionId}/message" \
        -H "Content-Type: application/json" \
        -d '{"parts":[{"type":"text","text":${escapedPrompt}}],"model":"${provider}/${model}"}' \
        --no-buffer`
    );

    let fullOutput = '';
    let sseBuffer = '';

    // Process stream events in real-time
    for await (const event of parseSSEStream(stream) as AsyncIterable<ExecEvent>) {
      switch (event.type) {
        case 'stdout':
          // Accumulate SSE data and parse complete events
          sseBuffer += event.data;

          // Process complete SSE events (separated by double newlines)
          const events = sseBuffer.split('\n\n');
          sseBuffer = events.pop() || ''; // Keep incomplete event in buffer

          for (const sseEvent of events) {
            const lines = sseEvent.split('\n');
            for (const line of lines) {
              if (line.startsWith('data:')) {
                try {
                  const data = JSON.parse(line.slice(5).trim());

                  // Handle different OpenCode event types
                  if (data.type === 'part' && data.part?.type === 'text') {
                    const text = data.part.text || '';
                    if (text) {
                      fullOutput += text;
                      onDelta(text);
                    }
                  } else if (data.type === 'text.delta' || data.type === 'content.delta') {
                    // Alternative event format
                    const text = data.delta || data.text || '';
                    if (text) {
                      fullOutput += text;
                      onDelta(text);
                    }
                  } else if (data.type === 'error') {
                    throw new Error(data.error?.message || data.message || 'OpenCode error');
                  }
                  // message.complete will come through but we just continue processing
                } catch (e) {
                  // Skip malformed JSON, but rethrow OpenCode errors
                  if (e instanceof Error && e.message.includes('OpenCode error')) {
                    throw e;
                  }
                }
              }
            }
          }
          break;

        case 'stderr':
          // Log stderr but don't fail
          console.warn('OpenCode stderr:', event.data);
          break;

        case 'complete':
          if (event.exitCode !== 0) {
            throw new Error(`OpenCode exited with code ${event.exitCode}`);
          }
          break;

        case 'error':
          throw new Error(`Stream error: ${event.error}`);
      }
    }

    return fullOutput;
  }

  /**
   * Ensure OpenCode serve is running, start if needed
   */
  private async ensureOpenCodeServe(sandbox: Sandbox, workDir: string): Promise<number> {
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

    // Start opencode serve
    const provider = this.env.PROVIDER || 'anthropic';
    const envVars: Record<string, string> = {};
    if (provider === 'anthropic' && this.env.ANTHROPIC_API_KEY) {
      envVars.ANTHROPIC_API_KEY = this.env.ANTHROPIC_API_KEY;
    } else if (provider === 'openai' && this.env.OPENAI_API_KEY) {
      envVars.OPENAI_API_KEY = this.env.OPENAI_API_KEY;
    } else if (provider === 'google' && this.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      envVars.GOOGLE_GENERATIVE_AI_API_KEY = this.env.GOOGLE_GENERATIVE_AI_API_KEY;
    }

    // Start in background
    await sandbox.exec(
      `nohup opencode serve --port ${port} > /tmp/opencode.log 2>&1 &`,
      { cwd: workDir, env: envVars }
    );

    // Wait for it to be ready
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const check = await sandbox.exec(`curl -s http://localhost:${port}/doc`);
        if (check.success) {
          // Save port to state
          state.openCodePort = port;
          await this.ctx.storage.put('state', state);
          return port;
        }
      } catch {
        // Not ready yet
      }
    }

    throw new Error('OpenCode serve failed to start');
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
      const url = urls[file.hash]?.startsWith('http') ? urls[file.hash] : `${apiUrl}${urls[file.hash]}`;

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
   */
  private async collectAndUploadFiles(
    sandbox: Sandbox,
    apiUrl: string,
    apiToken: string,
    workDir: string
  ): Promise<{ filesChanged: string[]; manifestHash: string }> {
    // List all files
    const listResult = await sandbox.exec(`find ${workDir} -type f | head -1000`);
    if (!listResult.success) {
      return { filesChanged: [], manifestHash: '' };
    }

    const filePaths = listResult.stdout.trim().split('\n').filter(Boolean);
    const files: Array<{ path: string; hash: string; size: number }> = [];
    const filesChanged: string[] = [];

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
      filesChanged.push(path);
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

    // Calculate manifest hash (simplified - in real impl would use crypto)
    const manifestHashResult = await sandbox.exec(`echo '${manifestJson}' | sha256sum | cut -d' ' -f1`);
    const manifestHash = manifestHashResult.stdout.trim();

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
        const url = urls[file.hash]?.startsWith('http') ? urls[file.hash] : `${apiUrl}${urls[file.hash]}`;

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

    return { filesChanged, manifestHash };
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
}
