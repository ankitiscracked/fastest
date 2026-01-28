import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from '@tanstack/react-router';
import {
  ArrowLeft,
  Plus,
  MessageSquare,
  GitBranch,
  AlertTriangle,
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
  History,
  Rocket,
  ExternalLink,
  Settings2,
} from 'lucide-react';
import type { Workspace, ConversationWithContext, DriftReport, DriftAnalysis, SyncPreview, DeploymentLogEntry } from '@fastest/shared';
import { api } from '../api/client';
import { DeploymentLogs } from '../components/conversation';

export function WorkspaceDetail() {
  const { workspaceId } = useParams({ strict: false }) as { workspaceId: string };
  const navigate = useNavigate();

  // Data state
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [conversations, setConversations] = useState<ConversationWithContext[]>([]);
  const [drift, setDrift] = useState<DriftReport | null>(null);
  const [isMainWorkspace, setIsMainWorkspace] = useState(false);
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

  // Snapshot history state
  interface Snapshot {
    id: string;
    project_id: string;
    manifest_hash: string;
    parent_snapshot_id: string | null;
    source: string;
    summary: string | null;
    created_at: string;
    is_current: boolean;
  }
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [isLoadingSnapshots, setIsLoadingSnapshots] = useState(false);

  // Tab state
  const [activeTab, setActiveTab] = useState<'conversations' | 'snapshots'>('conversations');

  // Deploy state
  const [isDeploying, setIsDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [currentDeployment, setCurrentDeployment] = useState<{
    id: string;
    conversationId: string;
    status: 'deploying' | 'success' | 'failed';
    url?: string;
  } | null>(null);
  const [deploymentLogs, setDeploymentLogs] = useState<DeploymentLogEntry[]>([]);
  const [showDeploymentLogs, setShowDeploymentLogs] = useState(false);
  const [latestDeploymentUrl, setLatestDeploymentUrl] = useState<string | null>(null);
  const deploymentPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

      // Load snapshot history
      await loadSnapshots(id);
    } catch (err) {
      console.error('Failed to load workspace:', err);
      setError(err instanceof Error ? err.message : 'Failed to load workspace');
    } finally {
      setLoading(false);
    }
  };

  const loadSnapshots = async (id: string) => {
    setIsLoadingSnapshots(true);
    try {
      const { snapshots: snaps } = await api.getWorkspaceSnapshots(id, { limit: 20 });
      setSnapshots(snaps);
    } catch (err) {
      console.error('Failed to load snapshots:', err);
      // Don't show error for snapshots, just log it
    } finally {
      setIsLoadingSnapshots(false);
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
          return;
        }
      } catch {
        // Invalid cache, continue to fetch
      }
    }

    setIsLoadingDrift(true);
    try {
      const { drift: driftReport, is_main_workspace } = await api.getDriftComparison(id);
      setDrift(driftReport);
      setIsMainWorkspace(is_main_workspace);

      // Cache the result
      localStorage.setItem(cacheKey, JSON.stringify({
        data: { drift: driftReport, is_main_workspace },
        timestamp: Date.now(),
      }));
    } catch (err) {
      console.error('Failed to load drift comparison:', err);
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

  const handleDeploy = async () => {
    if (!workspaceId || isDeploying) return;

    // Check if there are any snapshots
    if (snapshots.length === 0) {
      setDeployError('No snapshots found. Save a snapshot before deploying.');
      return;
    }

    setIsDeploying(true);
    setDeployError(null);
    setDeploymentLogs([]);

    try {
      const result = await api.deployWorkspace(workspaceId);

      // Track the deployment
      setCurrentDeployment({
        id: result.deploymentId,
        conversationId: result.conversation_id,
        status: 'deploying',
      });
      setShowDeploymentLogs(true);

      // Start polling for deployment logs
      startDeploymentPolling(result.conversation_id, result.deploymentId);
    } catch (err) {
      console.error('Failed to deploy:', err);
      setDeployError(err instanceof Error ? err.message : 'Failed to start deployment');
      setIsDeploying(false);
    }
  };

  const startDeploymentPolling = (conversationId: string, deploymentId: string) => {
    // Clear any existing poll
    if (deploymentPollRef.current) {
      clearInterval(deploymentPollRef.current);
    }

    const pollDeployment = async () => {
      try {
        // Fetch both deployments (for status) and logs (for entries) in parallel
        const [deploymentsRes, logsRes] = await Promise.all([
          api.getDeployments(conversationId),
          api.getDeploymentLogs(conversationId, deploymentId).catch(() => ({ log: null })),
        ]);

        // Update logs
        if (logsRes.log) {
          setDeploymentLogs(logsRes.log.entries || []);
        }

        // Find this deployment and check status
        const deployment = deploymentsRes.deployments.find(d => d.id === deploymentId);
        if (deployment) {
          // Check if deployment is complete
          if (deployment.status === 'success' || deployment.status === 'failed') {
            setIsDeploying(false);
            setCurrentDeployment(prev => prev ? {
              ...prev,
              status: deployment.status as 'success' | 'failed',
              url: deployment.url,
            } : null);

            if (deployment.status === 'success' && deployment.url) {
              setLatestDeploymentUrl(deployment.url);
            }

            // Stop polling
            if (deploymentPollRef.current) {
              clearInterval(deploymentPollRef.current);
              deploymentPollRef.current = null;
            }
          }
        }
      } catch (err) {
        console.error('Failed to fetch deployment status:', err);
      }
    };

    // Poll immediately and then every 2 seconds
    pollDeployment();
    deploymentPollRef.current = setInterval(pollDeployment, 2000);
  };

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (deploymentPollRef.current) {
        clearInterval(deploymentPollRef.current);
      }
    };
  }, []);

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
        <div className="flex items-center justify-between">
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
                {isMainWorkspace && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                    main
                  </span>
                )}
              </h1>
            </div>
          </div>

          {/* Header right: metadata + actions */}
          <div className="flex items-center gap-6">
            {/* Metadata */}
            <div className="flex items-center gap-4 text-xs text-surface-500">
              <span title="Created">
                Created {new Date(workspace.created_at).toLocaleDateString()}
              </span>
              <span className="text-surface-300">•</span>
              <span title="Last active">
                {workspace.last_seen_at ? `Active ${formatTimestamp(workspace.last_seen_at)}` : 'Never active'}
              </span>
              <span className="text-surface-300">•</span>
              <span className="font-mono" title="Workspace ID">
                {workspace.id.slice(0, 8)}
              </span>
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-2">
              {/* Sync with Main button (for branch workspaces) */}
              {!isMainWorkspace && (
                <button
                  onClick={handlePrepareSync}
                  disabled={isPreparingSyn || isLoadingDrift}
                  className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                    drift && drift.total_drift_files > 0
                      ? 'bg-accent-500 text-white hover:bg-accent-600'
                      : 'border border-surface-300 text-surface-600 hover:bg-surface-50'
                  } disabled:opacity-50`}
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
                      {drift && drift.total_drift_files > 0 && (
                        <span className="ml-1 px-1.5 py-0.5 bg-white/20 rounded text-xs">
                          {drift.total_drift_files}
                        </span>
                      )}
                    </>
                  )}
                </button>
              )}

              {/* Latest deployment URL */}
              {latestDeploymentUrl && (
                <a
                  href={latestDeploymentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-xs text-accent-600 hover:text-accent-700 hover:underline truncate max-w-48"
                  title={latestDeploymentUrl}
                >
                  <ExternalLink className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="truncate">{latestDeploymentUrl.replace(/^https?:\/\//, '')}</span>
                </a>
              )}

              {/* Deploy button */}
              <button
                onClick={handleDeploy}
                disabled={isDeploying || snapshots.length === 0}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md border border-surface-300 text-surface-600 hover:bg-surface-50 disabled:opacity-50 transition-colors"
                title={snapshots.length === 0 ? 'Save a snapshot before deploying' : 'Deploy from latest snapshot'}
              >
                {isDeploying ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Deploying...
                  </>
                ) : (
                  <>
                    <Rocket className="w-4 h-4" />
                    Deploy
                  </>
                )}
              </button>

              <Link
                to="/workspaces/$workspaceId/deployments"
                params={{ workspaceId }}
                className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md border border-surface-300 text-surface-600 hover:bg-surface-50 transition-colors"
                title="View deployment history"
              >
                <History className="w-4 h-4" />
                History
              </Link>

              <Link
                to="/workspaces/$workspaceId/deployment-settings"
                params={{ workspaceId }}
                className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md border border-surface-300 text-surface-600 hover:bg-surface-50 transition-colors"
                title="Deployment settings"
              >
                <Settings2 className="w-4 h-4" />
                Settings
              </Link>

              {/* View logs button (when deployment exists) */}
              {currentDeployment && (
                <button
                  onClick={() => setShowDeploymentLogs(true)}
                  className="p-2 text-surface-500 hover:text-surface-700 hover:bg-surface-100 rounded-md transition-colors"
                  title="View deployment logs"
                >
                  <FileText className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Overview */}
          <div className="bg-white rounded-md border border-surface-200 p-6">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <h2 className="text-sm font-medium text-surface-500 mb-1">Overview</h2>
                {isMainWorkspace ? (
                  <p className="text-surface-700">
                    This is the main workspace for this project. All other workspaces sync against this one.
                  </p>
                ) : (
                  <p className="text-surface-700">
                    {drift && drift.total_drift_files > 0 ? (
                      <>
                        This workspace has <span className="font-medium">{drift.total_drift_files} file{drift.total_drift_files !== 1 ? 's' : ''}</span> different from the source workspace.
                        {drift.source_only.length > 0 && ` ${drift.source_only.length} new in source.`}
                        {drift.both_different.length > 0 && ` ${drift.both_different.length} modified.`}
                        {drift.workspace_only.length > 0 && ` ${drift.workspace_only.length} only here.`}
                      </>
                    ) : isLoadingDrift ? (
                      'Checking for differences from main...'
                    ) : (
                      'This workspace is in sync with main.'
                    )}
                  </p>
                )}
              </div>
              {!isMainWorkspace && (
                <button
                  onClick={handleRefreshDrift}
                  disabled={isLoadingDrift}
                  className="p-1.5 text-surface-400 hover:text-surface-600 hover:bg-surface-100 rounded-md transition-colors disabled:opacity-50"
                  title="Refresh"
                >
                  <RefreshCw className={`w-4 h-4 ${isLoadingDrift ? 'animate-spin' : ''}`} />
                </button>
              )}
            </div>

            {/* Undo sync option */}
            {undoInfo && (
              <div className="mt-4 pt-4 border-t border-surface-100 flex items-center justify-between">
                <span className="text-sm text-surface-500">
                  Last sync: {undoInfo.filesAdded} added, {undoInfo.filesUpdated} updated
                </span>
                <button
                  onClick={handleUndo}
                  disabled={isUndoing}
                  className="flex items-center gap-1.5 text-sm text-surface-600 hover:text-surface-800"
                >
                  {isUndoing ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Undo2 className="w-3.5 h-3.5" />
                  )}
                  Undo sync
                </button>
              </div>
            )}
          </div>

          {/* Differences from Source (for branch workspaces with differences) */}
          {!isMainWorkspace && drift && drift.total_drift_files > 0 && (
            <div className="bg-white rounded-md border border-yellow-200 p-6">
              <h2 className="text-lg font-medium text-surface-800 flex items-center gap-2 mb-4">
                <AlertTriangle className="w-5 h-5 text-yellow-600" />
                Differences from Source
              </h2>

              {/* Summary counts */}
              <div className="flex gap-4 text-sm mb-4">
                {drift.source_only.length > 0 && (
                  <div className="flex items-center gap-1.5 text-blue-600">
                    <FilePlus className="w-4 h-4" />
                    <span>{drift.source_only.length} new in source</span>
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
                    <span>{drift.workspace_only.length} only here</span>
                  </div>
                )}
              </div>

              {/* Expandable file lists */}
              <div className="space-y-2">
                {drift.source_only.length > 0 && (
                  <FileListSection
                    title="New in source"
                    description="Files added to the source workspace that you don't have"
                    files={drift.source_only}
                    icon={<FilePlus className="w-4 h-4 text-blue-600" />}
                    bgColor="bg-blue-50"
                    textColor="text-blue-700"
                    isExpanded={expandedDriftSection === 'source_only'}
                    onToggle={() => setExpandedDriftSection(expandedDriftSection === 'source_only' ? null : 'source_only')}
                  />
                )}
                {drift.both_different.length > 0 && (
                  <FileListSection
                    title="Modified"
                    description="Files that differ between workspace and source"
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
                    description="Files you have that aren't in source"
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
              <div className="pt-4 mt-4 border-t border-surface-200">
                {!analysis && !isAnalyzing && !analysisError && (
                  <button
                    onClick={handleAnalyzeDrift}
                    className="flex items-center gap-2 px-4 py-2 bg-purple-500 text-white text-sm font-medium rounded-md hover:bg-purple-600 transition-colors"
                  >
                    <Sparkles className="w-4 h-4" />
                    Analyze with AI
                  </button>
                )}

                {isAnalyzing && (
                  <div className="flex items-center gap-2 text-sm text-surface-600">
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Analyzing differences...
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
                      <div className="p-3 bg-blue-50 rounded-md">
                        <div className="text-xs font-medium text-blue-700 mb-1">Changes in Main</div>
                      <div className="text-sm text-surface-700">{analysis.source_changes_summary}</div>
                      </div>
                      <div className="p-3 bg-purple-50 rounded-md">
                        <div className="text-xs font-medium text-purple-700 mb-1">Changes in Workspace</div>
                        <div className="text-sm text-surface-700">{analysis.workspace_changes_summary}</div>
                      </div>
                    </div>

                    {/* Recommendation */}
                    <div className="p-3 bg-surface-50 rounded-md">
                      <div className="text-xs font-medium text-surface-500 mb-1">Recommendation</div>
                      <div className="text-sm text-surface-700">{analysis.recommendation}</div>
                    </div>

                    {/* Risk explanation if not low */}
                    {analysis.risk_level !== 'low' && analysis.risk_explanation && (
                      <div className="p-3 bg-yellow-50 rounded-md">
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

              {syncError && (
                <p className="text-xs text-red-600 mt-4">{syncError}</p>
              )}
            </div>
          )}

          {/* Deploy error */}
          {deployError && (
            <div className="bg-red-50 border border-red-200 rounded-md p-4">
              <p className="text-sm text-red-700">{deployError}</p>
              <button
                onClick={() => setDeployError(null)}
                className="text-xs text-red-600 hover:text-red-800 mt-2"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Tabs: Conversations | Snapshots */}
          <div className="bg-white rounded-md border border-surface-200">
            {/* Tab headers */}
            <div className="flex border-b border-surface-200">
              <button
                onClick={() => setActiveTab('conversations')}
                className={`flex-1 px-6 py-3 text-sm font-medium transition-colors relative ${
                  activeTab === 'conversations'
                    ? 'text-surface-800'
                    : 'text-surface-500 hover:text-surface-700'
                }`}
              >
                <span className="flex items-center justify-center gap-2">
                  <MessageSquare className="w-4 h-4" />
                  Conversations
                  <span className={`px-1.5 py-0.5 rounded text-xs ${
                    activeTab === 'conversations' ? 'bg-surface-200 text-surface-700' : 'bg-surface-100 text-surface-500'
                  }`}>
                    {conversations.length}
                  </span>
                </span>
                {activeTab === 'conversations' && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-surface-400" />
                )}
              </button>
              <button
                onClick={() => setActiveTab('snapshots')}
                className={`flex-1 px-6 py-3 text-sm font-medium transition-colors relative ${
                  activeTab === 'snapshots'
                    ? 'text-surface-800'
                    : 'text-surface-500 hover:text-surface-700'
                }`}
              >
                <span className="flex items-center justify-center gap-2">
                  <History className="w-4 h-4" />
                  Snapshots
                  <span className={`px-1.5 py-0.5 rounded text-xs ${
                    activeTab === 'snapshots' ? 'bg-surface-200 text-surface-700' : 'bg-surface-100 text-surface-500'
                  }`}>
                    {snapshots.length}
                  </span>
                </span>
                {activeTab === 'snapshots' && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-surface-400" />
                )}
              </button>
            </div>

            {/* Tab content */}
            {activeTab === 'conversations' ? (
              <>
                {/* New conversation button */}
                <div className="px-6 py-3 border-b border-surface-100 flex justify-end">
                  <button
                    onClick={handleCreateConversation}
                    disabled={isCreatingConversation}
                    className="flex items-center gap-1.5 px-3 py-1.5 border border-surface-300 text-surface-600 text-sm font-medium rounded-md hover:bg-surface-50 hover:border-surface-400 disabled:opacity-50"
                  >
                    <Plus className="w-4 h-4" />
                    {isCreatingConversation ? 'Creating...' : 'New'}
                  </button>
                </div>

                {conversations.length === 0 ? (
                  <div className="px-6 py-12 text-center">
                    <MessageSquare className="w-10 h-10 text-surface-300 mx-auto mb-2" />
                    <p className="text-surface-500 text-sm">No conversations yet</p>
                    <button
                      onClick={handleCreateConversation}
                      disabled={isCreatingConversation}
                      className="text-sm text-accent-600 hover:underline mt-2"
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
              </>
            ) : (
              /* Snapshots tab */
              <>
                {isLoadingSnapshots ? (
                  <div className="px-6 py-12 text-center text-surface-500">
                    Loading snapshots...
                  </div>
                ) : snapshots.length === 0 ? (
                  <div className="px-6 py-12 text-center">
                    <History className="w-10 h-10 text-surface-300 mx-auto mb-2" />
                    <p className="text-surface-500 text-sm">No snapshots yet</p>
                    <p className="text-surface-400 text-xs mt-1">
                      Snapshots are created when you save your work in a conversation
                    </p>
                  </div>
                ) : (
                  <div className="divide-y divide-surface-100">
                    {snapshots.map((snapshot, index) => (
                      <div
                        key={snapshot.id}
                        className={`px-6 py-4 ${snapshot.is_current ? 'bg-accent-50/50' : ''}`}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              {snapshot.is_current && (
                                <span className="text-xs px-1.5 py-0.5 bg-accent-100 text-accent-700 rounded font-medium">
                                  Current
                                </span>
                              )}
                              {index === 0 && !snapshot.is_current && (
                                <span className="text-xs px-1.5 py-0.5 bg-surface-100 text-surface-600 rounded">
                                  Latest
                                </span>
                              )}
                              <span className="text-xs text-surface-400">
                                {formatTimestamp(snapshot.created_at)}
                              </span>
                            </div>
                            {snapshot.summary ? (
                              <p className="text-sm text-surface-700 mt-1">{snapshot.summary}</p>
                            ) : (
                              <p className="text-sm text-surface-400 mt-1 italic">
                                {snapshot.source === 'system' ? 'Auto-saved' :
                                 snapshot.source === 'web' ? 'Saved from web' :
                                 snapshot.source === 'cli' ? 'Saved from CLI' : 'Snapshot'}
                              </p>
                            )}
                          </div>
                          <div className="text-xs font-mono text-surface-400 flex-shrink-0">
                            {snapshot.manifest_hash.slice(0, 8)}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
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
        <div className="fixed bottom-4 right-4 bg-green-600 text-white px-4 py-3 rounded-md shadow-lg flex items-center gap-2 z-50">
          <Check className="w-5 h-5" />
          <span>Synced! {syncResult.filesAdded} added, {syncResult.filesUpdated} updated</span>
        </div>
      )}

      {/* Deployment Success Banner */}
      {currentDeployment?.status === 'success' && currentDeployment.url && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-gradient-to-r from-status-success to-emerald-600 text-white px-6 py-3 rounded-md shadow-lg flex items-center gap-4 z-50">
          <div className="flex items-center gap-2">
            <Check className="w-5 h-5" />
            <span>Deployed successfully!</span>
          </div>
          <a
            href={currentDeployment.url}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1 bg-white/20 hover:bg-white/30 rounded text-sm font-medium transition-colors"
          >
            Open Site
          </a>
          <button
            onClick={() => setCurrentDeployment(null)}
            className="p-1 hover:bg-white/20 rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Deployment Logs Panel */}
      {showDeploymentLogs && currentDeployment && (
        <div className="fixed inset-y-0 right-0 w-[500px] z-50 shadow-xl">
          <DeploymentLogs
            deploymentId={currentDeployment.id}
            isStreaming={currentDeployment.status === 'deploying'}
            entries={deploymentLogs}
            onClose={() => setShowDeploymentLogs(false)}
          />
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
      <div className="bg-white rounded-md shadow-xl max-w-2xl w-full max-h-[80vh] overflow-hidden flex flex-col">
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
          <div className="p-4 bg-surface-50 rounded-md">
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
                  <div className="bg-blue-50 rounded-md p-3">
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
                  <div className="bg-purple-50 rounded-md p-3">
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
                      <div key={decision.path} className="bg-yellow-50 rounded-md p-4">
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
                              className={`flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
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
                                className="mt-0.5 text-accent-500 focus:ring-surface-400"
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
              className="px-4 py-2 text-sm font-medium text-surface-600 hover:text-surface-800 hover:bg-surface-100 rounded-md transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            {!isEmpty && (
              <button
                onClick={() => onSync(decisions)}
                disabled={isSyncing || (hasDecisions && !allDecisionsMade)}
                className="flex items-center gap-2 px-4 py-2 bg-accent-500 text-white text-sm font-medium rounded-md hover:bg-accent-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
    <div className={`rounded-md ${bgColor}`}>
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
