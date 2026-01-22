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
  const [projectName, setProjectName] = useState<string>('');

  // UI state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCreatingConversation, setIsCreatingConversation] = useState(false);

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
      const { workspace: ws, drift: driftReport } = await api.getWorkspace(id);
      setWorkspace(ws);
      setDrift(driftReport);

      // Load project info
      const { project } = await api.getProject(ws.project_id);
      setProjectName(project.name);

      // Load conversations for this workspace
      const { conversations: convs } = await api.listConversations({ limit: 50 });
      // Filter to only this workspace's conversations
      const workspaceConvs = convs.filter(c => c.workspace_id === id);
      setConversations(workspaceConvs);
    } catch (err) {
      console.error('Failed to load workspace:', err);
      setError(err instanceof Error ? err.message : 'Failed to load workspace');
    } finally {
      setLoading(false);
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
        <div className="text-gray-500">Loading...</div>
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
            className="text-primary-600 hover:underline"
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
        <div className="text-gray-500">Workspace not found</div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* Header */}
      <header className="flex-shrink-0 bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate({ to: '/projects/$projectId', params: { projectId: workspace.project_id } })}
            className="p-1 text-gray-500 hover:text-gray-700 rounded-md hover:bg-gray-100"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <Link
                to="/projects/$projectId"
                params={{ projectId: workspace.project_id }}
                className="hover:text-primary-600"
              >
                {projectName}
              </Link>
              <span>/</span>
            </div>
            <h1 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
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
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-primary-100 flex items-center justify-center">
                  <MessageSquare className="w-5 h-5 text-primary-600" />
                </div>
                <div>
                  <div className="text-2xl font-semibold text-gray-900">
                    {conversations.length}
                  </div>
                  <div className="text-sm text-gray-500">Conversations</div>
                </div>
              </div>
            </div>

            {/* Last active */}
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
                  <Clock className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <div className="text-lg font-semibold text-gray-900">
                    {workspace.last_seen_at
                      ? formatTimestamp(workspace.last_seen_at)
                      : 'Never'}
                  </div>
                  <div className="text-sm text-gray-500">Last active</div>
                </div>
              </div>
            </div>

            {/* Drift status */}
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                  drift ? 'bg-yellow-100' : 'bg-green-100'
                }`}>
                  {drift ? (
                    <AlertTriangle className="w-5 h-5 text-yellow-600" />
                  ) : (
                    <GitBranch className="w-5 h-5 text-green-600" />
                  )}
                </div>
                <div>
                  <div className="text-lg font-semibold text-gray-900">
                    {drift ? `${drift.files_added + drift.files_modified + drift.files_deleted} changes` : 'Synced'}
                  </div>
                  <div className="text-sm text-gray-500">Drift status</div>
                </div>
              </div>
            </div>
          </div>

          {/* Workspace info */}
          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <h2 className="text-lg font-medium text-gray-900 mb-4">Details</h2>
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-gray-500">Workspace ID</dt>
                <dd className="font-mono text-gray-900 mt-1">{workspace.id}</dd>
              </div>
              <div>
                <dt className="text-gray-500">Created</dt>
                <dd className="text-gray-900 mt-1">
                  {new Date(workspace.created_at).toLocaleDateString()}
                </dd>
              </div>
              {workspace.local_path && (
                <div className="col-span-2">
                  <dt className="text-gray-500">Local path</dt>
                  <dd className="font-mono text-gray-900 mt-1 flex items-center gap-2">
                    <FolderOpen className="w-4 h-4 text-gray-400" />
                    {workspace.local_path}
                  </dd>
                </div>
              )}
              {workspace.machine_id && (
                <div>
                  <dt className="text-gray-500">Machine ID</dt>
                  <dd className="font-mono text-gray-900 mt-1 truncate">{workspace.machine_id}</dd>
                </div>
              )}
            </dl>
          </div>

          {/* Drift report */}
          {drift && (drift.files_added + drift.files_modified + drift.files_deleted > 0) && (
            <div className="bg-white rounded-lg border border-yellow-200 p-6">
              <h2 className="text-lg font-medium text-gray-900 mb-4 flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-yellow-600" />
                Drift Report
              </h2>
              <p className="text-sm text-gray-600 mb-4">
                The local workspace has diverged from the last snapshot.
              </p>
              <div className="space-y-2 text-sm">
                {drift.files_added > 0 && (
                  <div className="flex items-center gap-2 text-green-700 bg-green-50 px-3 py-2 rounded">
                    <span className="font-medium">+{drift.files_added}</span> files added
                  </div>
                )}
                {drift.files_modified > 0 && (
                  <div className="flex items-center gap-2 text-yellow-700 bg-yellow-50 px-3 py-2 rounded">
                    <span className="font-medium">~{drift.files_modified}</span> files modified
                  </div>
                )}
                {drift.files_deleted > 0 && (
                  <div className="flex items-center gap-2 text-red-700 bg-red-50 px-3 py-2 rounded">
                    <span className="font-medium">-{drift.files_deleted}</span> files deleted
                  </div>
                )}
                {drift.summary && (
                  <p className="text-gray-600 mt-3">{drift.summary}</p>
                )}
              </div>
            </div>
          )}

          {/* Conversations */}
          <div className="bg-white rounded-lg border border-gray-200">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h2 className="text-lg font-medium text-gray-900">Conversations</h2>
              <button
                onClick={handleCreateConversation}
                disabled={isCreatingConversation}
                className="flex items-center gap-2 px-3 py-1.5 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 disabled:opacity-50"
              >
                <Plus className="w-4 h-4" />
                {isCreatingConversation ? 'Creating...' : 'New Conversation'}
              </button>
            </div>

            {conversations.length === 0 ? (
              <div className="px-6 py-12 text-center">
                <MessageSquare className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                <p className="text-gray-500 mb-4">No conversations yet</p>
                <button
                  onClick={handleCreateConversation}
                  disabled={isCreatingConversation}
                  className="text-primary-600 hover:underline"
                >
                  Start a new conversation
                </button>
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {conversations.map(conv => (
                  <Link
                    key={conv.id}
                    to="/$conversationId"
                    params={{ conversationId: conv.id }}
                    className="flex items-center justify-between px-6 py-4 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-gray-900 truncate">
                        {conv.title || 'Untitled conversation'}
                      </div>
                      {conv.last_message_preview && (
                        <p className="text-sm text-gray-500 truncate mt-0.5">
                          {conv.last_message_preview}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-4 ml-4">
                      {conv.message_count !== undefined && (
                        <span className="text-xs text-gray-400">
                          {conv.message_count} messages
                        </span>
                      )}
                      <span className="text-xs text-gray-400">
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
