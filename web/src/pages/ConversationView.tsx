import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from '@tanstack/react-router';
import type { Project, Workspace, ConversationWithContext, TimelineItem } from '@fastest/shared';
import { api, type Message, type StreamEvent, type Deployment, type ProjectInfo, type DeploymentLogEntry } from '../api/client';
import {
  ConversationMessage,
  PromptInput,
  ContextBar,
  SuggestionsBar,
  generateSuggestions,
  Timeline,
  DeploymentLogs,
} from '../components/conversation';

// Confirmation Dialog Component
interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  isLoading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  isLoading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={!isLoading ? onCancel : undefined}
      />

      {/* Dialog */}
      <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-2">{title}</h3>
        <p className="text-sm text-gray-600 mb-6">{message}</p>

        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {isLoading && (
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            )}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// Conversation Actions Menu Component
interface ConversationActionsMenuProps {
  onClearConversation: () => void;
  onNewConversation: () => void;
  disabled?: boolean;
}

function ConversationActionsMenu({ onClearConversation, onNewConversation, disabled }: ConversationActionsMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
        title="Conversation actions"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute bottom-full right-0 mb-1 w-48 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1">
          <button
            onClick={() => {
              onNewConversation();
              setIsOpen(false);
            }}
            className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New conversation
          </button>
          <button
            onClick={() => {
              onClearConversation();
              setIsOpen(false);
            }}
            className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            Clear messages
          </button>
        </div>
      )}
    </div>
  );
}

export function ConversationView() {
  const { conversationId } = useParams({ strict: false }) as { conversationId?: string };
  const navigate = useNavigate();

  // Conversation data
  const [conversation, setConversation] = useState<ConversationWithContext | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [showTimeline, setShowTimeline] = useState(true);

  // Deployment state
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [isDeploying, setIsDeploying] = useState(false);
  const [deploymentLogs, setDeploymentLogs] = useState<Record<string, DeploymentLogEntry[]>>({});
  const [showingLogsFor, setShowingLogsFor] = useState<string | null>(null);
  const [previewBanner, setPreviewBanner] = useState<{ url: string; deploymentId: string } | null>(null);

  // Context data (for switching workspaces)
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(null);

  // UI state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningMessageId, setRunningMessageId] = useState<string | null>(null);
  const [streamingContent, setStreamingContent] = useState<string>('');
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearingConversation, setClearingConversation] = useState(false);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [isCreatingWorkspace, setIsCreatingWorkspace] = useState(false);

  // Refs
  const conversationEndRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingPromptSent = useRef(false);

  // Load conversation when conversationId changes
  useEffect(() => {
    if (conversationId) {
      loadConversation(conversationId);
    }
  }, [conversationId]);

  // Scroll to bottom when messages change
  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);


  // Handle WebSocket stream events
  const handleStreamEvent = useCallback((event: StreamEvent) => {
    switch (event.type) {
      case 'message_start':
        // Update the placeholder message ID to match the server's ID
        // This ensures streaming content is displayed correctly
        setMessages(prev => {
          // Find the running placeholder (status 'running' with empty content)
          const runningIdx = prev.findIndex(m => m.status === 'running' && !m.content);
          if (runningIdx >= 0) {
            const updated = [...prev];
            updated[runningIdx] = { ...updated[runningIdx], id: event.messageId };
            return updated;
          }
          return prev;
        });
        setRunningMessageId(event.messageId);
        setStreamingContent('');
        break;

      case 'content_delta':
        setStreamingContent(prev => prev + event.content);
        break;

      case 'status':
        // Update running message status if needed
        break;

      case 'files_changed':
        // Could show file change indicators
        break;

      case 'message_complete':
        setMessages(prev => {
          // Replace or add the completed message
          const idx = prev.findIndex(m => m.id === event.message.id);
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = event.message;
            return updated;
          }
          return [...prev, event.message];
        });
        setRunningMessageId(null);
        setStreamingContent('');
        break;

      case 'timeline_item':
        setTimeline(prev => {
          if (prev.some(item => item.id === event.item.id)) return prev;
          return [...prev, event.item];
        });
        break;

      case 'timeline_summary':
        setTimeline(prev => prev.map(item =>
          item.id === event.itemId
            ? { ...item, summary: event.summary, summaryStatus: 'completed' as const }
            : item
        ));
        break;

      case 'project_info':
        setProjectInfo(event.info);
        break;

      case 'deployment_started':
        setIsDeploying(true);
        setDeployments(prev => [...prev, event.deployment]);
        setDeploymentLogs(prev => ({ ...prev, [event.deployment.id]: [] }));
        setShowingLogsFor(event.deployment.id);
        break;

      case 'deployment_log':
        setDeploymentLogs(prev => ({
          ...prev,
          [event.deploymentId]: [...(prev[event.deploymentId] || []), event.entry],
        }));
        break;

      case 'deployment_complete':
        setIsDeploying(false);
        setDeployments(prev => prev.map(d =>
          d.id === event.deployment.id ? event.deployment : d
        ));
        // Show preview banner on successful deployment
        if (event.deployment.status === 'success' && event.deployment.url) {
          setPreviewBanner({ url: event.deployment.url, deploymentId: event.deployment.id });
        }
        break;

      case 'error':
        setError(event.error);
        setRunningMessageId(null);
        setStreamingContent('');
        break;
    }
  }, []);

  // Connect WebSocket when conversation changes
  useEffect(() => {
    if (!conversationId) return;

    // Close existing connection if open
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.close();
    }

    // Connect to stream
    const ws = api.connectStream(conversationId, handleStreamEvent);
    wsRef.current = ws;

    return () => {
      // Only close if the WebSocket is fully open
      // Closing during CONNECTING state causes "closed before connection established" errors
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
    // handleStreamEvent is stable (empty deps) so we exclude it to prevent reconnections
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Handle pending prompt from home page
  useEffect(() => {
    if (!conversationId || loading || pendingPromptSent.current) return;

    const pendingPrompt = sessionStorage.getItem('pendingPrompt');
    if (pendingPrompt) {
      sessionStorage.removeItem('pendingPrompt');
      pendingPromptSent.current = true;
      handleSubmitPrompt(pendingPrompt);
    }
  }, [conversationId, loading]);

  const loadConversation = async (convId: string) => {
    setLoading(true);
    setError(null);
    pendingPromptSent.current = false;

    try {
      // Load conversation details
      const { conversation: conv } = await api.getConversation(convId);
      setConversation(conv);

      // Load messages, timeline, and deployments in parallel
      const [messagesRes, timelineRes, deploymentsRes] = await Promise.all([
        api.getMessages(convId),
        api.getTimeline(convId).catch(() => ({ timeline: [] })),
        api.getDeployments(convId).catch(() => ({ deployments: [], projectInfo: null })),
      ]);

      setMessages(messagesRes.messages);
      setTimeline(timelineRes.timeline);
      setDeployments(deploymentsRes.deployments);
      setProjectInfo(deploymentsRes.projectInfo);

      // Check if any message is running
      const running = messagesRes.messages.find((m) => m.status === 'running');
      if (running) {
        setRunningMessageId(running.id);
      }

      // Load project and workspaces for context bar
      await loadContextData(conv.project_id, conv.workspace_id);
    } catch (err) {
      console.error('Failed to load conversation:', err);
      setError(err instanceof Error ? err.message : 'Failed to load conversation');
    } finally {
      setLoading(false);
    }
  };

  const loadContextData = async (projectId: string, workspaceId: string) => {
    try {
      // Load all projects
      const { projects: projectList } = await api.listProjects();
      setProjects(projectList);

      // Set current project
      const project = projectList.find(p => p.id === projectId);
      if (project) {
        setCurrentProject(project);
      }

      // Load workspaces for the project
      const { workspaces: workspaceList } = await api.listWorkspaces(projectId);
      setWorkspaces(workspaceList);

      // Set current workspace
      const workspace = workspaceList.find(w => w.id === workspaceId);
      if (workspace) {
        setCurrentWorkspace(workspace);
      }
    } catch (err) {
      console.error('Failed to load context data:', err);
    }
  };

  const handleSubmitPrompt = async (prompt: string) => {
    if (!conversationId) return;

    setError(null);

    // Optimistically add user message
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: prompt,
      status: 'completed',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMessage]);

    // Add placeholder for assistant response
    const assistantPlaceholder: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      status: 'running',
      createdAt: new Date().toISOString(),
    };
    setMessages(prev => [...prev, assistantPlaceholder]);
    setRunningMessageId(assistantPlaceholder.id);

    try {
      // Send message - the actual response will come via WebSocket
      const { message } = await api.sendMessage(conversationId, prompt);

      // Update with the real message from server
      setMessages(prev => prev.map(m =>
        m.id === assistantPlaceholder.id ? message : m
      ));

      if (message.status !== 'running') {
        setRunningMessageId(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
      // Remove placeholder on error
      setMessages(prev => prev.filter(m => m.id !== assistantPlaceholder.id));
      setRunningMessageId(null);
    }
  };

  const handleProjectChange = async (projectId: string) => {
    const project = projects.find((p) => p.id === projectId);
    if (project) {
      setCurrentProject(project);
      const { workspaces: workspaceList } = await api.listWorkspaces(projectId);
      setWorkspaces(workspaceList);
      if (workspaceList.length > 0) {
        const mainWorkspace = workspaceList.find((w) => w.name === 'main') || workspaceList[0];
        setCurrentWorkspace(mainWorkspace);
      }
    }
  };

  const handleWorkspaceChange = async (workspaceId: string) => {
    const workspace = workspaces.find((w) => w.id === workspaceId);
    if (workspace) {
      setCurrentWorkspace(workspace);
    }
  };

  const handleCreateProject = async (name: string) => {
    setIsCreatingProject(true);
    setError(null);
    try {
      const { project } = await api.createProject(name);
      setProjects(prev => [project, ...prev]);
      setCurrentProject(project);

      // Create default 'main' workspace for new project
      const { workspace } = await api.createWorkspace(project.id, 'main');
      setWorkspaces([workspace]);
      setCurrentWorkspace(workspace);

      // Create a new conversation in this workspace and navigate to it
      const { conversation: newConv } = await api.createConversation(workspace.id);
      navigate({ to: '/$conversationId', params: { conversationId: newConv.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setIsCreatingProject(false);
    }
  };

  const handleCreateWorkspace = async (name: string) => {
    if (!currentProject) return;

    setIsCreatingWorkspace(true);
    setError(null);
    try {
      const { workspace } = await api.createWorkspace(currentProject.id, name);
      setWorkspaces(prev => [...prev, workspace]);
      setCurrentWorkspace(workspace);

      // Create a new conversation in this workspace and navigate to it
      const { conversation: newConv } = await api.createConversation(workspace.id);
      navigate({ to: '/$conversationId', params: { conversationId: newConv.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace');
    } finally {
      setIsCreatingWorkspace(false);
    }
  };

  const handleNewConversation = async () => {
    if (!currentWorkspace) return;

    try {
      const { conversation: newConv } = await api.createConversation(currentWorkspace.id);
      navigate({ to: '/$conversationId', params: { conversationId: newConv.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create conversation');
    }
  };

  const handleSuggestionAction = (action: string, data?: unknown) => {
    switch (action) {
      case 'retry':
        if (data && typeof data === 'object' && 'prompt' in data) {
          handleSubmitPrompt((data as { prompt: string }).prompt);
        }
        break;
      case 'test':
        handleSubmitPrompt('Run the test suite and fix any failing tests');
        break;
      case 'deploy':
        handleSubmitPrompt('Deploy the application to production');
        break;
      case 'sync':
        handleSubmitPrompt('Sync this workspace with the latest changes from main');
        break;
      case 'merge':
        handleSubmitPrompt('Prepare changes for merging to main');
        break;
      case 'snapshot':
        handleSubmitPrompt('Create a snapshot of the current state');
        break;
      default:
        console.log('Unknown action:', action);
    }
  };

  const handleClearConversation = async () => {
    if (!conversationId) return;

    setClearingConversation(true);
    setError(null);

    try {
      await api.clearConversation(conversationId);
      setMessages([]);
      setShowClearConfirm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear conversation');
    } finally {
      setClearingConversation(false);
    }
  };

  const handleDeploy = async () => {
    if (!conversationId || isDeploying) return;

    setError(null);
    setIsDeploying(true);

    try {
      // First detect project type if not already done
      if (!projectInfo) {
        const { projectInfo: info } = await api.getProjectInfo(conversationId);
        setProjectInfo(info);

        if (info.type !== 'wrangler') {
          setError('Only Wrangler projects are supported for deployment');
          setIsDeploying(false);
          return;
        }
      }

      // Trigger deployment
      await api.deploy(conversationId);
      // The actual result will come via WebSocket
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start deployment');
      setIsDeploying(false);
    }
  };

  // Convert Message to Job-like structure for existing components
  const messagesAsJobs = messages.map(m => ({
    id: m.id,
    workspace_id: conversation?.workspace_id || '',
    project_id: conversation?.project_id || '',
    prompt: m.role === 'user' ? m.content : '',
    status: m.status,
    output: m.role === 'assistant' ? m.content : undefined,
    error: m.error,
    created_at: m.createdAt,
    completed_at: m.completedAt,
  }));

  // Generate suggestions based on current state
  const lastMessage = messages.filter(m => m.role === 'assistant').slice(-1)[0];
  const suggestions = generateSuggestions({
    lastJobStatus: lastMessage?.status === 'failed' ? 'failed' : null,
    lastJobPrompt: messages.filter(m => m.role === 'user').slice(-1)[0]?.content,
    hasDrift: false,
    driftCount: 0,
    hasUncommittedChanges: messages.some((m) => m.status === 'completed' && m.filesChanged?.length),
    isMainWorkspace: currentWorkspace?.name === 'main',
    onAction: handleSuggestionAction,
  });

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* Error banner */}
      {error && (
        <div className="bg-red-50 border-b border-red-200 px-4 py-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Conversation header */}
      {conversation && (
        <div className="bg-white border-b border-gray-200 px-4 py-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              <button
                onClick={() => navigate({ to: '/' })}
                className="text-gray-500 hover:text-gray-700"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <span className="font-medium text-gray-900 truncate max-w-md">
                {conversation.title || 'Untitled conversation'}
              </span>
              <span className="text-gray-400">•</span>
              <span className="text-gray-500">{conversation.workspace_name}</span>
            </div>
            <div className="flex items-center gap-2">
              {/* Latest deployment URL */}
              {deployments.length > 0 && deployments[deployments.length - 1].status === 'success' && (
                <a
                  href={deployments[deployments.length - 1].url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary-600 hover:text-primary-700 hover:underline truncate max-w-48"
                  title={deployments[deployments.length - 1].url}
                >
                  {deployments[deployments.length - 1].url}
                </a>
              )}

              {/* Deploy button */}
              {messages.length > 0 && (
                <button
                  onClick={handleDeploy}
                  disabled={isDeploying || !!runningMessageId}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors flex items-center gap-1.5 ${
                    isDeploying
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50'
                  }`}
                  title={projectInfo?.type === 'wrangler' ? 'Deploy to Cloudflare Workers' : 'Deploy project'}
                >
                  {isDeploying ? (
                    <>
                      <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Deploying...
                    </>
                  ) : (
                    <>
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                      </svg>
                      Deploy
                    </>
                  )}
                </button>
              )}

              {/* Timeline toggle */}
              <button
                onClick={() => setShowTimeline(!showTimeline)}
                className={`p-2 rounded-lg transition-colors ${
                  showTimeline ? 'bg-primary-100 text-primary-600' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
                }`}
                title={showTimeline ? 'Hide timeline' : 'Show timeline'}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Preview URL Banner */}
      {previewBanner && (
        <div className="bg-gradient-to-r from-green-500 to-emerald-600 text-white px-4 py-3 shadow-lg">
          <div className="max-w-4xl mx-auto flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex-shrink-0 w-8 h-8 bg-white/20 rounded-full flex items-center justify-center">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div>
                <div className="font-medium">Deployment successful!</div>
                <div className="text-sm text-white/80 font-mono truncate max-w-md">
                  {previewBanner.url}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <a
                href={previewBanner.url}
                target="_blank"
                rel="noopener noreferrer"
                className="px-4 py-2 bg-white text-green-700 rounded-lg font-medium text-sm hover:bg-green-50 transition-colors flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                Open Site
              </a>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(previewBanner.url);
                }}
                className="p-2 text-white/80 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                title="Copy URL"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
              <button
                onClick={() => setShowingLogsFor(previewBanner.deploymentId)}
                className="p-2 text-white/80 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                title="View logs"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </button>
              <button
                onClick={() => setPreviewBanner(null)}
                className="p-2 text-white/80 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                title="Dismiss"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main content area with sidebar */}
      <div className="flex-1 flex overflow-hidden">
        {/* Conversation area */}
        <div className="flex-1 overflow-y-auto px-4 py-6">
          <div className="max-w-3xl mx-auto space-y-6">
            {messages.length === 0 ? (
              <EmptyState />
            ) : (
              messagesAsJobs
                .filter(j => j.prompt || j.output || j.status === 'running')
                .map((job) => (
                  <ConversationMessage
                    key={job.id}
                    job={job as any}
                    isStreaming={job.id === runningMessageId}
                    streamingContent={job.id === runningMessageId ? streamingContent : undefined}
                  />
                ))
            )}
            <div ref={conversationEndRef} />
          </div>
        </div>

        {/* Timeline sidebar */}
        {showTimeline && (
          <div className="w-72 border-l border-gray-200 bg-white flex-shrink-0">
            <Timeline items={timeline} />
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="border-t border-gray-200 bg-white px-4 py-4">
        <div className="max-w-3xl mx-auto space-y-3">
          <PromptInput
            onSubmit={handleSubmitPrompt}
            isRunning={!!runningMessageId}
            placeholder={
              messages.length === 0 ? 'What do you want to build?' : 'Continue the conversation...'
            }
          />

          <ContextBar
            projects={projects}
            currentProject={currentProject}
            workspaces={workspaces}
            currentWorkspace={currentWorkspace}
            onProjectChange={handleProjectChange}
            onWorkspaceChange={handleWorkspaceChange}
            onCreateProject={handleCreateProject}
            onCreateWorkspace={handleCreateWorkspace}
            isCreatingProject={isCreatingProject}
            isCreatingWorkspace={isCreatingWorkspace}
            runningJobsCount={runningMessageId ? 1 : 0}
          />

          <div className="flex items-center justify-between">
            <SuggestionsBar suggestions={suggestions} />
            <ConversationActionsMenu
              onClearConversation={() => setShowClearConfirm(true)}
              onNewConversation={handleNewConversation}
              disabled={!!runningMessageId}
            />
          </div>
        </div>
      </div>

      {/* Clear Conversation Confirmation Dialog */}
      <ConfirmDialog
        isOpen={showClearConfirm}
        title="Clear conversation"
        message="Are you sure you want to clear this conversation? This action cannot be undone."
        confirmLabel="Clear"
        cancelLabel="Cancel"
        isLoading={clearingConversation}
        onConfirm={handleClearConversation}
        onCancel={() => setShowClearConfirm(false)}
      />

      {/* Deployment Logs Panel */}
      {showingLogsFor && (
        <div className="fixed inset-y-0 right-0 w-[500px] z-50 shadow-xl">
          <DeploymentLogs
            deploymentId={showingLogsFor}
            isStreaming={isDeploying && deployments.find(d => d.id === showingLogsFor)?.status === 'deploying'}
            entries={deploymentLogs[showingLogsFor] || []}
            onClose={() => setShowingLogsFor(null)}
          />
        </div>
      )}

    </div>
  );
}

function EmptyState() {
  return (
    <div className="text-center py-16">
      <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary-100 mb-4">
        <svg
          className="w-8 h-8 text-primary-600"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
          />
        </svg>
      </div>
      <h3 className="text-lg font-medium text-gray-900 mb-2">Start a conversation</h3>
      <p className="text-gray-500 max-w-sm mx-auto">
        Describe what you want to build and the agent will help you create it.
      </p>
    </div>
  );
}
