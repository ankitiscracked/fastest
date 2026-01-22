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
  Sparkles,
  Shield,
  ShieldAlert,
  ShieldCheck,
  X,
  Merge,
  Copy,
  Undo2,
} from 'lucide-react';
import type { Workspace, ConversationWithContext, DriftReport, DriftAnalysis, SyncPreview } from '@fastest/shared';
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

  // AI Analysis state
  const [analysis, setAnalysis] = useState<DriftAnalysis | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  // Sync state
  const [syncPreview, setSyncPreview] = useState<SyncPreview | null>(null);
  const [isPreparingSyn, setIsPreparingSync] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [syncResult, setSyncResult] = useState<{ success: boolean; filesAdded: number; filesUpdated: number } | null>(null);

  // Undo state
  interface UndoInfo {
    snapshotBeforeId: string;
    timestamp: number;
    filesAdded: number;
    filesUpdated: number;
  }
  const [undoInfo, setUndoInfo] = useState<UndoInfo | null>(null);
  const [isUndoing, setIsUndoing] = useState(false);

  // UI state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCreatingConversation, setIsCreatingConversation] = useState(false);
  const [isLoadingDrift, setIsLoadingDrift] = useState(false);
  const [expandedDriftSection, setExpandedDriftSection] = useState<string | null>(null);

  useEffect(() => {
    if (workspaceId) {
      loadWorkspace(workspaceId);
      loadUndoInfo(workspaceId);
    }
  }, [workspaceId]);

  const loadUndoInfo = (id: string) => {
    const undoKey = `sync_undo:${id}`;
    const stored = localStorage.getItem(undoKey);
    if (stored) {
      try {
        const info = JSON.parse(stored) as UndoInfo;
        // Only show undo if < 24 hours old
        const age = Date.now() - info.timestamp;
        const MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
        if (age < MAX_AGE) {
          setUndoInfo(info);
        } else {
          localStorage.removeItem(undoKey);
        }
      } catch {
        localStorage.removeItem(undoKey);
      }
    }
  };

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

  const loadDriftComparison = async (id: string, bypassCache = false) => {
    // Check cache first (5 minute TTL)
    const cacheKey = `drift_cache:${id}`;
    const cached = localStorage.getItem(cacheKey);

    if (!bypassCache && cached) {
      try {
        const { data, timestamp } = JSON.parse(cached);
        const age = Date.now() - timestamp;
        const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

        if (age < CACHE_TTL) {
          setDrift(data.drift);
          setIsMainWorkspace(data.is_main_workspace);
          setDriftMessage(data.message || null);
          return;
        }
      } catch {
        // Invalid cache, continue to fetch
      }
    }

    setIsLoadingDrift(true);
    try {
      const { drift: driftReport, is_main_workspace, message } = await api.getDriftComparison(id);
      setDrift(driftReport);
      setIsMainWorkspace(is_main_workspace);
      setDriftMessage(message || null);

      // Cache the result
      localStorage.setItem(cacheKey, JSON.stringify({
        data: { drift: driftReport, is_main_workspace, message },
        timestamp: Date.now(),
      }));
    } catch (err) {
      console.error('Failed to load drift comparison:', err);
      setDriftMessage('Failed to load drift comparison');
    } finally {
      setIsLoadingDrift(false);
    }
  };

  const handleRefreshDrift = () => {
    if (workspaceId) {
      setAnalysis(null); // Clear analysis when refreshing
      loadDriftComparison(workspaceId, true); // Bypass cache on manual refresh
    }
  };

  const handleAnalyzeDrift = async () => {
    if (!workspaceId) return;

    setIsAnalyzing(true);
    setAnalysisError(null);

    try {
      const { analysis: result, error: err } = await api.analyzeDrift(workspaceId);
      if (err) {
        setAnalysisError(err);
      } else {
        setAnalysis(result);
      }
    } catch (err) {
      console.error('Failed to analyze drift:', err);
      setAnalysisError(err instanceof Error ? err.message : 'Failed to analyze drift');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handlePrepareSync = async () => {
    if (!workspaceId) return;

    setIsPreparingSync(true);
    setSyncError(null);

    try {
      const { preview } = await api.prepareSync(workspaceId);
      setSyncPreview(preview);
      setShowSyncModal(true);
    } catch (err) {
      console.error('Failed to prepare sync:', err);
      setSyncError(err instanceof Error ? err.message : 'Failed to prepare sync');
    } finally {
      setIsPreparingSync(false);
    }
  };

  const handleExecuteSync = async (decisions: Record<string, string>) => {
    if (!workspaceId || !syncPreview) return;

    setIsSyncing(true);
    setSyncError(null);

    try {
      const result = await api.executeSync(workspaceId, syncPreview.id, decisions);

      if (result.success) {
        setSyncResult({
          success: true,
          filesAdded: result.files_added,
          filesUpdated: result.files_updated,
        });

        // Save undo info if we have a before snapshot
        if (result.snapshot_before_id) {
          const newUndoInfo: UndoInfo = {
            snapshotBeforeId: result.snapshot_before_id,
            timestamp: Date.now(),
            filesAdded: result.files_added,
            filesUpdated: result.files_updated,
          };
          localStorage.setItem(`sync_undo:${workspaceId}`, JSON.stringify(newUndoInfo));
          setUndoInfo(newUndoInfo);
        }

        // Invalidate drift cache since state changed
        localStorage.removeItem(`drift_cache:${workspaceId}`);

        // Close modal after brief delay to show success
        setTimeout(() => {
          setShowSyncModal(false);
          setSyncPreview(null);
          setSyncResult(null);
          // Refresh drift status (bypass cache)
          loadDriftComparison(workspaceId, true);
          // Clear analysis since state has changed
          setAnalysis(null);
        }, 1500);
      } else {
        setSyncError(`Sync completed with errors: ${result.errors.join(', ')}`);
      }
    } catch (err) {
      console.error('Failed to execute sync:', err);
      setSyncError(err instanceof Error ? err.message : 'Failed to execute sync');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleUndo = async () => {
    if (!workspaceId || !undoInfo) return;

    setIsUndoing(true);

    try {
      const result = await api.undoSync(workspaceId, undoInfo.snapshotBeforeId);

      if (result.success) {
        // Clear undo info
        localStorage.removeItem(`sync_undo:${workspaceId}`);
        setUndoInfo(null);

        // Invalidate drift cache
        localStorage.removeItem(`drift_cache:${workspaceId}`);

        // Refresh drift status
        loadDriftComparison(workspaceId, true);

        // Clear analysis
        setAnalysis(null);
      }
    } catch (err) {
      console.error('Failed to undo sync:', err);
      setSyncError(err instanceof Error ? err.message : 'Failed to undo sync');
    } finally {
      setIsUndoing(false);
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

                  {/* AI Analysis section */}
                  <div className="pt-4 border-t border-surface-200">
                    {!analysis && !isAnalyzing && !analysisError && (
                      <button
                        onClick={handleAnalyzeDrift}
                        className="flex items-center gap-2 px-4 py-2 bg-purple-500 text-white text-sm font-medium rounded-lg hover:bg-purple-600 transition-colors"
                      >
                        <Sparkles className="w-4 h-4" />
                        Analyze with AI
                      </button>
                    )}

                    {isAnalyzing && (
                      <div className="flex items-center gap-2 text-sm text-surface-600">
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        Analyzing drift with AI...
                      </div>
                    )}

                    {analysisError && (
                      <div className="space-y-2">
                        <div className="text-sm text-red-600">{analysisError}</div>
                        <button
                          onClick={handleAnalyzeDrift}
                          className="text-sm text-accent-600 hover:underline"
                        >
                          Try again
                        </button>
                      </div>
                    )}

                    {analysis && (
                      <div className="space-y-4">
                        {/* Risk level badge */}
                        <div className="flex items-center gap-3">
                          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-sm font-medium ${
                            analysis.risk_level === 'low'
                              ? 'bg-green-100 text-green-700'
                              : analysis.risk_level === 'medium'
                              ? 'bg-yellow-100 text-yellow-700'
                              : 'bg-red-100 text-red-700'
                          }`}>
                            {analysis.risk_level === 'low' ? (
                              <ShieldCheck className="w-4 h-4" />
                            ) : analysis.risk_level === 'medium' ? (
                              <Shield className="w-4 h-4" />
                            ) : (
                              <ShieldAlert className="w-4 h-4" />
                            )}
                            {analysis.risk_level.charAt(0).toUpperCase() + analysis.risk_level.slice(1)} Risk
                          </div>
                          {analysis.can_auto_sync && (
                            <span className="text-xs text-green-600 flex items-center gap-1">
                              <Check className="w-3 h-3" />
                              Safe to auto-sync
                            </span>
                          )}
                        </div>

                        {/* Summaries */}
                        <div className="grid grid-cols-2 gap-4">
                          <div className="p-3 bg-blue-50 rounded-lg">
                            <div className="text-xs font-medium text-blue-700 mb-1">Changes in Main</div>
                            <div className="text-sm text-surface-700">{analysis.main_changes_summary}</div>
                          </div>
                          <div className="p-3 bg-purple-50 rounded-lg">
                            <div className="text-xs font-medium text-purple-700 mb-1">Changes in Workspace</div>
                            <div className="text-sm text-surface-700">{analysis.workspace_changes_summary}</div>
                          </div>
                        </div>

                        {/* Recommendation */}
                        <div className="p-3 bg-surface-50 rounded-lg">
                          <div className="text-xs font-medium text-surface-500 mb-1">Recommendation</div>
                          <div className="text-sm text-surface-700">{analysis.recommendation}</div>
                        </div>

                        {/* Risk explanation if not low */}
                        {analysis.risk_level !== 'low' && analysis.risk_explanation && (
                          <div className="p-3 bg-yellow-50 rounded-lg">
                            <div className="text-xs font-medium text-yellow-700 mb-1">Risk Details</div>
                            <div className="text-sm text-surface-700">{analysis.risk_explanation}</div>
                          </div>
                        )}

                        {/* Re-analyze button */}
                        <button
                          onClick={handleAnalyzeDrift}
                          className="text-sm text-surface-500 hover:text-surface-700 flex items-center gap-1"
                        >
                          <RefreshCw className="w-3 h-3" />
                          Re-analyze
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Sync action */}
                  <div className="pt-4 border-t border-surface-200">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={handlePrepareSync}
                        disabled={isPreparingSyn}
                        className="flex items-center gap-2 px-4 py-2 bg-accent-500 text-white text-sm font-medium rounded-lg hover:bg-accent-600 disabled:opacity-50 transition-colors"
                      >
                        {isPreparingSyn ? (
                          <>
                            <RefreshCw className="w-4 h-4 animate-spin" />
                            Preparing...
                          </>
                        ) : (
                          <>
                            <GitBranch className="w-4 h-4" />
                            Sync with Main
                          </>
                        )}
                      </button>

                      {/* Undo button - shows when undo is available */}
                      {undoInfo && (
                        <button
                          onClick={handleUndo}
                          disabled={isUndoing}
                          className="flex items-center gap-2 px-4 py-2 bg-surface-100 text-surface-700 text-sm font-medium rounded-lg hover:bg-surface-200 disabled:opacity-50 transition-colors"
                          title={`Undo last sync (${undoInfo.filesAdded} added, ${undoInfo.filesUpdated} updated)`}
                        >
                          {isUndoing ? (
                            <>
                              <RefreshCw className="w-4 h-4 animate-spin" />
                              Undoing...
                            </>
                          ) : (
                            <>
                              <Undo2 className="w-4 h-4" />
                              Undo Sync
                            </>
                          )}
                        </button>
                      )}
                    </div>
                    {syncError && (
                      <p className="text-xs text-red-600 mt-2">{syncError}</p>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-sm text-green-600">
                    <Check className="w-4 h-4" />
                    This workspace is in sync with main
                  </div>

                  {/* Undo button when synced but undo available */}
                  {undoInfo && (
                    <button
                      onClick={handleUndo}
                      disabled={isUndoing}
                      className="flex items-center gap-2 px-3 py-1.5 bg-surface-100 text-surface-600 text-sm rounded-lg hover:bg-surface-200 disabled:opacity-50 transition-colors"
                      title={`Undo last sync (${undoInfo.filesAdded} added, ${undoInfo.filesUpdated} updated)`}
                    >
                      {isUndoing ? (
                        <>
                          <RefreshCw className="w-4 h-4 animate-spin" />
                          Undoing...
                        </>
                      ) : (
                        <>
                          <Undo2 className="w-4 h-4" />
                          Undo last sync
                        </>
                      )}
                    </button>
                  )}
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

      {/* Sync Preview Modal */}
      {showSyncModal && syncPreview && (
        <SyncPreviewModal
          preview={syncPreview}
          isSyncing={isSyncing}
          onClose={() => {
            if (!isSyncing) {
              setShowSyncModal(false);
              setSyncPreview(null);
              setSyncResult(null);
            }
          }}
          onSync={handleExecuteSync}
        />
      )}

      {/* Sync Success Toast */}
      {syncResult?.success && (
        <div className="fixed bottom-4 right-4 bg-green-600 text-white px-4 py-3 rounded-lg shadow-lg flex items-center gap-2 z-50">
          <Check className="w-5 h-5" />
          <span>Synced! {syncResult.filesAdded} added, {syncResult.filesUpdated} updated</span>
        </div>
      )}
    </div>
  );
}

// Sync Preview Modal Component
interface SyncPreviewModalProps {
  preview: SyncPreview;
  onClose: () => void;
  onSync: (decisions: Record<string, string>) => void;
  isSyncing: boolean;
}

function SyncPreviewModal({ preview, onClose, onSync, isSyncing }: SyncPreviewModalProps) {
  const [decisions, setDecisions] = useState<Record<string, string>>(() => {
    // Initialize with recommended options
    const initial: Record<string, string> = {};
    for (const decision of preview.decisions_needed) {
      if (decision.recommended_option_id) {
        initial[decision.path] = decision.recommended_option_id;
      }
    }
    return initial;
  });

  const copyActions = preview.auto_actions.filter(a => a.action === 'copy_from_main');
  const combineActions = preview.auto_actions.filter(a => a.action === 'ai_combined');
  const hasDecisions = preview.decisions_needed.length > 0;

  // Check if all required decisions are made
  const allDecisionsMade = preview.decisions_needed.every(d => decisions[d.path]);

  // Check if there's nothing to sync
  const isEmpty = preview.auto_actions.length === 0 && preview.decisions_needed.length === 0;

  const handleDecisionChange = (path: string, optionId: string) => {
    setDecisions(prev => ({ ...prev, [path]: optionId }));
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[80vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-200">
          <h2 className="text-lg font-semibold text-surface-800 flex items-center gap-2">
            <GitBranch className="w-5 h-5 text-accent-600" />
            {isEmpty ? 'Already Synced' : 'Ready to Sync'}
          </h2>
          <button
            onClick={onClose}
            disabled={isSyncing}
            className="p-1 text-surface-400 hover:text-surface-600 rounded-md hover:bg-surface-100 disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Summary */}
          <div className="p-4 bg-surface-50 rounded-lg">
            <p className="text-sm text-surface-700">{preview.summary}</p>
          </div>

          {isEmpty ? (
            <div className="text-center py-8">
              <Check className="w-12 h-12 text-green-500 mx-auto mb-3" />
              <p className="text-surface-600">Your workspace is already up to date with main.</p>
            </div>
          ) : (
            <>
              {/* Files to add from main */}
              {copyActions.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-surface-700 flex items-center gap-2">
                    <Copy className="w-4 h-4 text-blue-600" />
                    Files to add from main ({copyActions.length})
                  </h3>
                  <div className="bg-blue-50 rounded-lg p-3">
                    <ul className="space-y-1">
                      {copyActions.map(action => (
                        <li key={action.path} className="text-sm text-surface-700 flex items-center gap-2">
                          <FilePlus className="w-3.5 h-3.5 text-blue-600 flex-shrink-0" />
                          <span className="font-mono text-xs truncate">{action.path}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              {/* Files combined by AI */}
              {combineActions.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-surface-700 flex items-center gap-2">
                    <Merge className="w-4 h-4 text-purple-600" />
                    Files combined automatically ({combineActions.length})
                  </h3>
                  <div className="bg-purple-50 rounded-lg p-3">
                    <ul className="space-y-2">
                      {combineActions.map(action => (
                        <li key={action.path} className="text-sm">
                          <div className="flex items-center gap-2 text-surface-700">
                            <Sparkles className="w-3.5 h-3.5 text-purple-600 flex-shrink-0" />
                            <span className="font-mono text-xs truncate">{action.path}</span>
                          </div>
                          {action.description && (
                            <p className="text-xs text-surface-500 ml-5.5 mt-0.5">{action.description}</p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              {/* Decisions needed */}
              {hasDecisions && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-surface-700 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-yellow-600" />
                    Decisions needed ({preview.decisions_needed.length})
                  </h3>
                  <div className="space-y-4">
                    {preview.decisions_needed.map(decision => (
                      <div key={decision.path} className="bg-yellow-50 rounded-lg p-4">
                        <div className="font-mono text-xs text-surface-700 mb-3 font-medium">{decision.path}</div>

                        {/* Intent comparison */}
                        <div className="grid grid-cols-2 gap-2 text-xs mb-3">
                          <div className="p-2 bg-white/70 rounded">
                            <div className="font-medium text-blue-700 mb-1">Main:</div>
                            <div className="text-surface-600">{decision.main_intent}</div>
                          </div>
                          <div className="p-2 bg-white/70 rounded">
                            <div className="font-medium text-purple-700 mb-1">Yours:</div>
                            <div className="text-surface-600">{decision.workspace_intent}</div>
                          </div>
                        </div>

                        <div className="text-xs text-yellow-700 mb-3">
                          <span className="font-medium">Conflict:</span> {decision.conflict_reason}
                        </div>

                        {/* Decision options */}
                        <div className="space-y-2">
                          {decision.options.map(option => (
                            <label
                              key={option.id}
                              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                                decisions[decision.path] === option.id
                                  ? 'bg-accent-50 border-accent-300'
                                  : 'bg-white border-surface-200 hover:border-surface-300'
                              }`}
                            >
                              <input
                                type="radio"
                                name={`decision-${decision.path}`}
                                value={option.id}
                                checked={decisions[decision.path] === option.id}
                                onChange={() => handleDecisionChange(decision.path, option.id)}
                                className="mt-0.5 text-accent-500 focus:ring-accent-500"
                              />
                              <div className="flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium text-surface-800">{option.label}</span>
                                  {decision.recommended_option_id === option.id && (
                                    <span className="text-xs px-1.5 py-0.5 bg-green-100 text-green-700 rounded">
                                      Recommended
                                    </span>
                                  )}
                                </div>
                                {option.description && (
                                  <p className="text-xs text-surface-500 mt-0.5">{option.description}</p>
                                )}
                              </div>
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-surface-200 bg-surface-50">
          <div className="text-xs text-surface-500">
            {preview.files_to_add} to add • {preview.files_to_update} to update • {preview.files_unchanged} unchanged
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              disabled={isSyncing}
              className="px-4 py-2 text-sm font-medium text-surface-600 hover:text-surface-800 hover:bg-surface-100 rounded-lg transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            {!isEmpty && (
              <button
                onClick={() => onSync(decisions)}
                disabled={isSyncing || (hasDecisions && !allDecisionsMade)}
                className="flex items-center gap-2 px-4 py-2 bg-accent-500 text-white text-sm font-medium rounded-lg hover:bg-accent-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                title={hasDecisions && !allDecisionsMade ? 'Select an option for each conflict' : 'Apply sync'}
              >
                {isSyncing ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Syncing...
                  </>
                ) : (
                  <>
                    <Check className="w-4 h-4" />
                    Apply Sync
                  </>
                )}
              </button>
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
