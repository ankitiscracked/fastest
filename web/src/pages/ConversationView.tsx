import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from '@tanstack/react-router';
import type { ConversationWithContext, TimelineItem } from '@fastest/shared';
import { api, type Message, type StreamEvent, type Deployment, type ProjectInfo, type DeploymentLogEntry, type ReconnectingWebSocket } from '../api/client';
import type { OpenCodeEvent, OpenCodeGlobalEvent, OpenCodePart, OpenCodeQuestionRequest } from '../api/opencode';
import {
  ConversationMessage,
  PromptInput,
  SuggestionsBar,
  generateSuggestions,
  Timeline,
  DeploymentLogs,
} from '../components/conversation';

// Utility: debounce function for scroll optimization
function useDebounce<T extends (...args: unknown[]) => void>(fn: T, delay: number): T {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  return useCallback((...args: Parameters<T>) => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(() => {
      fnRef.current(...args);
    }, delay);
  }, [delay]) as T;
}

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
        <h3 className="text-lg font-semibold text-surface-800 mb-2">{title}</h3>
        <p className="text-sm text-surface-600 mb-6">{message}</p>

        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium text-surface-700 bg-surface-100 hover:bg-surface-200 rounded-lg transition-colors disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium text-white bg-status-error hover:bg-red-600 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
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
        className="p-2 text-surface-500 hover:text-surface-700 hover:bg-surface-100 rounded-lg transition-colors disabled:opacity-50"
        title="Conversation actions"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute bottom-full right-0 mb-1 w-48 bg-white border border-surface-200 rounded-lg shadow-lg z-50 py-1">
          <button
            onClick={() => {
              onNewConversation();
              setIsOpen(false);
            }}
            className="w-full text-left px-4 py-2 text-sm text-surface-700 hover:bg-surface-50 flex items-center gap-2"
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
            className="w-full text-left px-4 py-2 text-sm text-status-error hover:bg-status-error/10 flex items-center gap-2"
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
  const wsRef = useRef<ReconnectingWebSocket | null>(null);
  const pendingPromptSent = useRef(false);
  const handleStreamEventRef = useRef<(event: StreamEvent) => void>(() => {});
  const scrollRAFRef = useRef<number | null>(null);
  const isUserScrolledUpRef = useRef(false);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  // Track placeholder message ID to prevent race conditions between API response and WebSocket
  const placeholderIdRef = useRef<string | null>(null);
  const realMessageIdRef = useRef<string | null>(null);
  // Counter for generating unique part IDs when none provided
  const partIdCounterRef = useRef(0);

  // Debounced scroll to bottom - prevents scroll thrashing during streaming
  const scrollToBottom = useDebounce(() => {
    // Don't auto-scroll if user has scrolled up to read history
    if (isUserScrolledUpRef.current) return;

    // Use RAF for smooth scrolling without blocking
    if (scrollRAFRef.current) {
      cancelAnimationFrame(scrollRAFRef.current);
    }
    scrollRAFRef.current = requestAnimationFrame(() => {
      conversationEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    });
  }, 100);

  // Track if user has scrolled up (to disable auto-scroll)
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      // User is "scrolled up" if they're more than 100px from bottom
      isUserScrolledUpRef.current = scrollHeight - scrollTop - clientHeight > 100;
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  // Load conversation when conversationId changes
  useEffect(() => {
    if (conversationId) {
      loadConversation(conversationId);
    }
  }, [conversationId]);

  // Scroll to bottom when messages change (debounced)
  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingContent, scrollToBottom]);

  // Cleanup RAF on unmount
  useEffect(() => {
    return () => {
      if (scrollRAFRef.current) {
        cancelAnimationFrame(scrollRAFRef.current);
      }
    };
  }, []);

  const upsertOpenCodePart = (messageId: string, event: OpenCodeEvent) => {
    const part = event.properties?.part;
    if (!part) return;
    const delta = typeof event.properties?.delta === 'string' ? event.properties?.delta : undefined;

    setOpencodePartsByMessageId(prev => {
      const existing = prev[messageId] || [];

      // Generate a unique ID for this part if not provided
      // Use the part's own ID, or fall back to type + counter for uniqueness
      let partId = (part as OpenCodePart).id;
      if (!partId) {
        // For parts without IDs, try to find an existing part of the same type
        // that we're likely updating (e.g., text parts being streamed)
        const existingOfType = existing.filter(p => p.type === part.type && !p.id);
        if (existingOfType.length > 0) {
          // Update the last part of this type (for streaming deltas)
          partId = `${part.type}-${messageId}-${existingOfType.length - 1}`;
        } else {
          // Create new unique ID
          partId = `${part.type}-${messageId}-${partIdCounterRef.current++}`;
        }
      }

      // Find existing part by ID (check both the ID and generated IDs)
      const idx = existing.findIndex(p => {
        const existingId = p.id || `${p.type}-${messageId}-${existing.indexOf(p)}`;
        return existingId === partId || p.id === partId;
      });

      const prevPart = idx >= 0 ? existing[idx] : undefined;
      let nextPart: OpenCodePart = { ...(prevPart || {}), ...(part as OpenCodePart), id: partId };

      if (nextPart.type === 'text') {
        const prevText = (prevPart as OpenCodePart | undefined)?.type === 'text' ? (prevPart as any).text : '';
        const incomingText = (part as any).text;
        if (typeof incomingText === 'string' && incomingText.length > 0) {
          // Full text replacement - only if we have actual content
          (nextPart as any).text = incomingText;
        } else if (delta) {
          // Delta appending
          (nextPart as any).text = `${prevText || ''}${delta}`;
        } else if (prevText) {
          // Keep previous text if no new content
          (nextPart as any).text = prevText;
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
        // Use refs to prevent race conditions with API response
        realMessageIdRef.current = event.messageId;
        setMessages(prev => {
          // Find the placeholder by ID (more reliable than status check)
          const placeholderId = placeholderIdRef.current;
          if (placeholderId) {
            const idx = prev.findIndex(m => m.id === placeholderId);
            if (idx >= 0) {
              const updated = [...prev];
              updated[idx] = { ...updated[idx], id: event.messageId };
              return updated;
            }
          }
          // Fallback: find by status
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

  // WebSocket connection state for UI feedback
  const [wsConnected, setWsConnected] = useState(true);

  // Connect WebSocket when conversation changes
  useEffect(() => {
    if (!conversationId) return;

    // Close existing connection
    if (wsRef.current) {
      wsRef.current.close();
    }

    // Connect to stream with automatic reconnection
    const ws = api.connectStream(
      conversationId,
      (event) => handleStreamEventRef.current(event),
      {
        maxReconnectAttempts: 5,
        onConnectionChange: (connected) => {
          setWsConnected(connected);
          if (!connected) {
            console.log('[ConversationView] WebSocket disconnected, will attempt reconnection');
          }
        },
      }
    );
    wsRef.current = ws;

    return () => {
      ws.close();
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

    // Reset refs for new message
    placeholderIdRef.current = null;
    realMessageIdRef.current = null;

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
    const placeholderId = crypto.randomUUID();
    placeholderIdRef.current = placeholderId;
    const assistantPlaceholder: Message = {
      id: placeholderId,
      role: 'assistant',
      content: '',
      status: 'running',
      createdAt: new Date().toISOString(),
    };
    setMessages(prev => [...prev, assistantPlaceholder]);
    setRunningMessageId(placeholderId);

    try {
      // Send message - the actual response will come via WebSocket
      const { messageId } = await api.sendMessage(conversationId, prompt);

      // Only update if WebSocket hasn't already updated it
      // Check if the placeholder still has the original ID (WebSocket event may have updated it)
      if (messageId && !realMessageIdRef.current) {
        realMessageIdRef.current = messageId;
        setMessages(prev => prev.map(m =>
          m.id === placeholderId ? { ...m, id: messageId } : m
        ));
        setRunningMessageId(messageId);
      }
    } catch (err) {
      setError(formatErrorMessage(err instanceof Error ? err.message : 'Failed to send message'));
      // Remove placeholder on error
      const idToRemove = realMessageIdRef.current || placeholderId;
      setMessages(prev => prev.filter(m => m.id !== idToRemove && m.id !== placeholderId));
      setRunningMessageId(null);
      placeholderIdRef.current = null;
      realMessageIdRef.current = null;
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
        <div className="text-surface-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-surface-50">
      {/* Connection status banner */}
      {!wsConnected && (
        <div className="bg-status-warning/10 border-b border-status-warning/20 px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-status-warning animate-pulse" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            <span className="text-sm text-status-warning">Connection lost. Reconnecting...</span>
          </div>
          <button
            onClick={() => wsRef.current?.reconnect()}
            className="text-xs text-status-warning hover:text-yellow-700 underline"
          >
            Retry now
          </button>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="bg-status-error/10 border-b border-status-error/20 px-4 py-3">
          <p className="text-sm text-status-error">{error}</p>
        </div>
      )}

      {/* Conversation header */}
      {conversation && (
        <div className="bg-white border-b border-surface-200 px-4 py-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              <button
                onClick={() => navigate({ to: '/' })}
                className="text-surface-500 hover:text-surface-700"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <span className="font-medium text-surface-800 truncate max-w-md">
                {conversation.title || 'Untitled conversation'}
              </span>
              <span className="text-surface-400">•</span>
              <span className="text-surface-500">{conversation.workspace_name}</span>
            </div>
            <div className="flex items-center gap-2">
              {/* Latest deployment URL */}
              {deployments.length > 0 && deployments[deployments.length - 1].status === 'success' && (
                <a
                  href={deployments[deployments.length - 1].url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-accent-600 hover:text-accent-700 hover:underline truncate max-w-48"
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
                      ? 'bg-status-running/10 text-status-running'
                      : 'bg-accent-500 text-white hover:bg-accent-600 disabled:opacity-50'
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
                  showTimeline ? 'bg-accent-100 text-accent-600' : 'text-surface-400 hover:text-surface-600 hover:bg-surface-100'
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
        <div className="bg-gradient-to-r from-status-success to-emerald-600 text-white px-4 py-3 shadow-lg">
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
                className="px-4 py-2 bg-white text-status-success rounded-lg font-medium text-sm hover:bg-status-success/10 transition-colors flex items-center gap-2"
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
        <div ref={messagesContainerRef} className="flex-1 overflow-y-auto px-4 py-6">
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
          <div className="w-72 border-l border-surface-200 bg-white flex-shrink-0">
            <Timeline items={timeline} />
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="border-t border-surface-200 bg-white px-4 py-4">
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
      <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-accent-100 mb-4">
        <svg
          className="w-8 h-8 text-accent-600"
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
      <h3 className="text-lg font-medium text-surface-800 mb-2">Start a conversation</h3>
      <p className="text-surface-500 max-w-sm mx-auto">
        Describe what you want to build and the agent will help you create it.
      </p>
    </div>
  );
}

function formatErrorMessage(raw: string): string {
  if (!raw) return 'An unexpected error occurred';
  if (raw.includes('MAX_FILES') || raw.includes('max allowed') || raw.includes('file limit')) {
    const match = raw.match(/Workspace has (\d+) files; max allowed is (\d+)/);
    if (match) {
      const [, total, max] = match;
      return `This workspace has ${total} files, which exceeds the current limit (${max}). Remove files or contact support to increase the limit.`;
    }
    return 'This workspace exceeds the current file limit. Remove files or contact support to increase the limit.';
  }
  return raw;
}
