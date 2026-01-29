import type { TimelineItem } from '@fastest/shared';

export type SandboxExecResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number;
};

export type SandboxRunner = {
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
export interface ConversationState {
  conversationId: string;
  workspaceId: string;
  projectId: string;
  messages: Message[];
  activeAssistantMessageId?: string;
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
  decisionExtractionEvery?: number;
  decisionExtractionCount?: number;
  lastDecisionExtractionAt?: string;

  // Metadata
  createdAt: string;
  updatedAt: string;
}
