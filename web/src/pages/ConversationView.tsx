import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from '@tanstack/react-router';
import type { ConversationWithContext, TimelineItem } from '@fastest/shared';
import { api, type Message, type StreamEvent, type ReconnectingWebSocket } from '../api/client';
import type { OpenCodeEvent, OpenCodeGlobalEvent, OpenCodePart, OpenCodeQuestionRequest } from '../api/opencode';
import {
  ConversationMessage,
  PromptInput,
  Timeline,
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
      <div className="relative bg-white rounded-md shadow-xl max-w-md w-full mx-4 p-6">
        <h3 className="text-lg font-semibold text-surface-800 mb-2">{title}</h3>
        <p className="text-sm text-surface-600 mb-6">{message}</p>

        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium text-surface-700 bg-surface-100 hover:bg-surface-200 rounded-md transition-colors disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium text-white bg-status-error hover:bg-red-600 rounded-md transition-colors disabled:opacity-50 flex items-center gap-2"
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
        className="p-2 text-surface-500 hover:text-surface-700 hover:bg-surface-100 rounded-md transition-colors disabled:opacity-50"
        title="Conversation actions"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute top-full right-0 mt-1 w-48 bg-white border border-surface-200 rounded-md shadow-lg z-50 py-1">
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

  // Context data
  const [currentWorkspace, setCurrentWorkspace] = useState<{ id: string; name: string } | null>(null);
  const [currentProject, setCurrentProject] = useState<{ id: string; name: string; mainWorkspaceId: string | null } | null>(null);

  // Branching state
  const [isBranching, setIsBranching] = useState(false);
  const [branchPopoverOpen, setBranchPopoverOpen] = useState(false);
  const [branchName, setBranchName] = useState('');

  // Snapshot state
  const [isSavingSnapshot, setIsSavingSnapshot] = useState(false);
  const [snapshotSaved, setSnapshotSaved] = useState(false);

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
  // Track OpenCode assistant message IDs to filter out user message parts
  const assistantOpenCodeIdsRef = useRef<Set<string>>(new Set());

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

    // Track assistant message IDs from OpenCode
    if (payload.type === 'message.updated') {
      const info = payload.properties?.info as { role?: string; id?: string } | undefined;
      if (info?.role === 'assistant' && info?.id) {
        assistantOpenCodeIdsRef.current.add(info.id);
      }
    }

    if (payload.type === 'message.part.updated') {
      // Only store parts that belong to assistant messages
      const part = payload.properties?.part as { messageID?: string } | undefined;
      const partMessageId = part?.messageID;

      // Skip if this part belongs to a user message (not in our assistant IDs set)
      // Allow parts with no messageID or parts whose messageID is in the assistant set
      if (partMessageId && !assistantOpenCodeIdsRef.current.has(partMessageId)) {
        return;
      }

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
    assistantOpenCodeIdsRef.current.clear();

    try {
      // Load conversation details
      const { conversation: conv } = await api.getConversation(convId);
      setConversation(conv);

      // Load messages, timeline, and opencode messages in parallel
      const [messagesRes, timelineRes, openCodeRes] = await Promise.all([
        api.getMessages(convId),
        api.getTimeline(convId).catch(() => ({ timeline: [] })),
        api.getOpenCodeMessages(convId).catch(() => ({ messages: {} })),
      ]);

      setMessages(messagesRes.messages);
      setTimeline(timelineRes.timeline);
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

      // Store current workspace and project info
      setCurrentWorkspace({ id: conv.workspace_id, name: conv.workspace_name });

      // Fetch project details to get main_workspace_id
      try {
        const { project } = await api.getProject(conv.project_id);
        setCurrentProject({
          id: project.id,
          name: project.name,
          mainWorkspaceId: project.main_workspace_id
        });
      } catch (projErr) {
        console.error('Failed to load project:', projErr);
        // Still set basic project info from conversation
        setCurrentProject({ id: conv.project_id, name: conv.project_name, mainWorkspaceId: null });
      }
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

  const handleBranch = async (workspaceName: string) => {
    if (!currentProject || !currentWorkspace || !conversationId) return;

    setIsBranching(true);
    setError(null);

    try {
      // First, create a snapshot from the conversation's current state.
      // This captures any dirty files (modified but not yet in a snapshot).
      const { snapshot_id: currentSnapshotId } = await api.createConversationSnapshot(conversationId);

      // Create new workspace pointing to the current snapshot (includes dirty files)
      const { workspace: newWorkspace } = await api.createWorkspace(
        currentProject.id,
        workspaceName,
        currentSnapshotId || undefined
      );

      // Move current conversation to the new workspace
      await api.moveConversationToWorkspace(conversationId, newWorkspace.id);

      // Update local state - no navigation needed, we stay in the same conversation
      setCurrentWorkspace({ id: newWorkspace.id, name: newWorkspace.name });
      if (conversation) {
        setConversation({ ...conversation, workspace_id: newWorkspace.id, workspace_name: newWorkspace.name });
      }

      setBranchName('');
      setBranchPopoverOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace');
    } finally {
      setIsBranching(false);
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

  const handleSaveSnapshot = async () => {
    if (!conversationId || isSavingSnapshot) return;

    setIsSavingSnapshot(true);
    setError(null);

    try {
      const result = await api.createConversationSnapshot(conversationId, {
        generateSummary: true,
      });

      if (result.was_dirty) {
        // Show success indicator briefly
        setSnapshotSaved(true);
        setTimeout(() => setSnapshotSaved(false), 3000);
      } else {
        // No changes to save
        setError('No changes to save');
        setTimeout(() => setError(null), 3000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save snapshot');
    } finally {
      setIsSavingSnapshot(false);
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
              <span className="text-surface-500">{conversation.project_name}</span>
              <span className="text-surface-300">/</span>
              <span className="text-surface-500">{conversation.workspace_name}</span>

              {/* Branch button - only show when on main workspace */}
              {currentProject?.mainWorkspaceId === currentWorkspace?.id && (
                <div className="relative ml-1">
                  <button
                    onClick={() => setBranchPopoverOpen(!branchPopoverOpen)}
                    disabled={isBranching}
                    className="flex items-center gap-1 px-2 py-0.5 text-xs text-surface-500 hover:text-surface-700 hover:bg-surface-100 rounded-md transition-colors border border-surface-200"
                  >
                    {isBranching ? (
                      <>
                        <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        <span>Creating...</span>
                      </>
                    ) : (
                      <>
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                        </svg>
                        <span>Branch</span>
                      </>
                    )}
                  </button>

                  {/* Branch popover */}
                  {branchPopoverOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-10"
                        onClick={() => {
                          setBranchPopoverOpen(false);
                          setBranchName('');
                        }}
                      />
                      <div className="absolute left-0 top-full mt-1 z-20 w-72 p-3 bg-white rounded-md border border-surface-200 shadow-lg">
                        <div className="text-sm font-medium text-surface-800 mb-1">
                          Create workspace
                        </div>
                        <p className="text-xs text-surface-500 mb-3">
                          Files will be copied from the current state.
                        </p>
                        <input
                          type="text"
                          value={branchName}
                          onChange={(e) => setBranchName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && branchName.trim()) {
                              handleBranch(branchName.trim());
                            }
                            if (e.key === 'Escape') {
                              setBranchPopoverOpen(false);
                              setBranchName('');
                            }
                          }}
                          placeholder="feature-name"
                          className="input font-mono text-sm"
                          autoFocus
                        />
                        <div className="flex gap-2 mt-3">
                          <button
                            onClick={() => handleBranch(branchName.trim())}
                            disabled={!branchName.trim() || isBranching}
                            className="btn-primary flex-1 text-sm"
                          >
                            {isBranching ? 'Creating...' : 'Create'}
                          </button>
                          <button
                            onClick={() => {
                              setBranchPopoverOpen(false);
                              setBranchName('');
                            }}
                            className="btn-ghost text-sm"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              <span className="text-surface-300 mx-1">—</span>
              <span className="font-medium text-surface-800 truncate max-w-md">
                {conversation.title || 'Untitled conversation'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {/* Save snapshot button */}
              {messages.length > 0 && (
                <button
                  onClick={handleSaveSnapshot}
                  disabled={isSavingSnapshot || !!runningMessageId}
                  className={`h-7 px-3 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 ${
                    snapshotSaved
                      ? 'border border-status-success text-status-success'
                      : isSavingSnapshot
                      ? 'border border-status-running text-status-running'
                      : 'border border-surface-300 text-surface-600 hover:border-surface-400 hover:bg-surface-50 disabled:opacity-50'
                  }`}
                  title="Save a checkpoint of your current work"
                >
                  {isSavingSnapshot ? (
                    <>
                      <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Saving...
                    </>
                  ) : snapshotSaved ? (
                    <>
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      Saved
                    </>
                  ) : (
                    <>
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                      </svg>
                      Save snapshot
                    </>
                  )}
                </button>
              )}

              {/* Timeline toggle */}
              <button
                onClick={() => setShowTimeline(!showTimeline)}
                className={`h-7 w-7 flex items-center justify-center rounded-md transition-colors ${
                  showTimeline ? 'border border-accent-500 text-accent-600' : 'border border-surface-300 text-surface-400 hover:border-surface-400 hover:text-surface-600'
                }`}
                title={showTimeline ? 'Hide timeline' : 'Show timeline'}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>

              {/* Conversation actions menu */}
              <ConversationActionsMenu
                onClearConversation={() => setShowClearConfirm(true)}
                onNewConversation={handleNewConversation}
                disabled={!!runningMessageId}
              />
            </div>
          </div>
        </div>
      )}

      {/* Main content area with sidebar */}
      <div className="flex-1 flex overflow-hidden">
        {/* Conversation area */}
        <div className="flex-1 flex flex-col overflow-hidden">
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

          {/* Input area */}
          <div className="px-4 py-4">
            <div className="max-w-3xl mx-auto">
              <PromptInput
                onSubmit={handleSubmitPrompt}
                isRunning={!!runningMessageId}
                placeholder={
                  messages.length === 0 ? 'What do you want to build?' : 'Continue the conversation...'
                }
              />
            </div>
          </div>
        </div>

        {/* Timeline sidebar */}
        {showTimeline && (
          <div className="w-72 border-l border-surface-200 bg-white flex-shrink-0">
            <Timeline items={timeline} />
          </div>
        )}
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
