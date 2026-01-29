import { useState, useEffect } from 'react';
import { useParams, Link } from '@tanstack/react-router';
import type { Project, Workspace, Snapshot, ProjectEnvVar, ProjectSnapshotInsights } from '@fastest/shared';
import { api } from '../api/client';

type Tab = 'workspaces' | 'environment';

export function ProjectDetail() {
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const [project, setProject] = useState<Project | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [snapshotInsights, setSnapshotInsights] = useState<ProjectSnapshotInsights | null>(null);
  const [envVars, setEnvVars] = useState<ProjectEnvVar[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('workspaces');
  const [cliExpanded, setCliExpanded] = useState(false);

  // Env var form state
  const [newEnvKey, setNewEnvKey] = useState('');
  const [newEnvValue, setNewEnvValue] = useState('');
  const [newEnvIsSecret, setNewEnvIsSecret] = useState(false);
  const [envSaving, setEnvSaving] = useState(false);
  const [editingEnvKey, setEditingEnvKey] = useState<string | null>(null);
  const [editEnvValue, setEditEnvValue] = useState('');

  useEffect(() => {
    fetchProject();
    fetchEnvVars();
  }, [projectId]);

  const fetchProject = async () => {
    if (!projectId) return;
    try {
      setError(null);
      const data = await api.getProject(projectId);
      setProject(data.project);
      setWorkspaces(data.workspaces || []);
      setSnapshots(data.snapshots || []);
      setSnapshotInsights(data.snapshot_insights || null);
    } catch (err) {
      console.error('Failed to fetch project:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch project');
    } finally {
      setLoading(false);
    }
  };

  const fetchEnvVars = async () => {
    if (!projectId) return;
    try {
      const data = await api.getEnvVars(projectId);
      setEnvVars(data.variables || []);
    } catch (err) {
      console.error('Failed to fetch env vars:', err);
    }
  };

  const handleAddEnvVar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId || !newEnvKey.trim()) return;

    setEnvSaving(true);
    try {
      await api.setEnvVar(projectId, newEnvKey.trim(), newEnvValue, newEnvIsSecret);
      setNewEnvKey('');
      setNewEnvValue('');
      setNewEnvIsSecret(false);
      await fetchEnvVars();
    } catch (err) {
      console.error('Failed to add env var:', err);
      setError(err instanceof Error ? err.message : 'Failed to add environment variable');
    } finally {
      setEnvSaving(false);
    }
  };

  const handleUpdateEnvVar = async (key: string) => {
    if (!projectId) return;

    setEnvSaving(true);
    try {
      const existingVar = envVars.find(v => v.key === key);
      await api.setEnvVar(projectId, key, editEnvValue, existingVar?.is_secret || false);
      setEditingEnvKey(null);
      setEditEnvValue('');
      await fetchEnvVars();
    } catch (err) {
      console.error('Failed to update env var:', err);
      setError(err instanceof Error ? err.message : 'Failed to update environment variable');
    } finally {
      setEnvSaving(false);
    }
  };

  const handleDeleteEnvVar = async (key: string) => {
    if (!projectId) return;
    if (!confirm(`Delete environment variable "${key}"?`)) return;

    try {
      await api.deleteEnvVar(projectId, key);
      await fetchEnvVars();
    } catch (err) {
      console.error('Failed to delete env var:', err);
      setError(err instanceof Error ? err.message : 'Failed to delete environment variable');
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-surface-500">Loading project...</div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-lg font-medium text-surface-800">Project not found</h2>
          {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
        </div>
      </div>
    );
  }

  const sortedSnapshots = [...snapshots].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
  const lastSnapshot = sortedSnapshots[0] || null;
  const recentSnapshots = sortedSnapshots.slice(0, 3);

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'workspaces', label: 'Workspaces', count: workspaces.length },
    { key: 'environment', label: 'Environment', count: envVars.length },
  ];

  const formatTimestamp = (value?: string | null) =>
    value ? new Date(value).toLocaleString() : null;

  const lastMergeAt = formatTimestamp(snapshotInsights?.last_merge_at);
  const lastDeployAt = formatTimestamp(snapshotInsights?.last_deploy_at);
  const snapshotsSinceMerge = snapshotInsights?.snapshots_since_last_merge;
  const snapshotsSinceDeploy = snapshotInsights?.snapshots_since_last_deploy;

  return (
    <div className="h-full flex flex-col bg-surface-50">
      {/* Header */}
      <header className="flex-shrink-0 bg-white border-b border-surface-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-surface-800">{project.name}</h1>
            <div className="flex items-center gap-3 mt-1 text-xs text-surface-500">
              <span className="font-mono">{project.id.slice(0, 8)}</span>
              <span className="text-surface-300">•</span>
              <span>Updated {new Date(project.updated_at).toLocaleDateString()}</span>
              <span className="text-surface-300">•</span>
              <span>{snapshots.length} snapshots</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to="/projects/$projectId/atlas"
              params={{ projectId: projectId! }}
              className="px-4 py-2 border border-surface-300 text-surface-700 rounded-md hover:bg-surface-50 text-sm font-medium flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v12m6-6H6" />
              </svg>
              Atlas
            </Link>
            <Link
              to="/projects/$projectId/docs"
              params={{ projectId: projectId! }}
              className="px-4 py-2 border border-surface-300 text-surface-700 rounded-md hover:bg-surface-50 text-sm font-medium flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Docs
            </Link>
          </div>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Error display */}
          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-md">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          {/* Overview Card */}
          <div className="bg-white rounded-md border border-surface-200 p-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-8">
                <div>
                  <div className="text-2xl font-semibold text-surface-800">{workspaces.length}</div>
                  <div className="text-sm text-surface-500">Active Workspaces</div>
                </div>
                <div className="w-px h-10 bg-surface-200" />
                <div>
                  <div className="text-2xl font-semibold text-surface-800">{snapshots.length}</div>
                  <div className="text-sm text-surface-500">Snapshots</div>
                </div>
                <div className="w-px h-10 bg-surface-200" />
                <div>
                  <div className="text-2xl font-semibold text-surface-800">{envVars.length}</div>
                  <div className="text-sm text-surface-500">Env Variables</div>
                </div>
              </div>
              <Link
                to="/projects/$projectId/workspaces"
                params={{ projectId: projectId! }}
                search={{ create: true }}
                className="px-3 py-1.5 border border-surface-300 text-surface-700 rounded-md hover:bg-surface-50 text-sm font-medium"
              >
                New Workspace
              </Link>
            </div>
          </div>

          {/* CLI Quick Actions - Collapsible */}
          <div className="bg-white rounded-md border border-surface-200 overflow-hidden">
            <button
              onClick={() => setCliExpanded(!cliExpanded)}
              className="w-full px-4 py-3 flex items-center justify-between text-surface-700 hover:bg-surface-50"
            >
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-surface-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <span className="text-sm font-medium">CLI Quick Actions</span>
              </div>
              <svg
                className={`w-4 h-4 text-surface-400 transition-transform ${cliExpanded ? 'rotate-180' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {cliExpanded && (
              <div className="px-4 pb-4 space-y-2 border-t border-surface-200 pt-3">
                <div className="flex items-center justify-between bg-surface-100 rounded-md px-3 py-2 font-mono text-sm text-surface-800">
                  <code>fst link {project.id}</code>
                  <button
                    onClick={() => copyToClipboard(`fst link ${project.id}`)}
                    className="text-surface-500 hover:text-surface-700 text-xs font-sans"
                  >
                    Copy
                  </button>
                </div>
                <div className="flex items-center justify-between bg-surface-100 rounded-md px-3 py-2 font-mono text-sm text-surface-800">
                  <code>fst clone {project.id}</code>
                  <button
                    onClick={() => copyToClipboard(`fst clone ${project.id}`)}
                    className="text-surface-500 hover:text-surface-700 text-xs font-sans"
                  >
                    Copy
                  </button>
                </div>
                <div className="flex items-center justify-between bg-surface-100 rounded-md px-3 py-2 font-mono text-sm text-surface-800">
                  <code>fst snapshot</code>
                  <button
                    onClick={() => copyToClipboard('fst snapshot')}
                    className="text-surface-500 hover:text-surface-700 text-xs font-sans"
                  >
                    Copy
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Snapshot Activity */}
          <div className="bg-white rounded-md border border-surface-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-surface-200 bg-surface-50">
              <div className="text-sm font-medium text-surface-800">Snapshot activity</div>
            </div>
            <div className="p-4 grid gap-4 md:grid-cols-3">
              <div>
                <div className="text-xs text-surface-500">Last snapshot</div>
                {lastSnapshot ? (
                  <>
                    <div className="text-sm text-surface-800 mt-1">
                      {formatTimestamp(lastSnapshot.created_at)}
                    </div>
                    <div className="text-xs text-surface-500 font-mono">
                      {lastSnapshot.id.slice(0, 8)}...
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-surface-600 mt-1">No snapshots yet</div>
                )}
              </div>
              <div>
                <div className="text-xs text-surface-500">Since last merge</div>
                {lastMergeAt ? (
                  <>
                    <div className="text-sm text-surface-800 mt-1">
                      {snapshotsSinceMerge ?? 0} snapshot{snapshotsSinceMerge === 1 ? '' : 's'}
                    </div>
                    <div className="text-xs text-surface-500">since {lastMergeAt}</div>
                  </>
                ) : (
                  <div className="text-sm text-surface-600 mt-1">No merges yet</div>
                )}
              </div>
              <div>
                <div className="text-xs text-surface-500">Since last deploy</div>
                {lastDeployAt ? (
                  <>
                    <div className="text-sm text-surface-800 mt-1">
                      {snapshotsSinceDeploy ?? 0} snapshot{snapshotsSinceDeploy === 1 ? '' : 's'}
                    </div>
                    <div className="text-xs text-surface-500">since {lastDeployAt}</div>
                  </>
                ) : (
                  <div className="text-sm text-surface-600 mt-1">No deploys yet</div>
                )}
              </div>
            </div>
            <div className="border-t border-surface-200">
              <div className="px-4 py-3 text-xs text-surface-500">Recent snapshot summaries</div>
              {recentSnapshots.length === 0 ? (
                <div className="px-4 pb-4 text-sm text-surface-500">No snapshots yet.</div>
              ) : (
                <ul className="divide-y divide-surface-200">
                  {recentSnapshots.map((snapshot) => (
                    <li key={snapshot.id} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="text-xs text-surface-500 font-mono">
                            {snapshot.id.slice(0, 8)}...
                          </div>
                          <div className="text-sm text-surface-700 mt-1">
                            {snapshot.summary || 'No summary'}
                          </div>
                        </div>
                        <div className="text-xs text-surface-400">
                          {formatTimestamp(snapshot.created_at)}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Tabs */}
          <div className="border-b border-surface-200">
            <nav className="flex gap-6">
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`relative pb-3 text-sm font-medium transition-colors ${
                    activeTab === tab.key
                      ? 'text-surface-800'
                      : 'text-surface-500 hover:text-surface-700'
                  }`}
                >
                  {tab.label}
                  <span className="ml-1.5 text-surface-400">({tab.count})</span>
                  {activeTab === tab.key && (
                    <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-surface-400" />
                  )}
                </button>
              ))}
            </nav>
          </div>

          {/* Tab Content */}
          <div>
            {activeTab === 'workspaces' && (
              <div className="bg-white rounded-md border border-surface-200 overflow-hidden">
                {workspaces.length === 0 ? (
                  <div className="px-4 py-8 text-center text-surface-500 text-sm">
                    No active workspaces. Run <code className="bg-surface-100 px-1 py-0.5 rounded">fst workspace create</code> to create one.
                  </div>
                ) : (
                  <ul className="divide-y divide-surface-200">
                    {workspaces.map((workspace) => (
                      <li key={workspace.id}>
                        <Link
                          to="/workspaces/$workspaceId"
                          params={{ workspaceId: workspace.id }}
                          className="flex items-center justify-between px-4 py-3 hover:bg-surface-50"
                        >
                          <div>
                            <span className="font-medium text-surface-800">{workspace.name}</span>
                            <div className="text-xs text-surface-500 mt-0.5">{workspace.local_path}</div>
                          </div>
                          <span className="text-xs text-surface-400">
                            {workspace.last_seen_at
                              ? `Seen ${new Date(workspace.last_seen_at).toLocaleDateString()}`
                              : 'Never seen'}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {activeTab === 'environment' && (
              <div className="bg-white rounded-md border border-surface-200 overflow-hidden">
                <div className="px-4 py-3 border-b border-surface-200 bg-surface-50">
                  <p className="text-xs text-surface-500">
                    Environment variables are passed to deployments via Wrangler --var flags
                  </p>
                </div>
                <div className="p-4 space-y-4">
                  {/* Existing env vars */}
                  {envVars.length > 0 && (
                    <div className="space-y-2">
                      {envVars.map((envVar) => (
                        <div
                          key={envVar.key}
                          className="flex items-center gap-2 bg-surface-50 rounded-md p-3"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-sm text-surface-800">{envVar.key}</span>
                              {envVar.is_secret && (
                                <span className="text-xs bg-yellow-100 text-yellow-800 px-1.5 py-0.5 rounded">
                                  secret
                                </span>
                              )}
                            </div>
                            {editingEnvKey === envVar.key ? (
                              <div className="flex items-center gap-2 mt-2">
                                <input
                                  type={envVar.is_secret ? 'password' : 'text'}
                                  value={editEnvValue}
                                  onChange={(e) => setEditEnvValue(e.target.value)}
                                  className="flex-1 text-sm border border-surface-300 rounded-md px-2 py-1 font-mono"
                                  placeholder="New value"
                                />
                                <button
                                  onClick={() => handleUpdateEnvVar(envVar.key)}
                                  disabled={envSaving}
                                  className="text-xs px-2 py-1 bg-accent-500 text-white rounded-md hover:bg-accent-600 disabled:opacity-50"
                                >
                                  Save
                                </button>
                                <button
                                  onClick={() => {
                                    setEditingEnvKey(null);
                                    setEditEnvValue('');
                                  }}
                                  className="text-xs px-2 py-1 text-surface-600 hover:text-surface-800"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <div className="text-xs text-surface-500 font-mono truncate mt-0.5">
                                {envVar.value}
                              </div>
                            )}
                          </div>
                          {editingEnvKey !== envVar.key && (
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => {
                                  setEditingEnvKey(envVar.key);
                                  setEditEnvValue('');
                                }}
                                className="p-1.5 text-surface-400 hover:text-surface-600 rounded hover:bg-surface-100"
                                title="Edit value"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                </svg>
                              </button>
                              <button
                                onClick={() => handleDeleteEnvVar(envVar.key)}
                                className="p-1.5 text-surface-400 hover:text-red-600 rounded hover:bg-surface-100"
                                title="Delete"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Add new env var form */}
                  <form onSubmit={handleAddEnvVar} className={envVars.length > 0 ? 'border-t border-surface-200 pt-4' : ''}>
                    <div className="flex flex-wrap gap-2">
                      <input
                        type="text"
                        value={newEnvKey}
                        onChange={(e) => setNewEnvKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
                        placeholder="KEY"
                        className="flex-1 min-w-[120px] text-sm border border-surface-300 rounded-md px-3 py-2 font-mono"
                      />
                      <input
                        type={newEnvIsSecret ? 'password' : 'text'}
                        value={newEnvValue}
                        onChange={(e) => setNewEnvValue(e.target.value)}
                        placeholder="value"
                        className="flex-1 min-w-[200px] text-sm border border-surface-300 rounded-md px-3 py-2 font-mono"
                      />
                      <label className="flex items-center gap-1.5 text-sm text-surface-600 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={newEnvIsSecret}
                          onChange={(e) => setNewEnvIsSecret(e.target.checked)}
                          className="rounded border-surface-300"
                        />
                        Secret
                      </label>
                      <button
                        type="submit"
                        disabled={envSaving || !newEnvKey.trim()}
                        className="px-4 py-2 border border-surface-300 text-surface-700 rounded-md text-sm font-medium hover:bg-surface-50 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {envSaving ? 'Adding...' : 'Add'}
                      </button>
                    </div>
                  </form>

                  {envVars.length === 0 && (
                    <p className="text-sm text-surface-500 text-center py-2">
                      No environment variables configured
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
