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
import type { ConversationState, Message, Deployment, ProjectInfo, SandboxRunner } from './conversation_types';
import { createDb, workspaces, activityEvents, actionItems, actionItemRuns, snapshots, projects } from './db';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { ConversationFiles } from './conversation_files';
import { ConversationDeployments } from './conversation_deploy';
import { ConversationOpenCode } from './conversation_opencode';
import { ConversationWebSocket } from './conversation_ws';
import { ConversationSandbox } from './conversation_sandbox';
import { selectCheckCommands, type CheckCommands } from './action-items/checks';

 

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
  | { type: 'warning'; warning: string }
  | { type: 'error'; error: string };

const AUTO_SNAPSHOT_MIN_CHANGES = 2;
const AUTO_SNAPSHOT_LARGE_CHANGES = 10;
const AUTO_SNAPSHOT_MIN_BYTES = 5 * 1024;
const AUTO_SNAPSHOT_LARGE_BYTES = 50 * 1024;
const AUTO_SNAPSHOT_COOLDOWN_MS = 10 * 60 * 1000;

export class ConversationSession extends DurableObject<Env> {
  private static readonly DECISION_EXTRACTION_EVERY = 5;
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
      let updated = false;
      if (!stored.decisionExtractionEvery) {
        stored.decisionExtractionEvery = ConversationSession.DECISION_EXTRACTION_EVERY;
        updated = true;
      }
      if (stored.decisionExtractionCount === undefined) {
        stored.decisionExtractionCount = 0;
        updated = true;
      }
      if (updated) {
        await this.ctx.storage.put('state', stored);
      }
      this.state = stored;
      return this.state;
    }

    // New conversation - will be initialized on first message
    throw new Error('Conversation not initialized. Call init() first.');
  }

  /**
   * Initialize a new conversation
   */
  async init(
    conversationId: string,
    workspaceId: string,
    projectId: string,
    initialManifestHash?: string
  ): Promise<ConversationState> {
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
      decisionExtractionEvery: ConversationSession.DECISION_EXTRACTION_EVERY,
      decisionExtractionCount: 0,
      createdAt: now,
      updatedAt: now,
      lastManifestHash: initialManifestHash,
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
      const { conversationId, workspaceId, projectId, initialManifestHash } = await request.json() as {
        conversationId: string;
        workspaceId: string;
        projectId: string;
        initialManifestHash?: string;
      };
      const state = await this.init(conversationId, workspaceId, projectId, initialManifestHash);
      return Response.json({ state });
    }

    if (url.pathname === '/state' && request.method === 'GET') {
      const state = await this.getState();
      return Response.json({ state });
    }

    if (url.pathname === '/set-manifest' && request.method === 'POST') {
      const { manifestHash } = await request.json() as { manifestHash: string };
      const state = await this.ensureState();
      state.lastManifestHash = manifestHash;
      await this.ctx.storage.put('state', state);
      return Response.json({ success: true, manifestHash });
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

    if (url.pathname === '/action-item-runs/start' && request.method === 'POST') {
      const { runId, actionItemId, conversationId, workspaceId, projectId, apiUrl, apiToken } = await request.json() as {
        runId: string;
        actionItemId: string;
        conversationId: string;
        workspaceId: string;
        projectId: string;
        apiUrl: string;
        apiToken: string;
      };
      this.runActionItemRun(runId, actionItemId, conversationId, workspaceId, projectId, apiUrl, apiToken)
        .catch((err) => console.error('[ActionItemRun] Failed:', err));
      return Response.json({ success: true });
    }

    if (url.pathname === '/action-item-runs/apply' && request.method === 'POST') {
      const { runId, conversationId, workspaceId, projectId, apiUrl, apiToken } = await request.json() as {
        runId: string;
        conversationId: string;
        workspaceId: string;
        projectId: string;
        apiUrl: string;
        apiToken: string;
      };
      await this.applyActionItemRun(runId, conversationId, workspaceId, projectId, apiUrl, apiToken);
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
      const { apiUrl, apiToken, deploymentId: providedId } = await request.json() as { apiUrl: string; apiToken: string; deploymentId?: string };
      // Trigger async deployment - returns immediately
      const deploymentId = providedId || crypto.randomUUID();
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

      // OpenCode policy: require explicit user approval before deployment tools
      const policyPreamble = [
        'Policy:',
        '- If deployment is requested, ask the user for explicit approval before calling any deploy tool.',
        '- Only call the deploy tool after the user has clearly approved deployment in this conversation.',
      ].join('\n');

      const openCodePrompt = `${policyPreamble}\n\nUser request:\n${prompt}`;

      // Run in sandbox with streaming
      const result = await this.openCode.runInSandboxWithStreaming(
        openCodePrompt,
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
        await this.updateWorkspaceCurrentManifest(state.workspaceId, manifestHash, previousManifestHash);
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

      const shouldExtract = this.bumpDecisionExtraction(state);
      await this.ctx.storage.put('state', state);
      if (shouldExtract) {
        this.ctx.waitUntil(this.triggerDecisionExtraction(state, apiUrl, apiToken));
      }

      if (fileChanges.length > 0) {
        this.broadcast({ type: 'files_changed', files: fileChanges.map(f => f.path) });
        this.broadcast({ type: 'message_update', message: assistantMessage });
      }

      if (manifestHash && fileChanges.length > 0 && state.lastManifestHash === manifestHash) {
        this.ctx.waitUntil(this.maybeAutoSnapshot({
          apiUrl,
          apiToken,
          manifestHash,
          previousManifestHash,
          fileChanges,
          workspaceId: state.workspaceId,
          projectId: state.projectId,
        }));
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

  private truncateOutput(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}\n...truncated`;
  }

  private bumpDecisionExtraction(state: ConversationState): boolean {
    const every = state.decisionExtractionEvery || ConversationSession.DECISION_EXTRACTION_EVERY;
    const count = (state.decisionExtractionCount ?? 0) + 1;
    state.decisionExtractionCount = count;
    if (count >= every) {
      state.decisionExtractionCount = 0;
      state.lastDecisionExtractionAt = new Date().toISOString();
      return true;
    }
    return false;
  }

  private async triggerDecisionExtraction(state: ConversationState, apiUrl: string, apiToken: string) {
    if (!apiUrl || !apiToken) return;
    try {
      const endpoint = `${apiUrl}/v1/projects/${state.projectId}/decisions/extract`;
      await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify({
          conversation_id: state.conversationId,
          messages_per_conversation: 12,
        }),
      });
    } catch (err) {
      console.error('[Conversation] Decision extraction failed', err);
    }
  }

  private buildActionPrompt(args: {
    type: string;
    title: string;
    description?: string | null;
    affectedFiles?: string[];
    suggestedPrompt?: string | null;
    failureNotes?: string | null;
  }): string {
    const details = [
      `Type: ${args.type}`,
      `Title: ${args.title}`,
      args.description ? `Description: ${args.description}` : null,
      args.affectedFiles && args.affectedFiles.length > 0
        ? `Affected files: ${args.affectedFiles.join(', ')}`
        : null,
      args.suggestedPrompt ? `Suggested prompt: ${args.suggestedPrompt}` : null,
      args.failureNotes ? `Previous failures:\n${args.failureNotes}` : null,
    ].filter(Boolean).join('\n');

    return `You are a senior software engineer. Apply the requested fix and produce a clean, minimal patch.

Constraints:
- Only modify files needed for the fix.
- Keep changes focused and safe.
- Do not remove functionality.
- Provide a concise summary of what changed and why.

Task:
${details}

When done, summarize changes and call out any follow-up risks or tests that should pass.`;
  }

  private async ensureStateForActionRun(
    conversationId: string,
    workspaceId: string,
    projectId: string,
    initialManifestHash?: string | null
  ): Promise<ConversationState> {
    try {
      return await this.ensureState();
    } catch {
      return this.init(conversationId, workspaceId, projectId, initialManifestHash || undefined);
    }
  }

  private async runChecks(
    sandbox: SandboxRunner,
    workDir: string,
    commands: CheckCommands
  ): Promise<Array<{ kind: 'install' | 'build' | 'typecheck' | 'test'; command: string; success: boolean; output?: string }>> {
    const checks: Array<{ kind: 'install' | 'build' | 'typecheck' | 'test'; command: string; success: boolean; output?: string }> = [];
    const ordered: Array<{ kind: 'install' | 'build' | 'typecheck' | 'test'; command?: string }> = [
      { kind: 'install', command: commands.install },
      { kind: 'build', command: commands.build },
      { kind: 'typecheck', command: commands.typecheck },
      { kind: 'test', command: commands.test },
    ];

    for (const item of ordered) {
      if (!item.command) continue;
      const result = await sandbox.exec(`cd ${workDir} && ${item.command} 2>&1`);
      const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
      checks.push({
        kind: item.kind,
        command: item.command,
        success: result.success,
        output: output ? this.truncateOutput(output, 12000) : undefined,
      });
      if (!result.success) {
        break;
      }
    }

    return checks;
  }

  private async runActionItemRun(
    runId: string,
    actionItemId: string,
    conversationId: string,
    workspaceId: string,
    projectId: string,
    apiUrl: string,
    apiToken: string
  ): Promise<void> {
    const db = createDb(this.env.DB);
    const [item] = await db
      .select({
        id: actionItems.id,
        type: actionItems.type,
        title: actionItems.title,
        description: actionItems.description,
        affectedFiles: actionItems.affectedFiles,
        suggestedPrompt: actionItems.suggestedPrompt,
        metadata: actionItems.metadata,
      })
      .from(actionItems)
      .where(eq(actionItems.id, actionItemId))
      .limit(1);

    if (!item) {
      await db.update(actionItemRuns).set({
        status: 'failed',
        error: 'Action item not found',
        updatedAt: new Date().toISOString(),
      }).where(eq(actionItemRuns.id, runId));
      return;
    }

    const [workspaceRow] = await db
      .select({ currentManifestHash: workspaces.currentManifestHash })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);

    const baseManifestHash = workspaceRow?.currentManifestHash || null;
    if (!baseManifestHash) {
      await db.update(actionItemRuns).set({
        status: 'failed',
        error: 'Workspace has no manifest hash',
        updatedAt: new Date().toISOString(),
      }).where(eq(actionItemRuns.id, runId));
      return;
    }

    await this.ensureStateForActionRun(conversationId, workspaceId, projectId, baseManifestHash);

    const now = new Date().toISOString();
    await db.update(actionItemRuns).set({
      status: 'running',
      startedAt: now,
      baseManifestHash,
      updatedAt: now,
    }).where(eq(actionItemRuns.id, runId));

    await db.update(actionItems).set({
      status: 'running',
      updatedAt: now,
    }).where(eq(actionItems.id, actionItemId));

    const sandbox = await this.sandbox.getSandboxRunner();
    const workDir = this.sandbox.getSandboxWorkDir(sandbox);
    const runDir = `/tmp/action-run-${runId}`;

    await this.files.restoreFiles(sandbox, apiUrl, apiToken, baseManifestHash, workDir);
    await sandbox.exec(`rm -rf ${runDir} && mkdir -p ${runDir} && cp -a ${workDir} ${runDir}/orig`);

    const pkgResult = await sandbox.exec(`cat ${workDir}/package.json 2>/dev/null`);
    let packageJson: { scripts?: Record<string, string>; packageManager?: string } | undefined;
    if (pkgResult.success && pkgResult.stdout.trim()) {
      try {
        packageJson = JSON.parse(pkgResult.stdout);
      } catch {
        packageJson = undefined;
      }
    }

    const commands = selectCheckCommands({ packageJson });
    const maxAttempts = 3;
    let lastFailure: string | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await sandbox.exec(`rm -rf ${workDir} && cp -a ${runDir}/orig ${workDir}`);

      let affectedFiles: string[] = [];
      if (item.affectedFiles) {
        try {
          affectedFiles = JSON.parse(item.affectedFiles);
        } catch {
          affectedFiles = [];
        }
      }

      let metadataNote: string | null = null;
      if (item.metadata) {
        try {
          metadataNote = `Metadata: ${item.metadata}`;
        } catch {
          metadataNote = null;
        }
      }

      const prompt = this.buildActionPrompt({
        type: item.type,
        title: item.title,
        description: item.description,
        affectedFiles,
        suggestedPrompt: item.suggestedPrompt,
        failureNotes: [lastFailure, metadataNote].filter(Boolean).join('\n\n') || null,
      });

      const result = await this.openCode.runInSandboxWithStreaming(
        prompt,
        apiUrl,
        apiToken,
        `action-run-${runId}-${attempt}`,
        () => undefined,
        () => undefined
      );

      await sandbox.exec(`rm -rf ${runDir}/work && cp -a ${workDir} ${runDir}/work`);
      await sandbox.exec(`diff -ruN ${runDir}/orig ${runDir}/work > ${runDir}/patch.diff || true`);
      const patchResult = await sandbox.exec(`cat ${runDir}/patch.diff 2>/dev/null || true`);
      const patch = patchResult.stdout || '';

      const checks = await this.runChecks(sandbox, workDir, commands);
      const allPassed = checks.every((c) => c.success);

      if (allPassed && patch.trim().length > 0) {
        const finishedAt = new Date().toISOString();
        await db.update(actionItemRuns).set({
          status: 'ready',
          attemptCount: attempt,
          report: this.truncateOutput(result.output || '', 20000) || null,
          summary: this.truncateOutput((result.output || '').split('\n').slice(0, 3).join('\n'), 800) || null,
          patch,
          checks: JSON.stringify(checks),
          completedAt: finishedAt,
          updatedAt: finishedAt,
        }).where(eq(actionItemRuns.id, runId));

        await db.update(actionItems).set({
          status: 'ready',
          updatedAt: finishedAt,
        }).where(eq(actionItems.id, actionItemId));

        return;
      }

      const failedChecks = checks.filter((c) => !c.success);
      lastFailure = failedChecks.map((c) => `${c.kind} failed:\n${c.output || ''}`).join('\n\n') || 'Patch generation failed';

      await db.update(actionItemRuns).set({
        attemptCount: attempt,
        checks: JSON.stringify(checks),
        report: this.truncateOutput(result.output || '', 20000) || null,
        summary: this.truncateOutput((result.output || '').split('\n').slice(0, 3).join('\n'), 800) || null,
        updatedAt: new Date().toISOString(),
      }).where(eq(actionItemRuns.id, runId));
    }

    const failedAt = new Date().toISOString();
    await db.update(actionItemRuns).set({
      status: 'failed',
      error: lastFailure || 'Action run failed',
      completedAt: failedAt,
      updatedAt: failedAt,
    }).where(eq(actionItemRuns.id, runId));

    await db.update(actionItems).set({
      status: 'pending',
      updatedAt: failedAt,
    }).where(eq(actionItems.id, actionItemId));
  }

  private async applyActionItemRun(
    runId: string,
    conversationId: string,
    workspaceId: string,
    projectId: string,
    apiUrl: string,
    apiToken: string
  ): Promise<void> {
    const db = createDb(this.env.DB);
    const [run] = await db
      .select({
        id: actionItemRuns.id,
        actionItemId: actionItemRuns.actionItemId,
        status: actionItemRuns.status,
        patch: actionItemRuns.patch,
        baseManifestHash: actionItemRuns.baseManifestHash,
      })
      .from(actionItemRuns)
      .where(eq(actionItemRuns.id, runId))
      .limit(1);

    if (!run || run.status !== 'ready' || !run.patch) {
      throw new Error('Run is not ready to apply');
    }

    const [workspaceRow] = await db
      .select({ currentManifestHash: workspaces.currentManifestHash })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);

    if (run.baseManifestHash && workspaceRow?.currentManifestHash !== run.baseManifestHash) {
      throw new Error('Workspace has changed since run was generated');
    }

    const state = await this.ensureStateForActionRun(conversationId, workspaceId, projectId, run.baseManifestHash);
    if (run.baseManifestHash) {
      state.lastManifestHash = run.baseManifestHash;
      await this.ctx.storage.put('state', state);
    }

    const sandbox = await this.sandbox.getSandboxRunner();
    const workDir = this.sandbox.getSandboxWorkDir(sandbox);
    const runDir = `/tmp/action-run-${runId}`;

    const manifestHash = run.baseManifestHash || state.lastManifestHash;
    if (!manifestHash) {
      throw new Error('Missing base manifest hash for apply');
    }
    await this.files.restoreFiles(sandbox, apiUrl, apiToken, manifestHash, workDir);
    await sandbox.exec(`rm -rf ${runDir} && mkdir -p ${runDir}`);
    const marker = `PATCH_${runId.replace(/[^a-zA-Z0-9]/g, '')}`;
    await sandbox.exec(`cat <<'${marker}' > ${runDir}/patch.diff\n${run.patch}\n${marker}`);

    const applyResult = await sandbox.exec(`patch -p3 -d ${workDir} < ${runDir}/patch.diff 2>&1`);
    if (!applyResult.success) {
      throw new Error(`Patch apply failed: ${applyResult.stderr || applyResult.stdout || 'unknown error'}`);
    }

    const { fileChanges, manifestHash, previousManifestHash } = await this.files.collectAndUploadFiles(
      sandbox,
      apiUrl,
      apiToken,
      workDir
    );

    if (manifestHash) {
      state.lastManifestHash = manifestHash;
      await this.updateWorkspaceCurrentManifest(state.workspaceId, manifestHash, previousManifestHash);
    }

    const finishedAt = new Date().toISOString();
    await db.update(actionItemRuns).set({
      status: 'applied',
      updatedAt: finishedAt,
      completedAt: finishedAt,
    }).where(eq(actionItemRuns.id, runId));

    await db.update(actionItems).set({
      status: 'applied',
      updatedAt: finishedAt,
    }).where(eq(actionItems.id, run.actionItemId));
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

  private async updateWorkspaceCurrentManifest(
    workspaceId: string,
    manifestHash: string,
    previousManifestHash?: string
  ): Promise<void> {
    const db = createDb(this.env.DB);
    const now = new Date().toISOString();

    const allowOverwrite = previousManifestHash
      ? or(
          isNull(workspaces.currentManifestHash),
          eq(workspaces.currentManifestHash, previousManifestHash)
        )
      : isNull(workspaces.currentManifestHash);

    const updateResult = await db
      .update(workspaces)
      .set({
        currentManifestHash: manifestHash,
        lastSeenAt: now,
      })
      .where(and(eq(workspaces.id, workspaceId), allowOverwrite))
      .returning({ current_manifest_hash: workspaces.currentManifestHash });

    if (updateResult.length > 0) {
      return;
    }

    // Conflict: another session updated the workspace state first.
    const currentResult = await db
      .select({
        current_manifest_hash: workspaces.currentManifestHash,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);

    const latestHash = currentResult[0]?.current_manifest_hash || undefined;
    if (!latestHash || latestHash === manifestHash) {
      return;
    }

    const state = await this.ensureState();
    state.lastManifestHash = latestHash;
    await this.ctx.storage.put('state', state);

    await db.insert(activityEvents).values({
      id: crypto.randomUUID(),
      projectId: state.projectId,
      workspaceId,
      actor: 'system',
      type: 'workspace.out_of_date',
      message: 'Workspace updated by another session. Reloaded latest workspace state.',
      createdAt: now,
    });

    this.broadcast({ type: 'warning', warning: 'Workspace updated elsewhere. Reloaded latest state.' });
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

  private async maybeAutoSnapshot(args: {
    apiUrl: string;
    apiToken: string;
    manifestHash: string;
    previousManifestHash?: string;
    fileChanges: FileChange[];
    workspaceId: string;
    projectId: string;
  }): Promise<void> {
    if (!args.apiUrl || !args.apiToken) return;

    const changeCount = args.fileChanges.length;
    const hasAddDelete = args.fileChanges.some((change) => change.change === 'added' || change.change === 'deleted');

    let bytesChanged = 0;
    let significant = hasAddDelete || changeCount >= AUTO_SNAPSHOT_MIN_CHANGES;

    if (!args.previousManifestHash && changeCount > 0) {
      significant = true;
    }

    if (!significant && args.previousManifestHash) {
      bytesChanged = await this.estimateBytesChanged({
        projectId: args.projectId,
        manifestHash: args.manifestHash,
        previousManifestHash: args.previousManifestHash,
        fileChanges: args.fileChanges,
      });
      significant = bytesChanged >= AUTO_SNAPSHOT_MIN_BYTES;
    }

    if (!significant) return;

    const db = createDb(this.env.DB);
    const latest = await db
      .select({
        id: snapshots.id,
        manifest_hash: snapshots.manifestHash,
        created_at: snapshots.createdAt,
      })
      .from(snapshots)
      .where(eq(snapshots.workspaceId, args.workspaceId))
      .orderBy(desc(snapshots.createdAt))
      .limit(1);

    const lastSnapshot = latest[0];
    if (lastSnapshot?.manifest_hash === args.manifestHash) return;

    if (lastSnapshot?.created_at) {
      const ageMs = Date.now() - Date.parse(lastSnapshot.created_at);
      const isLarge = changeCount >= AUTO_SNAPSHOT_LARGE_CHANGES || bytesChanged >= AUTO_SNAPSHOT_LARGE_BYTES;
      if (ageMs < AUTO_SNAPSHOT_COOLDOWN_MS && !isLarge) return;
    }

    try {
      const response = await fetch(`${args.apiUrl}/v1/projects/${args.projectId}/snapshots`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${args.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          manifest_hash: args.manifestHash,
          parent_snapshot_ids: lastSnapshot?.id ? [lastSnapshot.id] : [],
          workspace_id: args.workspaceId,
          source: 'system',
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn('[Conversation] Auto snapshot failed:', response.status, errorText);
      }
    } catch (err) {
      console.warn('[Conversation] Auto snapshot error:', err);
    }
  }

  private async estimateBytesChanged(args: {
    projectId: string;
    manifestHash: string;
    previousManifestHash: string;
    fileChanges: FileChange[];
  }): Promise<number> {
    const db = createDb(this.env.DB);
    const project = await db
      .select({ owner_user_id: projects.ownerUserId })
      .from(projects)
      .where(eq(projects.id, args.projectId))
      .limit(1);

    const ownerUserId = project[0]?.owner_user_id;
    if (!ownerUserId) return 0;

    const currentKey = `${ownerUserId}/manifests/${args.manifestHash}.json`;
    const previousKey = `${ownerUserId}/manifests/${args.previousManifestHash}.json`;

    const [currentObj, previousObj] = await Promise.all([
      this.env.BLOBS.get(currentKey),
      this.env.BLOBS.get(previousKey),
    ]);

    if (!currentObj || !previousObj) return 0;

    let currentManifest: { files: Array<{ path: string; size?: number }> };
    let previousManifest: { files: Array<{ path: string; size?: number }> };

    try {
      currentManifest = JSON.parse(await currentObj.text());
      previousManifest = JSON.parse(await previousObj.text());
    } catch {
      return 0;
    }

    const currentSizes = new Map<string, number>();
    const previousSizes = new Map<string, number>();

    for (const file of currentManifest.files || []) {
      if (typeof file.path === 'string') {
        currentSizes.set(file.path, file.size || 0);
      }
    }

    for (const file of previousManifest.files || []) {
      if (typeof file.path === 'string') {
        previousSizes.set(file.path, file.size || 0);
      }
    }

    let bytesChanged = 0;
    for (const change of args.fileChanges) {
      if (change.change === 'added') {
        bytesChanged += currentSizes.get(change.path) || 0;
      } else if (change.change === 'deleted') {
        bytesChanged += previousSizes.get(change.path) || 0;
      } else {
        bytesChanged += currentSizes.get(change.path) || previousSizes.get(change.path) || 0;
      }
    }

    return bytesChanged;
  }

}
