import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from '@tanstack/react-router';
import type { ConversationWithContext, TimelineItem } from '@fastest/shared';
import { api, type Message, type StreamEvent, type Deployment, type ProjectInfo, type DeploymentLogEntry } from '../api/client';
import type { OpenCodeEvent, OpenCodeGlobalEvent, OpenCodePart, OpenCodeQuestionRequest } from '../api/opencode';
import {
  ConversationMessage,
  PromptInput,
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
  const [opencodePartsByMessageId, setOpencodePartsByMessageId] = useState<Record<string, OpenCodePart[]>>({});
  const [opencodeQuestionsByMessageId, setOpencodeQuestionsByMessageId] = useState<Record<string, OpenCodeQuestionRequest[]>>({});

  // Deployment state
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [isDeploying, setIsDeploying] = useState(false);
  const [deploymentLogs, setDeploymentLogs] = useState<Record<string, DeploymentLogEntry[]>>({});
  const [showingLogsFor, setShowingLogsFor] = useState<string | null>(null);
  const [previewBanner, setPreviewBanner] = useState<{ url: string; deploymentId: string } | null>(null);

  // Context data
  const [currentWorkspace, setCurrentWorkspace] = useState<{ id: string; name: string } | null>(null);

  // UI state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningMessageId, setRunningMessageId] = useState<string | null>(null);
  const [streamingContent, setStreamingContent] = useState<string>('');
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearingConversation, setClearingConversation] = useState(false);

  // Refs
  const conversationEndRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingPromptSent = useRef(false);
  const handleStreamEventRef = useRef<(event: StreamEvent) => void>(() => {});

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

  const upsertOpenCodePart = (messageId: string, event: OpenCodeEvent) => {
    const part = event.properties?.part;
    if (!part) return;
    const delta = typeof event.properties?.delta === 'string' ? event.properties?.delta : undefined;
    const partId = (part as OpenCodePart).id || `${part.type}-${messageId}`;

    setOpencodePartsByMessageId(prev => {
      const existing = prev[messageId] || [];
      const idx = existing.findIndex(p => (p.id || `${p.type}-${messageId}`) === partId);
      const prevPart = idx >= 0 ? existing[idx] : undefined;
      let nextPart: OpenCodePart = { ...(prevPart || {}), ...(part as OpenCodePart) };

      if (nextPart.type === 'text') {
        const prevText = (prevPart as OpenCodePart | undefined)?.type === 'text' ? (prevPart as any).text : '';
        const incomingText = (part as any).text;
        if (typeof incomingText === 'string') {
          (nextPart as any).text = incomingText;
        } else if (delta) {
          (nextPart as any).text = `${prevText || ''}${delta}`;
        }
      }

      if (idx >= 0) {
        const updated = [...existing];
        updated[idx] = nextPart;
        return { ...prev, [messageId]: updated };
      }

      return { ...prev, [messageId]: [...existing, nextPart] };
    });
  };

  const handleOpenCodeEvent = (messageId: string, globalEvent: OpenCodeGlobalEvent) => {
    const payload = globalEvent.payload;
    if (!payload || typeof payload.type !== 'string') return;
    if (payload.type === 'message.part.updated') {
      upsertOpenCodePart(messageId, payload);
    }
    if (payload.type === 'question.asked') {
      const request = payload.properties as OpenCodeQuestionRequest;
      const questionMessageId = request?.tool?.messageID || messageId;
      if (questionMessageId) {
        setOpencodeQuestionsByMessageId(prev => {
          const existing = prev[questionMessageId] || [];
          if (existing.some((q) => q.id === request.id)) return prev;
          return { ...prev, [questionMessageId]: [...existing, request] };
        });
      }
    }
    if (payload.type === 'question.replied' || payload.type === 'question.rejected') {
      const requestId = (payload.properties as { requestID?: string } | undefined)?.requestID;
      if (!requestId) return;
      setOpencodeQuestionsByMessageId(prev => {
        const next = { ...prev };
        for (const [id, list] of Object.entries(next)) {
          const filtered = list.filter((q) => q.id !== requestId);
          if (filtered.length !== list.length) {
            next[id] = filtered;
          }
        }
        return next;
      });
    }
  };


  // Handle WebSocket stream events
  const handleStreamEvent = (event: StreamEvent) => {
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

      case 'message_status':
        setMessages(prev => prev.map(m =>
          m.id === event.messageId ? { ...m, status: event.status } : m
        ));
        if (event.status === 'completed' || event.status === 'failed') {
          setRunningMessageId(null);
          setStreamingContent('');
        }
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

      case 'message_update':
        setMessages(prev => {
          const idx = prev.findIndex(m => m.id === event.message.id);
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = event.message;
            return updated;
          }
          return prev;
        });
        break;

      case 'opencode_event':
        handleOpenCodeEvent(event.messageId, event.event);
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
        setError(formatErrorMessage(event.error));
        setRunningMessageId(null);
        setStreamingContent('');
        break;
    }
  };

  handleStreamEventRef.current = handleStreamEvent;

  // Connect WebSocket when conversation changes
  useEffect(() => {
    if (!conversationId) return;

    // Close existing connection if open
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.close();
    }

    // Connect to stream
    const ws = api.connectStream(conversationId, (event) => handleStreamEventRef.current(event));
    wsRef.current = ws;

    return () => {
      // Only close if the WebSocket is fully open
      // Closing during CONNECTING state causes "closed before connection established" errors
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
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
      const [messagesRes, timelineRes, deploymentsRes, openCodeRes] = await Promise.all([
        api.getMessages(convId),
        api.getTimeline(convId).catch(() => ({ timeline: [] })),
        api.getDeployments(convId).catch(() => ({ deployments: [], projectInfo: null })),
        api.getOpenCodeMessages(convId).catch(() => ({ messages: {} })),
      ]);

      setMessages(messagesRes.messages);
      setTimeline(timelineRes.timeline);
      setDeployments(deploymentsRes.deployments);
      setProjectInfo(deploymentsRes.projectInfo);
      setOpencodePartsByMessageId(
        Object.fromEntries(
          Object.entries(openCodeRes.messages || {}).map(([id, value]) => {
            const record = value as { parts?: OpenCodePart[] };
            return [id, record.parts || []];
          })
        )
      );
      setOpencodeQuestionsByMessageId({});

      // Check if any message is running
      const running = messagesRes.messages.find((m) => m.status === 'running');
      if (running) {
        setRunningMessageId(running.id);
      }

      // Store current workspace info
      setCurrentWorkspace({ id: conv.workspace_id, name: conv.workspace_name });
    } catch (err) {
      console.error('Failed to load conversation:', err);
      setError(err instanceof Error ? err.message : 'Failed to load conversation');
    } finally {
      setLoading(false);
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
      const { messageId } = await api.sendMessage(conversationId, prompt);
      if (messageId) {
        setMessages(prev => prev.map(m =>
          m.id === assistantPlaceholder.id ? { ...m, id: messageId } : m
        ));
        setRunningMessageId(messageId);
      }
    } catch (err) {
      setError(formatErrorMessage(err instanceof Error ? err.message : 'Failed to send message'));
      // Remove placeholder on error
      setMessages(prev => prev.filter(m => m.id !== assistantPlaceholder.id));
      setRunningMessageId(null);
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

  const handleQuestionSubmit = async (requestId: string, answers: string[][]) => {
    if (!conversationId) return;
    try {
      await api.replyOpenCodeQuestion(conversationId, requestId, answers);
    } catch (err) {
      console.error('Failed to reply to question:', err);
      setError(err instanceof Error ? err.message : 'Failed to reply to question');
    }
  };

  const handleQuestionReject = async (requestId: string) => {
    if (!conversationId) return;
    try {
      await api.rejectOpenCodeQuestion(conversationId, requestId);
    } catch (err) {
      console.error('Failed to reject question:', err);
      setError(err instanceof Error ? err.message : 'Failed to reject question');
    }
  };

  const sortedMessages = [...messages].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  const conversationMessages = sortedMessages.map((m) => ({
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
    lastMessageStatus: lastMessage?.status === 'failed' ? 'failed' : null,
    lastUserPrompt: sortedMessages.filter(m => m.role === 'user').slice(-1)[0]?.content,
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
              conversationMessages
                .filter(j => j.prompt || j.output || j.status === 'running')
                .map((message) => (
                  <ConversationMessage
                    key={message.id}
                    message={message as any}
                    isStreaming={message.id === runningMessageId}
                    streamingContent={message.id === runningMessageId ? streamingContent : undefined}
                    parts={opencodePartsByMessageId[message.id]}
                    questions={opencodeQuestionsByMessageId[message.id]}
                    onQuestionSubmit={handleQuestionSubmit}
                    onQuestionReject={handleQuestionReject}
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

function formatErrorMessage(raw: string): string {
  if (!raw) return 'An unexpected error occurred';
  if (raw.includes('MAX_FILES_PER_MANIFEST') || raw.includes('max allowed')) {
    const match = raw.match(/Workspace has (\d+) files; max allowed is (\d+)/);
    if (match) {
      const [, total, max] = match;
      return `This workspace has ${total} files, which exceeds the current limit (${max}). Remove files or increase MAX_FILES_PER_MANIFEST, then retry.`;
    }
    return 'This workspace exceeds the current file limit. Remove files or increase MAX_FILES_PER_MANIFEST, then retry.';
  }
  return raw;
}
