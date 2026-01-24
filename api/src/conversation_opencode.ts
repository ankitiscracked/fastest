import type { DurableObjectState } from 'cloudflare:workers';
import type { Env } from './index';
import { createDb, workspaces, snapshots } from './db';
import { desc, eq } from 'drizzle-orm';
import type { ConversationState, SandboxRunner } from './conversation_types';
import type { ConversationFiles } from './conversation_files';
import type { ConversationSandbox } from './conversation_sandbox';

type Broadcast = (event: { type: string; [key: string]: unknown }) => void;

export class ConversationOpenCode {
  private env: Env;
  private ctx: DurableObjectState;
  private ensureState: () => Promise<ConversationState>;
  private sandbox: ConversationSandbox;
  private files: ConversationFiles;
  private broadcast: Broadcast;

  constructor(deps: {
    env: Env;
    ctx: DurableObjectState;
    ensureState: () => Promise<ConversationState>;
    sandbox: ConversationSandbox;
    files: ConversationFiles;
    broadcast: Broadcast;
  }) {
    this.env = deps.env;
    this.ctx = deps.ctx;
    this.ensureState = deps.ensureState;
    this.sandbox = deps.sandbox;
    this.files = deps.files;
    this.broadcast = deps.broadcast;
  }

  async getOpenCodeMessagesByConversationMessageId(): Promise<Record<string, { info?: Record<string, unknown>; parts: Record<string, unknown>[] }>> {
    const state = await this.ensureState();
    const openCodeMessages = state.openCodeMessages || {};
    const idMap = state.openCodeMessageIdMap || {};
    const mapped: Record<string, { info?: Record<string, unknown>; parts: Record<string, unknown>[] }> = {};

    for (const [openCodeMessageId, record] of Object.entries(openCodeMessages)) {
      const conversationMessageId = idMap[openCodeMessageId];
      if (!conversationMessageId) continue;

      // Skip user message parts - only include assistant message parts
      const role = (record.info as { role?: string } | undefined)?.role;
      if (role === 'user') continue;

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
   * Run prompt in sandbox with streaming output via OpenCode HTTP API
   */
  async runInSandboxWithStreaming(
    prompt: string,
    apiUrl: string,
    apiToken: string,
    assistantMessageId: string,
    onDelta: (delta: string) => void,
    onOpenCodeEvent: (payload: { type?: string; properties?: Record<string, unknown> }) => void
  ): Promise<{ output: string; sandbox: SandboxRunner; workDir: string }> {
    const state = await this.ensureState();
    const sandbox = await this.sandbox.getSandboxRunner();

    const workDir = this.sandbox.getSandboxWorkDir(sandbox);

    try {
      const currentManifestHash = await this.getWorkspaceCurrentManifestHash(state.workspaceId);
      if (currentManifestHash && currentManifestHash !== state.lastManifestHash) {
        state.lastManifestHash = currentManifestHash;
        await this.ctx.storage.put('state', state);
      }

      if (state.lastManifestHash) {
        try {
          await this.files.restoreFiles(sandbox, apiUrl, apiToken, state.lastManifestHash, workDir);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes('Failed to download manifest')) {
            state.lastManifestHash = undefined;
            await this.ctx.storage.put('state', state);
            await sandbox.exec(`mkdir -p ${workDir}`);
          } else {
            throw err;
          }
        }
      } else if (state.messages.length === 2) {
        await this.files.initializeWorkspace(sandbox, apiUrl, apiToken, workDir);
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
        let configuredUrl = (this.env.OPENCODE_URL || '').trim();
        if (configuredUrl) {
          openCodeUrl = configuredUrl.replace(/\/+$/, '');
        } else {
          const port = await this.ensureOpenCodeServe(sandbox, workDir, apiUrl, apiToken);
          openCodeUrl = `http://localhost:${port}`;
        }
      }

      const sessionId = await this.getOrCreateOpenCodeSession(openCodeUrl, openCodeDirectory);

      const fullOutput = await this.streamFromOpenCode(
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

      return {
        output: fullOutput,
        sandbox,
        workDir,
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

  private async getWorkspaceCurrentManifestHash(workspaceId: string): Promise<string | undefined> {
    const db = createDb(this.env.DB);
    const workspaceResult = await db
      .select({
        current_manifest_hash: workspaces.currentManifestHash,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    const currentManifestHash = workspaceResult[0]?.current_manifest_hash || undefined;
    if (currentManifestHash) {
      return currentManifestHash;
    }

    const snapshotResult = await db
      .select({ manifest_hash: snapshots.manifestHash })
      .from(snapshots)
      .where(eq(snapshots.workspaceId, workspaceId))
      .orderBy(desc(snapshots.createdAt))
      .limit(1);
    return snapshotResult[0]?.manifest_hash;
  }

  /**
   * Get or create an OpenCode session for this conversation
   */
  private async getOrCreateOpenCodeSession(openCodeUrl: string, workDir?: string): Promise<string> {
    const state = await this.ensureState();
    let sessionNeedsContextReplay = false;

    if (state.openCodeSessionId) {
      try {
        const response = await fetch(`${openCodeUrl}/session/${state.openCodeSessionId}${this.getOpenCodeDirQuery(workDir)}`);
        if (response.ok) {
          const sessionData = await response.json() as {
            id: string;
            messages?: unknown[];
            status?: { type?: string };
          };

          // Check if session is stuck in a non-idle state
          const sessionStatus = sessionData.status?.type;
          if (sessionStatus && sessionStatus !== 'idle') {
            console.log(`[OpenCode] Session ${state.openCodeSessionId} is in state: ${sessionStatus}, will create new session`);
            // Clear the stored session ID so we create a new one
            state.openCodeSessionId = undefined;
            await this.ctx.storage.put('state', state);
          } else {
            // Session is usable - check if it needs context replay
            const hasMessages = Array.isArray(sessionData.messages) && sessionData.messages.length > 0;
            const conversationHasHistory = state.openCodeMessages && Object.keys(state.openCodeMessages).length > 0;

            if (conversationHasHistory && !hasMessages) {
              console.log(`[OpenCode] Session ${state.openCodeSessionId} exists but appears empty, will replay context`);
              sessionNeedsContextReplay = true;
            }

            // Replay context if needed before returning
            if (sessionNeedsContextReplay) {
              await this.replayOpenCodeContext(openCodeUrl, state.openCodeSessionId, state, workDir);
            }

            return state.openCodeSessionId;
          }
        }
      } catch (err) {
        console.log(`[OpenCode] Could not verify existing session: ${err instanceof Error ? err.message : String(err)}`);
        // Session doesn't exist or error, clear it and create a new one
        state.openCodeSessionId = undefined;
        await this.ctx.storage.put('state', state);
      }
    }

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
    const sandbox = await this.sandbox.getSandboxRunner();
    const effectiveWorkDir = workDir || this.sandbox.getSandboxWorkDir(sandbox);
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

  async replyOpenCodeQuestion(
    requestId: string,
    answers: string[][],
    apiUrl: string,
    apiToken: string
  ): Promise<void> {
    const sandbox = await this.sandbox.getSandboxRunner();
    const workDir = this.sandbox.getSandboxWorkDir(sandbox);
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

  async rejectOpenCodeQuestion(
    requestId: string,
    apiUrl: string,
    apiToken: string
  ): Promise<void> {
    const sandbox = await this.sandbox.getSandboxRunner();
    const workDir = this.sandbox.getSandboxWorkDir(sandbox);
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
    const pendingDeltasByMessageId = new Map<string, string[]>();

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

    console.log(`[OpenCode] Sending prompt async to session ${sessionId}...`);
    console.log(`[OpenCode] Prompt payload: provider=${provider}, model=${model}, prompt="${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}"`);
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

        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const eventText of events) {
          const lines = eventText.split('\n');
          for (const line of lines) {
            if (line.startsWith('data:')) {
              try {
                const data = JSON.parse(line.slice(5).trim());
                eventCount++;

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
                    console.log(`[OpenCode] message.part.updated properties:`, JSON.stringify(payload.properties));

                    let delta = payload.properties?.delta;

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
                    } else if (delta && partMessageId) {
                      const pending = pendingDeltasByMessageId.get(partMessageId) || [];
                      pending.push(delta);
                      pendingDeltasByMessageId.set(partMessageId, pending);
                    }
                    break;

                  case 'message.updated':
                    const info = payload.properties?.info;
                    if (info?.role === 'assistant' && info?.id) {
                      assistantMessageIds.add(info.id);
                      const pending = pendingDeltasByMessageId.get(info.id);
                      if (pending && pending.length > 0) {
                        for (const buffered of pending) {
                          console.log(`[OpenCode] Flushing buffered delta: ${buffered.substring(0, 50)}...`);
                          fullOutput += buffered;
                          onDelta(buffered);
                        }
                        pendingDeltasByMessageId.delete(info.id);
                      }
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
                      if (fullOutput.length === 0 && assistantMessageIds.size === 0) {
                        console.warn(`[OpenCode] Session went idle without generating assistant response! Events: ${eventCount}`);
                      }
                      console.log(`[OpenCode] Session status idle - marking complete (output: ${fullOutput.length} chars, assistant msgs: ${assistantMessageIds.size})`);
                      messageComplete = true;
                    }
                    break;

                  case 'session.idle':
                    if (fullOutput.length === 0 && assistantMessageIds.size === 0) {
                      console.warn(`[OpenCode] Session went idle without generating assistant response! Events: ${eventCount}`);
                    }
                    console.log(`[OpenCode] Session idle - marking complete (output: ${fullOutput.length} chars, assistant msgs: ${assistantMessageIds.size})`);
                    messageComplete = true;
                    break;

                  case 'session.error':
                    console.log(`[OpenCode] Session error: ${JSON.stringify(payload.properties)}`);
                    throw new Error(payload.properties?.error || 'OpenCode session error');
                }
              } catch (e) {
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

  private async setOpenCodeCredentials(
    openCodeUrl: string,
    apiUrl: string,
    apiToken: string,
    provider: string
  ): Promise<boolean> {
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

    try {
      const response = await fetch(`${apiUrl}/v1/auth/api-keys/values`, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });

      if (!response.ok) {
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
        const envKey = this.env[envVarKey as keyof Env] as string | undefined;
        if (envKey) {
          await this.setOpenCodeProviderKey(openCodeUrl, provider, envKey);
          return true;
        }
        return false;
      }
    } catch (err) {
      console.error('Failed to fetch API keys:', err);
      const envKey = this.env[envVarKey as keyof Env] as string | undefined;
      if (envKey) {
        await this.setOpenCodeProviderKey(openCodeUrl, provider, envKey);
        return true;
      }
      return false;
    }
  }

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

  private async ensureOpenCodeServe(
    sandbox: SandboxRunner,
    workDir: string,
    apiUrl: string,
    apiToken: string
  ): Promise<number> {
    const state = await this.ensureState();
    const port = state.openCodePort || 19000 + Math.floor(Math.random() * 1000);

    try {
      const check = await sandbox.exec(`curl -s http://localhost:${port}/doc`);
      if (check.success) {
        return port;
      }
    } catch {
      // Not running, need to start
    }

    const serveCheck = await sandbox.exec(`opencode serve --help >/dev/null 2>&1`);
    if (!serveCheck.success) {
      const help = await sandbox.exec(`opencode --help 2>/dev/null | head -40`);
      throw new Error(
        `OpenCode CLI missing 'serve' subcommand. opencode --help output:\n${help.stdout || help.stderr || ''}`
      );
    }

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

    const binaryCheck = await sandbox.exec(`which opencode && opencode --version 2>&1`);
    if (!binaryCheck.success) {
      const whichOut = await sandbox.exec(`which opencode 2>&1`);
      throw new Error(
        `OpenCode binary not found or not executable. which opencode output:\n${whichOut.stdout || whichOut.stderr || 'No output'}`
      );
    }

    await sandbox.exec(
      `nohup opencode serve --port ${port} --hostname 127.0.0.1 > /tmp/opencode.log 2>&1 &`,
      { cwd: workDir, env: envVars }
    );

    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const check = await sandbox.exec(`curl -s http://127.0.0.1:${port}/doc 2>&1 | head -1`);
        if (check.success && check.stdout && check.stdout.includes('<!DOCTYPE')) {
          state.openCodePort = port;
          await this.ctx.storage.put('state', state);
          return port;
        }
      } catch {
        // Not ready yet
      }
    }

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
