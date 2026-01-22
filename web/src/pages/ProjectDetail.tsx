import { useState, useEffect } from 'react';
import { useParams, Link } from '@tanstack/react-router';
import type { Project, Workspace, Snapshot, ProjectEnvVar } from '@fastest/shared';
import { api } from '../api/client';

export function ProjectDetail() {
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const [project, setProject] = useState<Project | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [envVars, setEnvVars] = useState<ProjectEnvVar[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      <div className="flex justify-center py-12">
        <div className="text-surface-500">Loading project...</div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="text-center py-12">
        <h2 className="text-lg font-medium text-surface-800">Project not found</h2>
        {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Error display */}
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-md">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Header */}
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-2xl font-bold text-surface-800">{project.name}</h1>
          <p className="text-sm text-surface-500 font-mono flex items-center gap-2">
            {project.id}
            <button
              onClick={() => copyToClipboard(project.id)}
              className="text-accent-600 hover:text-accent-700"
              title="Copy ID"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
          </p>
        </div>
        <Link
          to="/projects/$projectId/workspaces"
          params={{ projectId: projectId! }}
          className="px-4 py-2 bg-accent-500 text-white rounded-md hover:bg-accent-600 text-sm font-medium"
        >
          View Workspaces
        </Link>
      </div>

      {/* CLI Quick Actions */}
      <div className="bg-gray-800 rounded-lg p-4 text-white">
        <h3 className="text-sm font-medium text-surface-300 mb-3">CLI Quick Actions</h3>
        <div className="space-y-2 font-mono text-sm">
          <div className="flex items-center justify-between bg-gray-900 rounded px-3 py-2">
            <code>fst link {project.id}</code>
            <button
              onClick={() => copyToClipboard(`fst link ${project.id}`)}
              className="text-surface-400 hover:text-white"
            >
              Copy
            </button>
          </div>
          <div className="flex items-center justify-between bg-gray-900 rounded px-3 py-2">
            <code>fst clone {project.id}</code>
            <button
              onClick={() => copyToClipboard(`fst clone ${project.id}`)}
              className="text-surface-400 hover:text-white"
            >
              Copy
            </button>
          </div>
          <div className="flex items-center justify-between bg-gray-900 rounded px-3 py-2">
            <code>fst snapshot</code>
            <button
              onClick={() => copyToClipboard('fst snapshot')}
              className="text-surface-400 hover:text-white"
            >
              Copy
            </button>
          </div>
        </div>
      </div>

      {/* Status */}
      <div className="bg-white rounded-lg border border-surface-200 p-4">
        <h3 className="text-sm font-medium text-surface-800 mb-3">Status</h3>
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-surface-500">Last Snapshot</dt>
            <dd className="font-mono text-surface-800">
              {project.last_snapshot_id || 'None'}
            </dd>
          </div>
          <div>
            <dt className="text-surface-500">Last Updated</dt>
            <dd className="text-surface-800">
              {new Date(project.updated_at).toLocaleString()}
            </dd>
          </div>
        </dl>
      </div>

      {/* Environment Variables */}
      <div className="bg-white rounded-lg border border-surface-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-surface-200">
          <h3 className="text-sm font-medium text-surface-800">Environment Variables</h3>
          <p className="text-xs text-surface-500 mt-1">
            These variables are passed to deployments via Wrangler --var flags
          </p>
        </div>
        <div className="p-4 space-y-4">
          {/* Existing env vars */}
          {envVars.length > 0 && (
            <div className="space-y-2">
              {envVars.map((envVar) => (
                <div
                  key={envVar.key}
                  className="flex items-center gap-2 bg-surface-50 rounded-md p-2"
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
                      <div className="flex items-center gap-2 mt-1">
                        <input
                          type={envVar.is_secret ? 'password' : 'text'}
                          value={editEnvValue}
                          onChange={(e) => setEditEnvValue(e.target.value)}
                          className="flex-1 text-sm border border-surface-300 rounded px-2 py-1 font-mono"
                          placeholder="New value"
                        />
                        <button
                          onClick={() => handleUpdateEnvVar(envVar.key)}
                          disabled={envSaving}
                          className="text-xs px-2 py-1 bg-accent-500 text-white rounded hover:bg-accent-600 disabled:opacity-50"
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
                      <div className="text-xs text-surface-500 font-mono truncate">
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
                        className="p-1 text-surface-400 hover:text-surface-600"
                        title="Edit value"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => handleDeleteEnvVar(envVar.key)}
                        className="p-1 text-surface-400 hover:text-red-600"
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
          <form onSubmit={handleAddEnvVar} className="border-t border-surface-200 pt-4">
            <div className="flex flex-wrap gap-2">
              <input
                type="text"
                value={newEnvKey}
                onChange={(e) => setNewEnvKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
                placeholder="KEY"
                className="flex-1 min-w-[120px] text-sm border border-surface-300 rounded px-3 py-2 font-mono"
              />
              <input
                type={newEnvIsSecret ? 'password' : 'text'}
                value={newEnvValue}
                onChange={(e) => setNewEnvValue(e.target.value)}
                placeholder="value"
                className="flex-1 min-w-[200px] text-sm border border-surface-300 rounded px-3 py-2 font-mono"
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
                className="px-4 py-2 bg-accent-500 text-white rounded text-sm font-medium hover:bg-accent-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {envSaving ? 'Adding...' : 'Add Variable'}
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

      {/* Active Workspaces */}
      <div className="bg-white rounded-lg border border-surface-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-surface-200">
          <h3 className="text-sm font-medium text-surface-800">Active Workspaces</h3>
        </div>
        {workspaces.length === 0 ? (
          <div className="px-4 py-8 text-center text-surface-500 text-sm">
            No active workspaces. Run <code className="bg-surface-100 px-1 py-0.5 rounded">fst workspace create</code> to create one.
          </div>
        ) : (
          <ul className="divide-y divide-surface-200">
            {workspaces.map((workspace) => (
              <li key={workspace.id} className="px-4 py-3">
                <Link
                  to="/"
                  className="flex items-center justify-between hover:bg-surface-50 -mx-4 px-4 py-2"
                >
                  <div>
                    <span className="font-medium text-surface-800">{workspace.name}</span>
                    <span className="ml-2 text-xs text-surface-500">{workspace.local_path}</span>
                  </div>
                  <span className="text-xs text-surface-400">
                    {workspace.last_seen_at
                      ? `Seen ${new Date(workspace.last_seen_at).toLocaleString()}`
                      : 'Never seen'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Recent Snapshots */}
      <div className="bg-white rounded-lg border border-surface-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-surface-200">
          <h3 className="text-sm font-medium text-surface-800">Recent Snapshots</h3>
        </div>
        {snapshots.length === 0 ? (
          <div className="px-4 py-8 text-center text-surface-500 text-sm">
            No snapshots yet. Run <code className="bg-surface-100 px-1 py-0.5 rounded">fst snapshot</code> to create one.
          </div>
        ) : (
          <ul className="divide-y divide-surface-200">
            {snapshots.slice(0, 10).map((snapshot) => (
              <li key={snapshot.id} className="px-4 py-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-mono text-sm text-surface-800">{snapshot.id}</span>
                    <span className="ml-2 text-xs text-surface-500">{snapshot.source}</span>
                  </div>
                  <span className="text-xs text-surface-400">
                    {new Date(snapshot.created_at).toLocaleString()}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
