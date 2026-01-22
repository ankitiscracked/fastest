import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from '@tanstack/react-router';
import {
  ArrowLeft,
  Plus,
  MessageSquare,
  Clock,
  GitBranch,
  AlertTriangle,
  FolderOpen,
  RefreshCw,
  Check,
  FileText,
  FilePlus,
  FileWarning,
} from 'lucide-react';
import type { Workspace, ConversationWithContext, DriftReport } from '@fastest/shared';
import { api } from '../api/client';

export function WorkspaceDetail() {
  const { workspaceId } = useParams({ strict: false }) as { workspaceId: string };
  const navigate = useNavigate();

  // Data state
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [conversations, setConversations] = useState<ConversationWithContext[]>([]);
  const [drift, setDrift] = useState<DriftReport | null>(null);
  const [isMainWorkspace, setIsMainWorkspace] = useState(false);
  const [driftMessage, setDriftMessage] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string>('');

  // UI state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCreatingConversation, setIsCreatingConversation] = useState(false);
  const [isLoadingDrift, setIsLoadingDrift] = useState(false);
  const [expandedDriftSection, setExpandedDriftSection] = useState<string | null>(null);

  useEffect(() => {
    if (workspaceId) {
      loadWorkspace(workspaceId);
    }
  }, [workspaceId]);

  const loadWorkspace = async (id: string) => {
    setLoading(true);
    setError(null);

    try {
      // Load workspace details
      const { workspace: ws } = await api.getWorkspace(id);
      setWorkspace(ws);

      // Load project info
      const { project } = await api.getProject(ws.project_id);
      setProjectName(project.name);

      // Load conversations for this workspace
      const { conversations: convs } = await api.listConversations({ limit: 50 });
      // Filter to only this workspace's conversations
      const workspaceConvs = convs.filter(c => c.workspace_id === id);
      setConversations(workspaceConvs);

      // Load drift comparison (sync with main)
      await loadDriftComparison(id);
    } catch (err) {
      console.error('Failed to load workspace:', err);
      setError(err instanceof Error ? err.message : 'Failed to load workspace');
    } finally {
      setLoading(false);
    }
  };

  const loadDriftComparison = async (id: string) => {
    setIsLoadingDrift(true);
    try {
      const { drift: driftReport, is_main_workspace, message } = await api.getDriftComparison(id);
      setDrift(driftReport);
      setIsMainWorkspace(is_main_workspace);
      setDriftMessage(message || null);
    } catch (err) {
      console.error('Failed to load drift comparison:', err);
      setDriftMessage('Failed to load drift comparison');
    } finally {
      setIsLoadingDrift(false);
    }
  };

  const handleRefreshDrift = () => {
    if (workspaceId) {
      loadDriftComparison(workspaceId);
    }
  };

  const handleCreateConversation = async () => {
    if (!workspaceId) return;

    setIsCreatingConversation(true);
    try {
      const { conversation } = await api.createConversation(workspaceId);
      navigate({ to: '/$conversationId', params: { conversationId: conversation.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create conversation');
    } finally {
      setIsCreatingConversation(false);
    }
  };

  const formatTimestamp = (dateStr: string): string => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString();
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-surface-500">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-600 mb-4">{error}</p>
          <button
            onClick={() => workspaceId && loadWorkspace(workspaceId)}
            className="text-accent-600 hover:underline"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!workspace) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-surface-500">Workspace not found</div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-surface-50">
      {/* Header */}
      <header className="flex-shrink-0 bg-white border-b border-surface-200 px-6 py-4">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate({ to: '/projects/$projectId', params: { projectId: workspace.project_id } })}
            className="p-1 text-surface-500 hover:text-surface-700 rounded-md hover:bg-surface-100"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <div className="flex items-center gap-2 text-sm text-surface-500">
              <Link
                to="/projects/$projectId"
                params={{ projectId: workspace.project_id }}
                className="hover:text-accent-600"
              >
                {projectName}
              </Link>
              <span>/</span>
            </div>
            <h1 className="text-xl font-semibold text-surface-800 flex items-center gap-2">
              {workspace.name}
              {workspace.name === 'main' && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                  prod
                </span>
              )}
            </h1>
          </div>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Overview cards */}
          <div className="grid grid-cols-3 gap-4">
            {/* Conversations count */}
            <div className="bg-white rounded-lg border border-surface-200 p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-accent-100 flex items-center justify-center">
                  <MessageSquare className="w-5 h-5 text-accent-600" />
                </div>
                <div>
                  <div className="text-2xl font-semibold text-surface-800">
                    {conversations.length}
                  </div>
                  <div className="text-sm text-surface-500">Conversations</div>
                </div>
              </div>
            </div>

            {/* Last active */}
            <div className="bg-white rounded-lg border border-surface-200 p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
                  <Clock className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <div className="text-lg font-semibold text-surface-800">
                    {workspace.last_seen_at
                      ? formatTimestamp(workspace.last_seen_at)
                      : 'Never'}
                  </div>
                  <div className="text-sm text-surface-500">Last active</div>
                </div>
              </div>
            </div>

            {/* Drift status */}
            <div className="bg-white rounded-lg border border-surface-200 p-4">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                  isMainWorkspace ? 'bg-blue-100' : drift && drift.total_drift_files > 0 ? 'bg-yellow-100' : 'bg-green-100'
                }`}>
                  {isMainWorkspace ? (
                    <GitBranch className="w-5 h-5 text-blue-600" />
                  ) : drift && drift.total_drift_files > 0 ? (
                    <AlertTriangle className="w-5 h-5 text-yellow-600" />
                  ) : (
                    <Check className="w-5 h-5 text-green-600" />
                  )}
                </div>
                <div>
                  <div className="text-lg font-semibold text-surface-800">
                    {isMainWorkspace
                      ? 'Main'
                      : isLoadingDrift
                      ? 'Checking...'
                      : drift && drift.total_drift_files > 0
                      ? `${drift.total_drift_files} differences`
                      : 'Synced'}
                  </div>
                  <div className="text-sm text-surface-500">
                    {isMainWorkspace ? 'Source of truth' : 'Sync status'}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Workspace info */}
          <div className="bg-white rounded-lg border border-surface-200 p-6">
            <h2 className="text-lg font-medium text-surface-800 mb-4">Details</h2>
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-surface-500">Workspace ID</dt>
                <dd className="font-mono text-surface-800 mt-1">{workspace.id}</dd>
              </div>
              <div>
                <dt className="text-surface-500">Created</dt>
                <dd className="text-surface-800 mt-1">
                  {new Date(workspace.created_at).toLocaleDateString()}
                </dd>
              </div>
              {workspace.local_path && (
                <div className="col-span-2">
                  <dt className="text-surface-500">Local path</dt>
                  <dd className="font-mono text-surface-800 mt-1 flex items-center gap-2">
                    <FolderOpen className="w-4 h-4 text-surface-400" />
                    {workspace.local_path}
                  </dd>
                </div>
              )}
              {workspace.machine_id && (
                <div>
                  <dt className="text-surface-500">Machine ID</dt>
                  <dd className="font-mono text-surface-800 mt-1 truncate">{workspace.machine_id}</dd>
                </div>
              )}
            </dl>
          </div>

          {/* Drift panel - Sync with main */}
          {!isMainWorkspace && (
            <div className={`bg-white rounded-lg border p-6 ${
              drift && drift.total_drift_files > 0 ? 'border-yellow-200' : 'border-surface-200'
            }`}>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-medium text-surface-800 flex items-center gap-2">
                  {drift && drift.total_drift_files > 0 ? (
                    <AlertTriangle className="w-5 h-5 text-yellow-600" />
                  ) : (
                    <Check className="w-5 h-5 text-green-600" />
                  )}
                  Sync with Main
                </h2>
                <button
                  onClick={handleRefreshDrift}
                  disabled={isLoadingDrift}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-surface-600 hover:text-surface-800 hover:bg-surface-100 rounded-md transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={`w-4 h-4 ${isLoadingDrift ? 'animate-spin' : ''}`} />
                  Refresh
                </button>
              </div>

              {isLoadingDrift ? (
                <div className="text-sm text-surface-500">Analyzing differences...</div>
              ) : driftMessage && !drift ? (
                <div className="text-sm text-surface-500">{driftMessage}</div>
              ) : drift && drift.total_drift_files > 0 ? (
                <div className="space-y-4">
                  <p className="text-sm text-surface-600">
                    This workspace has diverged from main. Review the differences below.
                  </p>

                  {/* Summary counts */}
                  <div className="flex gap-4 text-sm">
                    {drift.main_only.length > 0 && (
                      <div className="flex items-center gap-1.5 text-blue-600">
                        <FilePlus className="w-4 h-4" />
                        <span>{drift.main_only.length} new in main</span>
                      </div>
                    )}
                    {drift.both_different.length > 0 && (
                      <div className="flex items-center gap-1.5 text-yellow-600">
                        <FileWarning className="w-4 h-4" />
                        <span>{drift.both_different.length} modified</span>
                      </div>
                    )}
                    {drift.workspace_only.length > 0 && (
                      <div className="flex items-center gap-1.5 text-surface-500">
                        <FileText className="w-4 h-4" />
                        <span>{drift.workspace_only.length} only in workspace</span>
                      </div>
                    )}
                  </div>

                  {/* Expandable file lists */}
                  <div className="space-y-2">
                    {drift.main_only.length > 0 && (
                      <FileListSection
                        title="New in main"
                        description="Files added to main that you don't have"
                        files={drift.main_only}
                        icon={<FilePlus className="w-4 h-4 text-blue-600" />}
                        bgColor="bg-blue-50"
                        textColor="text-blue-700"
                        isExpanded={expandedDriftSection === 'main_only'}
                        onToggle={() => setExpandedDriftSection(expandedDriftSection === 'main_only' ? null : 'main_only')}
                      />
                    )}
                    {drift.both_different.length > 0 && (
                      <FileListSection
                        title="Modified"
                        description="Files that differ between workspace and main"
                        files={drift.both_different}
                        icon={<FileWarning className="w-4 h-4 text-yellow-600" />}
                        bgColor="bg-yellow-50"
                        textColor="text-yellow-700"
                        isExpanded={expandedDriftSection === 'both_different'}
                        onToggle={() => setExpandedDriftSection(expandedDriftSection === 'both_different' ? null : 'both_different')}
                      />
                    )}
                    {drift.workspace_only.length > 0 && (
                      <FileListSection
                        title="Only in workspace"
                        description="Files you have that aren't in main"
                        files={drift.workspace_only}
                        icon={<FileText className="w-4 h-4 text-surface-500" />}
                        bgColor="bg-surface-50"
                        textColor="text-surface-600"
                        isExpanded={expandedDriftSection === 'workspace_only'}
                        onToggle={() => setExpandedDriftSection(expandedDriftSection === 'workspace_only' ? null : 'workspace_only')}
                      />
                    )}
                  </div>

                  {/* Sync action - placeholder for Phase 3+ */}
                  <div className="pt-4 border-t border-surface-200">
                    <button
                      disabled
                      className="flex items-center gap-2 px-4 py-2 bg-accent-500 text-white text-sm font-medium rounded-lg opacity-50 cursor-not-allowed"
                      title="Coming soon in a future update"
                    >
                      <GitBranch className="w-4 h-4" />
                      Sync with Main
                    </button>
                    <p className="text-xs text-surface-400 mt-2">
                      Sync functionality coming soon
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm text-green-600">
                  <Check className="w-4 h-4" />
                  This workspace is in sync with main
                </div>
              )}
            </div>
          )}

          {/* Main workspace indicator */}
          {isMainWorkspace && (
            <div className="bg-white rounded-lg border border-blue-200 p-6">
              <h2 className="text-lg font-medium text-surface-800 flex items-center gap-2 mb-2">
                <GitBranch className="w-5 h-5 text-blue-600" />
                Main Workspace
              </h2>
              <p className="text-sm text-surface-600">
                This is the main workspace for this project. Other workspaces sync against this one.
              </p>
            </div>
          )}

          {/* Conversations */}
          <div className="bg-white rounded-lg border border-surface-200">
            <div className="px-6 py-4 border-b border-surface-200 flex items-center justify-between">
              <h2 className="text-lg font-medium text-surface-800">Conversations</h2>
              <button
                onClick={handleCreateConversation}
                disabled={isCreatingConversation}
                className="flex items-center gap-2 px-3 py-1.5 bg-accent-500 text-white text-sm font-medium rounded-lg hover:bg-accent-600 disabled:opacity-50"
              >
                <Plus className="w-4 h-4" />
                {isCreatingConversation ? 'Creating...' : 'New Conversation'}
              </button>
            </div>

            {conversations.length === 0 ? (
              <div className="px-6 py-12 text-center">
                <MessageSquare className="w-12 h-12 text-surface-300 mx-auto mb-3" />
                <p className="text-surface-500 mb-4">No conversations yet</p>
                <button
                  onClick={handleCreateConversation}
                  disabled={isCreatingConversation}
                  className="text-accent-600 hover:underline"
                >
                  Start a new conversation
                </button>
              </div>
            ) : (
              <div className="divide-y divide-surface-100">
                {conversations.map(conv => (
                  <Link
                    key={conv.id}
                    to="/$conversationId"
                    params={{ conversationId: conv.id }}
                    className="flex items-center justify-between px-6 py-4 hover:bg-surface-50 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-surface-800 truncate">
                        {conv.title || 'Untitled conversation'}
                      </div>
                      {conv.last_message_preview && (
                        <p className="text-sm text-surface-500 truncate mt-0.5">
                          {conv.last_message_preview}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-4 ml-4">
                      {conv.message_count !== undefined && (
                        <span className="text-xs text-surface-400">
                          {conv.message_count} messages
                        </span>
                      )}
                      <span className="text-xs text-surface-400">
                        {formatTimestamp(conv.updated_at)}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// File list section component for drift panel
interface FileListSectionProps {
  title: string;
  description: string;
  files: string[];
  icon: React.ReactNode;
  bgColor: string;
  textColor: string;
  isExpanded: boolean;
  onToggle: () => void;
}

function FileListSection({
  title,
  description,
  files,
  icon,
  bgColor,
  textColor,
  isExpanded,
  onToggle,
}: FileListSectionProps) {
  const displayFiles = isExpanded ? files : files.slice(0, 3);
  const hasMore = files.length > 3;

  return (
    <div className={`rounded-lg ${bgColor}`}>
      <button
        onClick={onToggle}
        className={`w-full flex items-center justify-between px-3 py-2 text-sm font-medium ${textColor}`}
      >
        <div className="flex items-center gap-2">
          {icon}
          <span>{title}</span>
          <span className="text-xs opacity-70">({files.length})</span>
        </div>
        <span className="text-xs opacity-70">
          {isExpanded ? 'Collapse' : 'Expand'}
        </span>
      </button>
      {(isExpanded || files.length <= 3) && (
        <div className="px-3 pb-3">
          <p className="text-xs text-surface-500 mb-2">{description}</p>
          <ul className="space-y-1">
            {displayFiles.map((file) => (
              <li key={file} className="text-xs font-mono text-surface-700 truncate" title={file}>
                {file}
              </li>
            ))}
            {!isExpanded && hasMore && (
              <li className="text-xs text-surface-400">
                +{files.length - 3} more files...
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
