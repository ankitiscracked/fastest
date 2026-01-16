import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import type { Project, Workspace, Snapshot } from '@fastest/shared';
import { api } from '../api/client';

export function ProjectDetail() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchProject();
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

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="text-gray-500">Loading project...</div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="text-center py-12">
        <h2 className="text-lg font-medium text-gray-900">Project not found</h2>
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
          <h1 className="text-2xl font-bold text-gray-900">{project.name}</h1>
          <p className="text-sm text-gray-500 font-mono flex items-center gap-2">
            {project.id}
            <button
              onClick={() => copyToClipboard(project.id)}
              className="text-primary-600 hover:text-primary-700"
              title="Copy ID"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
          </p>
        </div>
        <Link
          to={`/projects/${projectId}/workspaces`}
          className="px-4 py-2 bg-primary-600 text-white rounded-md hover:bg-primary-700 text-sm font-medium"
        >
          View Workspaces
        </Link>
      </div>

      {/* CLI Quick Actions */}
      <div className="bg-gray-800 rounded-lg p-4 text-white">
        <h3 className="text-sm font-medium text-gray-300 mb-3">CLI Quick Actions</h3>
        <div className="space-y-2 font-mono text-sm">
          <div className="flex items-center justify-between bg-gray-900 rounded px-3 py-2">
            <code>fst link {project.id}</code>
            <button
              onClick={() => copyToClipboard(`fst link ${project.id}`)}
              className="text-gray-400 hover:text-white"
            >
              Copy
            </button>
          </div>
          <div className="flex items-center justify-between bg-gray-900 rounded px-3 py-2">
            <code>fst clone {project.id}</code>
            <button
              onClick={() => copyToClipboard(`fst clone ${project.id}`)}
              className="text-gray-400 hover:text-white"
            >
              Copy
            </button>
          </div>
          <div className="flex items-center justify-between bg-gray-900 rounded px-3 py-2">
            <code>fst snapshot</code>
            <button
              onClick={() => copyToClipboard('fst snapshot')}
              className="text-gray-400 hover:text-white"
            >
              Copy
            </button>
          </div>
        </div>
      </div>

      {/* Status */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h3 className="text-sm font-medium text-gray-900 mb-3">Status</h3>
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-gray-500">Last Snapshot</dt>
            <dd className="font-mono text-gray-900">
              {project.last_snapshot_id || 'None'}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Last Updated</dt>
            <dd className="text-gray-900">
              {new Date(project.updated_at).toLocaleString()}
            </dd>
          </div>
        </dl>
      </div>

      {/* Active Workspaces */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200">
          <h3 className="text-sm font-medium text-gray-900">Active Workspaces</h3>
        </div>
        {workspaces.length === 0 ? (
          <div className="px-4 py-8 text-center text-gray-500 text-sm">
            No active workspaces. Run <code className="bg-gray-100 px-1 py-0.5 rounded">fst workspace create</code> to create one.
          </div>
        ) : (
          <ul className="divide-y divide-gray-200">
            {workspaces.map((workspace) => (
              <li key={workspace.id} className="px-4 py-3">
                <Link
                  to={`/workspaces/${workspace.id}`}
                  className="flex items-center justify-between hover:bg-gray-50 -mx-4 px-4 py-2"
                >
                  <div>
                    <span className="font-medium text-gray-900">{workspace.name}</span>
                    <span className="ml-2 text-xs text-gray-500">{workspace.local_path}</span>
                  </div>
                  <span className="text-xs text-gray-400">
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
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200">
          <h3 className="text-sm font-medium text-gray-900">Recent Snapshots</h3>
        </div>
        {snapshots.length === 0 ? (
          <div className="px-4 py-8 text-center text-gray-500 text-sm">
            No snapshots yet. Run <code className="bg-gray-100 px-1 py-0.5 rounded">fst snapshot</code> to create one.
          </div>
        ) : (
          <ul className="divide-y divide-gray-200">
            {snapshots.slice(0, 10).map((snapshot) => (
              <li key={snapshot.id} className="px-4 py-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-mono text-sm text-gray-900">{snapshot.id}</span>
                    <span className="ml-2 text-xs text-gray-500">{snapshot.source}</span>
                  </div>
                  <span className="text-xs text-gray-400">
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
